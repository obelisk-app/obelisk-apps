import { describe, expect, it } from 'vitest';

import { chess, replay, uci, type ChessAction, type ChessState } from './engine';

const W = 'pk-white';
const B = 'pk-black';

function play(moves: Array<[string, ChessAction]>): ChessState {
  let s = chess.initialState([W, B]);
  for (const [seat, a] of moves) {
    const v = chess.validateAction(s, a, seat, [W, B]);
    if (!v.ok) throw new Error(`${uci(a)} by ${seat}: ${v.error}`);
    s = chess.applyAction(s, a, seat, [W, B]).state;
  }
  return s;
}

const m = (from: string, to: string, promotion?: ChessAction['promotion']): ChessAction => ({ from, to, ...(promotion ? { promotion } : {}) });

describe('chess engine', () => {
  it('starts from the standard position with seat 1 as White', () => {
    const s = chess.initialState([W, B]);
    expect(s.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(s.white).toBe(W);
    expect(chess.firstTurn([W, B])).toBe(W);
  });

  it('accepts a legal move and hands the turn over', () => {
    const s0 = chess.initialState([W, B]);
    expect(chess.validateAction(s0, m('e2', 'e4'), W, [W, B]).ok).toBe(true);
    const r = chess.applyAction(s0, m('e2', 'e4'), W, [W, B]);
    expect(r.nextTurn).toBe(B);
    expect(r.state.moves).toEqual(['e2e4']);
  });

  it('refuses illegal moves, moves out of turn, strangers and malformed actions', () => {
    const s0 = chess.initialState([W, B]);
    expect(chess.validateAction(s0, m('e2', 'e5'), W, [W, B]).ok).toBe(false);
    expect(chess.validateAction(s0, m('e7', 'e5'), B, [W, B]).ok).toBe(false);
    expect(chess.validateAction(s0, m('e2', 'e4'), 'pk-nobody', [W, B]).ok).toBe(false);
    expect(chess.validateAction(s0, { from: 'z9', to: 'e4' } as ChessAction, W, [W, B]).ok).toBe(false);
    expect(chess.validateAction(s0, null as unknown as ChessAction, W, [W, B]).ok).toBe(false);
  });

  it("ends in checkmate with the mating side as winner (fool's mate)", () => {
    const s = play([[W, m('f2', 'f3')], [B, m('e7', 'e5')], [W, m('g2', 'g4')]]);
    const r = chess.applyAction(s, m('d8', 'h4'), B, [W, B]);
    expect(r.nextTurn).toBeNull();
    expect(r.winner).toBe(B);
    expect(r.state.end).toBe('checkmate');
  });

  it('requires an explicit promotion piece and records it', () => {
    // A white pawn reaches h7; it can promote by taking the knight on g8.
    const s = play([
      [W, m('h2', 'h4')], [B, m('g7', 'g5')], [W, m('h4', 'g5')], [B, m('g8', 'f6')],
      [W, m('g5', 'g6')], [B, m('f6', 'g8')], [W, m('g6', 'h7')], [B, m('a7', 'a6')],
    ]);
    expect(chess.validateAction(s, m('h7', 'g8'), W, [W, B]).ok).toBe(false);
    expect(chess.validateAction(s, m('h7', 'g8', 'n'), W, [W, B]).ok).toBe(true);
    const r = chess.applyAction(s, m('h7', 'g8', 'n'), W, [W, B]);
    expect(r.state.moves.at(-1)).toBe('h7g8n');
    expect(replay(r.state.moves).get('g8')).toMatchObject({ type: 'n', color: 'w' });
    // …and a promotion suffix on an ordinary move is refused.
    expect(chess.validateAction(chess.initialState([W, B]), m('e2', 'e4', 'q'), W, [W, B]).ok).toBe(false);
  });

  it('calls a draw on threefold repetition', () => {
    const shuffle: Array<[string, ChessAction]> = [
      [W, m('g1', 'f3')], [B, m('g8', 'f6')], [W, m('f3', 'g1')], [B, m('f6', 'g8')],
      [W, m('g1', 'f3')], [B, m('g8', 'f6')], [W, m('f3', 'g1')],
    ];
    const s = play(shuffle);
    const r = chess.applyAction(s, m('f6', 'g8'), B, [W, B]);
    expect(r.nextTurn).toBeNull();
    expect(r.draw).toBe(true);
    expect(r.state.end).toBe('threefold');
  });

  it('refuses any move once the game has ended', () => {
    const s = play([[W, m('f2', 'f3')], [B, m('e7', 'e5')], [W, m('g2', 'g4')], [B, m('d8', 'h4')]]);
    expect(s.end).toBe('checkmate');
    expect(chess.validateAction(s, m('a2', 'a3'), W, [W, B]).ok).toBe(false);
  });

  it('gives the game to the other side on timeout or resignation', () => {
    const s = chess.initialState([W, B]);
    expect(chess.onTimeout(s, W, [W, B])).toMatchObject({ nextTurn: null, winner: B, state: { end: 'timeout' } });
    expect(chess.onTimeout(s, B, [W, B]).winner).toBe(W);
  });

  it('never mutates the state it is handed', () => {
    const s0 = chess.initialState([W, B]);
    const frozen = Object.freeze({ ...s0, moves: Object.freeze([...s0.moves]) as string[] });
    expect(() => chess.applyAction(frozen, m('e2', 'e4'), W, [W, B])).not.toThrow();
    expect(frozen.moves).toEqual([]);
  });
});
