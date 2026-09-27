// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_STORAGE_KEY, MUSIC_TRACKS, disposeAudio, loadPrefs, savePrefs, setMusicSource, startMusic, stopMusic,
} from './audio';
import { memoryStorage, setStackerStorage, type KeyValueStorage } from './storage';

/** Just enough of HTMLAudioElement to watch what the module does with it. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  volume = 1;
  muted = false;
  currentTime = 0;
  played: string[] = [];
  paused = true;
  listeners: Record<string, Array<() => void>> = {};
  constructor() { FakeAudio.instances.push(this); }
  addEventListener(name: string, cb: () => void) { (this.listeners[name] ??= []).push(cb); }
  play() { this.played.push(this.src); this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  emit(name: string) { for (const cb of this.listeners[name] ?? []) cb(); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('stacker audio prefs', () => {
  let storage: KeyValueStorage;
  beforeEach(() => {
    storage = memoryStorage();
    setStackerStorage(storage);
  });

  it('defaults to sound and music on', async () => {
    expect(await loadPrefs()).toEqual({ muted: false, music: true });
  });

  it('round-trips through the injected store', async () => {
    await savePrefs({ muted: true, music: false });
    expect(await storage.get(AUDIO_STORAGE_KEY)).toBe(JSON.stringify({ muted: true, music: false }));
    expect(await loadPrefs()).toEqual({ muted: true, music: false });
  });

  it('survives junk and a failing store', async () => {
    await storage.set(AUDIO_STORAGE_KEY, 'not json');
    expect(await loadPrefs()).toEqual({ muted: false, music: true });
    const broken: KeyValueStorage = {
      get: async () => { throw new Error('gone'); },
      set: async () => { throw new Error('gone'); },
    };
    expect(await loadPrefs(broken)).toEqual({ muted: false, music: true });
    await expect(savePrefs({ muted: true, music: true }, broken)).resolves.toBeUndefined();
  });
});

describe('stacker music source', () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal('Audio', FakeAudio);
    let n = 0;
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:track-${n++}`),
      revokeObjectURL: vi.fn(),
    }));
  });
  afterEach(() => {
    setMusicSource(null);
    disposeAudio();
    vi.unstubAllGlobals();
  });

  it('asks the source for app asset paths, not public URLs', () => {
    for (const t of MUSIC_TRACKS) expect(t.path).toMatch(/^music\/[a-z-]+\.mp3$/);
  });

  it('plays a Blob from the source through an object URL', async () => {
    const source = vi.fn(async (_path: string) => new Blob(['mp3']));
    setMusicSource(source);
    startMusic();
    await flush();
    expect(source).toHaveBeenCalledTimes(1);
    expect(MUSIC_TRACKS.map((t) => t.path)).toContain(source.mock.calls[0][0]);
    const el = FakeAudio.instances[0];
    expect(el.src).toMatch(/^blob:track-/);
    expect(el.played).toEqual([el.src]);

    // Resuming after a stop reuses the loaded track instead of fetching again.
    stopMusic();
    startMusic();
    await flush();
    expect(source).toHaveBeenCalledTimes(1);
    expect(el.played).toHaveLength(2);

    disposeAudio();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(el.src);
  });

  it('accepts a plain URL string and moves to the next track when one ends', async () => {
    setMusicSource(async (path) => `https://example.test/${path}`);
    startMusic();
    await flush();
    const el = FakeAudio.instances[0];
    const first = el.src;
    el.emit('ended');
    await flush();
    expect(el.src).not.toBe(first);
    expect(el.src).toMatch(/^https:\/\/example\.test\/music\//);
  });

  it('falls back to the synth bed (no <audio>) when there is no source or it fails', async () => {
    startMusic();
    expect(FakeAudio.instances).toHaveLength(0);

    setMusicSource(async () => { throw new Error('asset missing'); });
    startMusic();
    await flush();
    // The element was made, but the failed fetch gave up on recorded music.
    startMusic();
    expect(FakeAudio.instances).toHaveLength(1);
  });
});
