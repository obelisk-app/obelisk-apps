/**
 * The HTTP surface: BUD-01 (GET/HEAD blob), BUD-02 (upload, delete, list)
 * and BUD-06 (HEAD /upload preflight). Plain node:http, no framework.
 *
 * Blobs are served with `Content-Security-Policy: sandbox` and `nosniff`:
 * this server stores app bundles, and a JS or HTML blob must never execute as
 * a page on blossom.obelisk.ar. Apps run only inside the frame, after the host
 * has verified the hash.
 */
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Admission } from './admission.js';
import { checkAuth } from './auth.js';
import type { Config } from './config.js';
import { BlobStore, TooLargeError, type BlobMeta } from './store.js';

const SHA_PATH = /^\/([0-9a-f]{64})(\.[a-z0-9]{1,10})?$/;
const LIST_PATH = /^\/list\/([0-9a-f]{64})$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export interface ServerDeps {
  cfg: Config;
  store: BlobStore;
  admission: Admission;
  now?: () => number;
  verify?: Parameters<typeof checkAuth>[0]['verify'];
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-SHA-256, X-Content-Length, X-Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Reason');
}

function fail(res: ServerResponse, status: number, reason: string, head = false): void {
  res.statusCode = status;
  res.setHeader('X-Reason', reason);
  if (head) { res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ message: reason }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function descriptor(cfg: Config, sha256: string, m: BlobMeta) {
  return { url: `${cfg.publicUrl}/${sha256}`, sha256, size: m.size, type: m.type, uploaded: m.uploaded };
}

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perHour: number) {}
  take(key: string, nowS: number): boolean {
    const since = nowS - 3600;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.perHour) { this.hits.set(key, list); return false; }
    list.push(nowS);
    this.hits.set(key, list);
    return true;
  }
}

export function createHandler(deps: ServerDeps) {
  const { cfg, store, admission } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const host = new URL(cfg.publicUrl).host;
  const limiter = new RateLimiter(cfg.uploadsPerHour);

  /** Everything an upload must pass before a byte is read. Shared by PUT and the BUD-06 preflight. */
  function gate(req: IncomingMessage, declaredSize: number | null, declaredSha: string | null) {
    const auth = checkAuth({ header: req.headers.authorization, verb: 'upload', sha256: declaredSha ?? undefined, host, now: now(), verify: deps.verify });
    if (!auth.ok) return { ok: false as const, status: auth.status, reason: auth.reason };
    const verdict = admission.judge(auth.pubkey);
    if (!verdict.allowed) {
      return { ok: false as const, status: 403, reason: verdict.reason === 'blocked' ? 'uploader is blocked' : 'uploader is outside this server\'s web of trust' };
    }
    if (declaredSize !== null) {
      if (declaredSize > cfg.maxBlobBytes) return { ok: false as const, status: 413, reason: `blob exceeds ${cfg.maxBlobBytes} bytes` };
      if (store.usageOf(auth.pubkey) + declaredSize > verdict.quotaBytes) return { ok: false as const, status: 413, reason: 'uploader quota exceeded' };
      if (store.totalBytes() + declaredSize > cfg.totalCapBytes) return { ok: false as const, status: 507, reason: 'server storage cap reached' };
      if (store.freeBytes() - declaredSize < cfg.minFreeBytes) return { ok: false as const, status: 507, reason: 'server disk is full' };
    }
    return { ok: true as const, pubkey: auth.pubkey, auth: auth.event, verdict };
  }

  function sizeHeader(v: string | string[] | undefined): number | null {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const declared = sizeHeader(req.headers['content-length']);
    const shaHeader = String(req.headers['x-sha-256'] ?? '').toLowerCase();
    const g = gate(req, declared, /^[0-9a-f]{64}$/.test(shaHeader) ? shaHeader : null);
    if (!g.ok) { req.resume(); return fail(res, g.status, g.reason); }
    if (!limiter.take(g.pubkey, now())) { req.resume(); return fail(res, 429, 'too many uploads, try again later'); }

    const remainingQuota = g.verdict.quotaBytes - store.usageOf(g.pubkey);
    const limit = Math.min(cfg.maxBlobBytes, remainingQuota, cfg.totalCapBytes - store.totalBytes());
    let received;
    try {
      received = await store.receive(req, Math.max(0, limit));
    } catch (err) {
      if (err instanceof TooLargeError) return fail(res, 413, 'blob exceeds the size or quota limit');
      throw err;
    }
    const covered = g.auth.tags.some((t) => t[0] === 'x' && t[1] === received.sha256);
    if (!covered) {
      store.discard(received.tmp);
      return fail(res, 403, 'authorization x tag does not match the uploaded blob');
    }
    if (store.freeBytes() < cfg.minFreeBytes) {
      store.discard(received.tmp);
      return fail(res, 507, 'server disk is full');
    }
    const rawType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const type = MIME.test(rawType) ? rawType : 'application/octet-stream';
    const meta = store.commit(received.tmp, received.sha256, { size: received.size, type, owner: g.pubkey, now: now() });
    json(res, 200, descriptor(cfg, received.sha256, meta));
  }

  function serveBlob(req: IncomingMessage, res: ServerResponse, sha256: string): void {
    const m = store.get(sha256);
    const head = req.method === 'HEAD';
    if (!m) return fail(res, 404, 'blob not found', head);
    res.setHeader('Content-Type', m.type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${sha256}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : m.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : m.size - 1;
      start = Math.max(0, start);
      end = Math.min(m.size - 1, end);
      if (start > end) {
        res.setHeader('Content-Range', `bytes */${m.size}`);
        return fail(res, 416, 'range not satisfiable', head);
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${m.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      if (head) { res.end(); return; }
      createReadStream(store.path(sha256), { start, end }).pipe(res);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', String(m.size));
    if (head) { res.end(); return; }
    createReadStream(store.path(sha256)).pipe(res);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(res);
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    try {
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Access-Control-Max-Age', '86400'); res.end(); return; }

      if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        return json(res, 200, {
          ok: true,
          blobs: store.count(),
          storedBytes: store.totalBytes(),
          capBytes: cfg.totalCapBytes,
          wot: admission.graphInfo,
        });
      }

      if (path === '/upload' && req.method === 'HEAD') {
        const size = sizeHeader(req.headers['x-content-length']);
        const sha = String(req.headers['x-sha-256'] ?? '').toLowerCase();
        if (size === null || !/^[0-9a-f]{64}$/.test(sha)) return fail(res, 400, 'X-Content-Length and X-SHA-256 are required', true);
        const g = gate(req, size, sha);
        if (!g.ok) return fail(res, g.status, g.reason, true);
        res.statusCode = 200; res.end(); return;
      }
      if (path === '/upload' && req.method === 'PUT') return await upload(req, res);

      const list = LIST_PATH.exec(path);
      if (list && req.method === 'GET') {
        return json(res, 200, store.listBy(list[1]).map(([sha, m]) => descriptor(cfg, sha, m)));
      }

      const blob = SHA_PATH.exec(path);
      if (blob && (req.method === 'GET' || req.method === 'HEAD')) return serveBlob(req, res, blob[1]);
      if (blob && req.method === 'DELETE') {
        const auth = checkAuth({ header: req.headers.authorization, verb: 'delete', sha256: blob[1], host, now: now(), verify: deps.verify });
        if (!auth.ok) return fail(res, auth.status, auth.reason);
        if (!store.release(blob[1], auth.pubkey)) return fail(res, 404, 'you have no blob with that hash');
        res.statusCode = 200; res.end(); return;
      }

      fail(res, 404, 'not found', req.method === 'HEAD');
    } catch (err) {
      if (!res.headersSent) fail(res, 500, 'internal error');
      else res.destroy();
      console.error('[blossom] request failed', req.method, path, err);
    }
  };
}

export function startServer(deps: ServerDeps): Server {
  const handle = createHandler(deps);
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 5 * 60_000;
  server.listen(deps.cfg.port, deps.cfg.host);
  return server;
}
