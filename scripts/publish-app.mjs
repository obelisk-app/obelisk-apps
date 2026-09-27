#!/usr/bin/env node
/**
 * Publish a built app: upload every file in dist/ to Blossom, then sign and
 * publish its kind 32390 manifest to the given relays.
 *
 *   node scripts/publish-app.mjs apps/chain-reaction \
 *     --nsec-file /root/.obelisk-apps/official-apps.nsec \
 *     --relay wss://public.obelisk.ar [--relay …] [--blossom https://blossom.obelisk.ar] \
 *     [--upload-only] [--dry-run]
 *
 * Uploads go to each --blossom server with a BUD-11 kind 24242 token scoped to
 * that server and that blob. Every upload is checked: the server must answer
 * with the same sha256 the manifest pins, or the publish stops. The manifest
 * is published only after every file is on every server.
 *
 * NIP-42: whitelisted relays close the REQ/EVENT with `auth-required:` until
 * the client authenticates; the pool's onauth signs the challenge with the
 * same key.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { decode, npubEncode } from 'nostr-tools/nip19';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

const args = process.argv.slice(2);
const appDir = resolve(args[0] ?? '');
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const flag = (name) => args.includes(`--${name}`);
const nsecFile = opt('nsec-file')[0];
const relays = opt('relay');
const blossoms = opt('blossom').length ? opt('blossom') : ['https://blossom.obelisk.ar'];
if (!args[0] || !nsecFile || (!relays.length && !flag('upload-only'))) {
  console.error('usage: publish-app.mjs <appDir> --nsec-file <file> --relay <wss://…> [--blossom <https://…>] [--upload-only] [--dry-run]');
  process.exit(2);
}

const decoded = decode(readFileSync(nsecFile, 'utf8').trim());
if (decoded.type !== 'nsec') throw new Error('not an nsec');
const sk = decoded.data;
const pk = getPublicKey(sk);
const draft = JSON.parse(readFileSync(join(appDir, 'dist/manifest.json'), 'utf8'));
const paths = draft.tags.filter((t) => t[0] === 'path');
const now = () => Math.floor(Date.now() / 1000);

console.log(`app ${draft.tags.find((t) => t[0] === 'd')[1]} as ${npubEncode(pk)}`);

for (const server of blossoms) {
  const host = new URL(server).host;
  for (const [, path, sha] of paths) {
    const bytes = readFileSync(join(appDir, 'dist', path));
    const head = await fetch(`${server}/${sha}`, { method: 'HEAD' });
    if (head.ok) { console.log(`  ${host} ${path} already there`); continue; }
    if (flag('dry-run')) { console.log(`  ${host} ${path} would upload ${bytes.length} bytes`); continue; }
    const auth = finalizeEvent({
      kind: 24242, created_at: now(), content: `Upload ${path}`,
      tags: [['t', 'upload'], ['x', sha], ['expiration', String(now() + 300)], ['server', host]],
    }, sk);
    const res = await fetch(`${server}/upload`, {
      method: 'PUT',
      body: bytes,
      headers: {
        Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
        'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'X-SHA-256': sha,
      },
    });
    if (!res.ok) throw new Error(`${host} refused ${path}: ${res.status} ${res.headers.get('x-reason') ?? ''}`);
    const desc = await res.json();
    if (desc.sha256 !== sha) throw new Error(`${host} stored ${path} as ${desc.sha256}, expected ${sha}`);
    console.log(`  ${host} ${path} uploaded (${bytes.length} bytes)`);
  }
}

if (flag('upload-only') || flag('dry-run')) process.exit(0);

const manifest = finalizeEvent({ kind: draft.kind, created_at: now(), content: draft.content, tags: draft.tags }, sk);
const pool = new SimplePool();
const onauth = (tmpl) => finalizeEvent(tmpl, sk);
const results = await Promise.allSettled(pool.publish(relays, manifest, { onauth }));
pool.close(relays);
let ok = 0;
results.forEach((r, i) => {
  if (r.status === 'fulfilled') { ok++; console.log(`  ${relays[i]} accepted ${manifest.id}`); }
  else console.log(`  ${relays[i]} refused: ${r.reason?.message ?? r.reason}`);
});
console.log(`address 32390:${pk}:${draft.tags.find((t) => t[0] === 'd')[1]}`);
process.exit(ok > 0 ? 0 : 1);
