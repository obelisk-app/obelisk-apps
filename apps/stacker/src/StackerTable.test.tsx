/**
 * Ported from obelisk-dex `StackerTable.test.tsx`. Sessions are built the way
 * the host builds them (generic `create`, seats and seed on `start`) and
 * folded by the SDK's `deriveSession`; the dex publish callbacks are one
 * `onSend`, whose bodies are asserted against what dex published.
 */
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { I18nProvider } from '@obelisk/apps-ui';
import { KIND_APP_EVENT, type NostrEvent } from '@obelisk/apps-sdk';
import { deriveSession, parseOp, type GameSession, type ParsedOp } from '@obelisk/apps-sdk/turn';
import StackerTable, { cellFor, type StackerTableProps } from './StackerTable';
import { parseMatchEvent, stacker } from './definition';
import { applyMatchEvent, type MatchState } from './match';
import { StackerRunner } from './runner';
import { acquireRun, clearRuns } from './run-registry';
import { KEYMAP_STORAGE_KEY } from './keymap';
import { memoryStorage, setStackerStorage } from './storage';

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';
const GAME_ID = 's'.repeat(64);

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

function parsed(id: string, pubkey: string, createdAt: number, op: string, body: Record<string, unknown> = {}): ParsedOp {
  const tags = [['h', CH], ['t', 'obelisk-app'], ['op', op]];
  if (op !== 'create') tags.push(['e', GAME_ID, '', 'root']);
  const ev: NostrEvent = { id, pubkey, created_at: createdAt, kind: KIND_APP_EVENT, tags, content: JSON.stringify(body), sig: '' };
  const p = parseOp(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

function match(): GameSession {
  return deriveSession(stacker, [
    parsed(GAME_ID, A, 1000, 'create', { nonce: 'n' }),
    parsed('j1', B, 1001, 'join'),
    parsed('s1', A, 1002, 'start', {
      seats: [{ id: A, by: A, label: 'Ana' }, { id: B, by: B, label: 'Bruno' }],
      opts: { seed: 1234 },
      turnTimeoutS: 0,
    }),
  ], 1100)!;
}

const m = (s: GameSession) => s.match as MatchState;
const label = (s: string) => (s === A ? 'Ana' : s === B ? 'Bruno' : s);
const BOX = { width: 900, height: 800 };

function renderTable(session: GameSession, overrides: Partial<StackerTableProps> = {}) {
  const props: StackerTableProps = {
    session,
    match: overrides.match ?? m(session),
    mySeats: overrides.mySeats ?? [A],
    seatLabel: label,
    onSend: overrides.onSend ?? vi.fn(),
    box: overrides.box ?? BOX,
    paused: overrides.paused,
  };
  return {
    ...render(<I18nProvider locale="en"><StackerTable {...props} /></I18nProvider>),
    props,
  };
}

describe('StackerTable', () => {
  let rafQueue: FrameRequestCallback[] = [];
  const pump = (frames: number, stepMs = 100) => {
    act(() => {
      let now = 0;
      for (let i = 0; i < frames; i++) {
        const queued = rafQueue;
        rafQueue = [];
        now += stepMs;
        for (const cb of queued) cb(now);
      }
    });
  };

  beforeEach(() => {
    // The loop runs on rAF; drive it by hand so tests are not timing races.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    rafQueue = [];
    setStackerStorage(memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearRuns();
  });

  it('renders my board, the queue, and the opponent', () => {
    renderTable(match());
    expect(screen.getByTestId('stacker-board')).toBeInTheDocument();
    expect(screen.getByTestId(`stacker-opponent-${B}`)).toHaveTextContent('Bruno');
  });

  it('starts everyone on the same seed, so the same pieces', () => {
    const session = match();
    expect(m(session).seed).toBe(1234);
    const ana = new StackerRunner({ seed: m(session).seed, onAttack: vi.fn(), onCheckpoint: vi.fn(), onTopOut: vi.fn() });
    const bruno = new StackerRunner({ seed: m(session).seed, onAttack: vi.fn(), onCheckpoint: vi.fn(), onTopOut: vi.fn() });
    expect(ana.state.active!.kind).toBe(bruno.state.active!.kind);
    expect(ana.state.queue).toEqual(bruno.state.queue);

    const other = new StackerRunner({ seed: m(session).seed + 1, onAttack: vi.fn(), onCheckpoint: vi.fn(), onTopOut: vi.fn() });
    expect(other.state.queue).not.toEqual(ana.state.queue);
  });

  it('resumes the same board when the table is closed and reopened', () => {
    const session = match();
    const first = renderTable(session);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    });

    const key = `${session.id}:${A}`;
    const played = acquireRun(key, m(session).seed).runner;
    const board = played.state.board.map((row) => [...row]);
    const frame = played.frame;
    expect(board.some((row) => row.some((c) => c !== 0))).toBe(true);

    first.unmount();
    renderTable(session);

    const resumed = acquireRun(key, m(session).seed).runner;
    expect(resumed).toBe(played);
    expect(resumed.state.board).toEqual(board);
    expect(resumed.frame).toBe(frame);
  });

  it('renders the hold and next chips', () => {
    renderTable(match());
    expect(screen.getByTestId('chip-hold')).toBeInTheDocument();
    expect(screen.getByTestId('chip-next')).toBeInTheDocument();
  });

  it('shows garbage aimed at me on the meter', () => {
    const session = match();
    const attacked = applyMatchEvent(m(session), {
      op: 'attack', seat: B, target: A, lines: 6, hole: 2, nonce: 1, at: 1010,
    });
    renderTable(session, { match: attacked, mySeats: [A] });
    expect(screen.getByTestId('stacker-garbage-meter')).toHaveAttribute('title', '6 lines incoming');
  });

  it('marks a player whose checkpoint did not check out', () => {
    const session = match();
    const flagged = applyMatchEvent(m(session), {
      op: 'checkpoint', seat: B, frame: 600, at: 1010,
      attacksSent: 999, linesCleared: 999, stackHeight: 5,
      inputs: '1h,1h,1h',
    });
    renderTable(session, { match: flagged, mySeats: [A] });
    expect(screen.getByTestId(`stacker-suspect-${B}`)).toBeInTheDocument();
  });

  it('marks a player whose checkpoint did check out', () => {
    const session = match();
    const clean = applyMatchEvent(m(session), {
      op: 'checkpoint', seat: B, frame: 600, at: 1010,
      attacksSent: 0, linesCleared: 0, stackHeight: 3,
      inputs: '1h,1h',
    });
    renderTable(session, { match: clean, mySeats: [A] });
    expect(screen.getByTestId(`stacker-verified-${B}`)).toBeInTheDocument();
  });

  it('shows the topped-out overlay to a player who is out', () => {
    const session = match();
    const dead = applyMatchEvent(m(session), { op: 'topout', seat: A, at: 1010 });
    renderTable(session, { match: dead, mySeats: [A] });
    expect(screen.getByTestId('stacker-dead')).toBeInTheDocument();
  });

  it('announces the last one standing', () => {
    const session = match();
    const over = applyMatchEvent(m(session), { op: 'topout', seat: B, at: 1010 });
    renderTable(session, { match: over, mySeats: [A] });
    expect(screen.getByTestId('stacker-result')).toHaveTextContent('Ana is the last one standing');
  });

  it('runs the local loop without waiting on anything', () => {
    renderTable(match());
    pump(5);
    expect(screen.getByTestId('stacker-board')).toBeInTheDocument();
  });

  it('publishes a topout with dex\'s body, which every client parses back', () => {
    const onSend = vi.fn();
    renderTable(match(), { onSend });
    // Hard-drop until the well is full, then let one frame notice.
    act(() => {
      for (let i = 0; i < 80; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      }
    });
    pump(3);
    const topouts = onSend.mock.calls.filter(([op]) => op === 'topout');
    expect(topouts).toEqual([['topout', { seat: A }]]);
    expect(parseMatchEvent({ id: 'x', pubkey: A, op: 'topout', seat: A, at: 1, body: topouts[0][1] }))
      .toEqual({ op: 'topout', seat: A, at: 1 });
  });

  it('publishes checkpoints with dex\'s body, which every client parses back', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const onSend = vi.fn();
      renderTable(match(), { onSend });
      // Enough frames for the board snapshot cadence, then the flush timer.
      pump(40, 1000 / 60 * 8);
      act(() => { vi.advanceTimersByTime(2000); });
      const cp = onSend.mock.calls.find(([op]) => op === 'checkpoint');
      expect(cp).toBeDefined();
      const body = cp![1] as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        expect.arrayContaining(['attacksSent', 'board', 'frame', 'linesCleared', 'seat', 'stackHeight']),
      );
      expect(body.seat).toBe(A);
      const parsedBack = parseMatchEvent({ id: 'x', pubkey: A, op: 'checkpoint', seat: A, at: 1, body });
      expect(parsedBack).toMatchObject({ op: 'checkpoint', seat: A, frame: body.frame, board: body.board });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run while the host has hidden the frame', () => {
    renderTable(match(), { paused: true });
    expect(rafQueue).toHaveLength(0);
  });

  it('reads key bindings from the injected store', async () => {
    const storage = memoryStorage();
    await storage.set(KEYMAP_STORAGE_KEY, JSON.stringify({ KeyJ: 'hard' }));
    setStackerStorage(storage);
    const session = match();
    renderTable(session);
    fireEvent.click(screen.getByTestId('stacker-keys-open'));
    await waitFor(() => expect(screen.getByTestId('keys-hard')).toHaveTextContent('J'));
    fireEvent.click(screen.getByTestId('stacker-keys-done'));

    // Space is no longer bound; J is.
    const run = acquireRun(`${session.id}:${A}`, m(session).seed).runner;
    await waitFor(() => {
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' })); });
      act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' })); });
      expect(run.state.board.some((row) => row.some((c) => c !== 0))).toBe(true);
    });
  });

  it('binding a key writes the store', async () => {
    const storage = memoryStorage();
    setStackerStorage(storage);
    renderTable(match());
    fireEvent.click(screen.getByTestId('stacker-keys-open'));
    fireEvent.click(screen.getByTestId('bind-hold'));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' })); });
    await waitFor(async () => {
      const saved = JSON.parse((await storage.get(KEYMAP_STORAGE_KEY)) ?? '{}');
      expect(saved.KeyQ).toBe('hold');
    });
  });
});

describe('cellFor', () => {
  it('fills a tall box up to the cap', () => {
    expect(cellFor({ width: 1400, height: 1200 }, true)).toBe(30);
  });
  it('shrinks to fit a short box, and never below 12px', () => {
    expect(cellFor({ width: 1400, height: 500 }, false)).toBe(Math.floor((500 - 56) / 20));
    expect(cellFor({ width: 240, height: 240 }, true)).toBe(12);
  });
  it('leaves room for the opponents strip', () => {
    expect(cellFor({ width: 1400, height: 700 }, true)).toBeLessThan(cellFor({ width: 1400, height: 700 }, false));
  });
});
