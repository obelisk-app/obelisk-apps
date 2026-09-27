import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Admission } from './admission.js';
import { loadConfig, type Config } from './config.js';
import { createHandler } from './server.js';
import { BlobStore } from './store.js';

const allowedSk = generateSecretKey();
const tier2Sk = generateSecretKey();
const strangerSk = generateSecretKey();
const blockedSk = generateSecretKey();

let server: Server;
let base: string;
let cfg: Config;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function auth(sk: Uint8Array, verb: string, x: string, extra: string[][] = []) {
  const now = Math.floor(Date.now() / 1000);
  const ev = finalizeEvent({ kind: 24242, created_at: now, content: '', tags: [['t', verb], ['x', x], ['expiration', String(now + 60)], ...extra] }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`;
}

function put(body: Buffer | string, sk: Uint8Array, opts: { x?: string; type?: string } = {}) {
  return fetch(`${base}/upload`, {
    method: 'PUT',
    body,
    headers: { Authorization: auth(sk, 'upload', opts.x ?? sha(body)), 'Content-Type': opts.type ?? 'text/javascript' },
  });
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'blossom-srv-'));
  cfg = {
    ...loadConfig({ BLOSSOM_DATA_DIR: dataDir, BLOSSOM_PUBLIC_URL: 'https://blossom.obelisk.ar' }),
    maxBlobBytes: 1024,
    tier1QuotaBytes: 4096,
    tier2QuotaBytes: 100,
    minFreeBytes: 0,
    blocked: [getPublicKey(blockedSk)],
    manualAllow: [getPublicKey(allowedSk), getPublicKey(blockedSk)],
  };
  const admission = new Admission(cfg, {
    builtAt: 0, maxHops: 2, roots: [], truncated: false, contactListsFetched: 0,
    hops: { [getPublicKey(tier2Sk)]: 2 },
  });
  const handle = createHandler({ cfg, store: new BlobStore(dataDir), admission });
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('blossom server', () => {
  const bundle = 'export default function main(){}';

  it('stores an upload from an admitted key and returns a descriptor', async () => {
    const res = await put(bundle, allowedSk);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sha256: sha(bundle), size: bundle.length, type: 'text/javascript',
      url: `https://blossom.obelisk.ar/${sha(bundle)}`,
    });
  });

  it('serves the blob sandboxed so it can never run as a page here', async () => {
    const res = await fetch(`${base}/${sha(bundle)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bundle);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers HEAD, extensions and byte ranges', async () => {
    expect((await fetch(`${base}/${sha(bundle)}.js`, { method: 'HEAD' })).status).toBe(200);
    const r = await fetch(`${base}/${sha(bundle)}`, { headers: { Range: 'bytes=0-5' } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe('export');
    expect((await fetch(`${base}/${'0'.repeat(64)}`)).status).toBe(404);
  });

  it('lists what a pubkey uploaded', async () => {
    const list = await (await fetch(`${base}/list/${getPublicKey(allowedSk)}`)).json();
    expect(list.map((d: { sha256: string }) => d.sha256)).toContain(sha(bundle));
  });

  it('refuses keys outside the web of trust, and blocked keys even when allowlisted', async () => {
    const out = await put('x', strangerSk);
    expect(out.status).toBe(403);
    expect(out.headers.get('x-reason')).toMatch(/web of trust/);
    const blocked = await put('y', blockedSk);
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('x-reason')).toMatch(/blocked/);
  });

  it('refuses a body that does not match the authorized hash', async () => {
    const res = await put('actual body', allowedSk, { x: sha('something else') });
    expect(res.status).toBe(403);
  });

  it('enforces the per-blob size cap and the tier 2 quota', async () => {
    expect((await put(Buffer.alloc(2048, 1), allowedSk)).status).toBe(413);
    expect((await put(Buffer.alloc(80, 2), tier2Sk)).status).toBe(200);
    expect((await put(Buffer.alloc(80, 3), tier2Sk)).status).toBe(413);
  });

  it('answers the BUD-06 preflight without reading a body', async () => {
    const x = sha('preflight');
    const ok = await fetch(`${base}/upload`, { method: 'HEAD', headers: { Authorization: auth(allowedSk, 'upload', x), 'X-SHA-256': x, 'X-Content-Length': '9' } });
    expect(ok.status).toBe(200);
    const big = await fetch(`${base}/upload`, { method: 'HEAD', headers: { Authorization: auth(allowedSk, 'upload', x), 'X-SHA-256': x, 'X-Content-Length': '999999' } });
    expect(big.status).toBe(413);
  });

  it('lets only an owner delete, and removes the file with the last owner', async () => {
    const x = sha(bundle);
    const stranger = await fetch(`${base}/${x}`, { method: 'DELETE', headers: { Authorization: auth(strangerSk, 'delete', x) } });
    expect(stranger.status).toBe(404);
    const owner = await fetch(`${base}/${x}`, { method: 'DELETE', headers: { Authorization: auth(allowedSk, 'delete', x) } });
    expect(owner.status).toBe(200);
    expect((await fetch(`${base}/${x}`)).status).toBe(404);
  });

  it('reports health', async () => {
    const h = await (await fetch(`${base}/health`)).json();
    expect(h).toMatchObject({ ok: true, wot: { admitted: 1, maxHops: 2 } });
  });
});
