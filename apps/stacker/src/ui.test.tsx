/**
 * Stacker's side of the shell contract: scoring (the Stacker cases of dex's
 * `standings.test.ts`), the status line, the seed option, and host wiring.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, isDraw, scoreFor, standingsFor } from '@obelisk/apps-ui';
import { KIND_APP_EVENT, type NostrEvent } from '@obelisk/apps-sdk';
import { deriveSession, parseOp, type GameSession, type ParsedOp } from '@obelisk/apps-sdk/turn';

import { MUSIC_TRACKS } from './audio';
import { stacker } from './definition';
import { bindHostServices, musicSourceFor } from './host-services';
import { stackerStorage } from './storage';
import { normalizeSeed, statusLine, ui } from './ui';

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';

function parsed(id: string, table: string, pubkey: string, at: number, op: string, body: Record<string, unknown> = {}): ParsedOp {
  const tags = [['h', CH], ['t', 'obelisk-app'], ['op', op]];
  if (op !== 'create') tags.push(['e', table, '', 'root']);
  const ev: NostrEvent = { id, pubkey, created_at: at, kind: KIND_APP_EVENT, tags, content: JSON.stringify(body), sig: '' };
  const p = parseOp(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

/** A one-player Stacker run that ends when its only player tops out. */
function soloRun(): GameSession {
  const id = 's'.repeat(64);
  return deriveSession(stacker, [
    parsed(id, id, A, 1000, 'create', { nonce: 'n' }),
    parsed('s1', id, A, 1001, 'start', { seats: [{ id: A, by: A, label: 'Ana' }], opts: { seed: 7 }, turnTimeoutS: 0 }),
    parsed('c1', id, A, 1002, 'checkpoint', { seat: A, frame: 600, attacksSent: 9, linesCleared: 31, stackHeight: 14 }),
    parsed('t1', id, A, 1003, 'topout', { seat: A }),
  ], 2000)!;
}

function duel(extra: (id: string) => ParsedOp[] = () => []): GameSession {
  const id = 'x'.repeat(64);
  return deriveSession(stacker, [
    parsed(id, id, A, 1000, 'create', { nonce: 'n' }),
    parsed('j1', id, B, 1001, 'join'),
    parsed('s1', id, A, 1002, 'start', { seats: [A, B], opts: { seed: 7 }, turnTimeoutS: 0 }),
    ...extra(id),
  ], 2000)!;
}

describe('a solo run that ends', () => {
  it('is over, and is NOT a draw', () => {
    const session = soloRun();
    expect(session.status).toBe('finished');
    expect(session.winner).toBeNull();
    expect(session.draw).toBe(false);
    expect(isDraw(session)).toBe(false);
  });

  it('still knows what the player finished with', () => {
    expect(scoreFor(ui, soloRun(), A)).toBe('9⚔ · 31▤');
  });

  it('returns nothing for a seat that never played', () => {
    expect(scoreFor(ui, soloRun(), 'pk-stranger')).toBeNull();
    expect(scoreFor(ui, soloRun(), null)).toBeNull();
  });
});

describe('a real draw', () => {
  it('needs more than one player and nobody left standing', () => {
    const session = duel((id) => [parsed('t1', id, A, 1003, 'topout', { seat: A })]);
    // Two players, one out: a win for the survivor, not a draw.
    expect(session.winner).toBe(B);
    expect(isDraw(session)).toBe(false);
  });
});

describe('standings', () => {
  it('sorts by score, best first, garbage before lines', () => {
    const session = duel((id) => [
      parsed('c1', id, A, 1003, 'checkpoint', { seat: A, frame: 60, attacksSent: 2, linesCleared: 50, stackHeight: 3 }),
      parsed('c2', id, B, 1004, 'checkpoint', { seat: B, frame: 60, attacksSent: 11, linesCleared: 20, stackHeight: 4 }),
    ]);
    const rows = standingsFor(ui, session);
    expect(rows.map((r) => r.seat)).toEqual([B, A]);
    expect(rows[0]).toMatchObject({ score: '11⚔ · 20▤', sort: 11020, detail: 'Garbage sent · lines cleared' });
    expect(rows[1]).toMatchObject({ score: '2⚔ · 50▤', sort: 2050 });
  });
});

describe('statusLine', () => {
  it('counts who is still standing', () => {
    expect(statusLine(duel())).toBe('2 still standing');
    const s = duel();
    expect(statusLine({ ...s, match: { ...(s.match as object), alive: [B] } })).toBe('1 still standing');
  });
});

describe('the seed option', () => {
  it('normalizes like dex (copied from vesta/definition)', () => {
    expect(normalizeSeed(7)).toBe(7);
    expect(normalizeSeed('7')).toBe(7);
    expect(normalizeSeed(-7.9)).toBe(7);
    expect(normalizeSeed('banana')).toBe(0);
    expect(normalizeSeed(undefined)).toBe(0);
    expect(normalizeSeed(12_345_678)).toBe(345_678);
  });

  it('defaults to a seed, and the form publishes it as a number', () => {
    const opts = ui.defaultOpts!();
    expect(typeof opts.seed).toBe('number');
    const setOpts = vi.fn();
    const Options = ui.Options!;
    render(<I18nProvider locale="en"><Options opts={opts} setOpts={setOpts} setError={vi.fn()} /></I18nProvider>);
    fireEvent.change(screen.getByTestId('stacker-seed'), { target: { value: '4242' } });
    expect(setOpts).toHaveBeenLastCalledWith({ seed: 4242 });
  });

  it('is a realtime game, so the shell hides the turn clock', () => {
    expect(ui.def.realtime).toBeTruthy();
    expect(ui.def.defaultTurnTimeoutS).toBe(0);
  });
});

describe('host services', () => {
  it('asks host.asset for the manifest path, with its leading slash', async () => {
    const asset = vi.fn(async () => new Blob(['mp3']));
    await musicSourceFor({ asset })('music/retro-game-ncc.mp3');
    expect(asset).toHaveBeenCalledWith('/music/retro-game-ncc.mp3');
  });

  it('every track is an asset the build will publish', () => {
    for (const t of MUSIC_TRACKS) {
      expect(existsSync(join(__dirname, '../assets', t.path))).toBe(true);
    }
  });

  it('points preferences at host.storage', () => {
    const storage = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
    bindHostServices({ asset: vi.fn(), storage });
    expect(stackerStorage()).toBe(storage);
  });
});
