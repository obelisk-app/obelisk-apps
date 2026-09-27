import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@obelisk/apps-ui';
import type { GameSession } from '@obelisk/apps-sdk/turn';

import ChessBoard, { material } from './Board';
import { chess, replay, type ChessState } from './engine';

const W = 'pk-white';
const B = 'pk-black';

function session(state: ChessState, currentTurn: string): GameSession {
  return {
    id: 'a'.repeat(64), status: 'in_progress', createdBy: W, createdAt: 1, opts: {}, turnTimeoutS: 0,
    minPlayers: 2, maxPlayers: 2, participants: [W, B], seats: [{ id: W, by: W }, { id: B, by: B }],
    joined: [W, B], state, currentTurn, turnIndex: state.moves.length, turnStartedAt: 1, turnDeadline: null,
    winner: null, draw: false, eliminated: [], finishedAt: null, match: null,
  };
}

const props = (s: GameSession, mySeats: string[], onMove = vi.fn().mockResolvedValue(undefined)) => ({
  session: s, mySeats, onMove, onSend: vi.fn(), seatLabel: (x: string) => (x === W ? 'Ana' : 'Bruno'),
  busy: false, box: { width: 480, height: 560 }, host: {} as never,
});

const square = (sq: string) => document.querySelector(`[data-square="${sq}"]`) as HTMLElement;

// jsdom has no layout; react-chessboard measures squares to animate a move.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { width: 60, height: 60, top: 0, left: 0, right: 60, bottom: 60, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  );
});

describe('ChessBoard', () => {
  it('shows both players in bars, the side to move lit, the viewer at the bottom', () => {
    render(<I18nProvider locale="en"><ChessBoard {...props(session(chess.initialState([W, B]), W), [B])} /></I18nProvider>);
    expect(screen.getByTestId('chess-bar-w')).toHaveTextContent('Ana');
    expect(screen.getByTestId('chess-bar-b')).toHaveTextContent('Bruno');
    expect(screen.getByTestId('chess-bar-w')).toContainElement(screen.getByTestId('chess-to-move'));
    // Black's viewer sees their own bar last (bottom).
    const bars = screen.getAllByTestId(/chess-bar-/).map((el) => el.getAttribute('data-testid'));
    expect(bars).toEqual(['chess-bar-w', 'chess-bar-b']);
  });

  it('counts captured material for each side', () => {
    let s = chess.initialState([W, B]);
    for (const [seat, from, to] of [[W, 'e2', 'e4'], [B, 'd7', 'd5'], [W, 'e4', 'd5']] as const) {
      s = chess.applyAction(s, { from, to }, seat, [W, B]).state;
    }
    const m = material(replay(s.moves));
    expect(m.w).toEqual({ taken: ['p'], score: 1 });
    expect(m.b).toEqual({ taken: [], score: -1 });
  });

  it('publishes a click-to-move for the seat on move', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider locale="en"><ChessBoard {...props(session(chess.initialState([W, B]), W), [W], onMove)} /></I18nProvider>);
    await waitFor(() => expect(square('e2')).toBeTruthy());
    fireEvent.click(square('e2'));
    fireEvent.click(square('e4'));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith({ from: 'e2', to: 'e4' }, W));
  });

  it('does nothing for a player who is not on move', async () => {
    const onMove = vi.fn();
    render(<I18nProvider locale="en"><ChessBoard {...props(session(chess.initialState([W, B]), W), [B], onMove)} /></I18nProvider>);
    await waitFor(() => expect(square('e7')).toBeTruthy());
    fireEvent.click(square('e7'));
    fireEvent.click(square('e5'));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('asks which piece to promote to, and publishes the choice', async () => {
    let s = chess.initialState([W, B]);
    const seq: Array<[string, string, string]> = [
      [W, 'h2', 'h4'], [B, 'g7', 'g5'], [W, 'h4', 'g5'], [B, 'g8', 'f6'],
      [W, 'g5', 'g6'], [B, 'f6', 'g8'], [W, 'g6', 'h7'], [B, 'a7', 'a6'],
    ];
    for (const [seat, from, to] of seq) s = chess.applyAction(s, { from, to }, seat, [W, B]).state;
    const onMove = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider locale="en"><ChessBoard {...props(session(s, W), [W], onMove)} /></I18nProvider>);
    await waitFor(() => expect(square('h7')).toBeTruthy());
    fireEvent.click(square('h7'));
    fireEvent.click(square('g8'));
    expect(screen.getByTestId('chess-promotion')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('promote-n'));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith({ from: 'h7', to: 'g8', promotion: 'n' }, W));
  });
});
