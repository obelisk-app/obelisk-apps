/**
 * The table itself: roster while waiting, board while playing, result when
 * done. Carried over from obelisk-dex `GameModal.tsx`, minus what the host now
 * owns — the modal, its title bar, close and fullscreen buttons live in dex's
 * frame chrome, outside the sandbox — and minus the per-game board switch,
 * which is `ui.Board`.
 *
 * Every button publishes one event and then does nothing: the UI updates when
 * that event comes back through the host, exactly like a chat message. There
 * is no optimistic local board, because a board the relay hasn't accepted is a
 * board the other players cannot see.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Host } from '@obelisk/apps-sdk';
import {
  canJoin, canStart, seatsControlledBy, turnSecondsLeft, type GameSession, type SeatSpec, type Table,
} from '@obelisk/apps-sdk/turn';

import GameOverOverlay from './GameOverOverlay.js';
import GameResults from './GameResults.js';
import { useGameUi } from './game-ui.js';
import { useTranslation } from './i18n.js';
import { Avatar, usePeople } from './people.js';
import { seatDisplayLabel } from './seat-label.js';
import StartTable from './StartTable.js';

/**
 * Room a board keeps for its own legend under the cells (seat chips, "you
 * play as"). Everything else around it is measured, not guessed: a guessed
 * constant is what made the board overflow the frame by a few pixels.
 */
const BOARD_LEGEND_PX = 64;
/** The deciding move is the biggest cascade; let it play before the splash covers it. */
const RESULT_SPLASH_DELAY_MS = 300;
/** …and a ceiling, so a board that never reports "done" can't eat the splash. */
const RESULT_SPLASH_MAX_WAIT_MS = 6000;

function useSession(table: Table): GameSession | null {
  return useSyncExternalStore(
    (notify) => table.subscribe(() => notify()),
    () => table.session,
    () => table.session,
  );
}

function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useViewport(): { width: number; height: number } {
  const key = useSyncExternalStore(
    (notify) => {
      window.addEventListener('resize', notify);
      return () => window.removeEventListener('resize', notify);
    },
    () => `${window.innerWidth}x${window.innerHeight}`,
    () => '640x640',
  );
  return useMemo(() => {
    const [w, h] = key.split('x').map(Number);
    return { width: w, height: h };
  }, [key]);
}

export default function GameApp({ host, table }: { host: Host; table: Table }) {
  const { t } = useTranslation();
  const ui = useGameUi();
  const { nameOf } = usePeople();
  const session = useSession(table);
  const myPubkey = table.me;
  const now = useNowSeconds();
  const viewport = useViewport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seatPickerOpen, setSeatPickerOpen] = useState(false);
  const [boardRevealing, setBoardRevealing] = useState(false);
  const boardArea = useRef<HTMLDivElement>(null);
  const actionsRow = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ area: number; actions: number; width: number } | null>(null);
  // Re-measure when the frame resizes or the table changes phase.
  useLayoutEffect(() => {
    const area = boardArea.current;
    if (!area) return;
    const measure = () => {
      const next = { area: area.clientHeight, actions: actionsRow.current?.offsetHeight ?? 0, width: area.clientWidth };
      setMeasured((cur) => (cur && cur.area === next.area && cur.actions === next.actions && cur.width === next.width ? cur : next));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(area);
    return () => ro?.disconnect();
  });

  // Arm the splash a beat after the table finishes, keyed by the result it's
  // armed for so a rematch re-arms on its own.
  const finished = session?.status === 'finished';
  const resultKey = `${session?.id}:${session?.finishedAt ?? ''}`;
  const [splashArmedFor, setSplashArmedFor] = useState<string | null>(null);
  const splashReady = finished && splashArmedFor === resultKey;
  useEffect(() => {
    if (!finished) return;
    const id = setTimeout(() => setSplashArmedFor(resultKey), RESULT_SPLASH_DELAY_MS);
    return () => clearTimeout(id);
  }, [finished, resultKey]);
  useEffect(() => {
    if (!finished || !boardRevealing) return;
    const id = setTimeout(() => setBoardRevealing(false), RESULT_SPLASH_MAX_WAIT_MS);
    return () => clearTimeout(id);
  }, [finished, boardRevealing]);

  // A seat can carry its own name — how two people sharing one account show
  // up as two players. Viewer-relative labels ("Vos") fall back to the profile.
  const seatLabelFor = useCallback((seatId: string) => {
    const seat = session?.seats.find((s2) => s2.id === seatId);
    return seatDisplayLabel(seat?.label, nameOf(seat?.by ?? seatId));
  }, [session, nameOf]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The host rejected that');
    } finally {
      setBusy(false);
    }
  }, []);

  const onMove = useCallback((action: unknown, seat: string) => run(() => table.move(action, seat)), [run, table]);
  // Real-time ops are fire-and-forget: a dropped attack must never stall the board.
  const onSend = useCallback((op: string, body: Record<string, unknown>) => {
    table.send(op, body).catch((err) => console.warn(`[${ui.def.type}] ${op} failed to publish`, err));
  }, [table, ui.def.type]);

  const box = useMemo(() => {
    const areaH = measured?.area ?? viewport.height - 48;
    const actionsH = measured?.actions ?? 40;
    return {
      width: Math.max(200, (measured?.width ?? viewport.width) - 8),
      height: Math.max(200, areaH - actionsH - 12 - BOARD_LEGEND_PX),
    };
  }, [measured, viewport]);

  if (!session) {
    return (
      <div className="p-6">
        <div className="lc-skeleton h-40 w-full rounded-lg" />
        <p className="mt-3 text-center text-xs text-lc-muted">{t('games.loadingTable')}</p>
      </div>
    );
  }

  const secondsLeft = turnSecondsLeft(session, now);
  const mySeats = seatsControlledBy(session, myPubkey);
  const roster = session.status === 'waiting' ? session.joined : session.participants;
  // Resigning names a seat: the seat on move if it's ours, else our only one.
  const resignSeat = session.currentTurn && mySeats.includes(session.currentTurn)
    ? session.currentTurn
    : mySeats.length === 1 ? mySeats[0] : null;

  const actions = (
    <div className="flex flex-wrap items-center gap-2" data-testid="game-actions">
      {canJoin(session, myPubkey) && (
        <button type="button" disabled={busy} onClick={() => run(() => table.join())}
          className="lc-pill-primary px-4 py-1.5 text-xs" data-testid="game-join">
          {t('games.join')}
        </button>
      )}
      {session.status === 'waiting' && myPubkey && myPubkey !== session.createdBy && session.joined.includes(myPubkey) && (
        <button type="button" disabled={busy} onClick={() => run(() => table.leave())}
          className="lc-pill-secondary px-4 py-1.5 text-xs" data-testid="game-leave">
          Leave
        </button>
      )}
      {canStart(session, myPubkey) && (
        <button type="button" disabled={busy} onClick={() => setSeatPickerOpen(true)}
          className="lc-pill-primary px-4 py-1.5 text-xs" data-testid="game-start">
          Start ({session.joined.length})
        </button>
      )}
      {session.status === 'waiting' && myPubkey === session.createdBy && (
        <button type="button" disabled={busy} onClick={() => run(() => table.cancel())}
          className="lc-pill-secondary px-4 py-1.5 text-xs" data-testid="game-cancel">
          {t('games.cancelTable')}
        </button>
      )}
      {session.status === 'in_progress' && resignSeat && !session.eliminated.includes(resignSeat) && (
        <button type="button" disabled={busy} onClick={() => run(() => table.resign(resignSeat))}
          className="lc-pill-secondary px-4 py-1.5 text-xs" data-testid="game-resign">
          {t('games.resign')}
        </button>
      )}
      {session.status === 'waiting' && session.joined.length < session.minPlayers && (
        <span className="text-[11px] text-lc-muted">Needs {session.minPlayers} players to start.</span>
      )}
    </div>
  );

  const status = (() => {
    switch (session.status) {
      case 'waiting': return `Waiting for players · ${session.joined.length}/${session.maxPlayers}`;
      case 'cancelled': return 'Table cancelled';
      case 'finished': return session.draw ? 'Draw' : session.winner ? `${seatLabelFor(session.winner)} won` : 'Game over';
      case 'in_progress':
        if (ui.statusLine) return ui.statusLine(session, seatLabelFor, mySeats);
        return session.currentTurn && mySeats.includes(session.currentTurn)
          ? 'Your turn'
          : `${seatLabelFor(session.currentTurn ?? '')}'s turn`;
    }
  })();

  return (
    <div className="relative flex h-screen flex-col overflow-y-auto p-3" data-testid="game-app">
      {seatPickerOpen && (
        <StartTable
          session={session}
          onClose={() => setSeatPickerOpen(false)}
          onStart={(seats: SeatSpec[], opts, turnTimeoutS) => {
            setSeatPickerOpen(false);
            void run(() => table.start(seats, opts, turnTimeoutS));
          }}
        />
      )}

      {splashReady && !boardRevealing && (
        <GameOverOverlay session={session} myPubkey={myPubkey} onClose={() => setSplashArmedFor(null)} />
      )}

      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-xs text-lc-muted" data-testid="game-status">{status}</p>
        {session.status === 'in_progress' && secondsLeft !== null && (
          <span className={`shrink-0 font-mono text-xs ${secondsLeft <= 10 ? 'text-red-400' : 'text-lc-white'}`} data-testid="game-clock">
            {secondsLeft}s
          </span>
        )}
      </div>

      {session.status === 'waiting' || session.status === 'cancelled' ? (
        // The lobby: one card with the people and what to do next, near the
        // top — not a lone roster line floating mid-frame with the buttons
        // pinned to the far bottom.
        <div className="mx-auto mt-6 w-full max-w-md rounded-xl border border-lc-border bg-lc-card p-4" data-testid="game-lobby">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-lc-white">{ui.icon} {ui.def.displayName}</h2>
            <span className="text-[11px] text-lc-muted">{session.joined.length}/{session.maxPlayers}</span>
          </div>
          <ul className="mt-3 space-y-2" data-testid="game-roster">
            {roster.map((pk, i) => (
              <li key={pk} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ui.colors[i] }} />
                <Avatar pubkey={pk} size={7} />
                <span className="min-w-0 truncate text-sm text-lc-white">{nameOf(pk)}</span>
                {pk === myPubkey && <span className="text-[11px] text-lc-muted">(you)</span>}
                {pk === session.createdBy && (
                  <span className="rounded-full border border-lc-border px-1.5 text-[10px] text-lc-muted">host</span>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
          <div className="mt-4 border-t border-lc-border pt-3">
            {actions}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 flex-col items-center" ref={boardArea}>
          {/* The same element whether running or finished: swapping it for a
              results panel unmounted the board mid-animation, so the winning
              explosion was the one nobody saw. */}
          <ui.Board
            session={session}
            mySeats={mySeats}
            onMove={onMove}
            onSend={onSend}
            seatLabel={seatLabelFor}
            busy={busy}
            box={box}
            onRevealChange={setBoardRevealing}
            host={host}
          />
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
          {session.status === 'finished' && (
            <div className="mt-4 w-full max-w-md">
              <GameResults session={session} seatLabel={seatLabelFor} myPubkey={myPubkey} />
            </div>
          )}
          <div className="mt-3" ref={actionsRow}>{actions}</div>
        </div>
      )}
    </div>
  );
}
