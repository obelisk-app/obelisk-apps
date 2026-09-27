/**
 * Deterministic replay: an event log in, a board out. Carried over from
 * obelisk-dex `src/lib/games/session.ts`.
 *
 * Every client runs this over the same relay-delivered kind 2390 events,
 * through the same pinned bundle, and must land on the same `GameSession`.
 * That agreement is the entire trust model.
 *
 * The ordering rules that make replay stable:
 *
 *   1. Events sort by `(created_at, id)`. `id` is a hash, so the tiebreak is
 *      total and identical everywhere.
 *   2. A `move` is only applied when it comes from the player to move AND
 *      carries the current turn index `n`. A duplicate, a replay, or a move
 *      published against a stale view fails one of those tests and is dropped.
 *   3. Everything the engine rejects (`validateAction`) is dropped, silently.
 *
 * What replay cannot fix: a player who simply stops publishing. That is what
 * the turn clock is for — after `turnTimeoutS`, ANY participant may publish a
 * `timeout` for that turn, and because the deadline is derived from the log
 * (not from the claimant's clock), everyone accepts or rejects it identically.
 *
 * Differences from the dex version:
 *   - the definition is passed in (one app = one game) instead of looked up
 *     in a registry by the create's `game`;
 *   - `opts` / `turnTimeoutS` come from `start`, falling back to a legacy
 *     create's;
 *   - `leave` (a host op) takes a waiting player back off the table;
 *   - real-time games go through `def.realtime` instead of Stacker's match
 *     module being imported here.
 */
import type { ParsedOp, SeatSpec } from './protocol.js';
import type { ApplyResult, GameDefinition } from './types.js';

/** How long a `waiting` table stays joinable before clients call it stale. */
export const WAITING_EXPIRY_MINUTES = 60;

export type GameStatus = 'waiting' | 'in_progress' | 'finished' | 'cancelled';

export interface GameSession {
  id: string;
  status: GameStatus;
  createdBy: string;
  createdAt: number;
  opts: Record<string, unknown>;
  turnTimeoutS: number;
  minPlayers: number;
  maxPlayers: number;
  /** Seat ids in seat order — what the engine sees as "the players". Not necessarily pubkeys. */
  participants: string[];
  /** Seat id → who may publish its moves, plus the display label. */
  seats: SeatSpec[];
  /** Everyone who asked for a seat while the table was `waiting`. */
  joined: string[];
  /** Board state, or `null` before `start`. */
  state: unknown;
  currentTurn: string | null;
  /** Index of the turn `currentTurn` is being asked to play. */
  turnIndex: number;
  /** Unix seconds the current turn began; `null` when not in progress. */
  turnStartedAt: number | null;
  /** When a real-time match began, so clients can align their frame counters. */
  startedAt?: number;
  /** Unix seconds the current turn expires; `null` when the table has no clock. */
  turnDeadline: number | null;
  winner: string | null;
  draw: boolean;
  eliminated: string[];
  finishedAt: number | null;
  /** Real-time games only. Turn-based tables leave this null. */
  match: unknown;
}

function sortLog(events: readonly ParsedOp[]): ParsedOp[] {
  return [...events].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Rebuild one table from its events.
 *
 * @param now - unix seconds, injected so the "stale waiting table" read is
 *   testable and never differs between a render and a re-render mid-second.
 * @returns the session, or `null` when the log has no `create`.
 */
export function deriveSession(
  def: GameDefinition,
  events: readonly ParsedOp[],
  now: number = Math.floor(Date.now() / 1000),
): GameSession | null {
  const session = replayLog(def, events);
  return session ? applyWaitingExpiry(session, now) : null;
}

/**
 * The replay proper: log in, board out, and **no wall clock anywhere** —
 * callers may cache the result keyed by the log's identity, which is only
 * sound while the output depends on nothing but the log.
 */
export function replayLog(def: GameDefinition, events: readonly ParsedOp[]): GameSession | null {
  const log = sortLog(events);
  const create = log.find((e) => e.op === 'create');
  if (!create || create.op !== 'create') return null;

  const session: GameSession = {
    id: create.id,
    status: 'waiting',
    createdBy: create.pubkey,
    createdAt: create.createdAt,
    opts: create.legacy?.opts ?? {},
    turnTimeoutS: create.legacy?.turnTimeoutS ?? 0,
    minPlayers: def.minPlayers,
    maxPlayers: def.maxPlayers,
    participants: [],
    seats: [],
    // The host holds seat 0 without having to publish a separate join.
    joined: [create.pubkey],
    state: null,
    currentTurn: null,
    turnIndex: 0,
    turnStartedAt: null,
    turnDeadline: null,
    winner: null,
    draw: false,
    eliminated: [],
    finishedAt: null,
    match: null,
  };

  // Entropy chain for engines that need a die roll. Seeded by the table id
  // and advanced by every accepted event, so the value for turn N is fixed by
  // events published BEFORE that turn — the player about to roll can't grind it.
  let lastAcceptedId = create.id;

  const setTurn = (seat: string | null, at: number) => {
    session.currentTurn = seat;
    session.turnStartedAt = seat ? at : null;
    session.turnDeadline = seat && session.turnTimeoutS > 0 ? at + session.turnTimeoutS : null;
  };

  const finish = (winner: string | null, draw: boolean, at: number) => {
    session.status = 'finished';
    session.winner = winner;
    session.draw = draw;
    session.finishedAt = at;
    setTurn(null, at);
  };

  const applyResult = (result: ApplyResult<unknown>, at: number) => {
    session.state = result.state;
    for (const pk of result.eliminated ?? []) {
      if (!session.eliminated.includes(pk)) session.eliminated.push(pk);
    }
    if (result.nextTurn === null) {
      finish(result.winner ?? null, result.draw ?? false, at);
    } else {
      session.turnIndex += 1;
      setTurn(result.nextTurn, at);
    }
  };

  for (const ev of log) {
    if (session.status === 'finished' || session.status === 'cancelled') break;

    switch (ev.op) {
      case 'create':
      case 'status':
        break;

      case 'join': {
        if (session.status !== 'waiting') break;
        if (session.joined.includes(ev.pubkey)) break;
        if (session.joined.length >= session.maxPlayers) break;
        session.joined.push(ev.pubkey);
        break;
      }

      case 'leave': {
        // Only before the table starts, and never the host (who holds seat 0).
        if (session.status !== 'waiting' || ev.pubkey === session.createdBy) break;
        session.joined = session.joined.filter((pk) => pk !== ev.pubkey);
        break;
      }

      case 'cancel': {
        // Only the host can call off a table, and only before it starts.
        if (ev.pubkey !== session.createdBy || session.status !== 'waiting') break;
        session.status = 'cancelled';
        session.finishedAt = ev.createdAt;
        break;
      }

      case 'start': {
        if (session.status !== 'waiting') break;
        if (ev.pubkey !== session.createdBy) break;
        // The host's seat list is authoritative for ORDER, but every seat has
        // to be controlled by someone who actually asked to play — otherwise a
        // host could drag a bystander into a match (and into its timeouts).
        // Extra seats controlled by a player who DID join are hot-seat.
        let seats = ev.seats.filter((seat) => session.joined.includes(seat.by));
        if (def.realtime) {
          // One board per account: two seats on one keyboard in a real-time
          // game is a board nobody is playing, which keeps the match alive forever.
          const seen = new Set<string>();
          seats = seats.filter((seat) => {
            if (seen.has(seat.by)) return false;
            seen.add(seat.by);
            return true;
          });
        }
        if (seats.length < session.minPlayers || seats.length > session.maxPlayers) break;
        if (ev.opts) session.opts = ev.opts;
        if (ev.turnTimeoutS !== undefined) session.turnTimeoutS = ev.turnTimeoutS;
        session.seats = seats;
        session.participants = seats.map((seat) => seat.id);
        session.status = 'in_progress';
        session.turnIndex = 0;
        if (def.realtime) {
          // Nobody is "to move" in a real-time match: every board runs at once.
          session.match = def.realtime.initial(realtimeSeed(session), session.participants);
          session.state = null;
          setTurn(null, ev.createdAt);
          session.startedAt = ev.createdAt;
        } else {
          session.state = def.initialState(session.participants, session.opts);
          setTurn(def.firstTurn(session.participants), ev.createdAt);
        }
        break;
      }

      case 'move': {
        if (session.status !== 'in_progress' || !session.currentTurn) break;
        if (ev.n !== session.turnIndex) break;
        // Authorized by CONTROLLER, attributed to the SEAT: on a hot-seat
        // table one pubkey moves for several seats, so the move names one.
        const seat = resolveSeat(session, ev.pubkey, ev.seat);
        if (!seat) break;
        const onMove = seat === session.currentTurn;
        if (!onMove && !def.canAct?.(session.state, seat, ev.action, session.participants)) break;
        const check = def.validateAction(session.state, ev.action, seat, session.participants);
        if (!check.ok) break;
        applyResult(
          def.applyAction(session.state, ev.action, seat, session.participants, {
            entropy: `${lastAcceptedId}:${session.turnIndex}`,
          }),
          ev.createdAt,
        );
        lastAcceptedId = ev.id;
        break;
      }

      case 'timeout': {
        if (session.status !== 'in_progress' || !session.currentTurn) break;
        if (ev.n !== session.turnIndex) break;
        // No clock on this table means no timeouts, ever.
        if (session.turnDeadline === null) break;
        // The claim has to have been published after the deadline it claims.
        if (ev.createdAt < session.turnDeadline) break;
        // Anyone may call the clock — restricting it to participants would
        // stall a two-player game whose other player has the tab shut.
        applyResult(def.onTimeout(session.state, session.currentTurn, session.participants), ev.createdAt);
        lastAcceptedId = ev.id;
        break;
      }

      case 'realtime': {
        if (!def.realtime || !def.realtime.ops.includes(ev.name)) break;
        if (session.match === null || session.status !== 'in_progress') break;
        // Same attribution rule as a move: an event only speaks for a seat
        // whose controller signed it.
        const seat = resolveSeat(session, ev.pubkey, ev.seat);
        if (!seat || seat !== ev.seat) break;
        session.match = def.realtime.apply(session.match, {
          id: ev.id, pubkey: ev.pubkey, op: ev.name, seat, at: ev.createdAt, body: ev.body,
        });
        if (def.realtime.over(session.match)) {
          // No winner is only a draw when there was somebody to draw WITH; a
          // solo run ends with nobody winning because nobody else was playing.
          const winner = def.realtime.winner(session.match);
          finish(winner, winner === null && session.participants.length > 1, ev.createdAt);
        }
        break;
      }

      case 'resign': {
        if (session.status !== 'in_progress') break;
        // A controller may hold several seats, so a resign names one; without
        // a name it means "the seat I hold".
        const held = session.seats.filter((s2) => s2.by === ev.pubkey).map((s2) => s2.id);
        const target = ev.seat && held.includes(ev.seat) ? ev.seat : held.length === 1 ? held[0] : null;
        if (!target) break;
        if (session.eliminated.includes(target)) break;
        const wasOnMove = target === session.currentTurn;
        const before = session.currentTurn;
        applyResult(def.onTimeout(session.state, target, session.participants), ev.createdAt);
        // Resigning out of turn must not steal the turn from whoever is on
        // move: `onTimeout` hands back the seat after the resigner.
        if (!wasOnMove && session.status === 'in_progress' && before && !session.eliminated.includes(before)) {
          session.turnIndex -= 1;
          setTurn(before, session.turnStartedAt ?? ev.createdAt);
        }
        lastAcceptedId = ev.id;
        break;
      }
    }
  }

  return session;
}

/**
 * The one thing the wall clock decides: a table nobody ever started stops
 * being interesting after an hour. Returns `session` itself when nothing has
 * expired and a clone when it has — never mutates a possibly-cached replay.
 */
export function applyWaitingExpiry(session: GameSession, now: number): GameSession {
  if (session.status !== 'waiting') return session;
  if (now - session.createdAt <= WAITING_EXPIRY_MINUTES * 60) return session;
  return { ...session, status: 'cancelled' };
}

/**
 * Which seat is this pubkey playing? Named explicitly when they hold several,
 * inferred when there is only one, and otherwise the seat on move if they hold
 * it. Null when the pubkey holds no seat.
 */
function resolveSeat(session: GameSession, pubkey: string, named?: string): string | null {
  const held = session.seats.filter((s) => s.by === pubkey).map((s) => s.id);
  if (held.length === 0) return null;
  if (named) return held.includes(named) ? named : null;
  if (held.length === 1) return held[0];
  return session.currentTurn && held.includes(session.currentTurn) ? session.currentTurn : null;
}

/**
 * Seed for a real-time match: the host's choice in `opts.seed`, otherwise the
 * table id — a hash, unpredictable before the table exists and identical for
 * everyone after.
 */
export function realtimeSeed(session: Pick<GameSession, 'id' | 'opts'>): number {
  const raw = (session.opts as { seed?: unknown }).seed;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(Math.abs(raw)) % 1_000_000;
  let h = 0;
  for (let i = 0; i < session.id.length; i++) h = (Math.imul(h, 31) + session.id.charCodeAt(i)) >>> 0;
  return h % 1_000_000;
}

/** Who may publish moves for a seat. Falls back to the seat id itself. */
export function controllerOf(session: GameSession, seatId: string): string {
  return session.seats.find((s) => s.id === seatId)?.by ?? seatId;
}

/** Every seat a pubkey is allowed to move for. */
export function seatsControlledBy(session: GameSession, pubkey: string | null): string[] {
  if (!pubkey) return [];
  return session.seats.filter((s) => s.by === pubkey).map((s) => s.id);
}

/** True when it is this account's move — on any of the seats it holds. */
export function isMyTurn(session: GameSession, pubkey: string | null): boolean {
  if (!pubkey || session.status !== 'in_progress' || !session.currentTurn) return false;
  return controllerOf(session, session.currentTurn) === pubkey;
}

/** True when the clock has run out on the current turn and anyone may claim it. */
export function isTurnExpired(session: GameSession, now: number = Math.floor(Date.now() / 1000)): boolean {
  return session.status === 'in_progress' && session.turnDeadline !== null && now >= session.turnDeadline;
}

/** Seconds left on the clock, or `null` when the table has no clock. */
export function turnSecondsLeft(session: GameSession, now: number = Math.floor(Date.now() / 1000)): number | null {
  if (session.status !== 'in_progress' || session.turnDeadline === null) return null;
  return Math.max(0, session.turnDeadline - now);
}

export function canJoin(session: GameSession, pubkey: string | null): boolean {
  return !!pubkey
    && session.status === 'waiting'
    && !session.joined.includes(pubkey)
    && session.joined.length < session.maxPlayers;
}

/**
 * Can the host open the seat assignment? Deliberately NOT "have enough people
 * joined": a table played entirely on one machine has one joined account
 * holding every seat. The seat count is checked where seats are chosen, and
 * again when `start` replays.
 */
export function canStart(session: GameSession, pubkey: string | null): boolean {
  return !!pubkey && session.status === 'waiting' && pubkey === session.createdBy;
}

/** Is every seat at this table signed by the same account? */
export function isSoloTable(session: GameSession): boolean {
  if (session.seats.length === 0) return false;
  const first = session.seats[0].by;
  return session.seats.every((s) => s.by === first);
}
