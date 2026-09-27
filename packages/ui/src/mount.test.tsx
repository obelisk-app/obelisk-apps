import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeHost, FakeRelay } from '@obelisk/apps-sdk/testing';

import { mountGame } from './mount.js';
import { fixtureUi } from './test-fixtures.js';

const A = 'a'.repeat(64);

describe('mountGame', () => {
  it('renders the roster with the names the host sent, and applies the accent', async () => {
    const relay = new FakeRelay();
    const sessionId = await relay.createSession(A);
    const fake = new FakeHost({ relay, sessionId, me: A, participants: [{ pubkey: A, name: 'Ana' }] });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await mountGame({ port: fake.ctx.port, root }, fixtureUi, '.x{}');
    await waitFor(() => expect(root.querySelector('[data-testid="game-roster"]')?.textContent).toContain('Ana'));
    expect(document.documentElement.style.getPropertyValue('--color-lc-green')).toBe('#b4f953');
    expect(document.head.querySelector('style')?.textContent).toBe('.x{}');
  });
});
