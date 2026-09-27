/**
 * The chess board, on react-chessboard. The truth is `session.state` (the
 * replayed move list); the only local state is a pending move shown while its
 * event is on its way, the square the player has picked up, and an open
 * promotion choice.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

function useNow(): number {
  const [t, setT] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const id = setInterval(() => setT(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(id); }, []);
  return t;
}
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { PlayerTag, type BoardProps } from '@obelisk/apps-ui';

import { replay, sideOf, type ChessAction, type ChessState, type Promotion } from './engine';

const PROMOTION_CHOICES: { piece: Promotion; label: string }[] = [
  { piece: 'q', label: 'Queen' },
  { piece: 'r', label: 'Rook' },
  { piece: 'b', label: 'Bishop' },
  { piece: 'n', label: 'Knight' },
];

const GLYPH: Record<string, string> = { q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const VALUE: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const START: Record<string, number> = { q: 1, r: 2, b: 2, n: 2, p: 8 };

/** What each side has taken, from the position alone (promotions count as the piece they became). */
export function material(game: Chess): { w: { taken: string[]; score: number }; b: { taken: string[]; score: number } } {
  const left = { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } } as Record<'w' | 'b', Record<string, number>>;
  for (const row of game.board()) for (const p of row) if (p && p.type !== 'k') left[p.color][p.type] += 1;
  const takenFrom = (c: 'w' | 'b') => (['q', 'r', 'b', 'n', 'p'] as const)
    .flatMap((t) => Array.from({ length: Math.max(0, START[t] - left[c][t]) }, () => t));
  const worth = (c: 'w' | 'b') => Object.entries(left[c]).reduce((n, [t, k]) => n + VALUE[t] * k, 0);
  return {
    w: { taken: takenFrom('b'), score: worth('w') - worth('b') },
    b: { taken: takenFrom('w'), score: worth('b') - worth('w') },
  };
}

const LAST_MOVE: CSSProperties = { background: 'color-mix(in oklab, var(--color-lc-green) 32%, transparent)' };
const PICKED: CSSProperties = { background: 'color-mix(in oklab, var(--color-lc-green) 50%, transparent)' };
const TARGET: CSSProperties = { background: 'radial-gradient(circle, color-mix(in oklab, var(--color-lc-green) 70%, transparent) 22%, transparent 24%)' };
const CAPTURE: CSSProperties = { background: 'radial-gradient(circle, transparent 58%, color-mix(in oklab, var(--color-lc-green) 70%, transparent) 60%)' };
const CHECK: CSSProperties = { background: 'radial-gradient(circle, #ef4444 0%, rgba(239,68,68,0.45) 45%, transparent 70%)' };

export default function ChessBoard({ session, mySeats, onMove, busy, box, seatLabel }: BoardProps) {
  const now = useNow();
  const state = session.state as ChessState | null;
  const moves = state?.moves ?? [];
  const game = useMemo(() => replay(moves), [moves]);
  const history = useMemo(() => game.history(), [game]);
  const [pending, setPending] = useState<{ fen: string; forMoves: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);

  // A pending move is dropped as soon as the log grows (the real move landed)
  // or the publish failed.
  useEffect(() => {
    if (pending && moves.length !== pending.forMoves) setPending(null);
  }, [moves.length, pending]);

  if (!state) return null;

  const turn = game.turn();
  const onMoveSeat = turn === 'w' ? state.white : state.black;
  const myTurnSeat = session.status === 'in_progress' && mySeats.includes(onMoveSeat) ? onMoveSeat : null;
  const mySide = myTurnSeat ? sideOf(state, myTurnSeat) : mySeats.map((s) => sideOf(state, s)).find(Boolean) ?? null;
  // Hot-seat: one keyboard holds both sides, so the board turns to whoever moves.
  const orientation = mySide === 'b' ? 'black' : 'white';

  const legalFrom = (sq: string) => (myTurnSeat
    ? game.moves({ square: sq as Square, verbose: true })
    : []);

  async function submit(action: ChessAction) {
    if (!myTurnSeat) return;
    const preview = new Chess(game.fen());
    try {
      preview.move({ from: action.from as Square, to: action.to as Square, promotion: action.promotion });
    } catch {
      return; // not legal: nothing to publish
    }
    setPending({ fen: preview.fen(), forMoves: moves.length });
    setPicked(null);
    try {
      await onMove(action, myTurnSeat);
    } catch {
      setPending(null);
    }
  }

  function attempt(from: string, to: string): boolean {
    const legal = legalFrom(from).filter((m) => m.to === to);
    if (legal.length === 0) return false;
    if (legal.some((m) => m.promotion)) {
      setPromotion({ from, to });
      return false; // wait for the choice
    }
    void submit({ from, to });
    return true;
  }

  const squareStyles: Record<string, CSSProperties> = {};
  const last = moves.at(-1);
  if (last) {
    squareStyles[last.slice(0, 2)] = LAST_MOVE;
    squareStyles[last.slice(2, 4)] = LAST_MOVE;
  }
  if (game.inCheck()) {
    const kingSq = game.board().flat().find((p) => p && p.type === 'k' && p.color === turn)?.square;
    if (kingSq) squareStyles[kingSq] = CHECK;
  }
  if (picked) {
    squareStyles[picked] = PICKED;
    for (const m of legalFrom(picked)) squareStyles[m.to] = m.captured ? CAPTURE : TARGET;
  }

  // Two player bars (~48px each) and the move list share the height with the board.
  const side = Math.floor(Math.max(200, Math.min(box.width - 8, box.height - 104)));
  const mat = material(game);
  const secondsLeft = session.turnDeadline !== null ? Math.max(0, session.turnDeadline - now) : null;
  const top: 'w' | 'b' = orientation === 'white' ? 'b' : 'w';
  const bar = (c: 'w' | 'b') => {
    const seat = c === 'w' ? state.white : state.black;
    const onMove = session.status === 'in_progress' && turn === c;
    const m = mat[c];
    return (
      <div className="flex w-full items-center justify-between gap-2" style={{ maxWidth: side }} data-testid={`chess-bar-${c}`}>
        <PlayerTag
          session={session}
          seat={seat}
          label={seatLabel(seat)}
          color={c === 'w' ? '#f5f5f5' : '#18181b'}
          active={onMove}
          mine={mySeats.includes(seat)}
          out={session.winner !== null && session.winner !== seat && session.status === 'finished'}
        >
          <span className="tracking-tight" data-testid={`chess-taken-${c}`}>
            {m.taken.map((t) => GLYPH[t]).join('')}
            {m.score > 0 && <span className="ml-1 text-lc-white">+{m.score}</span>}
            {m.taken.length === 0 && m.score <= 0 && (c === 'w' ? 'White' : 'Black')}
          </span>
        </PlayerTag>
        {onMove && (
          <span
            className={`shrink-0 rounded-lg px-2 py-1 font-mono text-sm ${
              secondsLeft !== null && secondsLeft <= 10 ? 'bg-red-500/20 text-red-300' : 'bg-lc-card text-lc-white'
            }`}
            data-testid="chess-to-move"
          >
            {game.inCheck() ? 'check · ' : ''}{secondsLeft !== null ? `${secondsLeft}s` : 'to move'}
          </span>
        )}
        {!onMove && session.status === 'finished' && session.winner === seat && (
          <span className="shrink-0 rounded-lg bg-lc-card px-2 py-1 text-sm" aria-label="winner">🏆</span>
        )}
      </div>
    );
  };
  const status = session.status === 'finished' && state.end ? ENDINGS[state.end] : '';

  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="chess-board">
      {bar(top)}

      <div className="relative" style={{ width: side, height: side }}>
        <Chessboard
          options={{
            id: `chess-${session.id.slice(0, 8)}`,
            position: pending?.fen ?? game.fen(),
            boardOrientation: orientation,
            allowDragging: !!myTurnSeat && !busy && !pending,
            canDragPiece: ({ piece }) => !!myTurnSeat && piece.pieceType[0] === turn,
            onPieceDrop: ({ sourceSquare, targetSquare }) => (targetSquare ? attempt(sourceSquare, targetSquare) : false),
            onSquareClick: ({ square, piece }) => {
              if (!myTurnSeat || pending) return;
              if (picked && picked !== square && attempt(picked, square)) return;
              if (picked && picked !== square && legalFrom(picked).some((m) => m.to === square)) return;
              setPicked(piece && piece.pieceType[0] === turn ? square : null);
            },
            squareStyles,
            // A cool blue-grey board: calm next to the dark UI, and high
            // contrast for both piece colours.
            darkSquareStyle: { backgroundColor: '#7b93a6' },
            lightSquareStyle: { backgroundColor: '#dfe5ea' },
            darkSquareNotationStyle: { color: '#dfe5ea', fontWeight: 700, fontSize: 11 },
            lightSquareNotationStyle: { color: '#7b93a6', fontWeight: 700, fontSize: 11 },
            boardStyle: { borderRadius: 8, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.45)' },
            animationDurationInMs: 180,
          }}
        />

        {promotion && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/60" data-testid="chess-promotion">
            <div className="rounded-xl border border-lc-border bg-lc-dark p-3">
              <p className="mb-2 text-center text-xs text-lc-muted">Promote to</p>
              <div className="flex gap-2">
                {PROMOTION_CHOICES.map((c) => (
                  <button
                    key={c.piece}
                    type="button"
                    aria-label={c.label}
                    onClick={() => { const p = promotion; setPromotion(null); void submit({ ...p, promotion: c.piece }); }}
                    className="h-12 w-12 rounded-lg border border-lc-border bg-lc-card text-3xl text-lc-white hover:border-lc-green"
                    data-testid={`promote-${c.piece}`}
                  >
                    {GLYPH[c.piece]}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setPromotion(null)} className="lc-pill-secondary mt-3 w-full px-3 py-1 text-xs">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {bar(top === 'w' ? 'b' : 'w')}

      {status && <p className="text-xs font-semibold text-lc-white" data-testid="chess-status">{status}</p>}

      {history.length > 0 && (
        <ol className="flex w-full flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-lc-muted" style={{ maxWidth: side }} data-testid="chess-moves">
          {history.reduce<string[][]>((rows, san, i) => {
            if (i % 2 === 0) rows.push([san]); else rows[rows.length - 1].push(san);
            return rows;
          }, []).map((pair, i) => (
            <li key={i}><span className="text-lc-muted/60">{i + 1}.</span> <span className="text-lc-white">{pair.join(' ')}</span></li>
          ))}
        </ol>
      )}
    </div>
  );
}

export const ENDINGS: Record<NonNullable<ChessState['end']>, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Draw · stalemate',
  threefold: 'Draw · threefold repetition',
  'fifty-moves': 'Draw · fifty-move rule',
  insufficient: 'Draw · insufficient material',
  timeout: 'Out of time',
  resign: 'Resigned',
};
