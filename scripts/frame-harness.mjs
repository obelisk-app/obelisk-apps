#!/usr/bin/env node
/**
 * Run a BUILT app in real Chromium, through the real frame.obelisk.ar loader,
 * against a minimal in-page host — the checks jsdom can't do (sandboxed
 * origin, CORS on the loader, layout, real drag/click).
 *
 *   node scripts/frame-harness.mjs apps/chess --stage board --click e2,e4 \
 *     [--opts '{"size":"small"}'] [--accent '#a855f7'] [--size 768x640] [--out shot.png]
 *
 * Stages: lobby (host alone), joined (+ a second player), board (started).
 * --click takes a,b,… `[data-square=…]` or CSS selectors to click in order
 * inside the frame. Prints every message the app sends the host.
 *
 * The page is served as https://test.obelisk.ar/__harness via request
 * interception (so the loader's origin allowlist applies as in production);
 * nothing is deployed and no relay is touched.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const appDir = resolve(args[0]);
const stage = opt('stage', 'board');
const [w, h] = opt('size', '768x640').split('x').map(Number);
const entry = readFileSync(join(appDir, 'dist/index.js'));
const clicks = (opt('click', '') || '').split(',').filter(Boolean);

const html = `<!doctype html><html><body style="margin:0;background:#111">
<iframe id="f" src="https://frame.obelisk.ar/v1/" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" style="width:${w}px;height:${h}px;border:0"></iframe>
<script>
const f = document.getElementById('f');
const me = 'a'.repeat(64), B = 'b'.repeat(64), S = '5'.repeat(64);
const t0 = Math.floor(Date.now() / 1000) - 30;
let port1, seq = 100;
const ev = (id, pk, at, op, body) => ({ id: String(id).repeat(64).slice(0, 64), pubkey: pk, created_at: at, kind: 2390, sig: '',
  tags: [['h','g'],['t','obelisk-app'],['op',op], ...(op === 'create' ? [] : [['e', S, '', 'root']])], content: JSON.stringify(body) });
window.addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || e.data?.type !== 'hello') return;
  const entry = new Blob([await (await fetch('/__entry.js')).arrayBuffer()], { type: 'text/javascript' });
  // Stand-in profile pictures, so avatar rendering is exercised.
  const pic = async (bg, fg, letter) => {
    const c = new OffscreenCanvas(96, 96); const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 96, 96); g.fillStyle = fg; g.font = 'bold 56px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(letter, 48, 52);
    return c.convertToBlob({ type: 'image/png' });
  };
  const avatars = [await pic('#2563eb', '#fff', 'F'), await pic('#ea580c', '#fff', 'B')];
  const ch = new MessageChannel(); port1 = ch.port1;
  port1.onmessage = (m) => {
    const r = m.data; console.log('APP ' + JSON.stringify(r).slice(0, 220));
    if (r.type === 'publish') {
      const e2 = ev(seq++, me, Math.floor(Date.now() / 1000), r.op, r.content ? JSON.parse(r.content) : {});
      port1.postMessage({ re: r.id, ok: true, result: { id: e2.id, created_at: e2.created_at } });
      port1.postMessage({ type: 'events', events: [e2] });
    } else if ('id' in r) port1.postMessage({ re: r.id, ok: true, result: null });
  };
  port1.start();
  port1.postMessage({ type: 'init', api: 1, app: { address: 'x', title: 'App', author: 'f'.repeat(64) },
    session: { id: S, createdBy: me, createdAt: t0, channelName: 'g' }, me,
    participants: [{ pubkey: me, name: 'Fabricio', avatar: avatars[0] }, { pubkey: B, name: 'Bruno', avatar: avatars[1] }], paths: ['/index.js'], locale: 'en',
    theme: { mode: 'dark', accent: ${JSON.stringify(opt('accent', '#a855f7'))} },
    limits: { contentBytes: 65536, publishPerSecond: 5, storageBytes: 262144 }, connection: { connected: true, since: 0 } });
  const evs = [ev(5, me, t0, 'create', { nonce: 'n' })];
  if (${JSON.stringify(stage)} !== 'lobby') evs.push(ev(6, B, t0 + 1, 'join', {}));
  if (${JSON.stringify(stage)} === 'board') evs.push(ev(7, me, t0 + 2, 'start', { seats: [me, B], opts: ${opt('opts', '{}')}, turnTimeoutS: 60 }));
  port1.postMessage({ type: 'events', events: evs });
  f.contentWindow.postMessage({ obelisk: 1, type: 'boot', entry }, '*', [ch.port2]);
});
</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: w + 20, height: h + 20 } });
page.on('console', (m) => console.log(m.text().slice(0, 240)));
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route(/https:\/\/test\.obelisk\.ar\/__harness.*/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
await page.route('https://test.obelisk.ar/__entry.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: entry }));
await page.goto('https://test.obelisk.ar/__harness');
await page.waitForTimeout(3500);
const frame = page.frames().find((fr) => fr.url().includes('frame.obelisk.ar'));
for (const c of clicks) {
  const sel = /^[a-h][1-8]$/.test(c) ? `[data-square="${c}"]` : c;
  await frame.click(sel);
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1200);
const m = await frame.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
console.log(`SCROLL ${m.sw}x${m.sh} in ${w}x${h}`);
await page.screenshot({ path: opt('out', 'harness.png') });
await browser.close();
