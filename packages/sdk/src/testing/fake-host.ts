/**
 * An in-memory host for tests and the games.obelisk.ar Playground: one fake
 * relay, any number of players, each with its own MessageChannel into the app.
 *
 * It enforces the same rules docs/host-api.md asks of obelisk-dex — the host
 * builds every event (kind, `h`, `e`, `t`, `op`, optional `n`), refuses
 * `create`, bad op names, oversized content and bursts — so an app that works
 * here won't be surprised by the real host. It does NOT sign: ids are real
 * NIP-01 hashes, `sig` is empty.
 */
import {
  APP_TAG, HOST_OPS, KIND_APP_EVENT, OP_PATTERN, STATUS_MAX_CHARS,
  type ConnectionState, type ErrorCode, type Init, type NostrEvent, type Participant, type Req,
} from '../types.js';

const enc = new TextEncoder();

async function eventId(ev: Omit<NostrEvent, 'id' | 'sig'>): Promise<string> {
  const data = enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FakeRelayOptions {
  /** Unix seconds; injectable so clock tests are deterministic. */
  now?: () => number;
}

/** Stores events and fans them out. Stands in for the channel's relay. */
export class FakeRelay {
  readonly events: NostrEvent[] = [];
  private subs = new Set<(ev: NostrEvent) => void>();
  constructor(readonly opts: FakeRelayOptions = {}) {}

  now(): number {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  async sign(pubkey: string, tmpl: { kind: number; tags: string[][]; content: string }, createdAt = this.now()): Promise<NostrEvent> {
    const base = { pubkey, created_at: createdAt, kind: tmpl.kind, tags: tmpl.tags, content: tmpl.content };
    return { ...base, id: await eventId(base), sig: '' };
  }

  publish(ev: NostrEvent): void {
    if (this.events.some((e) => e.id === ev.id)) return;
    this.events.push(ev);
    for (const cb of this.subs) cb(ev);
  }

  subscribe(cb: (ev: NostrEvent) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Publish a session `create` the way obelisk-dex does, and return its id. */
  async createSession(creator: string, channel = 'test-channel', extra: string[][] = []): Promise<string> {
    const ev = await this.sign(creator, {
      kind: KIND_APP_EVENT,
      content: JSON.stringify({ nonce: Math.random().toString(36).slice(2) }),
      tags: [['h', channel], ['t', APP_TAG], ['op', 'create'], ...extra],
    });
    this.publish(ev);
    return ev.id;
  }

  /** Publish a raw event as-is: legacy tables, or a hostile client that bypasses its host. */
  async inject(pubkey: string, tmpl: { kind?: number; tags: string[][]; content: string }, createdAt?: number): Promise<NostrEvent> {
    const ev = await this.sign(pubkey, { kind: tmpl.kind ?? KIND_APP_EVENT, tags: tmpl.tags, content: tmpl.content }, createdAt);
    this.publish(ev);
    return ev;
  }
}

export interface FakeHostOptions {
  relay: FakeRelay;
  sessionId: string;
  me: string | null;
  channel?: string;
  participants?: Participant[];
  assets?: Record<string, Blob>;
  connection?: ConnectionState;
  limits?: Partial<Init['limits']>;
  /** Milliseconds, for the rate bucket. */
  clockMs?: () => number;
}

/** The host side of one app frame. `ctx` is what the frame loader would hand the app. */
export class FakeHost {
  readonly ctx: { port: MessagePort; root: HTMLElement };
  readonly toasts: string[] = [];
  statusText: string | null = null;
  closed = false;
  private readonly port: MessagePort;
  private readonly storage = new Map<string, string>();
  private tokens: number;
  private lastRefill: number;
  private readonly limits: Init['limits'];
  private readonly unsubscribe: () => void;

  constructor(private readonly o: FakeHostOptions) {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.limits = { contentBytes: 64 * 1024, publishPerSecond: 5, storageBytes: 256 * 1024, ...o.limits };
    this.tokens = 20;
    this.lastRefill = this.clockMs();
    const root = (typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement));
    this.ctx = { port: channel.port2, root };
    this.port.onmessage = (e) => void this.handle(e.data as Req);
    this.port.start();

    const create = o.relay.events.find((ev) => ev.id === o.sessionId);
    const init: Init = {
      api: 1,
      app: { address: `32390:${'0'.repeat(64)}:test`, title: 'Test app', author: '0'.repeat(64) },
      session: {
        id: o.sessionId,
        createdBy: create?.pubkey ?? '',
        createdAt: create?.created_at ?? 0,
        channelName: 'test',
      },
      me: o.me,
      participants: o.participants ?? [],
      paths: Object.keys(o.assets ?? {}),
      locale: 'en',
      theme: { mode: 'dark', accent: '#b4f953' },
      limits: this.limits,
      connection: o.connection ?? { connected: true, since: 0 },
    };
    this.push({ type: 'init', ...init });
    this.push({ type: 'events', events: o.relay.events.filter((ev) => this.belongs(ev)).sort(byTime) });
    this.unsubscribe = o.relay.subscribe((ev) => {
      if (this.belongs(ev)) this.push({ type: 'events', events: [ev] });
    });
  }

  private clockMs(): number {
    return this.o.clockMs?.() ?? Date.now();
  }

  private belongs(ev: NostrEvent): boolean {
    return ev.id === this.o.sessionId || ev.tags.some((t) => t[0] === 'e' && t[1] === this.o.sessionId);
  }

  private push(msg: Record<string, unknown>): void {
    if (!this.closed) this.port.postMessage(msg);
  }

  setConnection(c: ConnectionState): void {
    this.push({ type: 'connection', ...c });
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe();
    this.port.close();
  }

  private reply(id: number, result?: unknown) {
    this.push({ re: id, ok: true, ...(result !== undefined ? { result } : {}) });
  }

  private fail(id: number, error: ErrorCode, message?: string) {
    this.push({ re: id, ok: false, error, ...(message ? { message } : {}) });
  }

  private takeToken(): boolean {
    const now = this.clockMs();
    this.tokens = Math.min(20, this.tokens + ((now - this.lastRefill) / 1000) * this.limits.publishPerSecond);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private async handle(req: Req): Promise<void> {
    if (!req || typeof req !== 'object' || !Number.isInteger(req.id) || typeof req.type !== 'string') return;
    if (this.closed) return this.fail(req.id, 'closed');
    switch (req.type) {
      case 'publish': return this.publish(req);
      case 'asset': {
        const blob = this.o.assets?.[String(req.path)];
        return blob ? this.reply(req.id, blob) : this.fail(req.id, 'not-found');
      }
      case 'storage.get':
        return this.reply(req.id, this.storage.get(String(req.key)) ?? null);
      case 'storage.set': {
        const key = String(req.key);
        const value = req.value === null ? null : String(req.value);
        const size = [...this.storage].reduce((n, [k, v]) => (k === key ? n : n + k.length + v.length), 0)
          + (value === null ? 0 : key.length + value.length);
        if (size > this.limits.storageBytes) return this.fail(req.id, 'quota');
        if (value === null) this.storage.delete(key); else this.storage.set(key, value);
        return this.reply(req.id);
      }
      case 'profiles': {
        const authors = new Set(this.o.relay.events.filter((ev) => this.belongs(ev)).map((ev) => ev.pubkey));
        const known = new Map((this.o.participants ?? []).map((p) => [p.pubkey, p]));
        const pubkeys = Array.isArray(req.pubkeys) ? (req.pubkeys as unknown[]).slice(0, 32).map(String) : [];
        return this.reply(req.id, pubkeys.map((pk) =>
          (authors.has(pk) && known.get(pk)) || { pubkey: pk, name: `npub…${pk.slice(-4)}` }));
      }
      case 'ui.toast':
        this.toasts.push(String(req.text).slice(0, 120));
        return this.reply(req.id);
      case 'ui.resize':
        return this.reply(req.id);
      case 'ui.close':
        this.closed = true;
        return this.reply(req.id);
      default:
        return this.fail(req.id, 'unsupported');
    }
  }

  private async publish(req: Req): Promise<void> {
    const op = req.op;
    if (typeof op !== 'string' || !OP_PATTERN.test(op) || op === 'create') return this.fail(req.id, 'forbidden-op');
    const content = req.content === undefined ? '' : req.content;
    if (typeof content !== 'string') return this.fail(req.id, 'bad-request');
    if (enc.encode(content).length > this.limits.contentBytes) return this.fail(req.id, 'too-large');
    if (op === 'status') {
      try {
        const text = (JSON.parse(content) as { text?: unknown }).text;
        if (typeof text !== 'string' || text.length > STATUS_MAX_CHARS) return this.fail(req.id, 'too-large');
      } catch {
        return this.fail(req.id, 'bad-request');
      }
    }
    if (req.n !== undefined && !(Number.isSafeInteger(req.n) && (req.n as number) >= 0)) return this.fail(req.id, 'bad-n');
    if (!this.o.me) return this.fail(req.id, 'signed-out');
    if (!this.takeToken()) return this.fail(req.id, 'rate-limited');

    const tags = [
      ['h', this.o.channel ?? 'test-channel'],
      ['t', APP_TAG],
      ['op', op],
      ['e', this.o.sessionId, '', 'root'],
      ...(req.n !== undefined ? [['n', String(req.n)]] : []),
    ];
    const ev = await this.o.relay.sign(this.o.me, { kind: KIND_APP_EVENT, tags, content });
    if (op === 'status') this.statusText = (JSON.parse(content) as { text: string }).text;
    this.o.relay.publish(ev);
    this.reply(req.id, { id: ev.id, created_at: ev.created_at });
  }
}

function byTime(a: NostrEvent, b: NostrEvent): number {
  return a.created_at !== b.created_at ? a.created_at - b.created_at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Host ops the fake interprets itself — re-exported for tests. */
export { HOST_OPS };
