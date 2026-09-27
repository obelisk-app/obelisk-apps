# App format

**Status: draft v1.** Nothing implements this yet. Numbers marked *tunable* are starting values, not promises.

An Obelisk app is two kinds of event and a set of Blossom blobs:

| What | Kind | Lives on | Lifetime |
|---|---|---|---|
| **App manifest**: what the app is and which blobs make it up | `32390` (addressable) | Any relay the author can write to. obelisk-dex reads only the **active** relay. | Until replaced or deleted. The relay must never prune it. |
| **Session events**: one table, poll or board in one channel | `2390` (regular, `h`-scoped) | The channel's relay | The relay's `2390` retention (7 days on `public.obelisk.ar`) |
| **Bundle and assets**: the code and its media | Blossom blobs (sha256) | The manifest's `server` hints | As long as the author keeps them there |

Neither number is claimed in the NIPs kind table as of 2026-09-27. `2390` has been used by obelisk-dex games since 2026-09. `32390` mirrors it in the addressable range.

## 1. App manifest: kind 32390

The file-mapping tags are the ones [NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md) (nsites) uses: `path`, the aggregate `x`, `server`, `title`, `description` and `source`. An app's files are therefore described exactly like an nsite's, and tooling that understands nsites can fetch them. What NIP-5A does not have is the runtime contract (`api`, `t`, `players`, `realtime`, `icon`), which is why this is its own kind rather than a kind 35128 named site.

```jsonc
{
  "kind": 32390,
  "pubkey": "<author>",
  "content": "Markdown. The long description shown in the catalog.",
  "tags": [
    ["d", "chain-reaction"],                        // slug, ^[a-z0-9-]{1,32}$
    ["title", "Chain Reaction"],
    ["description", "Place orbs, trigger explosions, take the board."],
    ["api", "1"],                                   // host API major version, see host-api.md
    ["t", "game"],                                  // game | widget | tool. May repeat.
    ["version", "1.4.0"],                           // human label only; the pin is `x`
    ["players", "2", "8"],                          // games: min, max
    ["realtime", "false"],                          // games: "true" when everyone acts at once
    ["path", "/index.js",   "<sha256>"],            // REQUIRED: the entry, one ES module
    ["path", "/icon.svg",   "<sha256>"],
    ["path", "/music/a.mp3","<sha256>"],
    ["icon", "/icon.svg"],                          // a `path` above, not a URL
    ["x", "<aggregate sha256>", "aggregate"],       // REQUIRED, NIP-5A §Aggregate Hash
    ["server", "https://nostr.download"],           // Blossom hints, in preference order
    ["server", "https://blossom.yakihonne.com"],
    ["source", "https://github.com/obelisk-app/obelisk-apps"],
    ["alt", "Obelisk app: Chain Reaction"]          // NIP-31, for clients that don't know this kind
  ]
}
```

### Rules

- **Required tags:**
  - `d`, `title`, `api` and exactly one `x … aggregate`.
  - A `path` for `/index.js`.
- **`path` values:**
  - absolute and lowercase, matching `^/[a-z0-9._/-]{1,128}$`;
  - no `..` segments;
  - at most 64 `path` tags (*tunable*; the relay's own cap is 2,000 tags).
- **The aggregate `x`** is computed exactly as NIP-5A specifies:
  1. For each `path` tag, make the line `<sha256> <path>\n`.
  2. Sort the lines.
  3. Concatenate them.
  4. Take the sha256.

  A manifest whose `x` doesn't match its `path` tags is ignored.
- **Size limits (*tunable*):**
  - `/index.js` ≤ 2 MiB;
  - all paths together ≤ 32 MiB;
  - `content` ≤ 16 KiB.

  The relay's own limit is 256 KiB of `content` per event, which is why code and media never go inline.
- **Unknown values:**
  - Unknown tags are ignored.
  - An unknown `t` value is shown as-is.
  - An `api` major the host doesn't support is listed but cannot be opened. It shows "needs a newer Obelisk".
- **Identity:** an app's identity is its address, `32390:<author>:<d>`. Two authors publishing `d=chess` are two different apps.

### Discovery

obelisk-dex asks the **active relay only**, following dex's single-relay rule for everything group-shaped:

```json
{ "kinds": [32390], "limit": 500 }
```

- The newest `created_at` per address wins. On a tie, the lower id wins.
- The result is cached per relay through `bridgeCache`.
- Every relay's catalog is therefore different, and that's intended. **Whoever can write to the relay can publish an app to it.** On a whitelisted relay that means the whitelist; on an open relay, anyone.

### Updating and deleting

- **To update,** publish a new 32390 with the same `d`. New sessions use it. Running sessions keep the version they pinned (§2.1).
- **To retire,** publish a NIP-09 kind 5 with `["a", "32390:<author>:<d>"]`. Hosts hide the app from the catalog, and sessions that are already open keep working.
- **Relay operators** remove an app the way they remove anything else: by deleting the event or banning the author.
- **Keep old blobs** for at least 8 days after replacing a version: the 7-day session retention plus a day of margin. Otherwise live sessions of the old version can no longer be opened.

## 2. Session events: kind 2390

A **session** is one running instance of an app in one channel: a table, a poll, a board. It is the `create` event and every kind 2390 that references it.

Every session event carries:

| Tag | Value | Why |
|---|---|---|
| `h` | channel id | NIP-29 scoping. The relay applies the channel's write policy, so only people who may post in the channel can act in its sessions. |
| `t` | `obelisk-app` | A tag the relay indexes. obelisk-dex probes for it and falls back when it's missing. |
| `op` | operation name | See below |
| `e` | `<sessionId>`, `""`, `"root"` | Every op except `create`. `sessionId` is the `create` event's id. |

### 2.1 `create`: published by the host, never by the app

When the user picks an app in `/app` or `/play`, obelisk-dex publishes:

```jsonc
{
  "kind": 2390,
  "content": "{\"nonce\":\"<client nonce>\"}",
  "tags": [
    ["h", "<channel>"], ["t", "obelisk-app"], ["op", "create"],
    ["a", "32390:<author>:<d>", "<relay hint>"],
    ["x", "<aggregate>", "aggregate"],
    ["path", "/index.js", "<sha256>"],             // copied verbatim from the manifest
    ["path", "/music/a.mp3", "<sha256>"],
    ["api", "1"],
    ["alt", "Obelisk app session: Chain Reaction"]
  ]
}
```

**The `create` event is the version pin.** It copies the manifest's `path` tags and aggregate, so:

- **Every participant runs the same bundle,** even if the author publishes a new manifest halfway through the game. Same code plus same log gives the same state; that is the whole trust model (see [security.md](security.md)).
- **A session doesn't need the old manifest to still exist.** Relays keep only the newest version of an addressable event. Without the copy, a replaced manifest would orphan every session that used it.
- **Hosts must recompute the aggregate from the copied `path` tags** and refuse a `create` whose `x` doesn't match.

`nonce` lets a host find its own `create` again after losing the publish confirmation. This is dex's existing `findCreateByNonce`.

### 2.2 Ops the host understands

| `op` | Who | Content | Host meaning |
|---|---|---|---|
| `join` | anyone in the channel | `{}` | Adds the author to the session's participant list (card, avatars) |
| `leave` | a participant | `{}` | Removes them |
| `cancel` | the `create` author | `{}` | The card shows the session as closed. Later events are still delivered to the app, which decides what they mean. |
| `status` | the `create` author or a participant | `{"text": "…"}` ≤ 140 chars | The line shown on the chat card. The latest one wins. |

`status` from anyone else is ignored. It is display-only, and the app decides when to publish it (for example "Alice's turn · move 14").

### 2.3 App ops

- **Any other `op`** that matches `^[a-z][a-z0-9-]{0,31}$` belongs to the app. The host doesn't interpret it; it only delivers it.
- **Reserved names** can't be app ops: `create`, `join`, `leave`, `cancel`, `status`.
- **Content** is an opaque string, JSON by convention, ≤ 64 KiB (*tunable*).
- **Extra tags:** apps may add exactly one, `["n", "<non-negative integer>"]`, a turn or sequence index kept filterable without parsing content. Anything else is rejected by the host (see host-api.md, `publish`).

Chain Reaction's and Vesta's `start` / `move` / `timeout` / `resign` and Stacker's `attack` / `topout` / `checkpoint` are app ops under this spec. They are implemented in the SDK's turn-based and realtime kits, not in the host.

### 2.4 Ordering

The host delivers a session's events to the app sorted by `(created_at, id)` ascending. `id` is a hash, so the tiebreak is the same on every client. After the backlog, live events arrive in arrival order. The SDK re-sorts on insert, and apps must not assume arrival order.

## 3. Chat marker

A session is announced in the channel by an ordinary kind 9 message:

```
[[app:<sessionId>]]
```

obelisk-dex renders it as an app card:

- The card shows the manifest's title and icon, the participants, and the latest `status`.
- Clicking the card opens the app frame.

The legacy marker `[[game:<id>]]` is still parsed (§4).

## 4. Sessions from before this spec

Tables created by obelisk-dex before the migration look different:

- **The `create` event** has `["t","obelisk-game"]` and `["game","<type>"]` and no `a` or `path` tags.
- **The host maps them** through a fixed table: `chain-reaction`, `vesta` and `stacker` map to the official addresses under the Obelisk apps pubkey.
- **They run the current bundle** of the official app, because no version was pinned. Legacy tables therefore depend on the new official app staying compatible with the old op formats. The ported apps keep those formats byte-for-byte.

Kind 2390 is pruned after 7 days, so this path matters only in the first week after the switch. It is listed in [known-issues.md](known-issues.md) to be removed later.
