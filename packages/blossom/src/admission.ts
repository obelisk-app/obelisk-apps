/**
 * Who may upload, and how much. The same ladder as obelisk-relay
 * `src/whitelist.rs` (`tier_of`):
 *
 *   blocked                       → denied, always, whatever else matches
 *   manual allow                  → tier 1
 *   hop 0-1 (references + follows)→ tier 1   (the relay's "follow sync" tier)
 *   hop 2..maxHops                → tier 2   (reduced quota, like the relay's
 *                                             50% rate budget at hop 2)
 *   anyone else                   → denied
 *
 * Reads are never gated: a blob is public once stored (BUD-01).
 */
import type { Config, Hex } from './config.js';
import type { GraphSnapshot } from './wot-graph.js';

export type Tier =
  | { allowed: true; tier: 1 | 2; source: 'manual' | 'reference' | 'follow' | 'wot'; hops: number | null; quotaBytes: number }
  | { allowed: false; reason: 'blocked' | 'not-in-wot' };

export class Admission {
  private blocked: Set<Hex>;
  private manual: Set<Hex>;
  private graph: GraphSnapshot | null;

  constructor(private cfg: Pick<Config, 'blocked' | 'manualAllow' | 'maxHops' | 'tier1QuotaBytes' | 'tier2QuotaBytes'>, graph: GraphSnapshot | null) {
    this.blocked = new Set(cfg.blocked);
    this.manual = new Set(cfg.manualAllow);
    this.graph = graph;
  }

  setGraph(graph: GraphSnapshot): void {
    this.graph = graph;
  }

  setLists(lists: { blocked: Hex[]; manualAllow: Hex[] }): void {
    this.blocked = new Set(lists.blocked);
    this.manual = new Set(lists.manualAllow);
  }

  get graphInfo() {
    const g = this.graph;
    return g
      ? { builtAt: g.builtAt, admitted: Object.keys(g.hops).length, truncated: g.truncated, maxHops: g.maxHops }
      : null;
  }

  judge(pubkey: Hex): Tier {
    if (this.blocked.has(pubkey)) return { allowed: false, reason: 'blocked' };
    if (this.manual.has(pubkey)) {
      return { allowed: true, tier: 1, source: 'manual', hops: null, quotaBytes: this.cfg.tier1QuotaBytes };
    }
    const hops = this.graph?.hops[pubkey];
    if (hops === undefined || hops > this.cfg.maxHops) return { allowed: false, reason: 'not-in-wot' };
    if (hops <= 1) {
      return { allowed: true, tier: 1, source: hops === 0 ? 'reference' : 'follow', hops, quotaBytes: this.cfg.tier1QuotaBytes };
    }
    return { allowed: true, tier: 2, source: 'wot', hops, quotaBytes: this.cfg.tier2QuotaBytes };
  }
}
