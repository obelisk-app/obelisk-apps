/**
 * The turn kit's ops on kind 2390, carried over from obelisk-dex
 * `src/lib/games/protocol.ts`.
 *
 * The host fixes kind, `h`, `e` and `t`, and interprets create / join /
 * leave / cancel / status itself (docs/app-format.md §2). Everything else is
 * ours: `start`, `move`, `timeout`, `resign`, and whatever real-time ops a
 * game declares. The content shapes are byte-for-byte those dex games
 * published, so tables started before the migration replay unchanged.
 *
 * One addition: `start` now carries the table's `opts` and `turnTimeoutS`,
 * which used to ride on `create`. A host-published `create` is generic and
 * knows nothing about a game's options; a legacy `create` still has them,
 * and the replay falls back to those.
 *
 * Never throws — a peer can put anything on the wire.
 */
import { KIND_APP_EVENT, type NostrEvent, type PublishRequest } from '../types.js';

/**
 * A seat at the table. `id` is the engine's identity for the player — NOT a
 * pubkey, because one person can hold several seats (hot-seat). `by` is the
 * pubkey allowed to publish that seat's moves. On an all-remote table
 * `id === by`.
 */
export interface SeatSpec {
  id: string;
  by: string;
  label?: string;
}

interface Base {
  id: string;
  pubkey: string;
  createdAt: number;
}

export type ParsedOp =
  | (Base & {
      op: 'create';
      nonce?: string;
      /** Only on pre-migration tables, whose create carried the game's settings. */
      legacy?: { game: string; opts: Record<string, unknown>; turnTimeoutS: number };
    })
  | (Base & { op: 'join' })
  | (Base & { op: 'leave' })
  | (Base & { op: 'cancel' })
  | (Base & { op: 'status'; text: string })
  | (Base & { op: 'start'; seats: SeatSpec[]; opts?: Record<string, unknown>; turnTimeoutS?: number })
  | (Base & { op: 'move'; n: number; action: unknown; seat?: string })
  | (Base & { op: 'timeout'; n: number })
  | (Base & { op: 'resign'; seat?: string })
  /** Any other op: a real-time game's, interpreted by its RealtimeMatch. */
  | (Base & { op: 'realtime'; name: string; seat: string; body: Record<string, unknown> });

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/**
 * Normalize a `start` seat list. Accepts both the object form and the older
 * bare-pubkey array — a table opened by a client that predates hot-seat is a
 * table where every seat is its own controller.
 */
export function parseSeats(raw: unknown): SeatSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: SeatSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let spec: SeatSpec | null = null;
    if (typeof entry === 'string' && entry.length > 0) {
      spec = { id: entry, by: entry };
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as { id?: unknown; by?: unknown; label?: unknown };
      if (typeof e.id === 'string' && e.id.length > 0 && typeof e.by === 'string' && e.by.length > 0) {
        spec = { id: e.id, by: e.by, ...(typeof e.label === 'string' && e.label.length > 0 ? { label: e.label } : {}) };
      }
    }
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    out.push(spec);
  }
  return out;
}

/** Seat id for the nth extra seat a pubkey holds. Seat 0 is the pubkey itself. */
export function localSeatId(pubkey: string, n: number): string {
  return n === 0 ? pubkey : `${pubkey}#${n}`;
}

function objectOpts(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function timeout(raw: unknown): number | undefined {
  return typeof raw === 'number' && raw >= 0 && Number.isFinite(raw) ? Math.floor(raw) : undefined;
}

function isIndex(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

export function parseOp(ev: NostrEvent): ParsedOp | null {
  if (ev.kind !== KIND_APP_EVENT) return null;
  const op = tag(ev.tags, 'op');
  if (!op) return null;

  let body: Record<string, unknown> = {};
  if (ev.content) {
    try {
      const parsed: unknown = JSON.parse(ev.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      body = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const base: Base = { id: ev.id, pubkey: ev.pubkey, createdAt: ev.created_at };

  if (op === 'create') {
    const game = typeof body.game === 'string' ? body.game : tag(ev.tags, 'game');
    return {
      ...base,
      op,
      ...(typeof body.nonce === 'string' ? { nonce: body.nonce } : {}),
      ...(game ? { legacy: { game, opts: objectOpts(body.opts) ?? {}, turnTimeoutS: timeout(body.turnTimeoutS) ?? 0 } } : {}),
    };
  }

  // Everything else references the session. The host only delivers this
  // session's events, but a stray one without the reference is still noise.
  if (!ev.tags.some((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0)) return null;

  switch (op) {
    case 'join':
    case 'leave':
    case 'cancel':
      return { ...base, op };
    case 'status':
      return typeof body.text === 'string' ? { ...base, op, text: body.text } : null;
    case 'start': {
      const seats = parseSeats(body.seats);
      if (seats.length === 0) return null;
      const opts = objectOpts(body.opts);
      const turnTimeoutS = timeout(body.turnTimeoutS);
      return {
        ...base, op, seats,
        ...(opts ? { opts } : {}),
        ...(turnTimeoutS !== undefined ? { turnTimeoutS } : {}),
      };
    }
    case 'move':
      if (!isIndex(body.n) || body.action === undefined) return null;
      return {
        ...base, op, n: body.n, action: body.action,
        ...(typeof body.seat === 'string' && body.seat.length > 0 ? { seat: body.seat } : {}),
      };
    case 'timeout':
      return isIndex(body.n) ? { ...base, op, n: body.n } : null;
    case 'resign':
      return { ...base, op, ...(typeof body.seat === 'string' && body.seat.length > 0 ? { seat: body.seat } : {}) };
    default:
      return {
        ...base,
        op: 'realtime',
        name: op,
        seat: typeof body.seat === 'string' && body.seat.length > 0 ? body.seat : ev.pubkey,
        body,
      };
  }
}

// ---- builders: what the kit asks the host to publish ----

export function buildStart(seats: SeatSpec[], opts: Record<string, unknown>, turnTimeoutS: number): PublishRequest {
  return { op: 'start', content: JSON.stringify({ seats, opts, turnTimeoutS }) };
}

export function buildMove(n: number, action: unknown, seat?: string): PublishRequest {
  return { op: 'move', content: JSON.stringify({ n, action, ...(seat ? { seat } : {}) }), n };
}

export function buildTimeout(n: number): PublishRequest {
  return { op: 'timeout', content: JSON.stringify({ n }), n };
}

export function buildResign(seat?: string): PublishRequest {
  return { op: 'resign', content: JSON.stringify(seat ? { seat } : {}) };
}

export function buildSimple(op: 'join' | 'leave' | 'cancel'): PublishRequest {
  return { op, content: '{}' };
}

export function buildStatus(text: string): PublishRequest {
  return { op: 'status', content: JSON.stringify({ text: text.slice(0, 140) }) };
}

export function buildRealtime(op: string, body: Record<string, unknown>): PublishRequest {
  return { op, content: JSON.stringify(body) };
}
