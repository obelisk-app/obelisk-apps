/**
 * Wire types of host API v1 (docs/host-api.md). Shared by the app-side client
 * (`host.ts`) and the in-memory host in `testing/`.
 */

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Participant {
  pubkey: string;
  /** Display name, NIP-05 or short npub; never raw hex. */
  name: string;
  /** Fetched by the host; the app never sees the URL. */
  avatar?: Blob;
}

export interface ConnectionState {
  connected: boolean;
  /** Unix seconds the relay socket last came up; null while down. */
  since: number | null;
}

export interface Init {
  api: 1;
  app: { address: string; title: string; version?: string; author: string };
  session: { id: string; createdBy: string; createdAt: number; channelName: string };
  me: string | null;
  participants: Participant[];
  paths: string[];
  locale: 'en' | 'es' | 'pt';
  theme: { mode: 'dark' | 'light'; accent: string };
  limits: { contentBytes: number; publishPerSecond: number; storageBytes: number };
  connection: ConnectionState;
}

export type ErrorCode =
  | 'unsupported'
  | 'forbidden-op'
  | 'too-large'
  | 'bad-n'
  | 'rate-limited'
  | 'signed-out'
  | 'signer-rejected'
  | 'closed'
  | 'not-found'
  | 'unavailable'
  | 'hash-mismatch'
  | 'quota'
  | 'bad-request';

export interface PublishRequest {
  op: string;
  content?: string;
  n?: number;
}

export type Req = { id: number; type: string; [k: string]: unknown };
export type Res =
  | { re: number; ok: true; result?: unknown }
  | { re: number; ok: false; error: ErrorCode; message?: string };
export type Push = { type: string; [k: string]: unknown };

/** Ops the host interprets itself; an app may publish all but `create`. */
export const HOST_OPS = ['create', 'join', 'leave', 'cancel', 'status'] as const;
export const OP_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const STATUS_MAX_CHARS = 140;
export const KIND_APP_EVENT = 2390;
export const APP_TAG = 'obelisk-app';
/** Pre-migration tables carried this `t` tag instead. */
export const LEGACY_GAME_TAG = 'obelisk-game';

export class HostError extends Error {
  constructor(readonly code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'HostError';
  }
}
