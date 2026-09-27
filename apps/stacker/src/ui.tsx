/**
 * Everything the shared table shell needs to know about Stacker: the board,
 * seat colours, how it scores, its one option (the piece seed) and its status
 * line. In obelisk-dex these were switches on the game id spread over
 * GameModal, GameResults, standings.ts, catalog.ts and NewGameModal.
 */
import { useEffect, useState } from 'react';
import type { BoardProps, GameUi, OptionsProps, Standing } from '@obelisk/apps-ui';
import { useTranslation } from '@obelisk/apps-ui';
import type { GameSession } from '@obelisk/apps-sdk/turn';

import { stacker } from './definition';
import { bindHostServices } from './host-services';
import type { MatchState } from './match';
import StackerTable from './StackerTable';

/**
 * Seat colours. Stacker's boards are coloured by piece, not by player, so it
 * has none of its own; dex's GameResults fell back to Chain Reaction's for it,
 * copied here.
 */
export const SEAT_COLORS = [
  '#ff4d5e', // red
  '#b4f953', // lime (brand)
  '#38bdf8', // sky
  '#fbbf24', // amber
  '#c084fc', // violet
  '#f472b6', // pink
  '#fb923c', // orange
  '#2dd4bf', // teal
];

/**
 * Board seeds are chosen by the host; keep them small and human-quotable.
 * Copied from dex `src/lib/games/vesta/definition.ts`, which the /play picker
 * used for Stacker's piece seed too.
 */
export function normalizeSeed(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(Math.abs(raw)) % 1_000_000;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.floor(Math.abs(n)) % 1_000_000;
  }
  return 0;
}

/** The host's visibility push, as a boolean. Visible until told otherwise. */
function useVisible(host: BoardProps['host']): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => host.onVisibility(setVisible), [host]);
  return visible;
}

function Board({ session, mySeats, onSend, seatLabel, box, host }: BoardProps) {
  // Before anything below mounts and reads its key map from storage.
  bindHostServices(host);
  const visible = useVisible(host);
  const match = session.match as MatchState | null;
  if (!match) return null;
  return (
    <StackerTable
      session={session}
      match={match}
      mySeats={mySeats}
      seatLabel={seatLabel}
      onSend={onSend}
      box={box}
      paused={!visible}
    />
  );
}

function Options({ opts, setOpts }: OptionsProps) {
  const { t } = useTranslation();
  // The text as typed; what's published is its normalized number.
  const [text, setText] = useState(() => String(normalizeSeed(opts.seed)));
  return (
    <>
      <p className="text-[10px] uppercase tracking-wide text-lc-muted">{t('games.pieceSeed')}</p>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpts({ ...opts, seed: normalizeSeed(e.target.value) });
        }}
        className="mt-1 w-full rounded bg-lc-black/50 px-2 py-1 text-xs text-lc-white outline-none focus:ring-1 focus:ring-lc-green"
        aria-label={t('games.pieceSeed')}
        data-testid="stacker-seed"
      />
      <p className="mt-1 text-[10px] text-lc-muted">{t('games.pieceSeedHelp')}</p>
    </>
  );
}

/**
 * Garbage sent is the number that decided the match, with lines as the
 * tiebreak. From dex standings.ts (its `session.match` branch).
 */
export function standings(session: GameSession): Standing[] {
  const match = session.match as MatchState | null;
  return session.participants
    .map((seat) => {
      const p = match?.progress[seat];
      return {
        seat,
        score: `${p?.attacksSent ?? 0}⚔ · ${p?.linesCleared ?? 0}▤`,
        sort: (p?.attacksSent ?? 0) * 1000 + (p?.linesCleared ?? 0),
        detail: 'Garbage sent · lines cleared',
      };
    })
    .sort((a, b) => b.sort - a.sort);
}

/** From dex GameModal: nobody is "on move", so say how many are left. */
export function statusLine(session: GameSession): string {
  const match = session.match as MatchState | null;
  return match ? `${match.alive.length} still standing` : 'In progress';
}

export const ui: GameUi = {
  def: stacker,
  icon: '🧱',
  colors: SEAT_COLORS,
  Board,
  Options,
  // Same default as dex's picker: seconds since the epoch, mod 100000.
  defaultOpts: () => ({ seed: Math.floor(Date.now() / 1000) % 100000 }),
  standings,
  statusLine,
};
