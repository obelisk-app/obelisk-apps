/**
 * Runtime configuration. Env vars first, then `<dataDir>/config.json` for the
 * lists an operator edits (reference accounts, manual allow, block), so a
 * list change is a file edit plus SIGHUP rather than a restart.
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

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface Config {
  host: string;
  port: number;
  /** Public base URL, used in blob descriptors (`url`). */
  publicUrl: string;
  dataDir: string;

  referenceAccounts: Hex[];
  manualAllow: Hex[];
  blocked: Hex[];
  followRelays: string[];
  /** 1 = reference accounts' follows only (relay "follow sync"); 2 = friends of those. */
  maxHops: number;
  /** Max contact lists fetched per rebuild — obelisk-relay's DEFAULT_MAX_REMOTE_FETCHES. */
  fetchBudget: number;
  rebuildIntervalMs: number;

  maxBlobBytes: number;
  /** Per-uploader quota for tier 1 (manual, reference accounts, their follows). */
  tier1QuotaBytes: number;
  /** Per-uploader quota for tier 2 (WoT hop 2). */
  tier2QuotaBytes: number;
  /** The whole store. */
  totalCapBytes: number;
  /** Refuse uploads when the volume holding dataDir has less free space than this. */
  minFreeBytes: number;
  uploadsPerHour: number;
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

export function configFilePath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.BLOSSOM_DATA_DIR ?? join(process.cwd(), 'data');
  let file: FileConfig = {};
  const path = configFilePath(dataDir);
  if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;

  const referenceAccounts = hexList(file.referenceAccounts);
  const maxHops = Math.min(3, Math.max(1, Math.floor(file.maxHops ?? num(env.BLOSSOM_MAX_HOPS, 2))));

  return {
    host: env.BLOSSOM_HOST ?? '127.0.0.1',
    port: num(env.BLOSSOM_PORT, 3023),
    publicUrl: (env.BLOSSOM_PUBLIC_URL ?? 'https://blossom.obelisk.ar').replace(/\/+$/, ''),
    dataDir,
    referenceAccounts: referenceAccounts.length ? referenceAccounts : DEFAULT_REFERENCE_ACCOUNTS,
    manualAllow: hexList(file.manualAllow),
    blocked: hexList(file.blocked),
    followRelays: file.followRelays?.length ? file.followRelays : DEFAULT_FOLLOW_RELAYS,
    maxHops,
    fetchBudget: num(env.BLOSSOM_FETCH_BUDGET, 25_000),
    rebuildIntervalMs: num(env.BLOSSOM_REBUILD_INTERVAL_S, 3600) * 1000,
    maxBlobBytes: num(env.BLOSSOM_MAX_BLOB_MIB, 16) * MiB,
    tier1QuotaBytes: num(env.BLOSSOM_TIER1_QUOTA_MIB, 512) * MiB,
    tier2QuotaBytes: num(env.BLOSSOM_TIER2_QUOTA_MIB, 64) * MiB,
    totalCapBytes: num(env.BLOSSOM_TOTAL_CAP_GIB, 3) * GiB,
    minFreeBytes: num(env.BLOSSOM_MIN_FREE_GIB, 1) * GiB,
    uploadsPerHour: num(env.BLOSSOM_UPLOADS_PER_HOUR, 120),
  };
}
