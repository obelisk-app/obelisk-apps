import { describe, expect, it } from 'vitest';

import { connect } from '../host.js';
import { HostError, type NostrEvent } from '../types.js';
import { FakeHost, FakeRelay } from './fake-host.js';

const HOST_PK = 'a'.repeat(64);
const B = 'b'.repeat(64);

async function setup(me: string | null = HOST_PK, extra: Partial<ConstructorParameters<typeof FakeHost>[0]> = {}) {
  const relay = new FakeRelay({ now: () => 1000 });
  const sessionId = await relay.createSession(HOST_PK);
  const fake = new FakeHost({ relay, sessionId, me, ...extra });
  const host = connect(fake.ctx);
  const init = await host.ready;
  return { relay, sessionId, fake, host, init };
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: HostError) => e.code);

describe('FakeHost + connect()', () => {
  it('delivers init and the session backlog', async () => {
    const { host, init, sessionId } = await setup();
    expect(init).toMatchObject({ api: 1, me: HOST_PK, session: { id: sessionId, createdBy: HOST_PK } });
    const batches: NostrEvent[][] = [];
    host.onEvents((evs) => batches.push(evs));
    await new Promise((r) => setTimeout(r, 0)); // the backlog push follows init
    expect(batches[0].map((e) => e.id)).toEqual([sessionId]);
  });

  it('builds the event itself: kind, h, t, op, e and n', async () => {
    const { host, relay, sessionId } = await setup();
    const res = await host.publish({ op: 'move', content: '{"n":0}', n: 0 });
    const ev = relay.events.find((e) => e.id === res.id)!;
    expect(ev.kind).toBe(2390);
    expect(ev.pubkey).toBe(HOST_PK);
    expect(ev.tags).toEqual([
      ['h', 'test-channel'], ['t', 'obelisk-app'], ['op', 'move'], ['e', sessionId, '', 'root'], ['n', '0'],
    ]);
  });

  it('echoes the published event back through onEvents', async () => {
    const { host } = await setup();
    const seen: string[] = [];
    host.onEvents((evs) => seen.push(...evs.map((e) => e.id)));
    const { id } = await host.publish({ op: 'ping', content: '{}' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toContain(id);
  });

  it('refuses create, bad op names, oversized content, bad n and long status', async () => {
    const { host } = await setup(HOST_PK, { limits: { contentBytes: 10 } });
    expect(await code(host.publish({ op: 'create' }))).toBe('forbidden-op');
    expect(await code(host.publish({ op: 'Move' }))).toBe('forbidden-op');
    expect(await code(host.publish({ op: 'x'.repeat(33) }))).toBe('forbidden-op');
    expect(await code(host.publish({ op: 'move', content: 'x'.repeat(11) }))).toBe('too-large');
    expect(await code(host.publish({ op: 'move', n: -1 }))).toBe('bad-n');
    expect(await code(host.publish({ op: 'move', n: 1.5 }))).toBe('bad-n');
  });

  it('caps status lines at 140 characters', async () => {
    const { host } = await setup();
    expect(await code(host.publish({ op: 'status', content: '{"text":"hi"}' }))).toBe('ok');
    expect(await code(host.publish({ op: 'status', content: JSON.stringify({ text: 'x'.repeat(141) }) }))).toBe('too-large');
  });

  it('refuses publishing for a signed-out spectator', async () => {
    const { host } = await setup(null);
    expect(await code(host.publish({ op: 'join' }))).toBe('signed-out');
  });

  it('rate-limits bursts with a 20-deep bucket', async () => {
    let ms = 0;
    const { host } = await setup(HOST_PK, { clockMs: () => ms });
    const results = await Promise.all(Array.from({ length: 21 }, () => code(host.publish({ op: 'ping' }))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(20);
    expect(results[20]).toBe('rate-limited');
    ms += 1000; // 5 tokens back after a second
    expect(await code(host.publish({ op: 'ping' }))).toBe('ok');
  });

  it('scopes storage per frame and enforces its quota', async () => {
    const { host } = await setup(HOST_PK, { limits: { storageBytes: 20 } });
    await host.storage.set('keys', 'wasd');
    expect(await host.storage.get('keys')).toBe('wasd');
    expect(await code(host.storage.set('big', 'x'.repeat(30)))).toBe('quota');
    await host.storage.set('keys', null);
    expect(await host.storage.get('keys')).toBeNull();
  });

  it('serves only pinned assets and answers unknown requests with unsupported', async () => {
    const { host, init } = await setup(HOST_PK, { assets: { '/music/a.mp3': new Blob(['mp3']) } });
    expect(init.paths).toEqual(['/music/a.mp3']);
    expect(await (await host.asset('/music/a.mp3')).text()).toBe('mp3');
    expect(await code(host.asset('/etc/passwd'))).toBe('not-found');
  });

  it('only resolves profiles for pubkeys that authored an event in the session', async () => {
    const { host } = await setup(HOST_PK, {
      participants: [{ pubkey: HOST_PK, name: 'Ana' }, { pubkey: B, name: 'Beto' }],
    });
    const [ana, beto] = await host.profiles([HOST_PK, B]);
    expect(ana.name).toBe('Ana');
    expect(beto.name).not.toBe('Beto'); // B never published here
  });

  it('forwards connection changes', async () => {
    const { host, fake } = await setup();
    const seen: boolean[] = [];
    host.onConnection((c) => seen.push(c.connected));
    fake.setConnection({ connected: false, since: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([true, false]);
  });

  it('rejects pending calls when disposed', async () => {
    const { host, fake } = await setup();
    fake.dispose();
    const p = host.publish({ op: 'ping' });
    host.dispose();
    expect(await code(p)).toBe('closed');
  });
});
