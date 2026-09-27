/**
 * The bundle's entry. The frame loader imports this module and calls its
 * default export with `{ port, root }` (docs/host-api.md § Topology).
 */
import { mountGame } from '@obelisk/apps-ui';
import type { HostContext } from '@obelisk/apps-sdk';

import css from './app.css';
import { ui } from './ui';

export default function main(ctx: HostContext) {
  return mountGame(ctx, ui, css);
}
