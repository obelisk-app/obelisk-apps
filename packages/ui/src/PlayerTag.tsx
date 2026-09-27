/**
 * A player, the way every board should show one: their picture in a ring of
 * their seat colour, their name, and a glow when it's their move.
 *
 * Seats aren't pubkeys (hot-seat: `<pubkey>#1` is a second player on the same
 * keyboard), so the picture comes from the seat's controller while the name
 * comes from the seat's own label.
 */
import type { GameSession } from '@obelisk/apps-sdk/turn';
import type { ReactNode } from 'react';

import { usePeople } from './people.js';

export function controllerOfSeat(session: Pick<GameSession, 'seats'>, seat: string): string {
  return session.seats.find((s) => s.id === seat)?.by ?? seat.split('#')[0];
}

/** Round picture with a coloured ring; initials when there's no picture. */
export function SeatAvatar({ pubkey, color, size = 32, active = false, dim = false }: {
  pubkey: string;
  color: string;
  size?: number;
  active?: boolean;
  dim?: boolean;
}) {
  const { nameOf, pictureOf } = usePeople();
  const picture = pictureOf(pubkey);
  const initials = nameOf(pubkey).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        boxShadow: `0 0 0 2px ${color}${active ? `, 0 0 14px 2px ${color}` : ''}`,
        opacity: dim ? 0.4 : 1,
        transition: 'box-shadow 200ms ease',
      }}
      data-testid="seat-avatar"
    >
      {picture ? (
        <img src={picture} alt="" className="h-full w-full rounded-full object-cover" draggable={false} />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full font-bold text-lc-white"
          style={{ background: `color-mix(in oklab, ${color} 35%, #171717)`, fontSize: Math.max(9, size * 0.36) }}
        >
          {initials}
        </span>
      )}
    </span>
  );
}

export default function PlayerTag({
  session,
  seat,
  label,
  color,
  active = false,
  mine = false,
  out = false,
  size = 28,
  children,
  align = 'left',
}: {
  session: Pick<GameSession, 'seats'>;
  seat: string;
  label: string;
  color: string;
  active?: boolean;
  mine?: boolean;
  out?: boolean;
  size?: number;
  /** Game-specific detail under the name (score, material, cards). */
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-colors ${
        active ? 'border-lc-white/70 bg-lc-card' : 'border-lc-border bg-lc-card/60'
      } ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}
      data-testid={`player-tag-${seat}`}
      data-active={active ? 'true' : undefined}
    >
      <SeatAvatar pubkey={controllerOfSeat(session, seat)} color={color} size={size} active={active} dim={out} />
      <div className="min-w-0">
        <div className={`truncate text-xs font-semibold ${out ? 'text-lc-muted line-through' : 'text-lc-white'}`}>
          {label}
          {mine && <span className="ml-1 font-normal text-lc-muted">(you)</span>}
        </div>
        {children && <div className="truncate text-[11px] text-lc-muted">{children}</div>}
      </div>
    </div>
  );
}
