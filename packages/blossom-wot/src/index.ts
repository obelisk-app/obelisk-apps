/**
 * blossom-wot: keeps blossom-server's upload allowlists in step with the
 * web of trust, and closes uploads when the disk is tight.
 *
 *   hourly   rebuild the follow graph, rewrite tier1.txt / tier2.txt
 *   1/min    disk guard: store over cap or volume low → empty the files
 *   SIGHUP   re-read config.json (manualAllow, blocked, referenceAccounts,
 *            maxHops); rewrite at once, rebuild if the roots or depth changed
 */
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

import { loadConfig } from './config.js';
import { dirBytes, freeBytes, judgeDisk, tierLists, writeTierFiles, type GuardVerdict } from './tiers.js';
import { acceptRebuild, buildGraph, loadGraph, saveGraph, type ContactList, type GraphSnapshot } from './wot-graph.js';

// Node 22's built-in WebSocket re-fires `error` from inside close(), and
// nostr-tools 2.25's onerror calls close(): unbounded recursion on the first
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

const cfg = loadConfig();
let graph: GraphSnapshot | null = loadGraph(cfg.stateDir);
let guard: GuardVerdict = { open: true };
let building = false;

function publish(reason: string): void {
  if (!guard.open) {
    writeTierFiles(cfg.tierDir, { tier1: [], tier2: [] }, `uploads closed: ${guard.reason}`);
    log('tier files emptied', { reason, guard: guard.reason });
    return;
  }
  const lists = tierLists(graph, cfg);
  writeTierFiles(cfg.tierDir, lists, graph ? `graph built ${new Date(graph.builtAt * 1000).toISOString()}` : 'no graph yet');
  log('tier files written', { reason, tier1: lists.tier1.length, tier2: lists.tier2.length });
}

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
    saveGraph(cfg.stateDir, next);
    log('follow graph rebuilt', {
      reason, ms: Date.now() - started, contactLists: next.contactListsFetched,
      admitted, maxHops: next.maxHops, truncated: next.truncated,
    });
    publish(reason);
  } catch (err) {
    log('follow graph rebuild failed', { reason, error: String(err) });
  } finally {
    building = false;
  }
}

function checkDisk(): void {
  const next = judgeDisk(dirBytes(cfg.blobDir), freeBytes(cfg.tierDir), cfg);
  if (next.open !== guard.open) {
    guard = next;
    log(next.open ? 'disk guard: uploads reopened' : 'disk guard: uploads closed', next.open ? {} : { why: next.reason });
    publish('disk-guard');
  }
}

log('blossom-wot starting', {
  stateDir: cfg.stateDir, tierDir: cfg.tierDir, blobDir: cfg.blobDir,
  references: cfg.referenceAccounts.length, maxHops: cfg.maxHops,
  cachedGraph: graph ? Object.keys(graph.hops).length : null,
});
checkDisk();
publish('startup');
void rebuild('startup');
const rebuildTimer = setInterval(() => void rebuild('interval'), cfg.rebuildIntervalMs);
const guardTimer = setInterval(checkDisk, cfg.guardIntervalMs);

process.on('SIGHUP', () => {
  const next = loadConfig();
  const rootsChanged = next.maxHops !== cfg.maxHops
    || next.referenceAccounts.join() !== cfg.referenceAccounts.join()
    || next.followRelays.join() !== cfg.followRelays.join();
  Object.assign(cfg, {
    referenceAccounts: next.referenceAccounts, manualAllow: next.manualAllow, blocked: next.blocked,
    followRelays: next.followRelays, maxHops: next.maxHops,
  });
  log('config reloaded', { manualAllow: next.manualAllow.length, blocked: next.blocked.length, rootsChanged });
  publish('sighup');
  if (rootsChanged) {
    graph = null;
    void rebuild('sighup');
  }
});

process.on('unhandledRejection', (err) => log('unhandled rejection', { error: String(err) }));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(rebuildTimer);
    clearInterval(guardTimer);
    process.exit(0);
  });
}
