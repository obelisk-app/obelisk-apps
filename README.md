# Obelisk Apps

Games and small apps for [Obelisk](https://github.com/obelisk-app/obelisk), shipped as Nostr events instead of as client code.

**Status: spec stage.** Only `docs/` exists. The SDK, the frame loader, the three ported games (Chain Reaction, Vesta, Stacker) and the `games.obelisk.ar` dashboard come next. See [docs/known-issues.md](docs/known-issues.md).

## The idea in one paragraph

Publishing an app works like this:

1. An author uploads a bundle (one ES module, plus any assets) to Blossom.
2. The author signs one **app manifest** event (kind `32390`) on a relay.

Anyone who can write to that relay can publish an app. The relay's existing write gate is the curation.

obelisk-dex doesn't ship game code. On the relay the user is browsing, it:

- lists the manifests;
- verifies the bundle against the sha256 in the manifest;
- runs it in a sandboxed, network-less iframe.

The app never touches the user's keys. It asks the host to publish kind `2390` session events, and the host builds and signs them under strict rules. Every client replays the same session log through the same pinned bundle, so no referee is needed. This is the trust model obelisk-dex games already use.

## Layout (planned)

```
docs/                 the wire format, host API, security model, known issues
packages/sdk/         @obelisk/apps-sdk: host RPC client, turn-based and realtime kits, test harness
packages/frame/       the sandbox loader page (served from its own origin)
apps/chain-reaction/  first-party apps, moved from obelisk-dex
apps/vesta/
apps/stacker/
dashboard/            games.obelisk.ar: publish, browse, try apps (admin-shell design)
```

## Docs

| Doc | What it covers |
|---|---|
| [app-format.md](docs/app-format.md) | Kind 32390 manifest, kind 2390 session events, chat marker, versioning |
| [host-api.md](docs/host-api.md) | The postMessage contract between obelisk-dex and an app frame |
| [security.md](docs/security.md) | Trust boundary, threat model, sandbox and CSP, what is deliberately not exposed |
| [known-issues.md](docs/known-issues.md) | Open bugs, security gaps and decisions still pending |

Cross-project policy lives in [obelisk-design/security-workflows/app-sandbox.md](https://github.com/obelisk-app/obelisk-design/blob/main/security-workflows/app-sandbox.md). The host side lives in obelisk-dex (`docs/apps.md`, once the migration lands).
