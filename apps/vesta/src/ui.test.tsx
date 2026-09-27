import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createGame, type GameState } from 'vesta';
import { I18nProvider } from '@obelisk/apps-ui';
import type { GameSession } from '@obelisk/apps-sdk/turn';

import { savedPlayers, standings, ui } from './ui';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

/** A three-player save, shaped like upstream's export. */
const saved = (() => {
  const state = createGame({ players: 3, roll: 7 });
  return { ...state, players: state.players.map((p, i) => ({ ...p, name: ['Ana', 'Beto', 'Caro'][i] })) };
})();
const saveFile = { startState: saved, turns: [], endState: saved };

/** The shell's side of the options contract: it owns opts and the error line. */
function Harness({ initial, onOpts }: { initial: Record<string, unknown>; onOpts: (o: Record<string, unknown>) => void }) {
  const [opts, setOpts] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const Options = ui.Options!;
  return (
    <I18nProvider locale="en">
      <Options opts={opts} setOpts={(o) => { setOpts(o); onOpts(o); }} setError={setError} />
      {error && <p data-testid="opt-error">{error}</p>}
    </I18nProvider>
  );
}

function upload(content: string, name = 'save.json') {
  const input = screen.getByTestId('vesta-import-input') as HTMLInputElement;
  const file = new File([content], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('Vesta options', () => {
  it('starts from a seed and normalises what the host types', () => {
    const initial = ui.defaultOpts!();
    expect(typeof initial.seed).toBe('number');
    const onOpts = vi.fn();
    render(<Harness initial={initial} onOpts={onOpts} />);
    expect(screen.getByTestId('vesta-seed')).toHaveValue(String(initial.seed));
    fireEvent.change(screen.getByTestId('vesta-seed'), { target: { value: '-1234567.8' } });
    expect(onOpts).toHaveBeenLastCalledWith({ seed: 234567 });
  });

  it('shows the per-action clock warning', () => {
    render(<Harness initial={{ seed: 1 }} onOpts={vi.fn()} />);
    expect(screen.getByTestId('vesta-clock-help')).toHaveTextContent('a Vesta turn is several');
  });

  it('loads a save into { resume } and locks the seed', async () => {
    const onOpts = vi.fn();
    render(<Harness initial={{ seed: 1 }} onOpts={onOpts} />);
    upload(JSON.stringify(saveFile), 'my-game.json');
    await waitFor(() => expect(onOpts).toHaveBeenLastCalledWith({ resume: saveFile }));
    expect(screen.getByTestId('vesta-resume-note')).toHaveTextContent('Resuming my-game.json — 3 players');
    expect(screen.getByTestId('vesta-seed')).toBeDisabled();

    fireEvent.click(screen.getByTestId('vesta-new-board'));
    expect(onOpts).toHaveBeenLastCalledWith({ seed: 1 });
    expect(screen.queryByTestId('vesta-resume-note')).not.toBeInTheDocument();
  });

  it('refuses a file that is not a Vesta save', async () => {
    const onOpts = vi.fn();
    render(<Harness initial={{ seed: 1 }} onOpts={onOpts} />);
    upload(JSON.stringify({ hello: 'world' }));
    await waitFor(() => expect(screen.getByTestId('opt-error')).toHaveTextContent('not a Vesta save'));
    upload('{ not json');
    await waitFor(() => expect(screen.getByTestId('opt-error')).toHaveTextContent('Could not read that file'));
    expect(onOpts).not.toHaveBeenCalled();
  });
});

describe('savedPlayers', () => {
  it('names the save’s players so the shell fixes the seat rows', () => {
    expect(savedPlayers({ resume: saveFile })).toEqual(['Ana', 'Beto', 'Caro']);
    expect(savedPlayers({ resume: saved })).toEqual(['Ana', 'Beto', 'Caro']);
    expect(savedPlayers({ seed: 3 })).toBeNull();
  });
});

describe('standings', () => {
  it('scores by victory points, highest first', () => {
    const state = createGame({ players: 2, roll: 1 }) as GameState;
    const scored = { ...state, players: state.players.map((p, i) => ({ ...p, vp: i === 1 ? 10 : 4 })) };
    const session = { participants: ['a', 'b'], state: scored } as unknown as GameSession;
    expect(standings(session)).toEqual([
      { seat: 'b', score: '10 VP', sort: 10, detail: 'Victory points at the end of the game' },
      { seat: 'a', score: '4 VP', sort: 4, detail: 'Victory points at the end of the game' },
    ]);
  });
});

describe('ui', () => {
  it('carries the dex icon and upstream’s player palette', () => {
    expect(ui.icon).toBe('🏛');
    expect(ui.colors).toEqual(['#e07b30', '#3498db', '#2ecc71', '#e74c3c']);
    expect(ui.def.type).toBe('vesta');
  });
});
