/**
 * BUD-01/02 authorization: `Authorization: Nostr <base64(kind 24242 event)>`.
 *
 * The event must be validly signed, not from the future, unexpired, carry the
 * right `t` verb and — for upload and delete — an `x` tag naming the exact
 * blob. A `server` tag, when present, must name this host (BUD-01 lets a
 * client scope a token to one server; we honour the scope).
 */
import { verifyEvent, type Event } from 'nostr-tools/pure';

export const KIND_BLOSSOM_AUTH = 24242;
const MAX_CLOCK_SKEW_S = 60;

export type AuthVerb = 'upload' | 'delete' | 'list' | 'get';

export type AuthResult =
  | { ok: true; pubkey: string; event: Event }
  | { ok: false; status: 401 | 403; reason: string };

export function parseAuthorization(header: string | undefined): Event | null {
  if (!header) return null;
  const m = /^Nostr\s+([A-Za-z0-9+/=_-]+)$/.exec(header.trim());
  if (!m) return null;
  try {
    const json = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const ev = JSON.parse(json) as Event;
    return ev && typeof ev === 'object' ? ev : null;
  } catch {
    return null;
  }
}

export function checkAuth(params: {
  header: string | undefined;
  verb: AuthVerb;
  sha256?: string;
  host: string;
  now?: number;
  verify?: (ev: Event) => boolean;
}): AuthResult {
  const ev = parseAuthorization(params.header);
  if (!ev) return { ok: false, status: 401, reason: 'missing or malformed Nostr authorization' };
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const verify = params.verify ?? verifyEvent;

  if (ev.kind !== KIND_BLOSSOM_AUTH) return { ok: false, status: 401, reason: 'authorization must be kind 24242' };
  if (!Array.isArray(ev.tags)) return { ok: false, status: 401, reason: 'malformed tags' };
  if (!verify(ev)) return { ok: false, status: 401, reason: 'invalid signature' };
  if (typeof ev.created_at !== 'number' || ev.created_at > now + MAX_CLOCK_SKEW_S) {
    return { ok: false, status: 401, reason: 'authorization created in the future' };
  }

  const tag = (name: string) => ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const expiration = Number(tag('expiration')[0]);
  if (!Number.isFinite(expiration) || expiration <= now) {
    return { ok: false, status: 401, reason: 'authorization expired or has no expiration' };
  }
  if (!tag('t').includes(params.verb)) return { ok: false, status: 401, reason: `authorization is not for ${params.verb}` };
  if (params.sha256 && !tag('x').includes(params.sha256)) {
    return { ok: false, status: 403, reason: 'authorization does not cover this blob' };
  }
  const servers = tag('server');
  if (servers.length > 0 && !servers.some((s) => s === params.host)) {
    return { ok: false, status: 403, reason: 'authorization is scoped to another server' };
  }
  return { ok: true, pubkey: ev.pubkey, event: ev };
}
