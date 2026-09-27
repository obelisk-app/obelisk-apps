/**
 * obelisk-blossom: boot, the hourly WoT rebuild, SIGHUP list reload.
 *
 *   SIGHUP  re-reads <dataDir>/config.json (manualAllow, blocked,
 *           referenceAccounts, maxHops) and rebuilds the graph if the roots
 *           or depth changed — the relay's "Sync" button, as a signal.
 */
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

import { Admission } from './admission.js';
import { loadConfig, type Config } from './config.js';
import { startServer } from './server.js';
import { BlobStore } from './store.js';
import { acceptRebuild, buildGraph, loadGraph, saveGraph, type ContactList, type GraphSnapshot } from './wot-graph.js';

// Node 22's built-in WebSocket re-fires `error` from inside close(), and
// nostr-tools 2.25's onerror calls close() -> unbounded recursion on the first
// unreachable relay ("Maximum call stack size exceeded", crash loop under pm2).
// The `ws` package doesn't, so the pool uses it.
useWebSocketImplementation(WebSocket);

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

function poolFetcher(relays: string[]) {
  return async (authors: string[]): Promise<ContactList[]> => {
    const pool = new SimplePool();
    try {
      return await pool.querySync(relays, { kinds: [3], authors }, { maxWait: 12_000 });
    } finally {
      try { pool.close(relays); } catch { /* best effort */ }
    }
  };
}

const cfg: Config = loadConfig();
const store = new BlobStore(cfg.dataDir);
let graph: GraphSnapshot | null = loadGraph(cfg.dataDir);
const admission = new Admission(cfg, graph);
let building = false;

async function rebuild(reason: string): Promise<void> {
  if (building) return;
  building = true;
  const started = Date.now();
  try {
    const next = await buildGraph({
      roots: cfg.referenceAccounts,
      maxHops: cfg.maxHops,
      fetchBudget: cfg.fetchBudget,
      fetch: poolFetcher(cfg.followRelays),
    });
    const admitted = Object.keys(next.hops).length;
    if (!acceptRebuild(graph, next)) {
      log('follow graph rebuild discarded (less than half the previous admitted set)', {
        reason, admitted, previous: graph ? Object.keys(graph.hops).length : 0,
      });
      return;
    }
    graph = next;
    admission.setGraph(next);
    saveGraph(cfg.dataDir, next);
    log('follow graph rebuilt', {
      reason, ms: Date.now() - started, contactLists: next.contactListsFetched,
      admitted, maxHops: next.maxHops, truncated: next.truncated,
    });
  } catch (err) {
    log('follow graph rebuild failed', { reason, error: String(err) });
  } finally {
    building = false;
  }
}

const server = startServer({ cfg, store, admission });
log('obelisk-blossom listening', {
  host: cfg.host, port: cfg.port, dataDir: cfg.dataDir, references: cfg.referenceAccounts.length,
  maxHops: cfg.maxHops, cachedGraph: admission.graphInfo,
});

void rebuild('startup');
const timer = setInterval(() => void rebuild('interval'), cfg.rebuildIntervalMs);

process.on('SIGHUP', () => {
  const next = loadConfig();
  const rootsChanged = next.maxHops !== cfg.maxHops
    || next.referenceAccounts.join() !== cfg.referenceAccounts.join()
    || next.followRelays.join() !== cfg.followRelays.join();
  // Mutate in place: Admission holds this same object and reads maxHops from it.
  Object.assign(cfg, {
    referenceAccounts: next.referenceAccounts, manualAllow: next.manualAllow, blocked: next.blocked,
    followRelays: next.followRelays, maxHops: next.maxHops,
  });
  admission.setLists({ blocked: next.blocked, manualAllow: next.manualAllow });
  log('config reloaded', { manualAllow: next.manualAllow.length, blocked: next.blocked.length, rootsChanged });
  if (rootsChanged) {
    graph = null;
    void rebuild('sighup');
  }
});

process.on('unhandledRejection', (err) => log('unhandled rejection', { error: String(err) }));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
