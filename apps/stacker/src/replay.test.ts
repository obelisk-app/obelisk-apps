/**
 * Stacker through the SDK's replay: the `realtime` hook on the definition is
 * what dex's session.ts used to special-case for ops attack / topout /
 * checkpoint. Events are built the way the host builds them (generic
 * `create`, settings on `start`), parsed by the SDK's `parseOp`, and folded
 * by `deriveSession`.
 */
import { describe, it, expect } from 'vitest';
import { deriveSession, parseOp, realtimeSeed, type ParsedOp } from '@obelisk/apps-sdk/turn';
import { KIND_APP_EVENT, type NostrEvent } from '@obelisk/apps-sdk';
import { parseMatchEvent, stacker as def, STACKER_OPS } from './definition';
import type { MatchState } from './match';

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';
const C = 'pk-c';
const TABLE = 'table-1';

let seq = 0;

function raw(pubkey: string, createdAt: number, op: string, body: Record<string, unknown>, opts: { id?: string; legacy?: boolean } = {}): NostrEvent {
  const tags = [['h', CH], ['t', opts.legacy ? 'obelisk-game' : 'obelisk-app'], ['op', op]];
  if (op !== 'create') tags.push(['e', TABLE, '', 'root']);
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

const op = (pk: string, at: number, name: string, body: Record<string, unknown> = {}, id?: string) =>
  parse(raw(pk, at, name, body, { id }));

/** Host + B at a started two-player table, seed 777, started at t=1002. */
function started(extra: ParsedOp[] = []): ParsedOp[] {
  return [
    parse(raw(HOST, 1000, 'create', { nonce: 'n' }, { id: TABLE })),
    op(B, 1001, 'join'),
    op(HOST, 1002, 'start', { seats: [HOST, B], opts: { seed: 777 }, turnTimeoutS: 0 }),
    ...extra,
  ];
}

function derive(log: ParsedOp[], now = 1100) {
  const s = deriveSession(def, log, now);
  if (!s) throw new Error('no session');
  return { ...s, match: s.match as MatchState };
}

describe('starting a Stacker table', () => {
  it('opens a match instead of a board, with nobody on move', () => {
    const s = derive(started());
    expect(s.status).toBe('in_progress');
    expect(s.state).toBeNull();
    expect(s.currentTurn).toBeNull();
    expect(s.turnDeadline).toBeNull();
    expect(s.startedAt).toBe(1002);
    expect(s.match.seats).toEqual([HOST, B]);
    expect(s.match.alive).toEqual([HOST, B]);
    expect(s.match.over).toBe(false);
  });

  it('seeds the match the way dex did: start opts, else the table id', () => {
    expect(derive(started()).match.seed).toBe(777);
    const unseeded = derive([
      parse(raw(HOST, 1000, 'create', { nonce: 'n' }, { id: TABLE })),
      op(B, 1001, 'join'),
      op(HOST, 1002, 'start', { seats: [HOST, B] }),
    ]);
    expect(unseeded.match.seed).toBe(realtimeSeed({ id: TABLE, opts: {} }));
  });

  it("reads a legacy table's seed off its create", () => {
    const s = derive([
      parse(raw(HOST, 1000, 'create', { game: 'stacker', opts: { seed: 4242 }, turnTimeoutS: 0 }, { id: TABLE, legacy: true })),
      op(B, 1001, 'join'),
      op(HOST, 1002, 'start', { seats: [HOST, B] }),
    ]);
    expect(s.match.seed).toBe(4242);
  });

  it('gives each account one board, however many seats the host lists for it', () => {
    const s = derive([
      parse(raw(HOST, 1000, 'create', { nonce: 'n' }, { id: TABLE })),
      op(B, 1001, 'join'),
      op(HOST, 1002, 'start', {
        seats: [
          { id: HOST, by: HOST },
          { id: `${HOST}#1`, by: HOST },
          { id: B, by: B },
          { id: `${B}#1`, by: B },
        ],
      }),
    ]);
    expect(s.participants).toEqual([HOST, B]);
    expect(s.match.seats).toEqual([HOST, B]);
  });
});

describe('ops routed through the realtime hook', () => {
  it('declares exactly the three ops dex special-cased', () => {
    expect([...STACKER_OPS]).toEqual(['attack', 'topout', 'checkpoint']);
    expect(def.realtime?.ops).toEqual(STACKER_OPS);
  });

  it('lands an attack, a checkpoint and nothing else', () => {
    const s = derive(started([
      op(HOST, 1010, 'attack', { seat: HOST, target: B, lines: 4, hole: 3, nonce: 1 }),
      op(B, 1011, 'checkpoint', { seat: B, frame: 600, attacksSent: 0, linesCleared: 2, stackHeight: 9, board: 'abc' }),
      // Not a Stacker op: ignored while in progress.
      op(B, 1012, 'dance', { seat: B }),
    ]));
    expect(s.match.attacks).toEqual([{ from: HOST, to: B, lines: 4, hole: 3, nonce: 1, at: 1010 }]);
    expect(s.match.progress[B]).toMatchObject({ frame: 600, linesCleared: 2, stackHeight: 9, board: 'abc' });
    expect(s.status).toBe('in_progress');
  });

  it("infers the seat from the signer when the body names none", () => {
    const s = derive(started([op(HOST, 1010, 'attack', { target: B, lines: 2 })]));
    expect(s.match.attacks).toEqual([{ from: HOST, to: B, lines: 2, hole: 0, nonce: 0, at: 1010 }]);
  });

  it("drops what dex's parser dropped", () => {
    const s = derive(started([
      op(HOST, 1010, 'attack', { seat: HOST, target: B, lines: 0 }),
      op(HOST, 1011, 'attack', { seat: HOST, lines: 4 }),
      op(HOST, 1012, 'checkpoint', { seat: HOST, attacksSent: 99 }),
    ]));
    expect(s.match.attacks).toEqual([]);
    expect(s.match.progress[HOST].attacksSent).toBe(0);
  });

  it('ignores realtime ops before start and after the match ends', () => {
    const early = derive([
      parse(raw(HOST, 1000, 'create', { nonce: 'n' }, { id: TABLE })),
      op(HOST, 1001, 'attack', { seat: HOST, target: B, lines: 4 }),
    ]);
    expect(early.status).toBe('waiting');
    expect(early.match).toBeNull();

    const late = derive(started([
      op(B, 1010, 'topout', { seat: B }),
      op(HOST, 1011, 'checkpoint', { seat: HOST, frame: 60, attacksSent: 1, linesCleared: 1, stackHeight: 1 }),
    ]));
    expect(late.status).toBe('finished');
    expect(late.match.progress[HOST].frame).toBe(0);
  });

  it('replays to the same match whatever order the events arrive in', () => {
    const log = started([
      op(HOST, 1010, 'attack', { seat: HOST, target: B, lines: 2, hole: 1, nonce: 1 }),
      op(B, 1010, 'attack', { seat: B, target: HOST, lines: 4, hole: 5, nonce: 2 }),
      op(B, 1011, 'checkpoint', { seat: B, frame: 120, attacksSent: 4, linesCleared: 4, stackHeight: 3 }),
    ]);
    const straight = derive(log);
    const shuffled = derive([...log].reverse());
    expect(shuffled.match).toEqual(straight.match);
  });
});

describe('attribution', () => {
  it('refuses an attack or topout signed for somebody else\'s seat', () => {
    const s = derive(started([
      op(B, 1010, 'attack', { seat: HOST, target: B, lines: 8 }),
      op(B, 1011, 'topout', { seat: HOST }),
      op(B, 1012, 'checkpoint', { seat: HOST, frame: 600, attacksSent: 0, linesCleared: 0, stackHeight: 20 }),
    ]));
    expect(s.match.attacks).toEqual([]);
    expect(s.match.alive).toEqual([HOST, B]);
    expect(s.match.progress[HOST].frame).toBe(0);
    expect(s.status).toBe('in_progress');
  });

  it('refuses ops from someone who is not at the table', () => {
    const s = derive(started([
      op(C, 1010, 'topout', { seat: C }),
      op(C, 1011, 'topout'),
      op(C, 1012, 'attack', { seat: C, target: B, lines: 4 }),
    ]));
    expect(s.match.alive).toEqual([HOST, B]);
    expect(s.match.attacks).toEqual([]);
  });

  it("drops an op whose body seat is the empty string, as dex did", () => {
    // dex took any string `seat` as the claim and then required it to match
    // the signer's seat; the SDK alone would attribute "" to the signer.
    const s = derive(started([op(B, 1010, 'topout', { seat: '' })]));
    expect(s.match.alive).toEqual([HOST, B]);
    expect(s.status).toBe('in_progress');
  });
});

describe('ending a match', () => {
  it('a topout leaves the last player standing as the winner', () => {
    const s = derive(started([op(B, 1030, 'topout', { seat: B })]));
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(HOST);
    expect(s.draw).toBe(false);
    expect(s.finishedAt).toBe(1030);
    expect(s.match.over).toBe(true);
    expect(s.match.alive).toEqual([HOST]);
  });

  it('a second topout from the same seat changes nothing', () => {
    const log = [
      parse(raw(HOST, 1000, 'create', { nonce: 'n' }, { id: TABLE })),
      op(B, 1001, 'join'),
      op(C, 1001, 'join'),
      op(HOST, 1002, 'start', { seats: [HOST, B, C] }),
      op(B, 1010, 'topout'),
      op(B, 1011, 'topout'),
    ];
    const s = derive(log);
    expect(s.status).toBe('in_progress');
    expect(s.match.alive).toEqual([HOST, C]);
  });

  it('a solo run ends with nobody winning, and is not a draw', () => {
    const s = derive([
      parse(raw(HOST, 1000, 'create', { nonce: 'n' }, { id: TABLE })),
      op(HOST, 1002, 'start', { seats: [HOST] }),
      op(HOST, 1090, 'topout'),
    ]);
    expect(s.status).toBe('finished');
    expect(s.winner).toBeNull();
    expect(s.draw).toBe(false);
    expect(s.match.alive).toEqual([]);
  });
});

describe('parseMatchEvent — dex parseGameEvent field rules', () => {
  const ev = (op: string, body: Record<string, unknown>, seat = HOST) => ({ id: 'x', pubkey: HOST, op, seat, at: 5, body });

  it('normalizes attack numbers', () => {
    expect(parseMatchEvent(ev('attack', { target: B, lines: 3.9, hole: -2.5, nonce: 1.5 }))).toEqual({
      op: 'attack', seat: HOST, target: B, lines: 3, hole: 3, nonce: 1.5, at: 5,
    });
    expect(parseMatchEvent(ev('attack', { target: B, lines: 0.5 }))).toBeNull();
    expect(parseMatchEvent(ev('attack', { target: '', lines: 2 }))).toBeNull();
    expect(parseMatchEvent(ev('attack', { target: B, lines: '2' }))).toBeNull();
  });

  it('floors checkpoint numbers and keeps inputs/board only when strings', () => {
    expect(parseMatchEvent(ev('checkpoint', {
      frame: 60.7, attacksSent: 2.2, linesCleared: 'x', stackHeight: 4.9, inputs: '5h', board: 7,
    }))).toEqual({
      op: 'checkpoint', seat: HOST, frame: 60, attacksSent: 2, linesCleared: 0, stackHeight: 4, inputs: '5h', at: 5,
    });
    expect(parseMatchEvent(ev('checkpoint', { frame: '60' }))).toBeNull();
  });

  it('takes a non-string body seat as unnamed, and rejects a mismatched string one', () => {
    expect(parseMatchEvent(ev('topout', { seat: 42 }))).toEqual({ op: 'topout', seat: HOST, at: 5 });
    expect(parseMatchEvent(ev('topout', { seat: B }))).toBeNull();
    expect(parseMatchEvent(ev('topout', { seat: HOST }))).toEqual({ op: 'topout', seat: HOST, at: 5 });
    expect(parseMatchEvent(ev('dance', {}))).toBeNull();
  });
});
