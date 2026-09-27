# obelisk-blossom

Blossom server for Obelisk app bundles, served at **`https://blossom.obelisk.ar`**. It implements:
- **BUD-01:** `GET`/`HEAD /<sha256>[.ext]`, with byte ranges.
- **BUD-02:** `PUT /upload`, `DELETE /<sha256>` and `GET /list/<pubkey>`.
- **BUD-06:** `HEAD /upload` preflight.

It exists because the media Blossom servers obelisk-dex uses for attachments refuse anything that isn't media, including a JS bundle (see `../../docs/known-issues.md`).

## Trust boundary

**Anyone can read. Only the web of trust can write.** A stored blob is public, as in BUD-01. Uploads are admitted with the same ladder obelisk-relay uses for relay access (`src/whitelist.rs` `tier_of`), rebuilt here in Node:

| Order | Who | Result |
|---|---|---|
| 1 | `blocked` | Denied, whatever else matches |
| 2 | `manualAllow` | Tier 1 |
| 3 | Hop 0–1: the reference accounts and everyone they follow (the relay's "follow sync") | Tier 1: 512 MiB each |
| 4 | Hop 2 up to `maxHops`: friends of those | Tier 2: 64 MiB each |
| 5 | Anyone else | 403 "outside this server's web of trust" |

- **Reference accounts:** by default, the two reference accounts `public.obelisk.ar` uses (`obelisk-relay/public-config/reference_accounts.json`). Contact lists (kind 3 `p` tags only, newest per author) come from the relay's three `FOLLOW_RELAYS`: damus, nos.lol, purplepag.es.
- **Rebuilds:** the graph is rebuilt hourly and on start, with the relay's 25,000-list fetch budget.
- **Two differences from the relay,** both in `src/wot-graph.ts`:
  - The graph is **saved** to `wot-graph.json`, so a restart admits people immediately.
  - A rebuild that comes back with **less than half** the previous admitted set is thrown away as a relay outage. On the public relay, the admitted count swings by ±50k between hourly runs.

Blobs are served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, so an uploaded HTML or JS file can never run as a page on this origin. Code runs only inside the app frame, after the host has checked its hash.

## Limits

These are env vars, set in `ecosystem.config.cjs`:

| Var | Default | |
|---|---|---|
| `BLOSSOM_MAX_BLOB_MIB` | 16 | Per blob. Stacker's music tracks are about 3 MiB each. |
| `BLOSSOM_TIER1_QUOTA_MIB` / `BLOSSOM_TIER2_QUOTA_MIB` | 512 / 64 | Per uploader. A shared blob counts against every owner. |
| `BLOSSOM_TOTAL_CAP_GIB` | 3 | The whole store |
| `BLOSSOM_MIN_FREE_GIB` | 1 | Refuse uploads below this much free space on the data volume |
| `BLOSSOM_UPLOADS_PER_HOUR` | 120 | Per uploader |
| `BLOSSOM_MAX_HOPS` | 2 | 1 = follow sync only; at most 3 |
| `BLOSSOM_FETCH_BUDGET` | 25000 | Contact lists per rebuild |

## Operating it (this host)

- **Process:** pm2 `obelisk-blossom` on `127.0.0.1:3023`. The cloudflared `fabri-ssh` tunnel maps `blossom.obelisk.ar` to it.
- **Data:** `/mnt/HC_Volume_105554531/obelisk-blossom/` (blobs, `index.json`, `wot-graph.json`, `config.json`). It is **never on `/`**: the root disk is about 99% full and also holds both relays.
- **Lists:** edit `config.json` (`referenceAccounts`, `manualAllow`, `blocked`, `maxHops`), then run `pm2 sendSignal SIGHUP obelisk-blossom`. The block and allow lists apply at once. A change to the reference accounts or `maxHops` triggers a rebuild, like the relay's "Sync" button.
- **Health:** `GET /health` shows the blob count, stored bytes, cap, and the graph (`admitted`, `truncated`, `builtAt`).
- **Deploy:** run `npm run build`, then `pm2 restart obelisk-blossom`.

## Gotcha

nostr-tools 2.25 on Node 22's built-in `WebSocket` recurses without end on the first relay that won't connect: its `onerror` calls `close()`, which fires `error` again. The first deploy crash-looped on "Maximum call stack size exceeded". `src/index.ts` switches the pool to the `ws` package with `useWebSocketImplementation`. Keep that call.

## Tests

`npm test` runs the graph walk, the admission ladder, BUD auth, and an HTTP round trip against a temp directory.
