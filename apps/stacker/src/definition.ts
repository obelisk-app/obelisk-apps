/**
 * Stacker as an Obelisk game.
 *
 * The turn-based hooks below are deliberately inert: a real-time game has no
 * seat "to move", so the SDK's `replayLog` routes past them the moment it
 * sees `realtime`, and the match lives in `session.match` instead of
 * `session.state`. What this definition contributes is the catalog entry, the
 * player limits, and the `realtime` adapter that folds `attack` / `topout` /
 * `checkpoint` into the match.
 *
 * Carried over from obelisk-dex, where `session.ts` imported `./stacker/match`
 * directly and `protocol.ts` parsed these three ops. The SDK knows nothing
 * about them: it hands the raw JSON body here, already attributed to a seat
 * its signer controls, and the parsing below is dex's `parseGameEvent`
 * 'attack' | 'topout' | 'checkpoint' cases, rule for rule. Any drift here
 * desyncs matches between clients on different builds.
 */
import type { ApplyResult, GameDefinition, RealtimeEvent, RealtimeMatch } from '@obelisk/apps-sdk/turn';
import { applyMatchEvent, initialMatch, type MatchState } from './match';

export const STACKER_MIN_PLAYERS = 1;
export const STACKER_MAX_PLAYERS = 6;

/** How the attack picks its victim when more than one opponent is standing. */
export type TargetMode = 'random' | 'badges' | 'attackers';

/** The ops Stacker publishes during a match. */
export const STACKER_OPS = ['attack', 'topout', 'checkpoint'] as const;

type MatchEvent = Parameters<typeof applyMatchEvent>[1];

/**
 * Turn the SDK's raw event into what `applyMatchEvent` takes, or `null` when
 * dex's parser would have dropped it.
 *
 * Seat: dex took `body.seat` whenever it was a string (even an empty one) and
 * then required it to equal the seat the signer resolves to. The SDK only
 * honours a NON-EMPTY `body.seat` and otherwise attributes to the signer, so
 * `seat: ""` would slip through as the signer's own seat. Rejecting any string
 * `body.seat` that is not the attributed seat restores dex's rule exactly.
 */
export function parseMatchEvent(ev: RealtimeEvent): MatchEvent | null {
  const body = ev.body;
  if (typeof body.seat === 'string' && body.seat !== ev.seat) return null;
  const seat = ev.seat;

  switch (ev.op) {
    case 'attack': {
      const target = typeof body.target === 'string' ? body.target : '';
      const lines = typeof body.lines === 'number' ? Math.floor(body.lines) : 0;
      if (!target || lines <= 0) return null;
      return {
        op: 'attack',
        seat,
        target,
        lines,
        hole: typeof body.hole === 'number' ? Math.abs(Math.floor(body.hole)) : 0,
        nonce: typeof body.nonce === 'number' ? body.nonce : 0,
        at: ev.at,
      };
    }

    case 'topout':
      return { op: 'topout', seat, at: ev.at };

    case 'checkpoint': {
      if (typeof body.frame !== 'number') return null;
      return {
        op: 'checkpoint',
        seat,
        frame: Math.floor(body.frame),
        attacksSent: typeof body.attacksSent === 'number' ? Math.floor(body.attacksSent) : 0,
        linesCleared: typeof body.linesCleared === 'number' ? Math.floor(body.linesCleared) : 0,
        stackHeight: typeof body.stackHeight === 'number' ? Math.floor(body.stackHeight) : 0,
        ...(typeof body.inputs === 'string' ? { inputs: body.inputs } : {}),
        ...(typeof body.board === 'string' ? { board: body.board } : {}),
        at: ev.at,
      };
    }

    default:
      return null;
  }
}

/** The match reducer the SDK drives while a table is in progress. */
export const stackerRealtime: RealtimeMatch<MatchState> = {
  ops: STACKER_OPS,
  initial: (seed, seats) => initialMatch(seed, seats),
  apply(match, ev) {
    const parsed = parseMatchEvent(ev);
    return parsed ? applyMatchEvent(match, parsed) : match;
  },
  over: (match) => match.over,
  winner: (match) => match.winner,
};

export const stacker: GameDefinition<null, never> = {
  type: 'stacker',
  displayName: 'Stacker',
  description: 'Falling blocks, shared piece order, and every line you clear buries somebody else. 1–6 players.',
  minPlayers: STACKER_MIN_PLAYERS,
  maxPlayers: STACKER_MAX_PLAYERS,
  // The clock here is gravity, not a turn timer.
  defaultTurnTimeoutS: 0,
  realtime: stackerRealtime as RealtimeMatch,

  initialState: () => null,
  firstTurn: (participants) => participants[0],
  validateAction: () => ({ ok: false, error: 'Stacker is played in real time' }),
  applyAction: (state): ApplyResult<null> => ({ state, nextTurn: null }),
  onTimeout: (state): ApplyResult<null> => ({ state, nextTurn: null }),
};
