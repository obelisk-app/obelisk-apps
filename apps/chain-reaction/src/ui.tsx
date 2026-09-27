/**
 * Everything the shared table shell needs to know about Chain Reaction: the
 * board, its seat colours, how it scores, and its one option (board size).
 * In obelisk-dex these were switches on the game id spread over GameModal,
 * GameResults, standings.ts and the /play picker.
 */
import type { BoardProps, GameUi, OptionsProps, Standing } from '@obelisk/apps-ui';
import { useTranslation } from '@obelisk/apps-ui';
import type { GameSession } from '@obelisk/apps-sdk/turn';

import ChainReactionBoard, { SEAT_COLORS } from './Board';
import { chainReaction, CR_SIZES, type CRSizeKey, type CRState } from './engine';

function Board({ session, mySeats, onMove, box, seatLabel, onRevealChange }: BoardProps) {
  return (
    <ChainReactionBoard
      game={session}
      mySeats={mySeats}
      onAction={(action, seat) => onMove(action, seat)}
      maxWidth={box.width}
      maxHeight={box.height}
      seatLabel={seatLabel}
      onRevealChange={onRevealChange}
    />
  );
}

function Options({ opts, setOpts }: OptionsProps) {
  const { t } = useTranslation();
  const size = (typeof opts.size === 'string' && opts.size in CR_SIZES ? opts.size : 'medium') as CRSizeKey;
  return (
    <>
      <p className="text-[10px] uppercase tracking-wide text-lc-muted">{t('games.board')}</p>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {(Object.keys(CR_SIZES) as CRSizeKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setOpts({ ...opts, size: key })}
            className={`rounded-lg border px-2 py-2 text-xs transition-colors ${
              size === key ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-white hover:bg-lc-border/40'
            }`}
            data-testid={`game-size-${key}`}
          >
            {CR_SIZES[key].label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Orbs held when the board was taken; the eliminated are out. From dex standings.ts. */
export function standings(session: GameSession): Standing[] {
  const seats = session.participants;
  const state = session.state as CRState | null;
  const owned = new Map<string, number>();
  for (const cell of state?.cells ?? []) {
    if (cell.owner === null) continue;
    const seat = state!.order[cell.owner];
    if (seat) owned.set(seat, (owned.get(seat) ?? 0) + cell.count);
  }
  return seats
    .map((seat) => ({
      seat,
      score: session.eliminated.includes(seat) ? 'out' : `${owned.get(seat) ?? 0} orbs`,
      sort: session.eliminated.includes(seat) ? -1 : (owned.get(seat) ?? 0),
      detail: 'Orbs held when the board was taken',
    }))
    .sort((a, b) => b.sort - a.sort);
}

export const ui: GameUi = {
  def: chainReaction,
  icon: '⚛',
  colors: SEAT_COLORS.map((c) => c.hex),
  Board,
  Options,
  defaultOpts: () => ({ size: 'medium' }),
  standings,
};
