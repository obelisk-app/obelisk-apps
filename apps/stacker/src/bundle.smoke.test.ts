/**
 * Loads the BUILT bundle (dist/index.js, run `npm run build` first) the way
 * the frame loader does — default export called with { port, root } — against
 * the in-memory host, starts a two-player match, and plays one board to a
 * topout through the keyboard, with the key binding coming out of
 * host.storage.
 *
 * The 60 Hz loop runs on requestAnimationFrame; it is stubbed and pumped by
 * hand so the test is not a timing race. The bundle calls the global, so the
 * stub reaches it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHost, FakeRelay } from '@obelisk/apps-sdk/testing';

const bundle = join(__dirname, '../dist/index.js');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const settle = () => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!existsSync(bundle))('built bundle', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let rafNow = 0;
  const pump = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      const queued = rafQueue;
      rafQueue = [];
      rafNow += 100;
      for (const cb of queued) cb(rafNow);
    }
  };

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    // jsdom has no canvas; the board draws into nothing.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts through the loader contract, starts a match, and publishes a topout', async () => {
    let t = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay({ now: () => t });
    const sessionId = await relay.createSession(A);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const mp3 = new Blob(['mp3'], { type: 'audio/mpeg' });
    const fake = new FakeHost({
      relay, sessionId, me: A,
      participants: [{ pubkey: A, name: 'Ana' }, { pubkey: B, name: 'Bruno' }],
      assets: { '/music/retro-game-ncc.mp3': mp3, '/music/digital-circus-ncc.mp3': mp3, '/music/shoebody-bop-ncc.mp3': mp3 },
    });
    // A binding saved on an earlier visit: hard drop on J, and nothing on Space.
    const storage = (fake as unknown as { storage: Map<string, string> }).storage;
    storage.set('stacker/keys', JSON.stringify({ KeyJ: 'hard', ArrowLeft: 'left' }));

    const main = (await import(pathToFileURL(bundle).href)).default as (ctx: unknown) => Promise<unknown>;
    await main({ port: fake.ctx.port, root });
    await settle();

    expect(document.head.querySelector('style')?.textContent).toContain('cr-win-title');
    await waitFor(() => expect(root.querySelector('[data-testid="game-roster"]')?.textContent).toContain('Ana'));

    // B joins from another client; A starts with a fixed piece seed.
    t++; await relay.inject(B, { tags: [['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'join'], ['e', sessionId, '', 'root']], content: '{}' });
    t++; await relay.inject(A, {
      tags: [['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'start'], ['e', sessionId, '', 'root']],
      content: JSON.stringify({ seats: [A, B], opts: { seed: 1234 }, turnTimeoutS: 0 }),
    });
    await waitFor(() => expect(root.querySelector('[data-testid="stacker-board"]')).not.toBeNull());
    expect(root.querySelector(`[data-testid="stacker-opponent-${B}"]`)?.textContent).toContain('Bruno');
    expect(root.querySelector('[data-testid="game-status"]')?.textContent).toContain('2 still standing');
    expect(root.querySelector('[data-testid="stacker-music-credit"]')?.getAttribute('href'))
      .toBe('https://github.com/soyezequiel/tetris-para-luna-negra');

    // The keys panel shows the binding read back from host.storage.
    fireEvent.click(root.querySelector('[data-testid="stacker-keys-open"]')!);
    await waitFor(() => expect(root.querySelector('[data-testid="keys-hard"]')?.textContent).toContain('J'));
    fireEvent.click(root.querySelector('[data-testid="stacker-keys-done"]')!);
    await settle();

    // Hard-drop on J until the well is full, then let a frame notice. A
    // second later than the start, as it would be on a real relay: events
    // are ordered by created_at, and a tie with the start sorts arbitrarily.
    t++;
    act(() => {
      for (let i = 0; i < 80; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
      }
      pump(3);
    });

    const ops = (name: string) => relay.events.filter((e) => e.tags.some((x) => x[0] === 'op' && x[1] === name));
    await waitFor(() => expect(ops('topout')).toHaveLength(1));
    const topout = ops('topout')[0];
    expect(topout.pubkey).toBe(A);
    expect(topout.tags).toContainEqual(['e', sessionId, '', 'root']);
    expect(JSON.parse(topout.content)).toEqual({ seat: A });

    // It comes back through the host and ends the match for everyone.
    await waitFor(() => expect(root.querySelector('[data-testid="game-status"]')?.textContent).toContain('won'));
    expect(root.querySelector('[data-testid="stacker-result"]')?.textContent).toContain('last one standing');
  });
});
