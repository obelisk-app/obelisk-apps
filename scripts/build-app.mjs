#!/usr/bin/env node
/**
 * Build one app into what gets published:
 *
 *   dist/index.js       the entry: one self-contained ES module (a blob: URL
 *                       can't resolve imports), with its CSS inlined
 *   dist/<asset paths>  everything under the app's assets/, as-is
 *   dist/manifest.json  the kind 32390 draft: `path` tags with sha256s and
 *                       the NIP-5A aggregate `x` (docs/app-format.md §1)
 *
 * Usage: node scripts/build-app.mjs apps/chain-reaction
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const MAX_ENTRY = 2 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;

const appDir = resolve(process.argv[2] ?? '.');
const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const meta = pkg.obelisk ?? {};
const dist = join(appDir, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. CSS: Tailwind v4 over the app and the shared shell.
const cssOut = join(dist, '.app.css');
execFileSync(join(root, 'node_modules/.bin/tailwindcss'), ['-i', join(appDir, 'src/app.css'), '-o', cssOut, '--minify'], {
  cwd: appDir, stdio: ['ignore', 'ignore', 'inherit'],
});
const css = readFileSync(cssOut, 'utf8');
rmSync(cssOut);

// 2. JS: one ESM file, React included, the CSS import replaced by the compiled string.
await build({
  entryPoints: [join(appDir, 'src/main.tsx')],
  outfile: join(dist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  plugins: [{
    name: 'inline-app-css',
    setup(b) {
      b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'app-css' }));
      b.onLoad({ filter: /.*/, namespace: 'app-css' }, () => ({ contents: css, loader: 'text' }));
    },
  }],
});

// 3. Assets, copied under their published paths.
const assetsDir = join(appDir, 'assets');
if (existsSync(assetsDir)) cpSync(assetsDir, dist, { recursive: true });

// 4. The manifest draft: every published file, hashed.
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name !== 'manifest.json' && !name.endsWith('.md')) files.push(p);
  }
})(dist);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const paths = files
  .map((p) => ['path', `/${relative(dist, p).split('\\').join('/')}`, sha(p)])
  .sort((a, b) => (a[1] < b[1] ? -1 : 1));
const aggregate = createHash('sha256')
  .update(paths.map(([, path, hash]) => `${hash} ${path}\n`).sort().join(''))
  .digest('hex');

const entry = statSync(join(dist, 'index.js')).size;
const total = files.reduce((n, p) => n + statSync(p).size, 0);
if (entry > MAX_ENTRY) throw new Error(`entry is ${entry} bytes, over the ${MAX_ENTRY} limit`);
if (total > MAX_TOTAL) throw new Error(`app is ${total} bytes, over the ${MAX_TOTAL} limit`);

const tags = [
  ['d', meta.slug],
  ['title', meta.title],
  ['description', meta.description ?? pkg.description],
  ['api', '1'],
  ...(meta.types ?? ['game']).map((t) => ['t', t]),
  ['version', pkg.version],
  ...(meta.players ? [['players', String(meta.players[0]), String(meta.players[1])]] : []),
  ...(meta.realtime !== undefined ? [['realtime', String(meta.realtime)]] : []),
  ...paths,
  ...(meta.icon ? [['icon', meta.icon]] : []),
  ['x', aggregate, 'aggregate'],
  ['server', 'https://blossom.obelisk.ar'],
  ['server', 'https://nostr.download'],
  ['source', 'https://github.com/obelisk-app/obelisk-apps'],
  ['alt', `Obelisk app: ${meta.title}`],
];
writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ kind: 32390, content: meta.content ?? '', tags }, null, 2));
console.log(`${meta.slug}: index.js ${(entry / 1024).toFixed(1)} KiB, ${files.length} files, ${(total / 1024).toFixed(1)} KiB total, x=${aggregate.slice(0, 12)}…`);
