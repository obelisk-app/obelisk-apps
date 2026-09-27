/**
 * Everything the shared table shell needs to know about Vesta: the table (board
 * plus turn controls), its seat colours, how it scores, and its options — a
 * board seed, or a saved game to resume. In obelisk-dex these were switches on
 * the game id spread over GameModal, GameResults, standings.ts, the /play
 * picker (NewGameModal) and StartTableModal.
 */
import { useRef, useState } from 'react';
import { CANVAS_HEIGHT, CANVAS_WIDTH, type GameState } from 'vesta';
import type { BoardProps, GameUi, OptionsProps, Standing } from '@obelisk/apps-ui';
import { useTranslation } from '@obelisk/apps-ui';
import type { GameSession } from '@obelisk/apps-sdk/turn';

import { normalizeSeed, playerCountOf, readResumeState, vesta, type VestaAction } from './definition';
import { VESTA_PLAYER_COLORS } from './VestaBoard';
import VestaTable from './VestaTable';

/** The board gets at most this share of the frame's height; the controls need the rest. */
const BOARD_HEIGHT_SHARE = 0.6;

function Board({ session, mySeats, onMove, box, seatLabel, busy }: BoardProps) {
  const boardMaxWidth = Math.min(box.width, (box.height * BOARD_HEIGHT_SHARE * CANVAS_WIDTH) / CANVAS_HEIGHT);
  return (
    <VestaTable
      session={session}
      mySeats={mySeats}
      seatLabel={seatLabel}
      onMove={(action: VestaAction, seat: string) => onMove(action, seat)}
      busy={busy}
      boardMaxWidth={Math.max(240, Math.floor(boardMaxWidth))}
    />
  );
}

/** A fresh seed, small and human-quotable, as dex's picker chose it. */
export function freshSeed(): number {
  return Math.floor(Date.now() / 1000) % 100000;
}

/**
 * dex's /play options for Vesta: a board seed, or a saved game to carry on.
 * The opts published on `start` are `{ seed }` or `{ resume: <the file> }`,
 * exactly what dex put on `create`.
 */
function Options({ opts, setOpts, setError }: OptionsProps) {
  const { t } = useTranslation();
  const [seed, setSeed] = useState(() => (opts.seed === undefined ? '' : String(opts.seed)));
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resuming = opts.resume !== undefined && readResumeState(opts.resume) !== null;
  const players = resuming ? playerCountOf(opts.resume) : null;

  async function loadSave(file: File) {
    setError(null);
    try {
      const parsed: unknown = JSON.parse(await readText(file));
      if (!readResumeState(parsed)) {
        setError('That file is not a Vesta save.');
        return;
      }
      setFileName(file.name);
      setOpts({ resume: parsed });
    } catch {
      setError('Could not read that file.');
    }
  }

  return (
    <>
      <p className="text-[10px] uppercase tracking-wide text-lc-muted">{t('games.boardSeed')}</p>
      <input
        value={seed}
        onChange={(e) => {
          setSeed(e.target.value);
          setOpts({ seed: normalizeSeed(e.target.value) });
        }}
        disabled={resuming}
        className="mt-1 w-full rounded bg-lc-black/50 px-2 py-1 text-xs text-lc-white outline-none focus:ring-1 focus:ring-lc-green disabled:opacity-40"
        aria-label={t('games.boardSeed')}
        data-testid="vesta-seed"
      />
      <p className="mt-1 text-[10px] text-lc-muted">{t('games.boardSeedHelp')}</p>

      <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">{t('games.continueSaved')}</p>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void loadSave(file);
          e.target.value = '';
        }}
        data-testid="vesta-import-input"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-full border border-lc-border bg-lc-card/60 px-3 py-1 text-xs text-lc-white hover:border-lc-muted"
          data-testid="vesta-import"
        >
          {t('games.loadVesta')}
        </button>
        {resuming && (
          <button
            type="button"
            onClick={() => {
              setFileName(null);
              setError(null);
              setOpts({ seed: normalizeSeed(seed) });
            }}
            className="rounded-full border border-lc-border bg-lc-card/60 px-3 py-1 text-xs text-lc-white hover:border-lc-muted"
            data-testid="vesta-new-board"
          >
            New board instead
          </button>
        )}
      </div>
      {resuming && (
        <p className="mt-2 text-[11px] text-lc-green" data-testid="vesta-resume-note">
          Resuming {fileName ?? 'a saved game'} — {players} players. The table needs exactly that many seats.
        </p>
      )}

      <p className="mt-3 text-[10px] text-lc-muted" data-testid="vesta-clock-help">{t('games.turnClockHelp')}</p>
    </>
  );
}

/** A file's text. FileReader rather than `Blob.text()`, which older engines (and jsdom) lack. */
function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** Victory points per player index. From dex standings.ts. */
export function standings(session: GameSession): Standing[] {
  const state = session.state as GameState | null;
  return session.participants
    .map((seat, i) => ({
      seat,
      score: `${state?.players[i]?.vp ?? 0} VP`,
      sort: state?.players[i]?.vp ?? 0,
      detail: 'Victory points at the end of the game',
    }))
    .sort((a, b) => b.sort - a.sort);
}

/** A resumed save fixes the seats: one per saved player, named as in the save. From dex StartTableModal. */
export function savedPlayers(opts: Record<string, unknown>): string[] | null {
  const state = readResumeState(opts.resume);
  return state ? state.players.map((p) => p.name) : null;
}

export const ui: GameUi = {
  def: vesta,
  icon: '🏛',
  colors: VESTA_PLAYER_COLORS,
  Board,
  Options,
  defaultOpts: () => ({ seed: freshSeed() }),
  standings,
  savedPlayers,
};
