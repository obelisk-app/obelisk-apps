/**
 * What the shared table shell needs to know about chess: the board, the two
 * side colours, how a finished game scores, and the running status line.
 * No options: seat 1 plays White, and the host orders seats in the picker.
 */
import type { BoardProps, GameUi, Standing } from '@obelisk/apps-ui';
import type { GameSession } from '@obelisk/apps-sdk/turn';

import ChessBoard, { ENDINGS } from './Board';
import { chess, replay, type ChessState } from './engine';

/** 1 for a win, ½ each for a draw — the usual chess score. */
export function standings(session: GameSession): Standing[] {
  const state = session.state as ChessState | null;
  const detail = state?.end ? `${ENDINGS[state.end]} · ${state.moves.length} plies` : undefined;
  return session.participants
    .map((seat) => {
      const score = session.winner === seat ? 1 : session.draw ? 0.5 : 0;
      const colour = state?.white === seat ? 'White' : 'Black';
      return { seat, score: `${score === 0.5 ? '½' : score} · ${colour}`, sort: score, detail };
    })
    .sort((a, b) => b.sort - a.sort);
}

function Board(props: BoardProps) {
  return <ChessBoard {...props} />;
}

export const ui: GameUi = {
  def: chess,
  icon: '♞',
  colors: ['#f5f5f5', '#52525b'],
  Board,
  turnClocks: [
    { label: 'none', seconds: 0 },
    { label: '1m', seconds: 60 },
    { label: '3m', seconds: 180 },
    { label: '10m', seconds: 600 },
  ],
  standings,
  statusLine: (session, seatLabel, mySeats) => {
    const state = session.state as ChessState | null;
    if (!state || !session.currentTurn) return 'In progress';
    const side = replay(state.moves).turn() === 'w' ? 'White' : 'Black';
    return mySeats.includes(session.currentTurn) ? `Your move · ${side}` : `${seatLabel(session.currentTurn)} to move · ${side}`;
  },
};
