/**
 * A match: your board at full speed, everyone else's as a meter.
 *
 * Ported from obelisk-dex `src/components/chat/games/stacker/StackerTable.tsx`.
 * What changed:
 *
 *   - dex's `onAttack` / `onCheckpoint` / `onTopOut` props, which GameModal
 *     turned into `publishAttack` / `publishCheckpoint` / `publishTopOut`, are
 *     one `onSend(op, body)` here (BoardProps.onSend → `table.send`). The
 *     bodies are exactly what dex put in the event content, because every
 *     client replays them through `parseMatchEvent`:
 *
 *       attack      { seat, target, lines, hole, nonce }
 *       checkpoint  { seat, frame, attacksSent, linesCleared, stackHeight, board, inputs? }
 *       topout      { seat }
 *
 *   - no `fullscreen` flag: the frame is the whole viewport, and the shell
 *     hands the board its space as `box`, so cells are sized from that
 *     instead of from `window` minus a guessed amount of modal chrome;
 *   - `paused`: the host reports when the modal is hidden, and a hidden
 *     table stops its loop (the run is kept, exactly as closing dex's modal
 *     suspended it) instead of burning frames nobody sees.
 *
 * Opponents are deliberately coarse. Their real boards run on their own
 * machines and only reach us through checkpoints every few seconds — drawing a
 * detailed board that is seconds stale would be a lie, so we show the one thing
 * that stays true between updates: how buried they are.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameSession } from '@obelisk/apps-sdk/turn';
import { useTranslation } from '@obelisk/apps-ui';
import { incomingFor, type MatchState } from './match';
import { useStackerLoop, type CheckpointPayload } from './useStackerLoop';
import { MUSIC_CREDIT, currentTrack, setTrackListener } from './audio';
import StackerBoard, { MiniBoard, PieceChip } from './StackerBoard';
import StackerKeysPanel from './StackerKeysPanel';
import { HEIGHT, WIDTH } from './engine';

export interface StackerTableProps {
  session: GameSession;
  match: MatchState;
  /** Seats this client plays. One board per person, so one seat. */
  mySeats: string[];
  seatLabel: (seatId: string) => string;
  /** Publish one of Stacker's ops. Fire-and-forget. */
  onSend: (op: 'attack' | 'checkpoint' | 'topout', body: Record<string, unknown>) => void;
  /** The space the shell gives the board. */
  box: { width: number; height: number };
  /** The host has hidden the frame: stop the loop, keep the run. */
  paused?: boolean;
}

/** Side rails (68px each), the garbage meter and the gaps between them. */
const RAILS_PX = 190;
/** The controls line and vertical spacing, with no opponents strip. */
const CONTROLS_PX = 56;
/** An opponent's name and score under their mini board. */
const OPPONENT_LABELS_PX = 44;

/**
 * Cell size for the space available. A fixed 26px board is 520px tall, which
 * is taller than a phone's usable area. The opponents strip is a quarter-size
 * board, so it costs HEIGHT/4 cells of height on top of the main board.
 */
export function cellFor(box: { width: number; height: number }, hasOpponents: boolean): number {
  const rows = HEIGHT + (hasOpponents ? HEIGHT / 4 : 0);
  const chrome = CONTROLS_PX + (hasOpponents ? OPPONENT_LABELS_PX : 0);
  const byHeight = Math.floor((box.height - chrome) / rows);
  const byWidth = Math.floor((box.width - RAILS_PX) / WIDTH);
  return Math.max(12, Math.min(30, byHeight, byWidth));
}

export default function StackerTable({
  session,
  match,
  mySeats,
  seatLabel,
  onSend,
  box,
  paused = false,
}: StackerTableProps) {
  const { t } = useTranslation();
  const mySeat = mySeats[0] ?? null;
  const alive = match.alive;
  const iAmAlive = !!mySeat && alive.includes(mySeat);

  const incoming = useMemo(
    () => (mySeat ? incomingFor(match, mySeat) : []),
    [match, mySeat],
  );

  /**
   * Who gets the garbage. With one opponent it is obvious; with several we
   * spread it, which stops a three-way match turning into everybody burying
   * whoever happens to be first in the list.
   */
  const pickTarget = useCallback((): string | null => {
    const others = alive.filter((s) => s !== mySeat);
    if (others.length === 0) return null;
    return others[Math.floor(Math.random() * others.length)];
  }, [alive, mySeat]);

  const { runner, stats, prefs, toggleMuted, reloadKeys } = useStackerLoop({
    seed: match.seed,
    // Per player per table: two seats on one account are two separate runs,
    // and reopening the same table must land back on the same one.
    matchKey: `${session.id}:${mySeat ?? 'spectator'}`,
    matchOver: match.over,
    incoming,
    enabled: iAmAlive && !match.over && !paused,
    onAttack: useCallback((lines: number, hole: number, nonce: number) => {
      if (!mySeat) return;
      const target = pickTarget();
      if (!target) return;
      onSend('attack', { seat: mySeat, target, lines, hole, nonce });
    }, [mySeat, pickTarget, onSend]),
    onCheckpoint: useCallback((payload: CheckpointPayload) => {
      if (mySeat) onSend('checkpoint', { seat: mySeat, ...payload });
    }, [mySeat, onSend]),
    onTopOut: useCallback(() => {
      if (mySeat) onSend('topout', { seat: mySeat });
    }, [mySeat, onSend]),
  });

  const opponents = session.participants.filter((s) => s !== mySeat);
  const banner = stats.lastClear;
  const [keysOpen, setKeysOpen] = useState(false);
  // The credit line follows whatever the playlist moved on to.
  const [track, setTrack] = useState(() => currentTrack().title);
  useEffect(() => {
    setTrackListener(setTrack);
    return () => setTrackListener(null);
  }, []);

  const cell = cellFor(box, opponents.length > 0);

  /*
   * Keys only reach this document while the frame has focus. Take it on
   * mount (best effort: a browser may refuse focus to a frame without a user
   * gesture) and on any pointer down inside the table, so one click on the
   * board is always enough to start steering.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onPointerDown={() => rootRef.current?.focus({ preventScroll: true })}
      className="space-y-3 outline-none"
      data-testid="stacker-table"
    >
      <div className="flex items-start justify-center gap-3">
        {/* Left rail: hold and the numbers that matter */}
        <div className="flex w-[68px] shrink-0 flex-col gap-2">
          <div className="rounded-lg border border-lc-border bg-lc-black/40 p-1.5">
            <PieceChip kind={runner.state.hold} label={t('games.hold')} dim={!runner.state.hold} />
          </div>
          <Stat label={t('games.sent')} value={stats.attacksSent} accent="#b4f953" testId="stacker-sent" />
          <Stat label={t('games.lines')} value={stats.linesCleared} />
          <Stat label={t('games.level')} value={stats.level} accent="#22d3ee" testId="stacker-level" />
          {stats.combo > 1 && <Stat label={t('games.combo')} value={`${stats.combo}×`} accent="#facc15" />}
          {stats.backToBack > 0 && <Stat label="B2B" value={stats.backToBack} accent="#a855f7" />}
        </div>

        {/* Board, with the incoming-garbage meter running up its left side */}
        <div className="relative flex items-stretch gap-1.5">
          <div
            className="flex w-2 flex-col-reverse overflow-hidden rounded-full bg-white/5"
            title={`${stats.incoming} lines incoming`}
            data-testid="stacker-garbage-meter"
          >
            <div
              className="w-full rounded-full bg-gradient-to-t from-red-600 to-red-400 transition-[height] duration-150 ease-out"
              style={{ height: `${Math.min(100, (stats.incoming / 12) * 100)}%` }}
            />
          </div>

          <StackerBoard runner={runner} cell={cell} dimmed={!iAmAlive || match.over} />

          {/* Clear banner — brief, centred, never in the way of the stack */}
          {banner && (
            <div className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center">
              <span
                className="cr-win-title rounded-lg bg-black/70 px-3 py-1 text-center text-sm font-black tracking-wide"
                style={{ color: banner.spin ? '#a855f7' : banner.lines >= 4 ? '#22d3ee' : '#b4f953' }}
                data-testid="stacker-banner"
              >
                {banner.spin ? 'SPIN' : banner.lines === 4 ? 'QUAD' : `${banner.lines}×`}
                {banner.attack > 0 && <span className="ml-1 text-lc-white">+{banner.attack}</span>}
              </span>
            </div>
          )}

          {(stats.dead || !iAmAlive) && (
            <div className="absolute inset-0 flex items-center justify-center" data-testid="stacker-dead">
              <span className="rounded-lg bg-black/80 px-4 py-2 text-base font-black tracking-wide text-red-400">
                {t('games.toppedOut')}
              </span>
            </div>
          )}
        </div>

        {/* Right rail: what's coming */}
        <div className="flex w-[68px] shrink-0 flex-col gap-1.5">
          <div className="rounded-lg border border-lc-border bg-lc-black/40 p-1.5">
            <PieceChip kind={runner.state.queue[0] ?? null} label={t('games.next')} />
            <div className="mt-1 space-y-1 opacity-80">
              {runner.state.queue.slice(1, 5).map((kind, i) => (
                <PieceChip key={`${kind}-${i}`} kind={kind} dim />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Opponents */}
      {opponents.length > 0 && (
        <div className="flex flex-wrap items-end justify-center gap-3" data-testid="stacker-opponents">
          {opponents.map((seat) => {
            const p = match.progress[seat];
            if (!p) return null;
            return (
              <div key={seat} className="text-center" data-testid={`stacker-opponent-${seat}`}>
                <MiniBoard board={p.board} height={p.stackHeight} dead={!p.alive} cell={Math.max(4, Math.round(cell / 4))} />
                <div className="mt-1 max-w-[72px] truncate text-[10px] text-lc-white">{seatLabel(seat)}</div>
                <div className="text-[10px] text-lc-muted">{p.attacksSent}⚔ · {p.linesCleared}▤</div>
                {p.verified === false && (
                  <div className="text-[9px] text-red-400" title={p.suspect ?? undefined} data-testid={`stacker-suspect-${seat}`}>
                    ⚠ unverified
                  </div>
                )}
                {p.verified === true && (
                  <div className="text-[9px] text-lc-green" data-testid={`stacker-verified-${seat}`}>✓ checked</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] text-lc-muted">
        <button
          type="button"
          onClick={() => setKeysOpen(true)}
          className="rounded-full border border-lc-border px-2 py-0.5 hover:text-lc-white"
          data-testid="stacker-keys-open"
        >
          ⌨ controls
        </button>
        <button
          type="button"
          onClick={toggleMuted}
          className="rounded-full border border-lc-border px-2 py-0.5 hover:text-lc-white"
          data-testid="stacker-mute"
        >
          {prefs.muted ? '🔇 muted' : '🔊 sound'}
        </button>
        {!prefs.muted && (
          // The sandbox has no allow-popups, so this link cannot actually
          // open; it stays a real link (never a same-frame navigation) so the
          // source is still named and hoverable.
          <a
            href={MUSIC_CREDIT.source}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[10px] text-lc-muted underline decoration-dotted hover:text-lc-white"
            title={`${track} — ${MUSIC_CREDIT.author}, ${MUSIC_CREDIT.note} · ${MUSIC_CREDIT.source}`}
            data-testid="stacker-music-credit"
          >
            ♫ {track} — {MUSIC_CREDIT.author}
          </a>
        )}
      </div>

      {keysOpen && (
        <StackerKeysPanel onClose={() => { setKeysOpen(false); reloadKeys(); }} />
      )}

      {match.over && (
        <p className="text-center text-xs text-lc-white" data-testid="stacker-result">
          {match.winner
            ? `${seatLabel(match.winner)} is the last one standing`
            : 'Everybody topped out'}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, accent, testId }: { label: string; value: number | string; accent?: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-lc-border bg-lc-black/40 px-2 py-1 text-center">
      <div className="text-[9px] uppercase tracking-[0.12em] text-lc-muted">{label}</div>
      <div className="text-sm font-bold" style={{ color: accent ?? '#fafafa' }} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
