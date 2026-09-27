/**
 * A live table: the host's event stream in, a replayed `GameSession` out, and
 * the actions a player can take. This is what obelisk-dex's store, its
 * `useGameSession` hook and `useTurnClockEnforcer` did, minus React — an app
 * renders from `table.subscribe(...)` with whatever UI library it bundles.
 *
 *   const host = connect(ctx);
 *   const table = await openTable(host, chainReaction);
 *   table.subscribe((s) => render(s));
 *   await table.move({ cell: 12 });
 */
import type { Host } from '../host.js';
import type { ConnectionState, Init, NostrEvent } from '../types.js';
import {
  buildMove, buildRealtime, buildResign, buildSimple, buildStart, buildStatus, buildTimeout,
  parseOp, type ParsedOp, type SeatSpec,
} from './protocol.js';
import {
  canJoin, canStart, controllerOf, deriveSession, isMyTurn, isTurnExpired, seatsControlledBy,
  type GameSession,
} from './session.js';
import type { GameDefinition } from './types.js';

/**
 * Grace between a deadline passing and this client being willing to say so.
 * It absorbs a move already in flight, and clock skew: `created_at` comes from
 * whoever claims, so a browser running fast would otherwise cut turns short.
 */
export const TIMEOUT_CLAIM_GRACE_S = 3;

/**
 * After a reconnect, wait this long before claiming anyone's clock. A tab
 * that slept through a turn must not report the player for it; give the
 * player on move the same window on a healthy relay the clock gave them.
 */
export const RECONNECT_CLAIM_GRACE_S = 20;

export interface TableOptions {
  /** Injected for tests. Unix seconds. */
  now?: () => number;
  /** How often the clock is checked. Default 1 s. */
  tickMs?: number;
  /** Publish `status` lines for the chat card automatically. Default true. */
  autoStatus?: boolean;
  /** Custom card line; default describes whose turn it is. */
  statusText?: (s: GameSession) => string | null;
}

export interface Table {
  readonly init: Init;
  readonly me: string | null;
  /** The latest session, or null until the host has delivered the `create`. */
  readonly session: GameSession | null;
  subscribe(cb: (s: GameSession | null) => void): () => void;

  join(): Promise<void>;
  leave(): Promise<void>;
  cancel(): Promise<void>;
  start(seats: SeatSpec[], opts?: Record<string, unknown>, turnTimeoutS?: number): Promise<void>;
  move(action: unknown, seat?: string): Promise<void>;
  resign(seat?: string): Promise<void>;
  /** Real-time games: publish one of the game's declared ops. */
  send(op: string, body: Record<string, unknown>): Promise<void>;

  canJoin(): boolean;
  canStart(): boolean;
  isMyTurn(): boolean;
  mySeats(): string[];
  dispose(): void;
}

function defaultStatus(s: GameSession): string | null {
  switch (s.status) {
    case 'waiting': return `Waiting for players · ${s.joined.length}/${s.maxPlayers}`;
    case 'cancelled': return 'Cancelled';
    case 'finished': return s.draw ? 'Finished · draw' : 'Finished';
    case 'in_progress': return s.currentTurn ? `In progress · move ${s.turnIndex + 1}` : 'In progress';
  }
}

export async function openTable(host: Host, def: GameDefinition, opts: TableOptions = {}): Promise<Table> {
  const init = await host.ready;
  const me = init.me;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const byId = new Map<string, ParsedOp>();
  let log: ParsedOp[] = [];
  let session: GameSession | null = null;
  let connection: ConnectionState = init.connection;
  const listeners = new Set<(s: GameSession | null) => void>();
  let claimedTurn: string | null = null;
  let lastStatus: string | null = null;

  const recompute = () => {
    session = deriveSession(def, log, now());
    for (const cb of listeners) cb(session);
    maybeClaim();
    maybeStatus();
  };

  const ingest = (events: NostrEvent[]) => {
    let changed = false;
    for (const ev of events) {
      if (byId.has(ev.id)) continue;
      const p = parseOp(ev);
      if (!p) continue;
      byId.set(ev.id, p);
      changed = true;
    }
    if (!changed) return;
    // Copy-on-write, so a caller holding the old array keeps a consistent view.
    log = [...byId.values()];
    recompute();
  };

  /** Port of useTurnClockEnforcer. Every seated client races; the reducer accepts one claim. */
  function maybeClaim() {
    const s = session;
    if (!s || !me || !s.currentTurn || s.status !== 'in_progress') return;
    // Seats, not pubkeys: on a hot-seat table one account holds several seats.
    if (seatsControlledBy(s, me).length === 0) return;
    // Never against our own turn: losing on time should cost you a move you
    // didn't make, not one your own browser reported you for.
    if (controllerOf(s, s.currentTurn) === me) return;
    const t = now();
    if (!isTurnExpired(s, t - TIMEOUT_CLAIM_GRACE_S)) return;
    if (!connection.connected || connection.since === null) return;
    if (t - connection.since < RECONNECT_CLAIM_GRACE_S) return;
    const key = `${s.id}:${s.turnIndex}`;
    if (claimedTurn === key) return;
    claimedTurn = key;
    host.publish(buildTimeout(s.turnIndex)).catch(() => { /* someone else's claim will do */ });
  }

  /** The chat card's line. Only the table's creator publishes it, and only when it changes. */
  function maybeStatus() {
    if (opts.autoStatus === false || !session || !me || me !== session.createdBy) return;
    const text = (opts.statusText ?? defaultStatus)(session);
    if (!text || text === lastStatus) return;
    lastStatus = text;
    host.publish(buildStatus(text)).catch(() => { lastStatus = null; });
  }

  const offEvents = host.onEvents(ingest);
  const offConn = host.onConnection((c) => { connection = c; maybeClaim(); });
  const timer = setInterval(() => {
    // The expiry and the clock are the two time-dependent reads.
    if (session && (session.status === 'waiting' || session.turnDeadline !== null)) recompute();
  }, opts.tickMs ?? 1000);

  const pub = async (req: Parameters<Host['publish']>[0]) => { await host.publish(req); };

  return {
    init,
    me,
    get session() { return session; },
    subscribe(cb) {
      listeners.add(cb);
      cb(session);
      return () => listeners.delete(cb);
    },
    join: () => pub(buildSimple('join')),
    leave: () => pub(buildSimple('leave')),
    cancel: () => pub(buildSimple('cancel')),
    start: (seats, o = {}, turnTimeoutS = def.defaultTurnTimeoutS) => pub(buildStart(seats, o, turnTimeoutS)),
    move: (action, seat) => {
      if (!session) return Promise.reject(new Error('no table yet'));
      return pub(buildMove(session.turnIndex, action, seat));
    },
    resign: (seat) => pub(buildResign(seat)),
    send: (op, body) => pub(buildRealtime(op, body)),
    canJoin: () => !!session && canJoin(session, me),
    canStart: () => !!session && canStart(session, me),
    isMyTurn: () => !!session && isMyTurn(session, me),
    mySeats: () => (session ? seatsControlledBy(session, me) : []),
    dispose() {
      clearInterval(timer);
      offEvents();
      offConn();
      listeners.clear();
    },
  };
}
