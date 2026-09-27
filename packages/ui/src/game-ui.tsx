/**
 * What an app tells the shared table shell about itself. This replaces the
 * places dex switched on game ids (catalog icons, standings, seat colours,
 * the per-game option forms, GameModal's board switch): each app now brings
 * its own, and the shell never learns a game's name.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { GameDefinition, GameSession } from '@obelisk/apps-sdk/turn';

export interface Standing {
  seat: string;
  /** Human-readable score, already formatted for its game. */
  score: string;
  /** Sort key, descending. */
  sort: number;
  /** What the score means, shown once under the table. */
  detail?: string;
}

export interface BoardProps {
  session: GameSession;
  /** Seats this viewer may move for (several on a hot-seat table). */
  mySeats: string[];
  /** Publish a move for `seat`; resolves when the host has published it. */
  onMove: (action: unknown, seat: string) => Promise<void>;
  /** Real-time games: publish one of the game's declared ops. Fire-and-forget. */
  onSend: (op: string, body: Record<string, unknown>) => void;
  seatLabel: (seatId: string) => string;
  busy: boolean;
  /** The frame's size minus the shell's chrome. */
  box: { width: number; height: number };
  /** Boards that animate the deciding move report it, so the result splash waits. */
  onRevealChange?: (revealing: boolean) => void;
  /** Host services a board may need (assets, per-user storage). */
  host: import('@obelisk/apps-sdk').Host;
}

export interface OptionsProps {
  opts: Record<string, unknown>;
  setOpts: (next: Record<string, unknown>) => void;
  setError: (message: string | null) => void;
}

export interface GameUi {
  def: GameDefinition;
  /** Emoji or short mark shown next to the name — content, not chrome. */
  icon: string;
  /** Seat colours, by seat index. */
  colors: string[];
  Board: ComponentType<BoardProps>;
  /** The game's own option form, shown to the host in the seat picker. */
  Options?: ComponentType<OptionsProps>;
  /** Starting options, before the host touches the form. */
  defaultOpts?: () => Record<string, unknown>;
  /** Clock choices for the seat picker; default: none / 30s / 1m / 2m / 5m. */
  turnClocks?: { label: string; seconds: number }[];
  /** Final standings with the game's own idea of a score. */
  standings?: (session: GameSession) => Standing[];
  /** A resumed save fixes the seat count and names. */
  savedPlayers?: (opts: Record<string, unknown>) => string[] | null;
  /** One line under the title while the game runs (default: whose turn). */
  statusLine?: (session: GameSession, seatLabel: (seat: string) => string, mySeats: string[]) => ReactNode;
}

const GameUiContext = createContext<GameUi | null>(null);

export const GameUiProvider = GameUiContext.Provider;

export function useGameUi(): GameUi {
  const ui = useContext(GameUiContext);
  if (!ui) throw new Error('useGameUi outside GameUiProvider');
  return ui;
}

export const DEFAULT_TURN_CLOCKS = [
  { label: 'none', seconds: 0 },
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '2m', seconds: 120 },
  { label: '5m', seconds: 300 },
];
