import type { GameSession } from '@obelisk/apps-sdk/turn';

import { useGameUi } from './game-ui.js';
import { useTranslation } from './i18n.js';
import { isDraw, standingsFor } from './standings.js';

/**
 * How a match ended, for everyone.
 *
 * A finished table is not private: the log is on the relay, so anybody in the
 * channel can replay it. This is that replay made readable — final standings
 * with each game's own idea of a score, shown to players and spectators alike,
 * whether or not they were sitting at the table.
 */
export default function GameResults({
  session,
  seatLabel,
  myPubkey,
}: {
  session: GameSession;
  seatLabel: (seatId: string) => string;
  myPubkey: string | null;
}) {
  const { t } = useTranslation();
  const ui = useGameUi();
  const rows = rowsFor(ui, session);
  const mine = session.seats.filter((s) => s.by === myPubkey).map((s) => s.id);

  return (
    <div className="space-y-3" data-testid="game-results">
      <div className="text-center">
        <div className="text-[10px] uppercase tracking-[0.14em] text-lc-muted">{t('games.finalResult')}</div>
        <div className="mt-0.5 text-sm font-semibold text-lc-white">
          {ui.icon} {ui.def.displayName}
          {session.winner
            ? ` · ${seatLabel(session.winner)} won`
            : isDraw(session)
              ? ' · draw'
              // A solo run has no winner and no draw: it simply ended.
              : ' · game over'}
        </div>
      </div>

      <ol className="space-y-1.5" data-testid="results-standings">
        {rows.map((row, i) => {
          const isWinner = row.seat === session.winner;
          return (
            <li
              key={row.seat}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                isWinner ? 'border-lc-green/60 bg-lc-green/10' : 'border-lc-border'
              }`}
              data-testid={`result-row-${row.seat}`}
            >
              <span className="w-4 text-center text-[11px] text-lc-muted">{i + 1}</span>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
              <span className={`min-w-0 flex-1 truncate text-xs ${isWinner ? 'text-lc-white' : 'text-lc-muted'}`}>
                {seatLabel(row.seat)}
                {mine.includes(row.seat) && <span className="ml-1 text-[10px] text-lc-muted">(you)</span>}
              </span>
              {isWinner && <span className="shrink-0 text-sm" aria-label="winner">🏆</span>}
              <span className="shrink-0 font-mono text-[11px] text-lc-white" data-testid={`result-score-${row.seat}`}>
                {row.score}
              </span>
            </li>
          );
        })}
      </ol>

      {rows.length > 0 && rows[0].detail && (
        <p className="text-center text-[10px] text-lc-muted">{rows[0].detail}</p>
      )}
    </div>
  );
}

interface Row {
  seat: string;
  score: string;
  color: string;
  detail?: string;
}

/** Standings from the game's own scorer, painted in its seat colours. */
function rowsFor(ui: ReturnType<typeof useGameUi>, session: GameSession): Row[] {
  return standingsFor(ui, session).map((row) => ({
    seat: row.seat,
    score: row.score,
    detail: row.detail,
    color: ui.colors[session.participants.indexOf(row.seat)] ?? '#a3a3a3',
  }));
}
