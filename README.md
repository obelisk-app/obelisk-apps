<div align="center">

<img src="docs/readme/hero.svg" alt="Obelisk Apps: Chain Reaction, Chess, Vesta and Stacker, each in a sandboxed frame with its sha256 checked" width="100%">

<p>
  <a href="https://github.com/obelisk-app/obelisk-apps/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/obelisk-app/obelisk-apps?style=for-the-badge&logo=github&label=stars&color=b4f953&labelColor=0a0a0a"></a>
  <a href="https://github.com/obelisk-app/obelisk-apps/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/obelisk-app/obelisk-apps?style=for-the-badge&color=b4f953&labelColor=0a0a0a"></a>
  <img alt="Games" src="https://img.shields.io/badge/games-4%20live-b4f953?style=for-the-badge&labelColor=0a0a0a">
</p>
<p>
  <img alt="Manifest kind 32390" src="https://img.shields.io/badge/manifest-kind%2032390-c5ff6e?style=flat-square&labelColor=0a0a0a">
  <img alt="Sessions kind 2390" src="https://img.shields.io/badge/sessions-kind%202390-c5ff6e?style=flat-square&labelColor=0a0a0a">
  <img alt="Files like NIP-5A" src="https://img.shields.io/badge/files-NIP--5A%20style-7c5cff?style=flat-square&labelColor=0a0a0a">
  <img alt="Blobs on Blossom" src="https://img.shields.io/badge/blobs-Blossom-ff7ab6?style=flat-square&labelColor=0a0a0a">
  <img alt="Sandbox: connect-src none" src="https://img.shields.io/badge/sandbox-connect--src%20'none'-e5e5e5?style=flat-square&labelColor=0a0a0a">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-3178c6?style=flat-square&logo=typescript&logoColor=white&labelColor=0a0a0a">
  <img alt="React" src="https://img.shields.io/badge/react-61dafb?style=flat-square&logo=react&logoColor=white&labelColor=0a0a0a">
  <img alt="Vitest" src="https://img.shields.io/badge/vitest-6e9f18?style=flat-square&logo=vitest&logoColor=white&labelColor=0a0a0a">
</p>

<h3>
  <a href="https://obelisk.ar">🗿 Play on Obelisk</a>
  &nbsp;·&nbsp;
  <a href="#the-idea-in-one-paragraph">💡 The idea</a>
  &nbsp;·&nbsp;
  <a href="docs/app-format.md">📜 App format</a>
  &nbsp;·&nbsp;
  <a href="#build-test-publish">🛠️ Build &amp; publish</a>
</h3>

</div>

# Obelisk Apps

Games and small apps for [Obelisk](https://github.com/obelisk-app/obelisk), shipped as Nostr events instead of as client code.

**Status: live on test.obelisk.ar.** The SDK, the shared UI shell, the frame loader, the Blossom sidecar and four games are built and published: Chain Reaction, Vesta and Stacker (moved from obelisk-dex) and Chess (new, on chess.js + react-chessboard). The `games.obelisk.ar` dashboard comes next. See [docs/known-issues.md](docs/known-issues.md).

## 🎲 The games

<div align="center">
<img src="docs/readme/chain-reaction.svg" alt="An 18-move game of Chain Reaction on the 5×7 board, scripted with the app's own engine rules, ending in a three-wave chain that wins the board for lime" width="100%">
<br><sub>An 18-move game on the 5×7 board, played by the rules in <a href="apps/chain-reaction/src/engine.ts"><code>engine.ts</code></a>. Every move is one kind 2390 event.</sub>
</div>

<table>
<tr>
<td width="33%"><img src="docs/readme/shots/chess.jpg" alt="Chess: Bruno to move, after 1. e4"></td>
<td width="33%"><img src="docs/readme/shots/vesta.jpg" alt="Vesta: the hex island at setup"></td>
<td width="33%"><img src="docs/readme/shots/stacker.jpg" alt="Stacker: a falling-block board with hold and next pieces"></td>
</tr>
<tr>
<td valign="top"><img src="apps/chess/assets/icon.svg" width="20" align="top"> <b>Chess</b><br>Two players, full rules, every move replayed by every client. Built on chess.js and react-chessboard.</td>
<td valign="top"><img src="apps/vesta/assets/icon.svg" width="20" align="top"> <b>Vesta</b><br>Settle, trade and build on a hex island.</td>
<td valign="top"><img src="apps/stacker/assets/icon.svg" width="20" align="top"> <b>Stacker</b><br>Real-time falling-block battles: clears send garbage lines to the others, and every attack can be replayed and checked.</td>
</tr>
</table>

<details>
<summary><b>🪑 The lobby every game shares</b></summary>
<br>
<div align="center"><img src="docs/readme/shots/lobby.jpg" alt="A Chess table waiting for players: Fabricio (host) and Bruno, Start (2) and Cancel table" width="520"></div>

`packages/ui` is the shared shell: the lobby card, a board that fits, readable buttons and the players' pictures on every board. Screenshots are from `scripts/frame-harness.mjs`, which runs each bundle in real Chromium inside the real frame.
</details>

## 🔁 From `git push` to a game in the chat

<div align="center">
<img src="docs/readme/pipeline.svg" alt="Build, upload blobs to Blossom, sign a kind 32390 manifest. A player's client lists manifests, pins the version in a kind 2390 create, verifies every sha256 and runs the bundle in a network-less sandbox. Each move is a kind 2390 event the host signs and every client replays." width="100%">
</div>

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
apps/chess/           chess.js rules, react-chessboard UI
dashboard/            games.obelisk.ar: publish, browse, try apps (admin-shell design)
```

## Build, test, publish

```bash
npm install
npm test                                   # every package and app
cd apps/chess && npm run build             # dist/index.js + assets + manifest draft
node scripts/frame-harness.mjs apps/chess --stage board --click e2,e4   # real Chromium, real frame
node scripts/publish-app.mjs apps/chess --nsec-file <file> --relay wss://public.obelisk.ar
```

## Docs

| Doc | What it covers |
|---|---|
| [app-format.md](docs/app-format.md) | Kind 32390 manifest, kind 2390 session events, chat marker, versioning |
| [host-api.md](docs/host-api.md) | The postMessage contract between obelisk-dex and an app frame |
| [security.md](docs/security.md) | Trust boundary, threat model, sandbox and CSP, what is deliberately not exposed |
| [known-issues.md](docs/known-issues.md) | Open bugs, security gaps and decisions still pending |

Cross-project policy lives in [obelisk-design/security-workflows/app-sandbox.md](https://github.com/obelisk-app/obelisk-design/blob/main/security-workflows/app-sandbox.md). The host side lives in obelisk-dex (`docs/apps.md`, once the migration lands).

## 🌐 Around it

| | |
|---|---|
| 🗿 [**obelisk**](https://github.com/obelisk-app/obelisk) | The client (obelisk-dex) that lists, verifies and hosts the apps. Live at [obelisk.ar](https://obelisk.ar). |
| 🏝️ [**obelisk-sky**](https://github.com/obelisk-app/obelisk-sky) | The 3D village; its tables follow the same kind 2390 session events. |
| 🌸 [**blossom-server**](https://github.com/obelisk-app/blossom-server) | Our fork of hzrd149's Blossom server behind `blossom.obelisk.ar`, with WoT allowlists (`packages/blossom-wot`) and sandboxed blobs. |
| 📡 [**obelisk-relay**](https://github.com/obelisk-app/obelisk-relay) | The NIP-29 relay whose write gate is the curation, and whose WoT ladder decides who may upload. |
| 🎨 [**obelisk-design**](https://github.com/obelisk-app/obelisk-design) | Cross-project policy, including the app sandbox. |

<div align="center">
<br>
<a href="https://star-history.com/#obelisk-app/obelisk-apps&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=obelisk-app/obelisk-apps&type=Date&theme=dark">
    <img alt="Star history of obelisk-app/obelisk-apps" src="https://api.star-history.com/svg?repos=obelisk-app/obelisk-apps&type=Date" width="560">
  </picture>
</a>
</div>
