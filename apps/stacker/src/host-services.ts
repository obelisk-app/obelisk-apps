/**
 * Points Stacker's device services at the host: preferences into
 * `host.storage`, soundtrack out of `host.asset`.
 *
 * The build publishes `assets/music/x.mp3` under the manifest path
 * `/music/x.mp3`, and `host.asset` takes exactly that path — while
 * `MUSIC_TRACKS` keeps dex's bundle-relative `music/x.mp3`. The leading slash
 * is added here, and only here.
 */
import type { Host } from '@obelisk/apps-sdk';
import { setMusicSource, type MusicSource } from './audio';
import { setStackerStorage } from './storage';

export function musicSourceFor(host: Pick<Host, 'asset'>): MusicSource {
  return (path) => host.asset(path.startsWith('/') ? path : `/${path}`);
}

let bound: Pick<Host, 'asset' | 'storage'> | null = null;

/**
 * Idempotent per host. Called while the board renders — before any child
 * effect loads a key map — because a parent's effect runs after its
 * children's, which would be too late for the first load.
 */
export function bindHostServices(host: Pick<Host, 'asset' | 'storage'>): void {
  if (bound === host) return;
  bound = host;
  setStackerStorage(host.storage);
  setMusicSource(musicSourceFor(host));
}
