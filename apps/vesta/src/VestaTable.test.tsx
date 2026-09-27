import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { createGame, applyMove, type GameState } from 'vesta';
import { I18nProvider } from '@obelisk/apps-ui';
import { KIND_APP_EVENT, type NostrEvent } from '@obelisk/apps-sdk';
import { deriveSession, parseOp, type GameSession, type ParsedOp } from '@obelisk/apps-sdk/turn';
import VestaTable from './VestaTable';
import { vesta } from './definition';
import { vertices, edges, nearestVertex } from './geometry';
import { savedPlayers, standings } from './ui';

/** The component reads its copy from the dictionary, so it needs a provider. */
const renderLocalized = (ui: React.ReactElement) => render(<I18nProvider locale="en">{ui}</I18nProvider>);
const localized = (ui: React.ReactElement) => <I18nProvider locale="en">{ui}</I18nProvider>;

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';
const GAME_ID = 'v'.repeat(64);

beforeAll(() => {
  // jsdom has no canvas backend; the board's draw pass is not what these
  // tests are about, so a no-op context keeps it quiet.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

function parsed(id: string, pubkey: string, createdAt: number, op: string, body: Record<string, unknown>): ParsedOp {
  const tags = [['h', CH], ['t', 'obelisk-app'], ['op', op]];
  if (op !== 'create') tags.push(['e', GAME_ID, '', 'root']);
  const ev: NostrEvent = { id, pubkey, created_at: createdAt, kind: KIND_APP_EVENT, tags, content: JSON.stringify(body), sig: '' };
  const p = parseOp(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

function table(seats: Array<{ id: string; by: string; label?: string }>): GameSession {
  const log = [
    parsed(GAME_ID, HOST, 1000, 'create', { nonce: 'n' }),
    parsed('j1', B, 1001, 'join', {}),
    parsed('s1', HOST, 1002, 'start', { seats, opts: { seed: 42 }, turnTimeoutS: 0 }),
  ];
  const s = deriveSession(vesta, log, 1100);
  if (!s) throw new Error('no session');
  return s;
}

/** The same table showing a hand-built board state. */
const withState = (session: GameSession, state: GameState): GameSession => ({ ...session, state });

const remoteSeats = [{ id: HOST, by: HOST, label: 'Ana' }, { id: B, by: B, label: 'Bruno' }];

describe('VestaTable', () => {
  const label = (seat: string) => (seat === HOST ? 'Ana' : seat === B ? 'Bruno' : seat);

  it('renders the board and every player', () => {
    const session = table(remoteSeats);
    renderLocalized(
      <VestaTable
        session={session}
        mySeats={[HOST]}
        seatLabel={label}
        onMove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('vesta-board')).toBeInTheDocument();
    expect(screen.getByTestId('vesta-player-0')).toHaveTextContent('Ana');
    expect(screen.getByTestId('vesta-player-1')).toHaveTextContent('Bruno');
  });

  it('shows the setup prompt to the player on move and a wait to the other', () => {
    const session = table(remoteSeats);
    const { rerender } = renderLocalized(
      <VestaTable session={session} mySeats={[HOST]} seatLabel={label} onMove={vi.fn()} />,
    );
    expect(screen.getByText(/Setup — Ana places a settlement/)).toBeInTheDocument();

    rerender(localized(<VestaTable session={session} mySeats={[B]} seatLabel={label} onMove={vi.fn()} />));
    expect(screen.getByText(/Waiting for Ana/)).toBeInTheDocument();
  });

  it('hides turn actions during setup and shows them in play', () => {
    const session = table(remoteSeats);
    const { rerender } = renderLocalized(
      <VestaTable session={session} mySeats={[HOST]} seatLabel={label} onMove={vi.fn()} />,
    );
    expect(screen.queryByTestId('vesta-actions')).not.toBeInTheDocument();

    const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false };
    rerender(localized(<VestaTable session={withState(session, playing)} mySeats={[HOST]} seatLabel={label} onMove={vi.fn()} />));
    expect(screen.getByTestId('vesta-actions')).toBeInTheDocument();
    expect(screen.getByText('🎲 Roll')).toBeEnabled();
    // Can't end a turn before rolling — the engine says so, so the button says so.
    expect(screen.getByText('↪ End turn')).toBeDisabled();
  });

  it('publishes a roll for the acting seat', async () => {
    const session = table(remoteSeats);
    const onMove = vi.fn().mockResolvedValue(undefined);
    const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false };
    renderLocalized(<VestaTable session={withState(session, playing)} mySeats={[HOST]} seatLabel={label} onMove={onMove} />);

    fireEvent.click(screen.getByText('🎲 Roll'));
    expect(onMove).toHaveBeenCalledWith({ type: 'roll-dice' }, HOST);
  });

  it('offers no actions to a player whose turn it is not', () => {
    const session = table(remoteSeats);
    const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false };
    renderLocalized(<VestaTable session={withState(session, playing)} mySeats={[B]} seatLabel={label} onMove={vi.fn()} />);
    expect(screen.queryByTestId('vesta-actions')).not.toBeInTheDocument();
  });

  it('asks over-full hands to discard on a seven', () => {
    const session = table(remoteSeats);
    const base = session.state as GameState;
    const fat = {
      ...base,
      phase: 'play' as const,
      dice: [3, 4] as [number, number],
      players: base.players.map((p, i) => i === 1
        ? { ...p, resources: { ...p.resources, brick: 5, ore: 5 } }
        : p),
    };
    // B is not on move, but a seven does not care whose turn it is.
    renderLocalized(<VestaTable session={withState(session, fat)} mySeats={[B]} seatLabel={label} onMove={vi.fn()} />);
    expect(screen.getByTestId('vesta-discard')).toHaveTextContent('discard 5 of your 10 cards');
  });

  it('shows a trade offer to its target with accept and reject', () => {
    const session = table(remoteSeats);
    const base = session.state as GameState;
    const offered = {
      ...base,
      pendingTrade: { from: 0, to: 1, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, take: { ore: 1, brick: 0, lumber: 0, wool: 0, grain: 0 } },
    } as GameState;

    const onMove = vi.fn().mockResolvedValue(undefined);
    renderLocalized(<VestaTable session={withState(session, offered)} mySeats={[B]} seatLabel={label} onMove={onMove} />);
    expect(screen.getByTestId('vesta-trade-offer')).toHaveTextContent('Ana offers 1🧱 for 1🪨');
    fireEvent.click(screen.getByText('Accept'));
    expect(onMove).toHaveBeenCalledWith({ type: 'accept-trade' }, B);
  });

  it('offers the proposer a withdraw instead of an accept', () => {
    const session = table(remoteSeats);
    const base = session.state as GameState;
    const offered = {
      ...base,
      pendingTrade: { from: 0, to: 1, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, take: { ore: 1, brick: 0, lumber: 0, wool: 0, grain: 0 } },
    } as GameState;
    renderLocalized(<VestaTable session={withState(session, offered)} mySeats={[HOST]} seatLabel={label} onMove={vi.fn()} />);
    expect(screen.getByText('Withdraw')).toBeInTheDocument();
    expect(screen.queryByText('Accept')).not.toBeInTheDocument();
  });

  describe('hot-seat', () => {
    const hotSeats = [
      { id: HOST, by: HOST, label: 'Ana' },
      { id: `${HOST}#1`, by: HOST, label: 'Beto' },
      { id: B, by: B, label: 'Bruno' },
    ];

    it('acts as whichever of its own seats is on move', () => {
      const session = table(hotSeats);
      const onMove = vi.fn().mockResolvedValue(undefined);
      const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false, currentPlayer: 1 };
      // The session's turn is seat 0; hand it a state where seat 1 is on move
      // by deriving a session whose currentTurn matches.
      const withTurn: GameSession = { ...session, currentTurn: `${HOST}#1` };
      renderLocalized(<VestaTable session={withState(withTurn, playing)} mySeats={[HOST, `${HOST}#1`]} seatLabel={(s) => hotSeats.find((h) => h.id === s)?.label ?? s} onMove={onMove} />);

      fireEvent.click(screen.getByText('🎲 Roll'));
      // Signed by the host's key, but played as Beto's seat.
      expect(onMove).toHaveBeenCalledWith({ type: 'roll-dice' }, `${HOST}#1`);
    });

    it('names both local players separately on the board', () => {
      const session = table(hotSeats);
      renderLocalized(
        <VestaTable
          session={session}
          mySeats={[HOST, `${HOST}#1`]}
          seatLabel={(s) => hotSeats.find((h) => h.id === s)?.label ?? s}
          onMove={vi.fn()}
        />,
      );
      expect(screen.getByTestId('vesta-player-0')).toHaveTextContent('Ana');
      expect(screen.getByTestId('vesta-player-1')).toHaveTextContent('Beto');
      expect(screen.getByTestId('vesta-player-2')).toHaveTextContent('Bruno');
    });
  });

  it('announces the winner', () => {
    const session = table(remoteSeats);
    const won = { ...(session.state as GameState), winner: 1 };
    renderLocalized(<VestaTable session={withState(session, won)} mySeats={[HOST]} seatLabel={label} onMove={vi.fn()} />);
    expect(screen.getByText('Bruno wins')).toBeInTheDocument();
  });
});

describe('board geometry', () => {
  it('builds the standard 54 vertices and 72 edges', () => {
    expect(vertices().size).toBe(54);
    expect(edges().size).toBe(72);
  });

  it('finds the vertex nearest a click, and nothing when the click is far', () => {
    const first = [...vertices().values()][0];
    expect(nearestVertex(first.x + 2, first.y + 2, 20)?.key).toBe(first.key);
    expect(nearestVertex(first.x + 500, first.y + 500, 20)).toBeNull();
  });

  it('agrees with the engine about vertex keys', () => {
    // Every settlement the engine places must land on a vertex we can draw.
    const state = applyMove(createGame({ players: 2, roll: 42 }), {
      type: 'place-settlement', player: 0, q: 0, r: 0, corner: 0,
    });
    const s = state.players[0].settlements[0];
    const positions = [...vertices().values()].filter((v) =>
      v.hexes.some((h) => h.q === s.q && h.r === s.r && h.corner === s.corner));
    expect(positions).toHaveLength(1);
  });
});

