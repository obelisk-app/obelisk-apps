/** The bundle's entry: the frame loader calls the default export with `{ port, root }`. */
import { mountGame } from '@obelisk/apps-ui';
import type { HostContext } from '@obelisk/apps-sdk';

import css from './app.css';
import { ui } from './ui';

export default function main(ctx: HostContext) {
  return mountGame(ctx, ui, css);
}
