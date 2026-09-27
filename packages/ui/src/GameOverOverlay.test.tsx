import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import GameOverOverlay from './GameOverOverlay.js';
import { B, HOST, renderShell, session } from './test-fixtures.js';

// Names come from the host's participants; without a PeopleProvider the
// fallback is the first 8 characters of the pubkey.
describe('GameOverOverlay', () => {
  it('stays out of the way while the game is running', () => {
    renderShell(<GameOverOverlay session={session({ status: 'in_progress', winner: null })} myPubkey={B} onClose={vi.fn()} />);
    expect(screen.queryByTestId('game-over-overlay')).not.toBeInTheDocument();
  });

  it('shouts YOU WON at the winner', () => {
    renderShell(<GameOverOverlay session={session()} myPubkey={B} onClose={vi.fn()} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('YOU WON');
    expect(screen.queryByTestId('game-over-winner')).not.toBeInTheDocument();
  });

  it('tells the loser they lost, and who took the board', () => {
    renderShell(<GameOverOverlay session={session()} myPubkey={HOST} onClose={vi.fn()} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('YOU LOST');
    expect(screen.getByTestId('game-over-winner')).toHaveTextContent('took the board');
  });

  it('shows spectators a neutral result', () => {
    renderShell(<GameOverOverlay session={session()} myPubkey="pk-nobody" onClose={vi.fn()} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('GAME OVER');
  });

  it("colours the headline with the winner's seat, from the app's palette", () => {
    renderShell(<GameOverOverlay session={session()} myPubkey={B} onClose={vi.fn()} />);
    expect(screen.getByTestId('game-over-headline')).toHaveStyle({ color: '#b4f953' });
  });

  it('shows what the viewer finished with, scored by the app', () => {
    renderShell(<GameOverOverlay session={session()} myPubkey={B} onClose={vi.fn()} />);
    expect(screen.getByTestId('game-over-score')).toHaveTextContent('20 pts');
  });

  it('dismisses on the close button and calls back', () => {
    const onClose = vi.fn();
    renderShell(<GameOverOverlay session={session()} myPubkey={B} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('game-over-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('game-over-overlay')).not.toBeInTheDocument();
  });

  it('dismisses when the backdrop itself is clicked', () => {
    const onClose = vi.fn();
    renderShell(<GameOverOverlay session={session()} myPubkey={B} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('game-over-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports a draw with no winner named', () => {
    renderShell(<GameOverOverlay session={session({ winner: null, draw: true })} myPubkey={B} onClose={vi.fn()} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('DRAW');
    expect(screen.getByText('Nobody took the board.')).toBeInTheDocument();
  });
});
