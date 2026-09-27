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

export async function mountGame(ctx: HostContext, ui: GameUi, css?: string): Promise<{ host: Host; table: Table }> {
  if (css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
  const host = connect(ctx);
  const table = await openTable(host, ui.def);
  createRoot(ctx.root).render(
    <StrictMode>
      <Root host={host} table={table} ui={ui} />
    </StrictMode>,
  );
  return { host, table };
}
