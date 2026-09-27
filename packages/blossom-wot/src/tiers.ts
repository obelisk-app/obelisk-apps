/**
 * The graph → tier files step, plus the disk guard.
 *
 * Same ladder as obelisk-relay `src/whitelist.rs` `tier_of`:
 *
 *   blocked                        → in no file, whatever else matches
 *   manual allow                   → tier1.txt
 *   hop 0-1 (references + follows) → tier1.txt   (the relay's "follow sync")
 *   hop 2..maxHops                 → tier2.txt
 *
 * blossom-server (obelisk-app fork, `pubkeysFile` rules with
 * `requirePubkeyInRule: true`) does the rest: tier 1 and tier 2 map to
 * rules with different retention, and a key in neither file can't upload.
 */
import { mkdirSync, readdirSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config, Hex } from './config.js';
import type { GraphSnapshot } from './wot-graph.js';

export interface TierLists {
  tier1: Hex[];
  tier2: Hex[];
}

export function tierLists(
  graph: GraphSnapshot | null,
  cfg: Pick<Config, 'manualAllow' | 'blocked' | 'maxHops'>,
): TierLists {
  const blocked = new Set(cfg.blocked);
  const tier1 = new Set<Hex>();
  const tier2 = new Set<Hex>();
  for (const pk of cfg.manualAllow) if (!blocked.has(pk)) tier1.add(pk);
  for (const [pk, hops] of Object.entries(graph?.hops ?? {})) {
    if (blocked.has(pk) || tier1.has(pk)) continue;
    if (hops <= 1) tier1.add(pk);
    else if (hops <= cfg.maxHops) tier2.add(pk);
  }
  return { tier1: [...tier1].sort(), tier2: [...tier2].sort() };
}

function render(header: string, keys: Hex[]): string {
  return `# ${header}\n# Written by obelisk-apps/packages/blossom-wot. Do not edit; edit config.json and SIGHUP.\n${keys.join('\n')}\n`;
}

/** Replace both files atomically (write + rename), so blossom-server never reads a half-written list. */
export function writeTierFiles(dir: string, lists: TierLists, note: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, keys] of [['tier1', lists.tier1], ['tier2', lists.tier2]] as const) {
    const path = join(dir, `${name}.txt`);
    writeFileSync(`${path}.tmp`, render(`${name}: ${keys.length} keys, ${note}`, keys));
    renameSync(`${path}.tmp`, path);
  }
}

/** Bytes used by regular files directly under `dir` (blossom-server's local store is flat). */
export function dirBytes(dir: string): number {
  let n = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const s = statSync(join(dir, name));
        if (s.isFile()) n += s.size;
      } catch { /* raced with a delete */ }
    }
  } catch { /* no store yet */ }
  return n;
}

export function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export type GuardVerdict = { open: true } | { open: false; reason: string };

/**
 * blossom-server has no total cap and no free-space floor, and this volume is
 * shared, so the guard closes uploads by emptying the tier files: the fork's
 * pubkeysFile rules then match nobody.
 */
export function judgeDisk(stored: number, free: number, cfg: Pick<Config, 'totalCapBytes' | 'minFreeBytes'>): GuardVerdict {
  if (stored >= cfg.totalCapBytes) return { open: false, reason: `store is at its ${cfg.totalCapBytes} byte cap` };
  if (free < cfg.minFreeBytes) return { open: false, reason: `volume has only ${free} bytes free` };
  return { open: true };
}
