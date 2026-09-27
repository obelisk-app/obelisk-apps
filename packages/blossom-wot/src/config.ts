/**
 * Sidecar configuration. Env vars set the paths and limits;
 * `<stateDir>/config.json` holds the lists an operator edits (reference
 * accounts, manual allow, block), re-read on SIGHUP.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Hex = string;

export const HEX64 = /^[0-9a-f]{64}$/;

/** The public.obelisk.ar reference accounts (obelisk-relay public-config/reference_accounts.json). */
export const DEFAULT_REFERENCE_ACCOUNTS: Hex[] = [
  'd9590d95a7811e1cb312be66edd664d7e3e6ed57822ad9f213ed620fc6748be8',
  '1f24d0d9a7dbb221b0206a866508374f44b00d704a34e8b1b3fc9a8bc1403806',
];

/** Same three obelisk-relay hardcodes as FOLLOW_RELAYS (src/wot_graph.rs, src/follow_sync.rs). */
export const DEFAULT_FOLLOW_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
];

const GiB = 1024 * 1024 * 1024;

export interface Config {
  /** Where config.json and wot-graph.json live. */
  stateDir: string;
  /** Where tier1.txt / tier2.txt are written — the paths blossom-server's rules name in `pubkeysFile`. */
  tierDir: string;
  /** blossom-server's storage.local.dir, measured for the disk guard. */
  blobDir: string;

  referenceAccounts: Hex[];
  manualAllow: Hex[];
  blocked: Hex[];
  followRelays: string[];
  /** 1 = reference accounts' follows only (the relay's "follow sync"); 2 = friends of those. */
  maxHops: number;
  /** Max contact lists fetched per rebuild: obelisk-relay's DEFAULT_MAX_REMOTE_FETCHES. */
  fetchBudget: number;
  rebuildIntervalMs: number;

  /** Close uploads when the blob dir holds more than this. */
  totalCapBytes: number;
  /** Close uploads when the volume has less free space than this. */
  minFreeBytes: number;
  guardIntervalMs: number;
}

interface FileConfig {
  referenceAccounts?: string[];
  manualAllow?: string[];
  blocked?: string[];
  followRelays?: string[];
  maxHops?: number;
}

function hexList(raw: unknown): Hex[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((v) => String(v).toLowerCase()).filter((v) => HEX64.test(v)))];
}

function num(env: string | undefined, fallback: number): number {
  const n = env === undefined ? NaN : Number(env);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.WOT_STATE_DIR ?? join(process.cwd(), 'data');
  let file: FileConfig = {};
  const path = join(stateDir, 'config.json');
  if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;

  const referenceAccounts = hexList(file.referenceAccounts);
  return {
    stateDir,
    tierDir: env.WOT_TIER_DIR ?? join(stateDir, 'wot'),
    blobDir: env.WOT_BLOB_DIR ?? join(stateDir, 'blobs'),
    referenceAccounts: referenceAccounts.length ? referenceAccounts : DEFAULT_REFERENCE_ACCOUNTS,
    manualAllow: hexList(file.manualAllow),
    blocked: hexList(file.blocked),
    followRelays: file.followRelays?.length ? file.followRelays : DEFAULT_FOLLOW_RELAYS,
    maxHops: Math.min(3, Math.max(1, Math.floor(file.maxHops ?? num(env.WOT_MAX_HOPS, 2)))),
    fetchBudget: num(env.WOT_FETCH_BUDGET, 25_000),
    rebuildIntervalMs: num(env.WOT_REBUILD_INTERVAL_S, 3600) * 1000,
    totalCapBytes: num(env.WOT_TOTAL_CAP_GIB, 3) * GiB,
    minFreeBytes: num(env.WOT_MIN_FREE_GIB, 1) * GiB,
    guardIntervalMs: num(env.WOT_GUARD_INTERVAL_S, 60) * 1000,
  };
}
