import { describe, expect, it } from 'vitest';

import { connect } from '../host.js';
import { FakeHost, FakeRelay } from '../testing/fake-host.js';
import { openTable, RECONNECT_CLAIM_GRACE_S, TIMEOUT_CLAIM_GRACE_S, type Table } from './table.js';
import type { GameDefinition } from './types.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** Fixture: players alternate adding 1; whoever makes the total 3 wins. */
const race: GameDefinition<{ total: number }, { add: number }> = {
  type: 'race', displayName: 'Race', description: 'to three',
  minPlayers: 2, maxPlayers: 2, defaultTurnTimeoutS: 30,
  initialState: () => ({ total: 0 }),
  firstTurn: (p) => p[0],
  validateAction: (_s, a) => ({ ok: a.add === 1 }),
  applyAction: (s, a, seat, p) => {
    const total = s.total + a.add;
    return total >= 3
      ? { state: { total }, nextTurn: null, winner: seat }
      : { state: { total }, nextTurn: p[(p.indexOf(seat) + 1) % p.length] };
  },
  onTimeout: (s, seat, p) => ({ state: s, nextTurn: null, winner: p.find((x) => x !== seat) ?? null }),
};

const tick = () => new Promise((r) => setTimeout(r, 5));
async function settle(n = 4) { for (let i = 0; i < n; i++) await tick(); }

async function twoPlayers(opts: { now?: () => number; connectedSince?: number } = {}) {
  let t = 1000;
  const now = opts.now ?? (() => t);
  const relay = new FakeRelay({ now });
  const sessionId = await relay.createSession(A);
  const mk = async (me: string) => {
    const fake = new FakeHost({ relay, sessionId, me, connection: { connected: true, since: opts.connectedSince ?? 0 } });
    const table = await openTable(connect(fake.ctx), race, { now, tickMs: 5 });
    return { fake, table };
  };
  const a = await mk(A);
  const b = await mk(B);
  await settle();
  const step = () => { t += 1; };
  return { relay, a, b, setNow: (v: number) => { t = v; }, now, step };
}

const moves = (relay: FakeRelay, op: string) => relay.events.filter((e) => e.tags.some((t) => t[0] === 'op' && t[1] === op));

describe('openTable', () => {
  it('plays a whole game across two hosts on one relay', async () => {
    const { a, b, step } = await twoPlayers();
    expect(a.table.session?.status).toBe('waiting');
    expect(b.table.canJoin()).toBe(true);
    step(); await b.table.join(); await settle();
    expect(a.table.canStart()).toBe(true);
    step(); await a.table.start([{ id: A, by: A }, { id: B, by: B }], {}, 0); await settle();
    expect(a.table.isMyTurn()).toBe(true);
    expect(b.table.isMyTurn()).toBe(false);
    step(); await a.table.move({ add: 1 }); await settle();
    step(); await b.table.move({ add: 1 }); await settle();
    step(); await a.table.move({ add: 1 }); await settle();
    for (const t of [a.table, b.table] as Table[]) {
      expect(t.session).toMatchObject({ status: 'finished', winner: A, state: { total: 3 } });
    }
  });

  it('drops an illegal move on every client', async () => {
    const { a, b, step } = await twoPlayers();
    step(); await b.table.join(); await settle();
    step(); await a.table.start([{ id: A, by: A }, { id: B, by: B }], {}, 0); await settle();
    step(); await a.table.move({ add: 2 }); await settle();
    expect(b.table.session?.state).toEqual({ total: 0 });
    expect(b.table.session?.turnIndex).toBe(0);
  });

  it('claims the clock on the other player once deadline + grace has passed', async () => {
    const { relay, a, b, setNow, step } = await twoPlayers();
    step(); await b.table.join(); await settle();
    step(); await a.table.start([{ id: A, by: A }, { id: B, by: B }], {}, 30); await settle();
    const deadline = 1002 + 30;
    setNow(deadline + TIMEOUT_CLAIM_GRACE_S - 1); await settle();
    expect(moves(relay, 'timeout')).toHaveLength(0);
    setNow(deadline + TIMEOUT_CLAIM_GRACE_S); await settle();
    const claims = moves(relay, 'timeout');
    expect(claims).toHaveLength(1);
    expect(claims[0].pubkey).toBe(B); // never A against its own turn
    expect(a.table.session).toMatchObject({ status: 'finished', winner: B });
  });

  it('waits out the reconnect grace before claiming', async () => {
    const { relay, a, b, setNow, step } = await twoPlayers({ connectedSince: 1030 });
    step(); await b.table.join(); await settle();
    step(); await a.table.start([{ id: A, by: A }, { id: B, by: B }], {}, 30); await settle();
    setNow(1040); await settle();
    expect(moves(relay, 'timeout')).toHaveLength(0);
    setNow(1030 + RECONNECT_CLAIM_GRACE_S); await settle();
    expect(moves(relay, 'timeout')).toHaveLength(1);
  });

  it('does not claim while disconnected', async () => {
    const { relay, a, b, setNow, step } = await twoPlayers();
    step(); await b.table.join(); await settle();
    step(); await a.table.start([{ id: A, by: A }, { id: B, by: B }], {}, 30); await settle();
    b.fake.setConnection({ connected: false, since: null }); await settle();
    setNow(2000); await settle();
    expect(moves(relay, 'timeout')).toHaveLength(0);
  });

  it('publishes the card status from the creator only, and only on change', async () => {
    const { relay, a, b, step } = await twoPlayers();
    step(); await b.table.join(); await settle();
    const statuses = moves(relay, 'status');
    expect(statuses.every((e) => e.pubkey === A)).toBe(true);
    expect(a.fake.statusText).toBe('Waiting for players · 2/2');
    const count = statuses.length;
    await settle();
    expect(moves(relay, 'status')).toHaveLength(count);
  });
});

describe('realtime games', () => {
  interface Match { lines: Record<string, number>; out: string[] }
  const blocks: GameDefinition = {
    ...race,
    type: 'blocks',
    minPlayers: 1,
    realtime: {
      ops: ['clear', 'topout'],
      initial: (_seed, seats) => ({ lines: Object.fromEntries(seats.map((s) => [s, 0])), out: [] }),
      apply: (m, ev) => {
        const match = m as Match;
        if (ev.op === 'clear') return { ...match, lines: { ...match.lines, [ev.seat]: match.lines[ev.seat] + Number(ev.body.lines ?? 0) } };
        return { ...match, out: [...match.out, ev.seat] };
      },
      over: (m) => (m as Match).out.length >= Object.keys((m as Match).lines).length - 1,
      winner: (m) => Object.keys((m as Match).lines).find((s) => !(m as Match).out.includes(s)) ?? null,
    },
  };

  it('routes declared ops through the match reducer and attributes them to the signer\'s seat', async () => {
    let t = 1000;
    const relay = new FakeRelay({ now: () => t });
    const sessionId = await relay.createSession(A);
    const mk = async (me: string) => openTable(connect(new FakeHost({ relay, sessionId, me }).ctx), blocks, { now: () => t });
    const a = await mk(A);
    const b = await mk(B);
    await settle();
    t++; await b.join(); await settle();
    t++; await a.start([{ id: A, by: A }, { id: B, by: B }], { seed: 7 }, 0); await settle();
    t++;
    expect(a.session?.match).toEqual({ lines: { [A]: 0, [B]: 0 }, out: [] });
    await a.send('clear', { seat: A, lines: 2 });
    // B tries to speak for A's seat: dropped.
    await b.send('clear', { seat: A, lines: 9 });
    // Undeclared op: ignored.
    await b.send('cheat', { seat: B });
    await settle();
    expect((a.session?.match as Match).lines).toEqual({ [A]: 2, [B]: 0 });
    await b.send('topout', { seat: B }); await settle();
    expect(a.session).toMatchObject({ status: 'finished', winner: A, draw: false });
  });
});
