/**
 * The whole app entry, for games built on the shell:
 *
 *   import { mountGame } from '@obelisk/apps-ui';
 *   import css from './app.css';            // built by tailwind, inlined by esbuild
 *   export default (ctx) => mountGame(ctx, ui, css);
 *
 * `ctx` is what the frame loader passes to the entry's default export
 * (`{ port, root }`, docs/host-api.md § Topology).
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { connect, type Host, type HostContext } from '@obelisk/apps-sdk';
import { openTable, type Table } from '@obelisk/apps-sdk/turn';

import GameApp from './GameApp.js';
import { GameUiProvider, type GameUi } from './game-ui.js';
import { I18nProvider, type Locale } from './i18n.js';
import { PeopleProvider } from './people.js';

function Root({ host, table, ui }: { host: Host; table: Table; ui: GameUi }) {
  const [locale, setLocale] = useState<Locale>(table.init.locale);
  useEffect(() => host.onEnv((e) => setLocale(e.locale)), [host]);
  return (
    <I18nProvider locale={locale}>
      <GameUiProvider value={ui}>
        <PeopleProvider host={host}>
          <GameApp host={host} table={table} />
        </PeopleProvider>
      </GameUiProvider>
    </I18nProvider>
  );
}

/**
 * The host's accent, applied to the theme token every lc-* class reads, so a
 * relay retinted purple stays purple inside the frame. Only a #rrggbb gets
 * through: this value lands in a style attribute.
 */
export function inkFor(accent: string): string {
  // Dex's own rule (src/lib/preferences.ts readableInk), so a game's buttons
  // read like the app around them: dark text only on light colours (lime),
  // light text on the purple relay accent.
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(accent.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? '#0a0a0a' : '#fafafa';
}

function applyAccent(accent: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return;
  const root = document.documentElement.style;
  root.setProperty('--color-lc-green', accent);
  root.setProperty('--obelisk-button-ink', inkFor(accent));
}

export async function mountGame(ctx: HostContext, ui: GameUi, css?: string): Promise<{ host: Host; table: Table }> {
  if (css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
  const host = connect(ctx);
  const table = await openTable(host, ui.def);
  applyAccent(table.init.theme.accent);
  host.onEnv((e) => applyAccent(e.theme.accent));
  createRoot(ctx.root).render(
    <StrictMode>
      <Root host={host} table={table} ui={ui} />
    </StrictMode>,
  );
  return { host, table };
}
