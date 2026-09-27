/**
 * The app side of host API v1 (docs/host-api.md).
 *
 *   export default function main(ctx) {
 *     const host = connect(ctx);
 *     const init = await host.ready;
 *     host.onEvents((evs) => …);
 *     await host.publish({ op: 'move', content: JSON.stringify(…), n: 3 });
 *   }
 *
 * Everything goes over the MessagePort the loader handed us. Nothing here is
 * trusted by the host — it re-checks every request — so this file is about
 * ergonomics, not enforcement.
 */
import {
  HostError,
  type ConnectionState,
  type Init,
  type NostrEvent,
  type Participant,
  type PublishRequest,
  type Push,
  type Res,
} from './types.js';

export interface HostContext {
  port: MessagePort;
  root: HTMLElement;
}

type Listener<T> = (value: T) => void;

export interface Host {
  /** Resolves with the `init` push. Every other call works before it resolves, but you'll want it. */
  readonly ready: Promise<Init>;
  readonly root: HTMLElement;
  /** The backlog arrives as one call, then each live batch. Returns an unsubscribe. */
  onEvents(cb: Listener<NostrEvent[]>): () => void;
  onParticipants(cb: Listener<Participant[]>): () => void;
  onVisibility(cb: Listener<boolean>): () => void;
  onEnv(cb: Listener<Pick<Init, 'locale' | 'theme'>>): () => void;
  onConnection(cb: Listener<ConnectionState>): () => void;

  publish(req: PublishRequest): Promise<{ id: string; created_at: number }>;
  asset(path: string): Promise<Blob>;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<void>;
  };
  profiles(pubkeys: string[]): Promise<Participant[]>;
  ui: {
    resize(height: number): Promise<void>;
    toast(text: string, tone?: 'info' | 'error'): Promise<void>;
    close(): Promise<void>;
  };
  /** Stop listening; the port is closed. */
  dispose(): void;
}

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  /** Replayed to late subscribers, so a listener attached after the backlog still sees it. */
  private history: T[] = [];
  constructor(private readonly replay: 'all' | 'last' | 'none') {}
  on(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    for (const v of this.history) cb(v);
    return () => this.listeners.delete(cb);
  }
  emit(v: T): void {
    if (this.replay === 'all') this.history.push(v);
    else if (this.replay === 'last') this.history = [v];
    for (const cb of this.listeners) cb(v);
  }
}

export function connect(ctx: HostContext): Host {
  const { port } = ctx;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let resolveReady!: (i: Init) => void;
  const ready = new Promise<Init>((r) => { resolveReady = r; });

  const events = new Emitter<NostrEvent[]>('all');
  const participants = new Emitter<Participant[]>('last');
  const visibility = new Emitter<boolean>('last');
  const env = new Emitter<Pick<Init, 'locale' | 'theme'>>('last');
  const connection = new Emitter<ConnectionState>('last');

  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as Res | Push;
    if (!msg || typeof msg !== 'object') return;
    if ('re' in msg && typeof msg.re === 'number') {
      const res = msg as Res;
      const p = pending.get(res.re);
      if (!p) return;
      pending.delete(res.re);
      if (res.ok) p.resolve(res.result);
      else p.reject(new HostError(res.error, res.message));
      return;
    }
    const push = msg as Push;
    switch (push.type) {
      case 'init': {
        const init = push as unknown as Init & Push;
        participants.emit(init.participants);
        connection.emit(init.connection);
        env.emit({ locale: init.locale, theme: init.theme });
        resolveReady(init);
        break;
      }
      case 'events':
        if (Array.isArray(push.events)) events.emit(push.events as NostrEvent[]);
        break;
      case 'participants':
        if (Array.isArray(push.participants)) participants.emit(push.participants as Participant[]);
        break;
      case 'visibility':
        visibility.emit(push.visible === true);
        break;
      case 'env':
        env.emit({ locale: push.locale as Init['locale'], theme: push.theme as Init['theme'] });
        break;
      case 'connection':
        connection.emit({ connected: push.connected === true, since: typeof push.since === 'number' ? push.since : null });
        break;
    }
  };
  port.start?.();

  function call<T>(type: string, body: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ id, type, ...body });
    });
  }

  return {
    ready,
    root: ctx.root,
    onEvents: (cb) => events.on(cb),
    onParticipants: (cb) => participants.on(cb),
    onVisibility: (cb) => visibility.on(cb),
    onEnv: (cb) => env.on(cb),
    onConnection: (cb) => connection.on(cb),
    publish: (req) => call('publish', { ...req }),
    asset: (path) => call('asset', { path }),
    storage: {
      get: (key) => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
    },
    profiles: (pubkeys) => call('profiles', { pubkeys }),
    ui: {
      resize: (height) => call('ui.resize', { height }),
      toast: (text, tone = 'info') => call('ui.toast', { text, tone }),
      close: () => call('ui.close'),
    },
    dispose() {
      port.onmessage = null;
      for (const p of pending.values()) p.reject(new HostError('closed'));
      pending.clear();
      port.close();
    },
  };
}
