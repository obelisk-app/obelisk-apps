# blossom-wot

Web-of-trust upload allowlists for **`https://blossom.obelisk.ar`**.

The server itself isn't here. It's **[obelisk-app/blossom-server](https://github.com/obelisk-app/blossom-server)**, branch `wot-pubkeys-file`: a fork of hzrd149's reference Blossom server (Deno + SQLite, BUD-01/02/04/06/09/11) with two small, generic additions, both candidates for upstreaming:

- **`pubkeysFile` on storage rules:** a hot-reloaded file of hex pubkeys, re-read when it changes. A missing file counts as empty, so the rule fails closed. Pruning filters owners in memory, because these lists run past SQLite's parameter limit.
- **`storage.sandboxBlobs`:** every blob is served with `CSP: default-src 'none'; sandbox` + `nosniff`, so an uploaded HTML or JS file can never run as a page on the server's origin.

This package is the sidecar that keeps those files current.

## Trust boundary

**Anyone can read. Only the web of trust can write.** The ladder is obelisk-relay's own (`src/whitelist.rs` `tier_of`):

| Who | File | Server rule |
|---|---|---|
| `blocked` | In neither file, whatever else matches | Can't upload |
| `manualAllow` | `tier1.txt` | Blobs kept 1 year |
| Hop 0–1: the reference accounts + their follows (the relay's "follow sync") | `tier1.txt` | 1 year |
| Hop 2 up to `maxHops`: friends of those | `tier2.txt` | 3 months |
| Anyone else | In neither file | 401 "Pubkey not authorized by any storage rule" |

- **Reference accounts:** by default, the two `public.obelisk.ar` uses (`obelisk-relay/public-config/reference_accounts.json`).
- **Contact lists:** kind 3 `p` tags only, newest per author, fetched from the relay's `FOLLOW_RELAYS`: damus, nos.lol, purplepag.es.
- **Rebuilds:** hourly and at start, with the relay's 25,000-list budget. The graph is saved, so a restart republishes at once.
- **A rebuild that loses more than half the admitted set is discarded.** The relay's own admitted count swings by ±50k between runs.

**The disk guard.** blossom-server has no total cap and no free-space floor, and this volume is shared. So every minute the sidecar measures the blob directory and the volume. If the store is over 3 GiB, or the volume has under 1 GiB free, it empties both files and uploads close. When there's room again, it restores them.

## Operating it (this host)

| | |
|---|---|
| **pm2** | `obelisk-blossom`: the fork, on `127.0.0.1:3023`, run by Deno from the volume. `obelisk-blossom-wot`: this sidecar. Both are defined in `ecosystem.config.cjs`. |
| **Tunnel** | cloudflared `fabri-ssh`: `blossom.obelisk.ar` → `:3023` |
| **Data** | `/mnt/HC_Volume_105554531/obelisk-blossom/`, never on `/` (≈97% full, and it holds both relays) |
| | `server/config.yml`: the fork's config (rules → `wot/tier{1,2}.txt`, `requirePubkeyInRule: true`, `sandboxBlobs: true`, 16 MiB per blob) |
| | `server/sqlite.db`, `server/blobs/`: the server's state |
| | `config.json`: the lists (`referenceAccounts`, `manualAllow`, `blocked`, `maxHops`) |
| | `wot-graph.json`: the saved graph |
| | `wot/tier1.txt`, `wot/tier2.txt`: written by the sidecar; don't edit them by hand |
| **Deno** | `/mnt/HC_Volume_105554531/deno/bin/deno`, with its cache under `deno/cache` |
| **Server code** | `/root/obelisk-blossom-server` (the fork, branch `wot-pubkeys-file`) |

- **To allow or block someone:** edit `config.json`, then `pm2 sendSignal SIGHUP obelisk-blossom-wot`. The files are rewritten at once and the server picks them up within 2 s, with no restart. A change to the reference accounts or `maxHops` also triggers a rebuild.
- **To deploy the sidecar:** `npm run build && pm2 restart obelisk-blossom-wot`.
- **To deploy the server:** `git pull` in `/root/obelisk-blossom-server`, then `pm2 restart obelisk-blossom`.

## Gotcha

nostr-tools 2.25 on Node 22's built-in `WebSocket` recurses without end on the first relay that won't connect. The first deploy crash-looped with "Maximum call stack size exceeded". `src/index.ts` switches the pool to the `ws` package. Keep that.

## Tests

`npm test` covers the graph walk (hops, newest list wins, the 200-author batches, the budget cut-off, a fetcher that throws), the discard rule, the tier ladder, the tier files and the disk guard. The fork's own tests cover `pubkeysFile` and `sandboxBlobs` (`tests/unit/pubkeys-file.test.ts`, `tests/e2e/wot-rules.test.ts`).
