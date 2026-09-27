/**
 * Game engine contract, carried over from obelisk-dex `src/lib/games/types.ts`.
 *
 * An engine is PURE: same log in, same board out, on every client. That
 * purity is what replaces an authoritative server — there is no referee, only
 * a deterministic reducer every player runs over the same relay-delivered log.
 *
 * Rules an engine must hold to, or clients will disagree about the board:
 *   - no wall-clock reads, no randomness, no I/O;
 *   - never mutate the state it is handed — return a fresh object;
 *   - `applyAction` must be total for any input `validateAction` accepted.
 *
 * Lifecycle: waiting → in_progress → finished, or waiting → cancelled.
 * An engine ends the game by returning `nextTurn: null`.
 */

/**
 * Everything an engine is allowed to know beyond the board and the action.
 *
 * `entropy` is fixed by the log BEFORE this turn (the id of the last accepted
 * event, plus the turn index). Engines that need a die roll derive it from
 * here instead of `Math.random`, which would make replay disagree.
 */
export interface MoveContext {
  entropy: string;
}

export interface ApplyResult<S> {
  state: S;
  /** Seat to move next; `null` finishes the game. */
  nextTurn: string | null;
  winner?: string | null;
  draw?: boolean;
  eliminated?: string[];
}

/** One real-time op, already attributed to a seat its signer controls. */
export interface RealtimeEvent {
  id: string;
  pubkey: string;
  op: string;
  seat: string;
  at: number;
  body: Record<string, unknown>;
}

/**
 * Real-time games (Stacker) run every player's board at once, locally, and put
 * only consequences on the wire. The turn machinery is skipped; this reducer
 * gets the match's ops instead. It must be as pure as a turn-based engine.
 */
export interface RealtimeMatch<M = unknown> {
  /** The ops this game publishes during a match. Anything else is ignored while in progress. */
  ops: readonly string[];
  initial(seed: number, seats: readonly string[]): M;
  apply(match: M, ev: RealtimeEvent): M;
  over(match: M): boolean;
  winner(match: M): string | null;
}

export interface GameDefinition<S = unknown, A = unknown> {
  type: string;
  displayName: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  defaultTurnTimeoutS: number;

  /** Present for real-time games; see RealtimeMatch. */
  realtime?: RealtimeMatch;

  initialState(participants: string[], opts?: unknown): S;
  firstTurn(participants: string[]): string;

  validateAction(state: S, action: A, actorSeat: string, participants: string[]): { ok: boolean; error?: string };
  applyAction(state: S, action: A, actorSeat: string, participants: string[], ctx?: MoveContext): ApplyResult<S>;
  /**
   * The player to move blew the clock, or resigned. Both are the same thing
   * to an engine: that seat is out, the board moves on.
   */
  onTimeout(state: S, timedOutSeat: string, participants: string[]): ApplyResult<S>;

  /**
   * May this seat act right now, even though it is not on move? Most games
   * answer "only the seat on move" (the default when this is left out). Vesta
   * lets a trade partner answer and makes every over-full hand discard on a
   * seven while somebody else holds the turn. It doesn't weaken replay: the
   * move is still ordered, still carries its sequence number, and is still
   * dropped if `validateAction` rejects it.
   */
  canAct?(state: S, seat: string, action: A, participants: string[]): boolean;
}
