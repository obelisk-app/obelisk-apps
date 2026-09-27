/**
 * Where Stacker keeps its device preferences (key bindings, audio toggles).
 *
 * In obelisk-dex these went straight to `localStorage`. An app runs in a
 * sandboxed iframe with an opaque origin, where `localStorage` either throws
 * or forgets everything on reload, so the store is injected instead. The shape
 * is exactly the SDK Host's `host.storage`, so the app passes that through:
 *
 *   setStackerStorage(host.storage);
 *
 * Until something is injected, preferences live in memory for the session.
 */
export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

/** A store that forgets on reload. The default, and handy in tests. */
export function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      if (value === null) data.delete(key);
      else data.set(key, value);
    },
  };
}

let current: KeyValueStorage = memoryStorage();

/** Point every Stacker preference at a store, e.g. `host.storage`. */
export function setStackerStorage(storage: KeyValueStorage): void {
  current = storage;
}

export function stackerStorage(): KeyValueStorage {
  return current;
}
