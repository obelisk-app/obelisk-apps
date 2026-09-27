import { describe, expect, it } from 'vitest';

import { defaultStandings, isDraw, scoreFor, standingsFor } from './standings.js';
import { B, fixtureUi, HOST, session } from './test-fixtures.js';

describe('isDraw', () => {
  it('is false for a solo run with no winner — nobody to draw with', () => {
    expect(isDraw(session({ winner: null, draw: true, participants: [HOST] }))).toBe(false);
  });
  it('is true only with more than one player and the draw flag', () => {
    expect(isDraw(session({ winner: null, draw: true }))).toBe(true);
    expect(isDraw(session({ winner: B, draw: false }))).toBe(false);
  });
});

describe('standings', () => {
  it("uses the app's scorer when it has one", () => {
    expect(standingsFor(fixtureUi, session()).map((r) => r.seat)).toEqual([B, HOST]);
    expect(scoreFor(fixtureUi, session(), B)).toBe('20 pts');
  });

  it('falls back to winner / out / — for games without one', () => {
    const rows = standingsFor({}, session());
    expect(rows).toEqual(defaultStandings(session()));
    expect(rows.find((r) => r.seat === B)?.score).toBe('winner');
    expect(rows.find((r) => r.seat === HOST)?.score).toBe('out');
  });

  it('returns nothing useful for a seat that never played', () => {
    expect(scoreFor(fixtureUi, session(), 'pk-stranger')).toBeNull();
    expect(scoreFor(fixtureUi, session(), null)).toBeNull();
  });
});
