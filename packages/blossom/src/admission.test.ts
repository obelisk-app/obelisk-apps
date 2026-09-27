import { describe, expect, it } from 'vitest';

import { Admission } from './admission.js';
import type { GraphSnapshot } from './wot-graph.js';

const pk = (n: number) => n.toString(16).padStart(64, '0');
const graph: GraphSnapshot = {
  builtAt: 0, maxHops: 2, roots: [pk(1)], truncated: false, contactListsFetched: 0,
  hops: { [pk(1)]: 0, [pk(2)]: 1, [pk(3)]: 2, [pk(4)]: 3 },
};
const cfg = { blocked: [pk(2)], manualAllow: [pk(9)], maxHops: 2, tier1QuotaBytes: 100, tier2QuotaBytes: 10 };

describe('Admission', () => {
  const a = new Admission(cfg, graph);

  it('denies a blocked key even when it is in the graph', () => {
    expect(a.judge(pk(2))).toEqual({ allowed: false, reason: 'blocked' });
  });
  it('puts the manual allowlist in tier 1', () => {
    expect(a.judge(pk(9))).toMatchObject({ allowed: true, tier: 1, source: 'manual', quotaBytes: 100 });
  });
  it('puts reference accounts in tier 1', () => {
    expect(a.judge(pk(1))).toMatchObject({ allowed: true, tier: 1, source: 'reference', hops: 0 });
  });
  it('puts hop 2 in tier 2 with the smaller quota', () => {
    expect(a.judge(pk(3))).toMatchObject({ allowed: true, tier: 2, source: 'wot', hops: 2, quotaBytes: 10 });
  });
  it('denies keys beyond maxHops and keys outside the graph', () => {
    expect(a.judge(pk(4))).toEqual({ allowed: false, reason: 'not-in-wot' });
    expect(a.judge(pk(77))).toEqual({ allowed: false, reason: 'not-in-wot' });
  });
  it('denies everyone but the manual list before any graph exists', () => {
    const empty = new Admission(cfg, null);
    expect(empty.judge(pk(1)).allowed).toBe(false);
    expect(empty.judge(pk(9)).allowed).toBe(true);
  });
  it('applies reloaded lists', () => {
    const b = new Admission(cfg, graph);
    b.setLists({ blocked: [], manualAllow: [] });
    expect(b.judge(pk(2))).toMatchObject({ allowed: true, source: 'follow' });
    expect(b.judge(pk(9)).allowed).toBe(false);
  });
});
