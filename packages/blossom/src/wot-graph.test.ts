import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { acceptRebuild, buildGraph, loadGraph, saveGraph, type ContactList, type GraphSnapshot } from './wot-graph.js';

const pk = (n: number) => n.toString(16).padStart(64, '0');
const follows = (from: number, to: number[], at = 1): ContactList =>
  ({ pubkey: pk(from), created_at: at, tags: to.map((t) => ['p', pk(t)]) });

function fakeFetch(lists: ContactList[]) {
  const calls: string[][] = [];
  return {
    calls,
    fetch: async (authors: string[]) => {
      calls.push(authors);
      return lists.filter((l) => authors.includes(l.pubkey));
    },
  };
}

describe('buildGraph', () => {
  it('assigns hop distances outward from the roots', async () => {
    const f = fakeFetch([follows(1, [2, 3]), follows(2, [4]), follows(4, [5])]);
    const g = await buildGraph({ roots: [pk(1)], maxHops: 2, fetchBudget: 1000, fetch: f.fetch });
    expect(g.hops).toEqual({ [pk(1)]: 0, [pk(2)]: 1, [pk(3)]: 1, [pk(4)]: 2 });
    expect(g.truncated).toBe(false);
  });

  it('keeps the shortest distance when a key is reachable twice', async () => {
    const f = fakeFetch([follows(1, [2, 3]), follows(2, [3])]);
    const g = await buildGraph({ roots: [pk(1)], maxHops: 2, fetchBudget: 1000, fetch: f.fetch });
    expect(g.hops[pk(3)]).toBe(1);
  });

  it('uses only the newest contact list per author', async () => {
    const f = fakeFetch([follows(1, [2], 10), follows(1, [3], 20)]);
    const g = await buildGraph({ roots: [pk(1)], maxHops: 1, fetchBudget: 1000, fetch: f.fetch });
    expect(Object.keys(g.hops).sort()).toEqual([pk(1), pk(3)].sort());
  });

  it('ignores lists for authors it did not ask about and malformed p tags', async () => {
    const fetch = async () => [
      { pubkey: pk(1), created_at: 1, tags: [['p', 'nothex'], ['p', pk(2).toUpperCase()], ['e', pk(9)]] },
      follows(7, [8]),
    ];
    const g = await buildGraph({ roots: [pk(1)], maxHops: 2, fetchBudget: 1000, fetch });
    expect(Object.keys(g.hops).sort()).toEqual([pk(1), pk(2)].sort());
  });

  it('stops and marks the graph truncated when the fetch budget runs out', async () => {
    const f = fakeFetch([follows(1, [2, 3, 4]), follows(2, [5])]);
    const g = await buildGraph({ roots: [pk(1)], maxHops: 2, fetchBudget: 2, fetch: f.fetch });
    expect(g.truncated).toBe(true);
    expect(g.contactListsFetched).toBe(2);
  });

  it('batches authors in groups of 200', async () => {
    const many = Array.from({ length: 450 }, (_, i) => i + 10);
    const f = fakeFetch([follows(1, many)]);
    await buildGraph({ roots: [pk(1)], maxHops: 2, fetchBudget: 10_000, fetch: f.fetch });
    expect(f.calls.map((c) => c.length)).toEqual([1, 200, 200, 50]);
  });

  it('survives a fetcher that throws', async () => {
    const g = await buildGraph({ roots: [pk(1)], maxHops: 2, fetchBudget: 100, fetch: async () => { throw new Error('down'); } });
    expect(g.hops).toEqual({ [pk(1)]: 0 });
  });
});

describe('acceptRebuild', () => {
  const snap = (n: number, roots = [pk(1)]): GraphSnapshot => ({
    builtAt: 0, maxHops: 2, roots, truncated: false, contactListsFetched: 0,
    hops: Object.fromEntries(Array.from({ length: n }, (_, i) => [pk(i + 100), 1])),
  });
  it('accepts the first build', () => expect(acceptRebuild(null, snap(1))).toBe(true));
  it('rejects a build that lost more than half', () => expect(acceptRebuild(snap(100), snap(40))).toBe(false));
  it('accepts a modest shrink', () => expect(acceptRebuild(snap(100), snap(60))).toBe(true));
  it('accepts any size when the roots changed', () => expect(acceptRebuild(snap(100), snap(1, [pk(2)]))).toBe(true));
});

describe('graph persistence', () => {
  it('round-trips through disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blossom-graph-'));
    expect(loadGraph(dir)).toBeNull();
    const g: GraphSnapshot = { builtAt: 5, maxHops: 2, roots: [pk(1)], truncated: false, contactListsFetched: 1, hops: { [pk(1)]: 0 } };
    saveGraph(dir, g);
    expect(loadGraph(dir)).toEqual(g);
  });
});
