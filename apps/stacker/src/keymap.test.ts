import { describe, it, expect, beforeEach } from 'vitest';
import {
  BINDABLE, bindKey, defaultKeyMap, keyLabel, keysFor, loadKeyMap,
  resetKeyMap, saveKeyMap, unbindKey, KEYMAP_STORAGE_KEY,
} from './keymap';
import { memoryStorage, setStackerStorage, type KeyValueStorage } from './storage';

describe('stacker key bindings', () => {
  let storage: KeyValueStorage;
  beforeEach(() => {
    storage = memoryStorage();
    setStackerStorage(storage);
  });

  it('starts from the defaults', async () => {
    const map = await loadKeyMap();
    expect(map.ArrowLeft).toBe('left');
    expect(map.Space).toBe('hard');
  });

  it('binds a key and keeps it across a reload', async () => {
    const next = bindKey(defaultKeyMap(), 'KeyJ', 'left');
    await saveKeyMap(next);
    expect((await loadKeyMap()).KeyJ).toBe('left');
  });

  it('lets one action keep several keys', () => {
    const map = bindKey(defaultKeyMap(), 'KeyJ', 'left');
    expect(keysFor(map, 'left')).toEqual(expect.arrayContaining(['ArrowLeft', 'KeyJ']));
  });

  it('reassigns a key away from whatever it did before', () => {
    const map = bindKey(defaultKeyMap(), 'ArrowLeft', 'hold');
    expect(map.ArrowLeft).toBe('hold');
    expect(keysFor(map, 'left')).not.toContain('ArrowLeft');
  });

  it('unbinds a single key', () => {
    const map = unbindKey(defaultKeyMap(), 'ArrowLeft');
    expect(map.ArrowLeft).toBeUndefined();
    expect(map.ArrowRight).toBe('right');
  });

  it('falls back to the defaults rather than trusting nonsense', async () => {
    await storage.set(KEYMAP_STORAGE_KEY, 'not json');
    expect((await loadKeyMap()).ArrowLeft).toBe('left');

    await storage.set(KEYMAP_STORAGE_KEY, JSON.stringify({ KeyQ: 'launch-missiles' }));
    // An unknown action is dropped; dropping everything would leave the game
    // unplayable with no way back, so the defaults come through instead.
    expect((await loadKeyMap()).ArrowLeft).toBe('left');
  });

  it('resets back to the defaults', async () => {
    await saveKeyMap(bindKey(defaultKeyMap(), 'KeyJ', 'left'));
    expect((await loadKeyMap()).KeyJ).toBe('left');
    await resetKeyMap();
    expect((await loadKeyMap()).KeyJ).toBeUndefined();
  });

  it('uses whichever store it is handed, e.g. host.storage', async () => {
    const other = memoryStorage();
    await saveKeyMap(bindKey(defaultKeyMap(), 'KeyK', 'hold'), other);
    expect((await loadKeyMap(other)).KeyK).toBe('hold');
    // The injected default store never saw it.
    expect((await loadKeyMap()).KeyK).toBeUndefined();
  });

  it('falls back to the defaults when the store itself fails', async () => {
    const broken: KeyValueStorage = {
      get: async () => { throw new Error('port closed'); },
      set: async () => { throw new Error('port closed'); },
    };
    expect((await loadKeyMap(broken)).ArrowLeft).toBe('left');
    await expect(saveKeyMap(defaultKeyMap(), broken)).resolves.toBeUndefined();
  });

  it('names keys the way a person would', () => {
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('KeyX')).toBe('X');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Digit3')).toBe('3');
  });

  it('offers every action a player needs', () => {
    const actions = BINDABLE.map((b) => b.action);
    for (const needed of ['left', 'right', 'soft', 'hard', 'cw', 'ccw', 'hold']) {
      expect(actions).toContain(needed);
    }
  });
});
