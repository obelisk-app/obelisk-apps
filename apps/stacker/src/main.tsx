/**
 * The bundle's entry. The frame loader imports this module and calls its
 * default export with `{ port, root }` (docs/host-api.md § Topology).
 *
 * Host services (storage for key bindings and audio prefs, `host.asset` for
 * the soundtrack) are bound by the board itself (`host-services.ts`), from
 * BoardProps.host, before its first key map load.
 */
import { mountGame } from '@obelisk/apps-ui';
import type { HostContext } from '@obelisk/apps-sdk';

import css from './app.css';
import { ui } from './ui';

export default function main(ctx: HostContext) {
  return mountGame(ctx, ui, css);
}
