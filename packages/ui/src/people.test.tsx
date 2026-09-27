import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { connect } from '@obelisk/apps-sdk';
import { FakeHost, FakeRelay } from '@obelisk/apps-sdk/testing';

import { PeopleProvider, usePeople } from './people.js';

const A = 'a'.repeat(64);

function Name({ pk }: { pk: string }) {
  return <span data-testid="name">{usePeople().nameOf(pk)}</span>;
}

describe('PeopleProvider', () => {
  it('names people from the participants the host sent in init', async () => {
    const relay = new FakeRelay();
    const sessionId = await relay.createSession(A);
    const fake = new FakeHost({ relay, sessionId, me: A, participants: [{ pubkey: A, name: 'Ana' }] });
    const host = connect(fake.ctx);
    await host.ready;
    render(<PeopleProvider host={host}><Name pk={A} /></PeopleProvider>);
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Ana'));
  });

  it('falls back to a short key for someone the host never named', () => {
    render(<Name pk={A} />);
    expect(screen.getByTestId('name')).toHaveTextContent('aaaaaaaa…');
  });
});
