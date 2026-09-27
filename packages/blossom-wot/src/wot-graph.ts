/**
 * Follow-graph admission, ported from obelisk-relay `src/wot_graph.rs` and
 * `src/follow_sync.rs` (and the SFU's `follow-whitelist.ts`):
 *
 *   hop 0  the reference accounts
 *   hop 1  everyone a reference account follows (the relay's "follow sync")
 *   hop 2  everyone THEY follow, and so on up to `maxHops`
 *
 * Only kind 3 `p` tags count; the newest contact list per author wins. The
 * walk fetches contact lists hop by hop in batches, bounded by `fetchBudget`
 * lists per rebuild — when the budget runs out the graph is marked
 * `truncated`, exactly like the relay's coverage warning.
 *
 * Two deliberate differences from the relay:
 *   - the result is persisted (`wot-graph.json`), so a restart admits people
 *     immediately instead of waiting a full rebuild;
 *   - a rebuild that comes back with less than half the previous admitted set
 *     is treated as a relay outage and discarded (the relay's admitted count
 *     swings ±50k between runs because its fetch windows are nondeterministic;
 *     here a bad run can't lock out half the uploaders for an hour).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HEX64, type Hex } from './config.js';

export interface ContactList {
  pubkey: string;
  created_at: number;
  tags: string[][];
}

/** Fetch the kind 3 contact lists of `authors`. Implementations may return several per author. */
export type ContactListFetcher = (authors: Hex[]) => Promise<ContactList[]>;

export interface GraphSnapshot {
  builtAt: number;
  maxHops: number;
  roots: Hex[];
  truncated: boolean;
  contactListsFetched: number;
  /** pubkey → hop distance from the nearest root. */
  hops: Record<Hex, number>;
}

export const BATCH_SIZE = 200;

export async function buildGraph(params: {
  roots: Hex[];
  maxHops: number;
  fetchBudget: number;
  fetch: ContactListFetcher;
  now?: number;
}): Promise<GraphSnapshot> {
  const hops = new Map<Hex, number>();
  for (const r of params.roots) hops.set(r, 0);

  let frontier = [...params.roots];
  let fetched = 0;
  let truncated = false;

  for (let hop = 1; hop <= params.maxHops && frontier.length > 0; hop++) {
    const next: Hex[] = [];
    for (let i = 0; i < frontier.length; i += BATCH_SIZE) {
      const remaining = params.fetchBudget - fetched;
      if (remaining <= 0) { truncated = true; break; }
      const batch = frontier.slice(i, i + Math.min(BATCH_SIZE, remaining));
      fetched += batch.length;
      // A batch the budget cut short leaves part of this hop unfetched.
      if (remaining < Math.min(BATCH_SIZE, frontier.length - i)) truncated = true;

      let lists: ContactList[] = [];
      try { lists = await params.fetch(batch); } catch { lists = []; }

      const wanted = new Set(batch);
      const newest = new Map<Hex, ContactList>();
      for (const ev of lists) {
        if (!wanted.has(ev.pubkey)) continue;
        const prev = newest.get(ev.pubkey);
        if (!prev || prev.created_at < ev.created_at) newest.set(ev.pubkey, ev);
      }
      for (const ev of newest.values()) {
        for (const tag of ev.tags) {
          if (tag[0] !== 'p') continue;
          const pk = tag[1]?.toLowerCase();
          if (!pk || !HEX64.test(pk) || hops.has(pk)) continue;
          hops.set(pk, hop);
          next.push(pk);
        }
      }
    }
    if (truncated) break;
    frontier = next;
  }

  return {
    builtAt: params.now ?? Math.floor(Date.now() / 1000),
    maxHops: params.maxHops,
    roots: [...params.roots],
    truncated,
    contactListsFetched: fetched,
    hops: Object.fromEntries(hops),
  };
}

/** Keep the previous graph when a rebuild looks like an outage rather than a change of heart. */
export function acceptRebuild(prev: GraphSnapshot | null, next: GraphSnapshot): boolean {
  if (!prev) return true;
  const sameShape = prev.maxHops === next.maxHops
    && prev.roots.length === next.roots.length
    && prev.roots.every((r) => next.roots.includes(r));
  if (!sameShape) return true;
  const before = Object.keys(prev.hops).length;
  const after = Object.keys(next.hops).length;
  return after * 2 >= before;
}

export function graphPath(dataDir: string): string {
  return join(dataDir, 'wot-graph.json');
}

export function loadGraph(dataDir: string): GraphSnapshot | null {
  const path = graphPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const g = JSON.parse(readFileSync(path, 'utf8')) as GraphSnapshot;
    return g && typeof g.hops === 'object' ? g : null;
  } catch {
    return null;
  }
}

export function saveGraph(dataDir: string, g: GraphSnapshot): void {
  const path = graphPath(dataDir);
  writeFileSync(`${path}.tmp`, JSON.stringify(g));
  renameSync(`${path}.tmp`, path);
}
