/**
 * Names and faces, from what the host hands the frame. The host resolves
 * profiles (it never gives the app a URL — avatars arrive as Blobs, which
 * become object URLs here), so there is no relay or profile lookup in the app.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Host, Participant } from '@obelisk/apps-sdk';

interface People {
  nameOf: (pubkey: string) => string;
  pictureOf: (pubkey: string) => string | null;
}

const PeopleContext = createContext<People>({
  nameOf: (pk) => `${pk.slice(0, 8)}…`,
  pictureOf: () => null,
});

export function usePeople(): People {
  return useContext(PeopleContext);
}

export function PeopleProvider({ host, children }: { host: Host; children: ReactNode }) {
  const [people, setPeople] = useState<Participant[]>([]);
  useEffect(() => host.onParticipants(setPeople), [host]);

  // One object URL per blob, revoked when the participant list moves on.
  const urls = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) if (p.avatar) m.set(p.pubkey, URL.createObjectURL(p.avatar));
    return m;
  }, [people]);
  useEffect(() => () => { for (const u of urls.values()) URL.revokeObjectURL(u); }, [urls]);

  const nameOf = useCallback(
    (pk: string) => people.find((p) => p.pubkey === pk)?.name ?? `${pk.slice(0, 8)}…`,
    [people],
  );
  const pictureOf = useCallback((pk: string) => urls.get(pk) ?? null, [urls]);
  const value = useMemo(() => ({ nameOf, pictureOf }), [nameOf, pictureOf]);
  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

/** Round avatar with a two-letter fallback, like dex's UserAvatar. `size` is in Tailwind units (×4px). */
export function Avatar({ pubkey, size = 6 }: { pubkey: string; size?: number }) {
  const { nameOf, pictureOf } = usePeople();
  const [failed, setFailed] = useState(false);
  const px = size * 4;
  const picture = pictureOf(pubkey);
  const name = nameOf(pubkey);
  if (picture && !failed) {
    return (
      <img
        src={picture}
        alt=""
        width={px}
        height={px}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: px, height: px }}
      />
    );
  }
  const initials = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-lc-border font-bold text-lc-white"
      style={{ width: px, height: px, fontSize: Math.max(8, px * 0.4) }}
    >
      {initials}
    </span>
  );
}
