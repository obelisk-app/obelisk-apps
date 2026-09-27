import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { dirBytes, judgeDisk, tierLists, writeTierFiles } from './tiers.js';
import type { GraphSnapshot } from './wot-graph.js';

const pk = (n: number) => n.toString(16).padStart(64, '0');
const graph: GraphSnapshot = {
  builtAt: 0, maxHops: 2, roots: [pk(1)], truncated: false, contactListsFetched: 0,
  hops: { [pk(1)]: 0, [pk(2)]: 1, [pk(3)]: 2, [pk(4)]: 3, [pk(5)]: 1 },
};
const cfg = { blocked: [pk(5)], manualAllow: [pk(9), pk(3)], maxHops: 2 };

describe('tierLists', () => {
  const t = tierLists(graph, cfg);
  it('puts references, their follows and the manual list in tier 1', () => {
    expect(t.tier1).toEqual([pk(1), pk(2), pk(3), pk(9)].sort());
  });
  it('puts hop 2 in tier 2 unless already tier 1, and drops keys past maxHops', () => {
    expect(t.tier2).toEqual([]);
    expect(tierLists(graph, { ...cfg, manualAllow: [] }).tier2).toEqual([pk(3)]);
    expect([...t.tier1, ...t.tier2]).not.toContain(pk(4));
  });
  it('keeps blocked keys out of every file, even when manually allowed', () => {
    const b = tierLists(graph, { ...cfg, blocked: [pk(9), pk(2)] });
    expect([...b.tier1, ...b.tier2]).not.toContain(pk(9));
    expect([...b.tier1, ...b.tier2]).not.toContain(pk(2));
  });
  it('admits only the manual list before any graph exists', () => {
    expect(tierLists(null, cfg)).toEqual({ tier1: [pk(3), pk(9)].sort(), tier2: [] });
  });
});

describe('writeTierFiles', () => {
  it('writes one key per line under a comment header blossom-server ignores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wot-tiers-'));
    writeTierFiles(dir, { tier1: [pk(1), pk(2)], tier2: [] }, 'test');
    const lines = readFileSync(join(dir, 'tier1.txt'), 'utf8').split('\n');
    expect(lines.filter((l) => l && !l.startsWith('#'))).toEqual([pk(1), pk(2)]);
    expect(readFileSync(join(dir, 'tier2.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([]);
  });
});

describe('disk guard', () => {
  const limits = { totalCapBytes: 1000, minFreeBytes: 100 };
  it('stays open with room to spare', () => expect(judgeDisk(10, 5000, limits)).toEqual({ open: true }));
  it('closes at the store cap', () => expect(judgeDisk(1000, 5000, limits).open).toBe(false));
  it('closes when the volume runs low', () => expect(judgeDisk(10, 99, limits).open).toBe(false));
  it('measures the flat blob directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wot-blobs-'));
    writeFileSync(join(dir, 'a'), 'x'.repeat(30));
    writeFileSync(join(dir, 'b.js'), 'y'.repeat(12));
    expect(dirBytes(dir)).toBe(42);
    expect(dirBytes(join(dir, 'missing'))).toBe(0);
  });
});
