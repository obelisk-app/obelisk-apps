# Known issues

The canonical list of open bugs, security gaps and pending decisions for Obelisk Apps. When an item is fixed, strike it through and add the date: `~~…~~ — **resolved YYYY-MM-DD.**`. Host-side items (in obelisk-dex) are also listed in that repo's `docs/known-bugs.md` under **Apps**.

## Security gaps (accepted for v1)

Full context is in [security.md § Gaps](security.md#gaps-what-the-sandbox-does-not-stop).

- **Self-navigation can exfiltrate.** An app can do `location = "https://x/?d=…"` inside its own frame. The host detects the second `load` and kills the frame, but the request has already gone out with the user's IP and whatever the app put in the URL. There's no browser fix until CSP `navigate-to` (or an equivalent) ships.
- **WebRTC bypasses `connect-src`.** An app can reach a STUN/TURN server with data in the ICE credentials. The only fix would be the unshipped CSP `webrtc 'block'` directive.
- **Phishing inside the frame.** An app can draw a fake "enter your nsec" screen. The mitigations (host chrome, author label, toast prefix) help but don't prevent it.
- **CPU and battery abuse** lasts until the user closes the modal. The stall watchdog only catches a frame that stops answering, not one that is merely busy.
- **No review or trust signal on apps.** On an open relay anyone can publish, and the catalog shows every app with equal weight. A WoT badge on the author, or an operator "featured" list (kind 30078 on the relay), are the candidate fixes.
- **Relay operators moderate apps only by** deleting events or banning authors. There's no "hide this app" that leaves the author's other activity alone.

## Replay-trust limits (carried over from obelisk-dex `docs/games.md`)

- **Walk-aways on tables with no clock.** Vesta and Stacker default to no turn clock, so a player who stops publishing stalls the table forever. Only a clock (`timeout`) resolves it.
- **The table host picks the seat order** at `start`, and could collude with a player.
- **No hidden information.** Every move is public on the relay, so card games (hands, decks) need commit-reveal or NIP-44 to specific players. Neither is designed yet, and NIP-44 needs a host capability that v1 withholds on purpose.
- **Same-second events reorder by id.** Replay sorts by `(created_at, id)`, and `created_at` has one-second resolution. If a host presses Start in the same second someone's `join` lands, the `start` can sort first, and that player's seat is dropped because they hadn't joined yet. This matches obelisk-dex games before the migration. A fix would make `start` reference the join ids it saw (`e` tags) instead of relying on order. Found while porting the SDK tests (2026-09-27).
- **Stacker cheats are detected, not prevented.** `verifyCheckpoint` flags a player whose claimed board doesn't match their replayed inputs, but the match has already been affected.

## Platform: open issues

- ~~**Blossom servers that accept JS.**~~ — **resolved 2026-09-27.** The media servers obelisk-dex uses for attachments (primal, nostr.build, blossom.band) reject non-media. `https://blossom.obelisk.ar` now runs hzrd149's reference blossom-server from our fork (`obelisk-app/blossom-server`, with `pubkeysFile` rules and `sandboxBlobs`). Its upload allowlists are written by `packages/blossom-wot` from the obelisk-relay WoT ladder. `nostr.download` remains a valid secondary `server` hint.
- **blossom.obelisk.ar has one disk and no mirror.** It runs on the same host as both relays, with a 3 GiB cap on a volume that has ~6 GiB free. If the host or volume dies, every app whose only `server` hint is ours becomes unopenable. First-party manifests should also list `nostr.download` and actually copy the blobs there (BUD-04 `PUT /mirror` on the receiving server). Nothing does that yet.
- **The Blossom WoT is only as good as three public relays.** Contact lists come from damus, nos.lol and purplepag.es, the relay's hardcoded `FOLLOW_RELAYS`. A key whose kind 3 is only on other relays isn't admitted until it's added to `manualAllow`.
- **No per-uploader quota on blossom.obelisk.ar.** Upstream blossom-server has none. Tiers differ only in retention (1 year vs 3 months). The only brakes are the 16 MiB per-blob cap and the sidecar's disk guard, which closes *all* uploads at 3 GiB stored or 1 GiB free. One admitted key can therefore fill the store and lock everyone else out until an operator deletes blobs. A per-pubkey byte quota would be a good upstream PR to the fork.
- **The fork must be kept in step with upstream** (`hzrd149/blossom-server`). Both additions are small and generic (`pubkeysFile`, `sandboxBlobs`), so offering them upstream would remove the fork. **Not done yet; the user decides.**
- **An app disappears when its blobs do.** If the author deletes the blobs, or every hinted server drops them, the app can't open. That includes live sessions of an old version (app-format.md §1, keep blobs ≥ 8 days). Nothing mirrors them yet.
- **The first open of an app is slow.** It fetches the entry (and eventually assets) from Blossom. Later opens hit the Cache Storage copy keyed by hash.
- **No `eval`.** Bundles that use `eval` or `new Function` (some template engines, older emulators) don't load, because the frame CSP omits `'unsafe-eval'`. This is intentional. Document it in `building-an-app.md` when that's written.
- **Size caps are guesses.** The 2 MiB entry, 32 MiB total, 64 KiB content per event and the 20/5-per-second bucket were sized against the three first-party games and aren't measured. Stacker's music alone is about 8.8 MiB of MP3s.
- **Participant names and avatars are given to every app.** Needed for any multiplayer UI, but it is data the app could leak (security.md gaps 1–2).
- **No version-skew handling in the SDK** when a host is older than an app expects, beyond `unsupported` errors. Needs a real test once v1.1 exists.
- **Legacy `[[game:…]]` tables run the *current* official bundle,** because they have no pin (app-format.md §4). Remove the legacy mapping once the relays have pruned every pre-migration `create` (7 days after the switch).
- **The kind numbers are unregistered.** `2390` and `32390` aren't in the NIPs kind table (checked 2026-09-27). Consider a NIP PR once the format settles, citing NIP-5A for the `path` / `x` / `server` vocabulary.
- **The relay must allow kind 32390 without an `h` tag** (add it to `NON_GROUP_ALLOWED_KINDS` in obelisk-relay `src/group.rs`) and must never prune it. Until that ships, manifests are rejected with `invalid: group events must contain an 'h' tag`. Third-party NIP-29 relays will reject them too, so their channels have no catalog.
- **Tauri parity.** obelisk-tauri has its own CSP, which must get the same `frame-src https://frame.obelisk.ar` entry and be kept in step by hand.

## Not built yet

This is the build order from the migration plan:

1. ~~The SDK (`packages/sdk`)~~ — **done 2026-09-27**: host client, turn kit (replay, table, clock enforcer) ported from dex, a generic `realtime` hook replacing the Stacker-specific branch, and `testing/` FakeRelay + FakeHost.
2. ~~The frame loader (`packages/frame`)~~ — **live 2026-09-27** at `https://frame.obelisk.ar/v1/` (Caddy :8101 via the `fabri-ssh` tunnel), next to `https://blossom.obelisk.ar` (pm2 `obelisk-blossom` :3023).
3. Chain Reaction, Vesta and Stacker ported onto the SDK, with their dex tests.
4. The relay change for kind 32390.
5. The `games.obelisk.ar` dashboard (admin-shell design, see obelisk-design).
6. The obelisk-dex switch, in one PR.

Also missing: `docs/building-an-app.md`, and any app permission system (v2).
