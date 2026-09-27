/** Hand-built sessions and a fixture GameUi, so the shell is tested without any real game. */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { GameDefinition, GameSession } from '@obelisk/apps-sdk/turn';

import { GameUiProvider, type GameUi } from './game-ui.js';
import { I18nProvider } from './i18n.js';

export const HOST = 'pk-host';
export const B = 'pk-b';

const def: GameDefinition = {
  type: 'fixture', displayName: 'Fixture', description: '', minPlayers: 1, maxPlayers: 4, defaultTurnTimeoutS: 30,
  initialState: () => ({}), firstTurn: (p) => p[0],
  validateAction: () => ({ ok: true }),
  applyAction: (s) => ({ state: s, nextTurn: null }),
  onTimeout: (s) => ({ state: s, nextTurn: null }),
};

export const fixtureUi: GameUi = {
  def,
  icon: '◆',
  colors: ['#ef4444', '#b4f953', '#3b82f6', '#eab308'],
  Board: () => <div data-testid="fixture-board" />,
  standings: (s) => s.participants
    .map((seat, i) => ({ seat, score: `${(i + 1) * 10} pts`, sort: (i + 1) * 10, detail: 'Points' }))
    .sort((a, b) => b.sort - a.sort),
};

export function session(over: Partial<GameSession> = {}): GameSession {
  return {
    id: 'a'.repeat(64), status: 'finished', createdBy: HOST, createdAt: 1000,
    opts: {}, turnTimeoutS: 45, minPlayers: 1, maxPlayers: 4,
    participants: [HOST, B], seats: [{ id: HOST, by: HOST }, { id: B, by: B }], joined: [HOST, B],
    state: {}, currentTurn: null, turnIndex: 3, turnStartedAt: null, turnDeadline: null,
    winner: B, draw: false, eliminated: [HOST], finishedAt: 1010, match: null,
    ...over,
  };
}

export const renderShell = (el: ReactElement, ui: GameUi = fixtureUi) => render(
  <I18nProvider locale="en"><GameUiProvider value={ui}>{el}</GameUiProvider></I18nProvider>,
);
