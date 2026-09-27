/**
 * Rebind the controls.
 *
 * Ported from obelisk-dex `src/components/chat/games/stacker/StackerKeysPanel.tsx`.
 * Two changes:
 *   - bindings go through the injected store (`host.storage`), so they load
 *     asynchronously; the list shows the defaults until the stored map lands;
 *   - dex's `ModalShell` (a portal to document.body) is replaced by an overlay
 *     inside the table. The frame is the whole document, so there is no card
 *     to escape from, and Escape / backdrop-click close it the same way.
 *
 * Bindings are a property of the keyboard in front of you, not of your
 * account, so they have no business on the relay. An action can hold several
 * keys — the defaults bind rotate to both ↑ and X — so binding one key never
 * clears the others.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@obelisk/apps-ui';
import {
  BINDABLE, bindKey, defaultKeyMap, keyLabel, keysFor, loadKeyMap, resetKeyMap, saveKeyMap, unbindKey,
  type KeyMap,
} from './keymap';
import type { InputKind } from './engine';

export default function StackerKeysPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [map, setMap] = useState<KeyMap>(() => defaultKeyMap());
  const [listening, setListening] = useState<InputKind | null>(null);
  // A late load must not undo an edit made before the stored map arrived.
  const touched = useRef(false);
  const edit = (next: KeyMap) => {
    touched.current = true;
    setMap(next);
    void saveKeyMap(next);
  };

  useEffect(() => {
    let live = true;
    void loadKeyMap().then((m) => { if (live && !touched.current) setMap(m); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListening(null);
        return;
      }
      edit(bindKey(map, e.code, listening));
      setListening(null);
    };
    // Capture, so the game's own handler does not also see this keypress.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, map]);

  // Escape closes, as ModalShell did. While a key is being captured the
  // capture listener above swallows Escape first, so it only cancels that.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="stacker-keys-panel"
    >
      <div
        className="w-full max-w-sm mx-4 rounded-xl bg-lc-dark border border-lc-border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-lc-white">{t('games.controls')}</h2>
        <p className="mt-1 text-[11px] text-lc-muted">
          {t('games.controlsHelp')}
        </p>

        <ul className="mt-3 space-y-1.5" data-testid="stacker-key-list">
          {BINDABLE.map(({ action, label }) => {
            const bound = keysFor(map, action);
            return (
              <li key={action} className="flex items-center gap-2" data-testid={`keys-${action}`}>
                <span className="flex-1 text-xs text-lc-white">{label}</span>
                {bound.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => edit(unbindKey(map, code))}
                    title={t('games.removeKey')}
                    className="rounded border border-lc-border px-1.5 py-0.5 font-mono text-[10px] text-lc-muted hover:border-red-400 hover:text-red-400"
                  >
                    {keyLabel(code)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setListening(action)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    listening === action
                      ? 'border-lc-green text-lc-green'
                      : 'border-lc-border text-lc-muted hover:text-lc-white'
                  }`}
                  data-testid={`bind-${action}`}
                >
                  {listening === action ? 'press a key…' : '+ key'}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex justify-between">
          <button
            type="button"
            onClick={() => { touched.current = true; void resetKeyMap().then(setMap); }}
            className="lc-pill-secondary px-4 py-1.5 text-xs"
            data-testid="stacker-keys-reset"
          >
            {t('games.resetKeys')}
          </button>
          <button type="button" onClick={onClose} className="lc-pill-primary px-4 py-1.5 text-xs" data-testid="stacker-keys-done">
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
