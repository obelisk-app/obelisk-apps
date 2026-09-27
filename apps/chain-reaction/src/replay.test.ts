/**
 * The turn kit's replay, exercised with the real Chain Reaction engine.
 * Ported case-for-case from obelisk-dex `src/lib/games/session.test.ts`, with
 * events built the way the host now builds them (generic `create`, settings
 * on `start`). The `legacy tables` block covers pre-migration tables, whose
 * `create` carried the game's settings.
 */
import { describe, it, expect } from 'vitest';
import {
  applyWaitingExpiry, buildMove, canJoin, canStart, deriveSession, isSoloTable, isTurnExpired,
  parseOp, replayLog, turnSecondsLeft, type ParsedOp,
} from '@obelisk/apps-sdk/turn';
import { KIND_APP_EVENT, type NostrEvent } from '@obelisk/apps-sdk';
import { chainReaction as def, CR_SIZES } from './engine';

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';
const C = 'pk-c';

let seq = 0;

function raw(pubkey: string, createdAt: number, op: string, body: Record<string, unknown>, opts: { id?: string; session?: string; legacy?: boolean } = {}): NostrEvent {
  const tags = [['h', CH], ['t', opts.legacy ? 'obelisk-game' : 'obelisk-app'], ['op', op]];
  if (op !== 'create') tags.push(['e', opts.session ?? 'game-1', '', 'root']);
  if (typeof body.n === 'number') tags.push(['n', String(body.n)]);
  if (op === 'create' && typeof body.game === 'string') tags.push(['game', body.game]);
  return {
    id: opts.id ?? `id-${String(seq++).padStart(4, '0')}`,
    pubkey, created_at: createdAt, kind: KIND_APP_EVENT, tags, content: JSON.stringify(body), sig: '',
  };
}

function parse(e: NostrEvent): ParsedOp {
  const p = parseOp(e);
  if (!p) throw new Error(`unparseable event: ${e.content}`);
  return p;
}

const create = (id: string, at = 1000) => parse(raw(HOST, at, 'create', { nonce: 'n' }, { id }));
const op = (pk: string, at: number, name: string, body: Record<string, unknown> = {}, session = 'game-1', id?: string) =>
  parse(raw(pk, at, name, body, { session, id }));

/** A table with host+B seated and started at t=1002, small board, `timeoutS` clock. */
function startedTable(timeoutS = 45) {
  const log = [
    create('game-1'),
    op(B, 1001, 'join'),
    op(HOST, 1002, 'start', { seats: [HOST, B], opts: { size: 'small' }, turnTimeoutS: timeoutS }),
  ];
  return { gameId: 'game-1', log };
}

describe('deriveSession', () => {
  it('returns null without a create event', () => {
    expect(deriveSession(def, [op(B, 10, 'join', {}, 'game-x')], 20)).toBeNull();
  });

  it('seats the host at creation without a join event', () => {
    const s = deriveSession(def, [create('g0', 100)], 120)!;
    expect(s.status).toBe('waiting');
    expect(s.joined).toEqual([HOST]);
    expect(s.createdBy).toBe(HOST);
  });

  it('is order-independent: shuffled logs derive the same board', () => {
    const { log } = startedTable();
    const straight = deriveSession(def, log, 1100)!;
    const shuffled = deriveSession(def, [...log].reverse(), 1100)!;
    expect(shuffled.state).toEqual(straight.state);
    expect(shuffled.currentTurn).toBe(straight.currentTurn);
    expect(shuffled.status).toBe('in_progress');
  });

  it('honours the start opts (board size)', () => {
    const s = deriveSession(def, startedTable().log, 1100)!;
    const state = s.state as { rows: number; cols: number };
    expect(state.rows).toBe(CR_SIZES.small.rows);
    expect(state.cols).toBe(CR_SIZES.small.cols);
  });

  it('ignores joins after start and joins beyond maxPlayers', () => {
    const { log } = startedTable();
    const s = deriveSession(def, [...log, op(C, 1500, 'join')], 1600)!;
    expect(s.participants).toEqual([HOST, B]);
    expect(s.joined).toEqual([HOST, B]);
  });

  it('lets a waiting player leave, but not the host, and not after start', () => {
    const base = [create('gl'), op(B, 1001, 'join', {}, 'gl'), op(C, 1001, 'join', {}, 'gl')];
    const left = deriveSession(def, [...base, op(B, 1002, 'leave', {}, 'gl'), op(HOST, 1002, 'leave', {}, 'gl')], 1010)!;
    expect(left.joined).toEqual([HOST, C]);
    const { log } = startedTable();
    expect(deriveSession(def, [...log, op(B, 1010, 'leave')], 1020)!.participants).toEqual([HOST, B]);
  });

  it('only the host can start, and only with players who joined', () => {
    const base = [create('g2'), op(B, 1001, 'join', {}, 'g2')];
    const byImpostor = deriveSession(def, [...base, op(B, 1002, 'start', { seats: [HOST, B] }, 'g2')], 1100)!;
    expect(byImpostor.status).toBe('waiting');
    // C never joined — the host cannot drag them to the table.
    const withGhost = deriveSession(def, [...base, op(HOST, 1002, 'start', { seats: [HOST, B, C] }, 'g2')], 1100)!;
    expect(withGhost.participants).toEqual([HOST, B]);
  });

  it('applies a legal move and advances the turn', () => {
    const { log } = startedTable();
    const s = deriveSession(def, [...log, op(HOST, 1010, 'move', { n: 0, action: { cell: 0 } })], 1020)!;
    expect(s.turnIndex).toBe(1);
    expect(s.currentTurn).toBe(B);
    const state = s.state as { cells: Array<{ count: number; owner: number | null }> };
    expect(state.cells[0]).toEqual({ count: 1, owner: 0 });
  });

  it('drops a move from the wrong player', () => {
    const { log } = startedTable();
    const s = deriveSession(def, [...log, op(B, 1010, 'move', { n: 0, action: { cell: 0 } })], 1020)!;
    expect(s.currentTurn).toBe(HOST);
    expect(s.turnIndex).toBe(0);
  });

  it('drops a move carrying the wrong turn index (replay / stale view)', () => {
    const { log } = startedTable();
    const s = deriveSession(def, [...log, op(HOST, 1010, 'move', { n: 3, action: { cell: 0 } })], 1020)!;
    expect(s.turnIndex).toBe(0);
  });

  it('drops an illegal move (cell owned by an opponent)', () => {
    const { log } = startedTable();
    const s = deriveSession(def, [
      ...log,
      op(HOST, 1010, 'move', { n: 0, action: { cell: 0 } }),
      op(B, 1011, 'move', { n: 1, action: { cell: 0 } }),
    ], 1020)!;
    expect(s.currentTurn).toBe(B);
    expect(s.turnIndex).toBe(1);
  });

  it('resolves two moves for the same turn by (created_at, id) — first one wins', () => {
    const { log } = startedTable();
    const late = op(HOST, 1011, 'move', { n: 0, action: { cell: 5 } }, 'game-1', 'id-aaa');
    const early = op(HOST, 1010, 'move', { n: 0, action: { cell: 0 } }, 'game-1', 'id-zzz');
    const state = deriveSession(def, [...log, late, early], 1020)!.state as { cells: Array<{ count: number }> };
    expect(state.cells[0].count).toBe(1);
    expect(state.cells[5].count).toBe(0);
  });

  it('breaks a same-second tie by event id, identically for every client', () => {
    const { log } = startedTable();
    const a = op(HOST, 1010, 'move', { n: 0, action: { cell: 0 } }, 'game-1', 'id-aaa');
    const z = op(HOST, 1010, 'move', { n: 0, action: { cell: 5 } }, 'game-1', 'id-zzz');
    const one = deriveSession(def, [...log, a, z], 1020)!;
    const other = deriveSession(def, [...log, z, a], 1020)!;
    expect(one.state).toEqual(other.state);
    expect((one.state as { cells: Array<{ count: number }> }).cells[0].count).toBe(1);
  });

  describe('turn clock', () => {
    it('accepts a timeout claim published after the deadline', () => {
      const { log } = startedTable(45);
      const s = deriveSession(def, [...log, op(B, 1002 + 45, 'timeout', { n: 0 })], 1100)!;
      expect(s.status).toBe('finished');
      expect(s.winner).toBe(B);
    });

    it('rejects a timeout claim published before the deadline', () => {
      const { log } = startedTable(45);
      const s = deriveSession(def, [...log, op(B, 1010, 'timeout', { n: 0 })], 1100)!;
      expect(s.status).toBe('in_progress');
      expect(s.currentTurn).toBe(HOST);
    });

    it('rejects any timeout on a table with no clock', () => {
      const { log } = startedTable(0);
      const s = deriveSession(def, [...log, op(B, 99999, 'timeout', { n: 0 })], 100000)!;
      expect(s.status).toBe('in_progress');
      expect(s.turnDeadline).toBeNull();
    });

    it('a move beats a timeout claim for the same turn when it came first', () => {
      const { log } = startedTable(45);
      const move = op(HOST, 1020, 'move', { n: 0, action: { cell: 0 } });
      const claim = op(B, 1047, 'timeout', { n: 0 });
      const s = deriveSession(def, [...log, claim, move], 1100)!;
      expect(s.status).toBe('in_progress');
      expect(s.currentTurn).toBe(B);
      expect(s.turnIndex).toBe(1);
    });

    it('exposes deadline helpers', () => {
      const s = deriveSession(def, startedTable(45).log, 1010)!;
      expect(s.turnDeadline).toBe(1002 + 45);
      expect(turnSecondsLeft(s, 1010)).toBe(37);
      expect(isTurnExpired(s, 1010)).toBe(false);
      expect(isTurnExpired(s, 1047)).toBe(true);
      expect(turnSecondsLeft(s, 1099)).toBe(0);
    });
  });

  describe('resign', () => {
    it('ends a two-player game and crowns the other player', () => {
      const s = deriveSession(def, [...startedTable().log, op(HOST, 1010, 'resign')], 1020)!;
      expect(s.status).toBe('finished');
      expect(s.winner).toBe(B);
    });

    it('out-of-turn resign does not steal the turn from the player on move', () => {
      const log = [
        create('g3'),
        op(B, 1001, 'join', {}, 'g3'),
        op(C, 1001, 'join', {}, 'g3'),
        op(HOST, 1002, 'start', { seats: [HOST, B, C], turnTimeoutS: 45 }, 'g3'),
      ];
      const s = deriveSession(def, [...log, op(C, 1005, 'resign', {}, 'g3')], 1010)!;
      expect(s.status).toBe('in_progress');
      expect(s.currentTurn).toBe(HOST);
      expect(s.eliminated).toContain(C);
    });

    it('ignores a resign from someone who is not at the table', () => {
      const s = deriveSession(def, [...startedTable().log, op(C, 1010, 'resign')], 1020)!;
      expect(s.status).toBe('in_progress');
      expect(s.eliminated).toEqual([]);
    });
  });

  describe('cancel and expiry', () => {
    it('lets the host cancel a waiting table', () => {
      expect(deriveSession(def, [create('g4'), op(HOST, 1005, 'cancel', {}, 'g4')], 1010)!.status).toBe('cancelled');
    });

    it('ignores a cancel from anyone else', () => {
      expect(deriveSession(def, [create('g5'), op(B, 1005, 'cancel', {}, 'g5')], 1010)!.status).toBe('waiting');
    });

    it('treats a waiting table older than an hour as stale, with no event', () => {
      expect(deriveSession(def, [create('g6')], 1000 + 3599)!.status).toBe('waiting');
      expect(deriveSession(def, [create('g6')], 1000 + 3601)!.status).toBe('cancelled');
    });

    it('does not expire a table that already started', () => {
      expect(deriveSession(def, startedTable().log, 1000 + 99999)!.status).toBe('in_progress');
    });

    it('keeps the clock out of replayLog', () => {
      const log = [create('g6b')];
      expect(replayLog(def, log)!.status).toBe('waiting');
      expect(deriveSession(def, log, 1000 + 3601)!.status).toBe('cancelled');
    });

    it('never mutates the session it is handed the expiry for', () => {
      const base = replayLog(def, [create('g6c')])!;
      expect(applyWaitingExpiry(base, 1000 + 3599)).toBe(base);
      const expired = applyWaitingExpiry(base, 1000 + 3601);
      expect(expired).not.toBe(base);
      expect(expired.status).toBe('cancelled');
      expect(base.status).toBe('waiting');
    });
  });

  it('ignores events published after the game finished', () => {
    const finished = [...startedTable().log, op(HOST, 1010, 'resign')];
    const s = deriveSession(def, [...finished, op(B, 1020, 'move', { n: 1, action: { cell: 0 } })], 1030)!;
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(B);
  });

  it('ignores host-only ops it has no rule for (status)', () => {
    const s = deriveSession(def, [...startedTable().log, op(HOST, 1005, 'status', { text: 'hi' })], 1010)!;
    expect(s.status).toBe('in_progress');
  });
});

describe('legacy tables (pre-migration create carried the settings)', () => {
  const legacyCreate = (id: string, opts: Record<string, unknown>, turnTimeoutS: number) =>
    parse(raw(HOST, 1000, 'create', { game: 'chain-reaction', opts, turnTimeoutS }, { id, legacy: true }));

  it('uses the create\'s opts and clock when start carries none', () => {
    const s = deriveSession(def, [
      legacyCreate('L1', { size: 'small' }, 30),
      op(B, 1001, 'join', {}, 'L1'),
      op(HOST, 1002, 'start', { seats: [HOST, B] }, 'L1'),
    ], 1010)!;
    expect(s.opts).toEqual({ size: 'small' });
    expect(s.turnDeadline).toBe(1002 + 30);
    expect((s.state as { rows: number }).rows).toBe(CR_SIZES.small.rows);
  });

  it('lets a start override the legacy settings', () => {
    const s = deriveSession(def, [
      legacyCreate('L2', { size: 'small' }, 30),
      op(B, 1001, 'join', {}, 'L2'),
      op(HOST, 1002, 'start', { seats: [HOST, B], opts: { size: 'large' }, turnTimeoutS: 0 }, 'L2'),
    ], 1010)!;
    expect(s.opts).toEqual({ size: 'large' });
    expect(s.turnDeadline).toBeNull();
  });
});

describe('seat helpers', () => {
  it('canJoin only while waiting, once, and under maxPlayers', () => {
    const waiting = deriveSession(def, [create('g7')], 1010)!;
    expect(canJoin(waiting, B)).toBe(true);
    expect(canJoin(waiting, HOST)).toBe(false);
    expect(canJoin(waiting, null)).toBe(false);
    expect(canJoin(deriveSession(def, startedTable().log, 1010)!, C)).toBe(false);
  });

  it("canStart is the host's call, head-count or not", () => {
    expect(canStart(deriveSession(def, [create('g8')], 1010)!, HOST)).toBe(true);
    const two = deriveSession(def, [create('g8'), op(B, 1001, 'join', {}, 'g8')], 1010)!;
    expect(canStart(two, HOST)).toBe(true);
    expect(canStart(two, B)).toBe(false);
  });

  it('but the reducer still refuses a start with too few seats', () => {
    const s = deriveSession(def, [create('g9'), op(HOST, 1002, 'start', { seats: [{ id: HOST, by: HOST }] }, 'g9')], 1010)!;
    expect(s.status).toBe('waiting');
  });

  it('starts a table where the host holds every seat', () => {
    const s = deriveSession(def, [
      create('g10'),
      op(HOST, 1002, 'start', {
        seats: [
          { id: HOST, by: HOST, label: 'Ana' },
          { id: `${HOST}#1`, by: HOST, label: 'Beto' },
          { id: `${HOST}#2`, by: HOST, label: 'Caro' },
        ],
      }, 'g10'),
    ], 1010)!;
    expect(s.status).toBe('in_progress');
    expect(s.participants).toEqual([HOST, `${HOST}#1`, `${HOST}#2`]);
    expect(isSoloTable(s)).toBe(true);
  });
});

describe('parseOp', () => {
  it('rejects the wrong kind and unparseable content', () => {
    const good = raw(HOST, 1, 'create', { nonce: 'x' });
    expect(parseOp({ ...good, kind: 1 })).toBeNull();
    expect(parseOp({ ...good, content: '{oops' })).toBeNull();
    expect(parseOp({ ...good, content: '[]' })).toBeNull();
  });

  it('rejects ops that reference no table', () => {
    const e = raw(B, 1, 'join', {});
    expect(parseOp({ ...e, tags: e.tags.filter((t) => t[0] !== 'e') })).toBeNull();
  });

  it('rejects malformed moves, timeouts and starts', () => {
    expect(parseOp(raw(B, 1, 'move', { action: { cell: 1 } }))).toBeNull();
    expect(parseOp(raw(B, 1, 'move', { n: -1, action: { cell: 1 } }))).toBeNull();
    expect(parseOp(raw(B, 1, 'move', { n: 0 }))).toBeNull();
    expect(parseOp(raw(B, 1, 'timeout', { n: 'soon' }))).toBeNull();
    expect(parseOp(raw(HOST, 1, 'start', { seats: [] }))).toBeNull();
  });

  it('reads a legacy create\'s settings and puts n on a move publish', () => {
    const created = parseOp(raw(HOST, 5, 'create', { game: 'chain-reaction', opts: { size: 'large' }, turnTimeoutS: 30 }, { legacy: true }));
    expect(created).toMatchObject({ op: 'create', legacy: { game: 'chain-reaction', turnTimeoutS: 30, opts: { size: 'large' } } });
    expect(buildMove(4, { cell: 2 })).toMatchObject({ op: 'move', n: 4 });
  });
});
