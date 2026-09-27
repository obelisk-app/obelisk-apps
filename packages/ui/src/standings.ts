/**
 * Final standings. Each app scores its own game (`GameUi.standings`); this is
 * the fallback for games that don't, plus the two game-independent reads the
 * results screens share. Carried over from obelisk-dex
 * `src/lib/games/standings.ts`, minus its per-game branches, which moved into
 * the apps.
 */
import type { GameSession } from '@obelisk/apps-sdk/turn';

import type { GameUi, Standing } from './game-ui.js';

export function defaultStandings(session: GameSession): Standing[] {
  return session.participants.map((seat) => ({
    seat,
    score: seat === session.winner ? 'winner' : session.eliminated.includes(seat) ? 'out' : '—',
    sort: seat === session.winner ? 1 : 0,
  }));
}

export function standingsFor(ui: Pick<GameUi, 'standings'>, session: GameSession): Standing[] {
  return ui.standings ? ui.standings(session) : defaultStandings(session);
}

/** One seat's final score, or null if it wasn't at the table. */
export function scoreFor(ui: Pick<GameUi, 'standings'>, session: GameSession, seat: string | null): string | null {
  if (!seat) return null;
  return standingsFor(ui, session).find((row) => row.seat === seat)?.score ?? null;
}

/**
 * Did this end in an actual draw? A game with no winner is not automatically
 * a draw — a solo run ends with nobody winning because there was nobody to
 * beat.
 */
export function isDraw(session: GameSession): boolean {
  return session.draw && session.participants.length > 1;
}
