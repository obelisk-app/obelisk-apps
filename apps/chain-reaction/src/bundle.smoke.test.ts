/**
 * Loads the BUILT bundle (dist/index.js, run `npm run build` first) the way
 * the frame loader does — default export called with { port, root } — against
 * the in-memory host, and checks a table actually renders and plays.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeHost, FakeRelay } from '@obelisk/apps-sdk/testing';

const bundle = join(__dirname, '../dist/index.js');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const settle = () => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!existsSync(bundle))('built bundle', () => {
  it('mounts through the loader contract, injects its CSS, and plays a move', async () => {
    let t = Math.floor(Date.now() / 1000);
    const relay = new FakeRelay({ now: () => t });
    const sessionId = await relay.createSession(A);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const fake = new FakeHost({ relay, sessionId, me: A, participants: [{ pubkey: A, name: 'Ana' }, { pubkey: B, name: 'Bruno' }] });
    const main = (await import(pathToFileURL(bundle).href)).default as (ctx: unknown) => Promise<unknown>;
    await main({ port: fake.ctx.port, root });
    await settle();

    expect(document.head.querySelector('style')?.textContent).toContain('cr-orb');
    await waitFor(() => expect(root.querySelector('[data-testid="game-roster"]')?.textContent).toContain('Ana'));

    // B joins from another client; A starts a small board and drops an orb.
    t++; await relay.inject(B, { tags: [['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'join'], ['e', sessionId, '', 'root']], content: '{}' });
    t++; await relay.inject(A, {
      tags: [['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'start'], ['e', sessionId, '', 'root']],
      content: JSON.stringify({ seats: [A, B], opts: { size: 'small' }, turnTimeoutS: 0 }),
    });
    await waitFor(() => expect(root.querySelectorAll('.cr-matrix button').length).toBe(35)); // 5×7
    const cells = root.querySelectorAll('.cr-matrix button');

    t++; (cells[0] as HTMLElement).click();
    const moves = () => relay.events.filter((e) => e.tags.some((x) => x[0] === 'op' && x[1] === 'move'));
    await waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0].pubkey).toBe(A);
    expect(JSON.parse(moves()[0].content)).toMatchObject({ n: 0, action: { cell: 0 } });
  });
});
