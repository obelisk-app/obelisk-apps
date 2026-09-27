/**
 * Loads the BUILT bundle (dist/index.js, run `npm run build` first) the way
 * the frame loader does — default export called with { port, root } — against
 * the in-memory host, and checks a table actually renders and plays.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CANVAS_HEIGHT, CANVAS_WIDTH, getValidPositions, type GameState } from 'vesta';
import { FakeHost, FakeRelay } from '@obelisk/apps-sdk/testing';

import { vesta } from './definition';
import { vertexAt } from './geometry';

const bundle = join(__dirname, '../dist/index.js');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const SEED = 42;
const settle = () => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!existsSync(bundle))('built bundle', () => {
  const realRect = HTMLCanvasElement.prototype.getBoundingClientRect;
  beforeAll(() => {
    // jsdom has no canvas backend and no layout: a null context skips the
    // draw pass, and a rect at the canvas's own size makes a click's client
    // coordinates equal to board coordinates.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    HTMLCanvasElement.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, right: CANVAS_WIDTH, bottom: CANVAS_HEIGHT, x: 0, y: 0 }) as DOMRect;
  });
  afterAll(() => { HTMLCanvasElement.prototype.getBoundingClientRect = realRect; });

  it('mounts through the loader contract, injects its CSS, and places a setup settlement', async () => {
    let t = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay({ now: () => t });
    const sessionId = await relay.createSession(A);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const fake = new FakeHost({ relay, sessionId, me: A, participants: [{ pubkey: A, name: 'Ana' }, { pubkey: B, name: 'Bruno' }] });
    const main = (await import(pathToFileURL(bundle).href)).default as (ctx: unknown) => Promise<unknown>;
    await main({ port: fake.ctx.port, root });
    await settle();

    // The player grid's class, compiled from this app's sources, not the shell's.
    expect(document.head.querySelector('style')?.textContent).toContain('grid-cols-4');
    await waitFor(() => expect(root.querySelector('[data-testid="game-roster"]')?.textContent).toContain('Ana'));

    // B joins from another client; A starts a seeded board.
    t++; await relay.inject(B, { tags: [['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'join'], ['e', sessionId, '', 'root']], content: '{}' });
    t++; await relay.inject(A, {
      tags: [['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'start'], ['e', sessionId, '', 'root']],
      content: JSON.stringify({ seats: [A, B], opts: { seed: SEED }, turnTimeoutS: 0 }),
    });
    await waitFor(() => expect(root.querySelector('[data-testid="vesta-board"]')).not.toBeNull());
    expect(root.querySelector('[data-testid="vesta-player-0"]')?.textContent).toContain('Ana');
    expect(root.querySelector('[data-testid="vesta-player-1"]')?.textContent).toContain('Bruno');
    expect(root.textContent).toContain('places a settlement');

    // Ana is first to place: click a spot the engine itself calls legal.
    const state = vesta.initialState([A, B], { seed: SEED }) as GameState;
    const spot = vertexAt(getValidPositions(state, 'initial-settlement')[0].key)!;
    const canvas = root.querySelector('[data-testid="vesta-board"]') as HTMLCanvasElement;
    t++; canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: spot.x, clientY: spot.y }));

    const moves = () => relay.events.filter((e) => e.tags.some((x) => x[0] === 'op' && x[1] === 'move'));
    await waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0].pubkey).toBe(A);
    const body = JSON.parse(moves()[0].content);
    expect(body).toMatchObject({ n: 0, action: { type: 'place-settlement', ...spot.hexes[0] } });
    // The wire never names a player index — the seat comes from the signer.
    expect(body.action).not.toHaveProperty('player');

    // And every client, replaying the log, now sees the road step.
    await waitFor(() => expect(root.textContent).toContain('places a road'));
  });
});
