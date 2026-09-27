/**
 * Chess on the Obelisk Apps turn kit.
 *
 * The rules are chess.js's, not ours: it is the standard, well-tested move
 * generator, and it is pure — same moves in, same position out — which is
 * exactly what replay needs. This file only adapts it to the SDK's
 * GameDefinition contract.
 *
 * The state is the list of moves (UCI: "e2e4", "e7e8q"), not a board. Every
 * check replays that list through a fresh chess.js, so threefold repetition
 * and the fifty-move rule see the whole game, and there is no hidden
 * mutable state for two clients to disagree about.
 *
 * Seats: participants[0] plays White, participants[1] plays Black. The host
 * orders them in the seat picker.
 */
import { Chess, type Square } from 'chess.js';
import type { ApplyResult, GameDefinition } from '@obelisk/apps-sdk/turn';

export type Promotion = 'q' | 'r' | 'b' | 'n';

export interface ChessAction {
  from: string;
  to: string;
  promotion?: Promotion;
}

export type ChessEnd =
  | 'checkmate' | 'stalemate' | 'threefold' | 'fifty-moves' | 'insufficient' | 'timeout' | 'resign';

export interface ChessState {
  /** UCI moves in order. The whole truth of the game. */
  moves: string[];
  /** Position after `moves`, cached for rendering. Never trusted by the rules. */
  fen: string;
  white: string;
  black: string;
  end: ChessEnd | null;
}

const SQUARE = /^[a-h][1-8]$/;
const PROMOTIONS: readonly string[] = ['q', 'r', 'b', 'n'];

export function uci(a: ChessAction): string {
  return `${a.from}${a.to}${a.promotion ?? ''}`;
}

/** A chess.js positioned after `moves`. Throws only on a corrupt list, which the reducer never produces. */
export function replay(moves: readonly string[]): Chess {
  const game = new Chess();
  for (const m of moves) {
    game.move({ from: m.slice(0, 2) as Square, to: m.slice(2, 4) as Square, promotion: m[4] });
  }
  return game;
}

export function sideOf(state: ChessState, seat: string): 'w' | 'b' | null {
  return seat === state.white ? 'w' : seat === state.black ? 'b' : null;
}

function isShaped(a: unknown): a is ChessAction {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  if (typeof x.from !== 'string' || typeof x.to !== 'string') return false;
  if (!SQUARE.test(x.from) || !SQUARE.test(x.to)) return false;
  return x.promotion === undefined || (typeof x.promotion === 'string' && PROMOTIONS.includes(x.promotion));
}

/** Try the move on a replayed board; the resulting game, or null if illegal. */
function tryMove(state: ChessState, a: ChessAction): Chess | null {
  const game = replay(state.moves);
  try {
    const move = game.move({ from: a.from as Square, to: a.to as Square, promotion: a.promotion });
    // chess.js fills in a default promotion; a promotion must be chosen explicitly
    // so the published move says what the player picked.
    if (move.promotion && move.promotion !== a.promotion) return null;
    if (!move.promotion && a.promotion) return null;
    return game;
  } catch {
    return null;
  }
}

function endOf(game: Chess): ChessEnd | null {
  if (game.isCheckmate()) return 'checkmate';
  if (game.isStalemate()) return 'stalemate';
  if (game.isThreefoldRepetition()) return 'threefold';
  if (game.isInsufficientMaterial()) return 'insufficient';
  if (game.isDrawByFiftyMoves()) return 'fifty-moves';
  return null;
}

export const chess: GameDefinition<ChessState, ChessAction> = {
  type: 'chess',
  displayName: 'Chess',
  description: 'Classic chess for two',
  minPlayers: 2,
  maxPlayers: 2,
  defaultTurnTimeoutS: 0,

  initialState(participants) {
    return { moves: [], fen: new Chess().fen(), white: participants[0], black: participants[1], end: null };
  },

  firstTurn(participants) {
    return participants[0];
  },

  validateAction(state, action, seat) {
    if (state.end) return { ok: false, error: 'game over' };
    if (!isShaped(action)) return { ok: false, error: 'malformed move' };
    const side = sideOf(state, seat);
    if (!side) return { ok: false, error: 'not a player' };
    if (replay(state.moves).turn() !== side) return { ok: false, error: 'not your move' };
    return tryMove(state, action) ? { ok: true } : { ok: false, error: 'illegal move' };
  },

  applyAction(state, action, seat): ApplyResult<ChessState> {
    const game = tryMove(state, action)!;
    const end = endOf(game);
    const next: ChessState = { ...state, moves: [...state.moves, uci(action)], fen: game.fen(), end };
    if (end === 'checkmate') return { state: next, nextTurn: null, winner: seat };
    if (end) return { state: next, nextTurn: null, draw: true };
    return { state: next, nextTurn: seat === state.white ? state.black : state.white };
  },

  onTimeout(state, seat) {
    // Out of time and resigning are the same to an engine: that side loses.
    const winner = seat === state.white ? state.black : state.white;
    return { state: { ...state, end: state.end ?? 'timeout' }, nextTurn: null, winner, eliminated: [seat] };
  },
};
