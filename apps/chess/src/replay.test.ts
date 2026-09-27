/** Chess through the SDK's deterministic replay, as every client runs it. */
import { describe, expect, it } from 'vitest';
import { KIND_APP_EVENT, type NostrEvent } from '@obelisk/apps-sdk';
import { deriveSession, parseOp, type ParsedOp } from '@obelisk/apps-sdk/turn';

import { chess, type ChessState } from './engine';

const W = 'pk-white';
const B = 'pk-black';
let seq = 0;

function op(pubkey: string, at: number, name: string, body: Record<string, unknown>, id?: string): ParsedOp {
  const tags = [['h', 'ch'], ['t', 'obelisk-app'], ['op', name]];
  if (name !== 'create') tags.push(['e', 'g', '', 'root']);
  const ev: NostrEvent = { id: id ?? `id-${String(seq++).padStart(4, '0')}`, pubkey, created_at: at, kind: KIND_APP_EVENT, tags, content: JSON.stringify(body), sig: '' };
  return parseOp(ev)!;
}

const table = (timeoutS = 0) => [
  op(W, 1000, 'create', { nonce: 'n' }, 'g'),
  op(B, 1001, 'join', {}),
  op(W, 1002, 'start', { seats: [W, B], opts: {}, turnTimeoutS: timeoutS }),
];

const move = (pk: string, at: number, n: number, from: string, to: string) => op(pk, at, 'move', { n, action: { from, to } });

describe('chess over the SDK replay', () => {
  it('plays fool\'s mate to a finished table with Black winning', () => {
    const s = deriveSession(chess, [
      ...table(),
      move(W, 1010, 0, 'f2', 'f3'), move(B, 1011, 1, 'e7', 'e5'),
      move(W, 1012, 2, 'g2', 'g4'), move(B, 1013, 3, 'd8', 'h4'),
    ], 1100)!;
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(B);
    expect((s.state as ChessState).end).toBe('checkmate');
  });

  it('drops an illegal move and a move by the wrong side, identically for every client', () => {
    const log = [...table(), move(W, 1010, 0, 'e2', 'e5'), move(B, 1011, 0, 'e7', 'e5'), move(W, 1012, 0, 'e2', 'e4')];
    const a = deriveSession(chess, log, 1100)!;
    const b = deriveSession(chess, [...log].reverse(), 1100)!;
    expect((a.state as ChessState).moves).toEqual(['e2e4']);
    expect(b.state).toEqual(a.state);
    expect(a.currentTurn).toBe(B);
  });

  it('lets the clock decide a stalled game', () => {
    const s = deriveSession(chess, [...table(60), op(B, 1002 + 60, 'timeout', { n: 0 })], 1100)!;
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(B);
  });

  it('refuses a third player', () => {
    const s = deriveSession(chess, [...table(), op('pk-c', 1001, 'join', {})], 1100)!;
    expect(s.participants).toEqual([W, B]);
  });
});
