import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import GameResults from './GameResults.js';
import { B, HOST, renderShell, session } from './test-fixtures.js';

const label = (seat: string) => (seat === B ? 'Bruno' : 'Hostess');

describe('GameResults', () => {
  it('names the winner and lists everyone, best first, in the app\'s scoring', () => {
    renderShell(<GameResults session={session()} seatLabel={label} myPubkey={B} />);
    expect(screen.getByText(/Bruno won/)).toBeInTheDocument();
    const rows = within(screen.getByTestId('results-standings')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([`result-row-${B}`, `result-row-${HOST}`]);
    expect(screen.getByTestId(`result-score-${B}`)).toHaveTextContent('20 pts');
    expect(screen.getByText('Points')).toBeInTheDocument();
  });

  it('marks which seat belongs to the person looking', () => {
    renderShell(<GameResults session={session()} seatLabel={label} myPubkey={HOST} />);
    expect(within(screen.getByTestId(`result-row-${HOST}`)).getByText('(you)')).toBeInTheDocument();
    expect(within(screen.getByTestId(`result-row-${B}`)).queryByText('(you)')).not.toBeInTheDocument();
  });

  it('shows a spectator the same standings, with nothing marked as theirs', () => {
    renderShell(<GameResults session={session()} seatLabel={label} myPubkey="pk-nobody" />);
    expect(screen.queryByText('(you)')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('says draw when nobody took it, and "game over" for a solo run', () => {
    renderShell(<GameResults session={session({ winner: null, draw: true })} seatLabel={label} myPubkey={B} />);
    expect(screen.getByText(/· draw/)).toBeInTheDocument();
  });

  it('calls a solo run that ended "game over", not a draw', () => {
    renderShell(<GameResults
      session={session({ winner: null, draw: false, participants: [HOST], seats: [{ id: HOST, by: HOST }] })}
      seatLabel={label} myPubkey={HOST} />);
    expect(screen.getByText(/· game over/)).toBeInTheDocument();
  });
});
