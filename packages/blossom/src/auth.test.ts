import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import { checkAuth } from './auth.js';

const sk = generateSecretKey();
const NOW = 1_800_000_000;
const SHA = 'a'.repeat(64);

function header(tags: string[][], over: { kind?: number; created_at?: number } = {}) {
  const ev = finalizeEvent({ kind: over.kind ?? 24242, created_at: over.created_at ?? NOW, content: '', tags }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`;
}
const good = (extra: string[][] = []) => header([['t', 'upload'], ['x', SHA], ['expiration', String(NOW + 60)], ...extra]);
const check = (h: string | undefined, verb: 'upload' | 'delete' = 'upload') =>
  checkAuth({ header: h, verb, sha256: SHA, host: 'blossom.obelisk.ar', now: NOW });

describe('checkAuth', () => {
  it('accepts a valid upload token', () => {
    const r = check(good());
    expect(r).toMatchObject({ ok: true, pubkey: getPublicKey(sk) });
  });
  it('accepts a token scoped to this server', () => {
    expect(check(good([['server', 'blossom.obelisk.ar']])).ok).toBe(true);
  });
  it('rejects a token scoped to another server', () => {
    expect(check(good([['server', 'blossom.primal.net']]))).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a missing or malformed header', () => {
    expect(check(undefined)).toMatchObject({ ok: false, status: 401 });
    expect(check('Bearer xyz')).toMatchObject({ ok: false, status: 401 });
    expect(check('Nostr !!!')).toMatchObject({ ok: false, status: 401 });
  });
  it('rejects the wrong kind, verb, expiry and future timestamps', () => {
    expect(check(header([['t', 'upload'], ['x', SHA], ['expiration', String(NOW + 60)]], { kind: 1 })).ok).toBe(false);
    expect(check(good(), 'delete').ok).toBe(false);
    expect(check(header([['t', 'upload'], ['x', SHA], ['expiration', String(NOW - 1)]])).ok).toBe(false);
    expect(check(header([['t', 'upload'], ['x', SHA]])).ok).toBe(false);
    expect(check(header([['t', 'upload'], ['x', SHA], ['expiration', String(NOW + 600)]], { created_at: NOW + 3600 })).ok).toBe(false);
  });
  it('rejects a token for a different blob', () => {
    const h = header([['t', 'upload'], ['x', 'b'.repeat(64)], ['expiration', String(NOW + 60)]]);
    expect(check(h)).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a tampered signature', () => {
    const ev = JSON.parse(Buffer.from(good().slice(6), 'base64').toString());
    ev.tags.push(['x', 'c'.repeat(64)]);
    expect(check(`Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`)).toMatchObject({ ok: false, reason: 'invalid signature' });
  });
});
