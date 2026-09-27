# Host API v1

**Status: draft.** This is the contract between the **host** and an **app**:

- The host is obelisk-dex, or the dashboard's Playground, which implements the same API against a fake relay.
- The app is a bundle running in the sandbox frame.

The app's manifest declares `["api","1"]`. A host that doesn't support an app's major version won't load it.

Read [security.md](security.md) first. Every "no" in this document has a reason there.

## Topology

```
obelisk-dex (https://obelisk.ar)                 frame loader (https://frame.obelisk.ar/v1/)
┌─────────────────────────────────┐              ┌──────────────────────────────────────────┐
│ AppFrameModal                   │  <iframe     │ sandbox="allow-scripts"  (opaque origin) │
│  ├─ fetch bundle from Blossom   │   sandbox>   │ CSP: default-src 'none'; script-src      │
│  ├─ verify sha256 vs `create`   │──────────────│      'self' blob:; connect-src 'none' …  │
│  ├─ signer, relay subs          │  1 postMsg   │                                          │
│  └─ RPC server  ◄───────────────┼──MessagePort─┼─► @obelisk/apps-sdk ◄─► app module     │
└─────────────────────────────────┘              └──────────────────────────────────────────┘
```

1. **Load:** the host mounts `<iframe src="https://frame.obelisk.ar/v1/" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">`.
2. **Hello:** the loader posts `{obelisk: 1, type: "hello", loader: "<version>"}` to `window.parent`.
3. **Handshake:** the host checks that `event.source === iframe.contentWindow`. It creates a `MessageChannel` and posts `{type: "boot", port, entry: Blob}`, transferring `port2`. It uses target origin `"*"`, because a sandboxed frame's origin is the opaque `"null"`.
4. **Start:** the loader accepts `boot` only when `event.source === window.parent` and `event.origin` is in its allowlist (obelisk.ar, test.obelisk.ar, the Tauri origin, localhost in dev). It then:
   - imports the entry via a `blob:` URL;
   - hands the port to the SDK;
   - calls the module's default export: `export default function main(host: Host): void | Promise<void>`.
5. **Everything else** goes over the `MessagePort`, never over `window.postMessage`. A port belongs to the document it was transferred into: if the app navigates its frame away, the port dies with it and the new page receives nothing.

The entry is a **single self-contained ES module**. A `blob:` module can't resolve relative imports, so bundlers must inline everything, and other files come in through `asset()`.

## Envelope

Every message on the port is one of these:

```ts
type Req  = { id: number; type: string; [k: string]: unknown }         // app → host, expects a reply
type Res  = { re: number; ok: true; result?: unknown }
          | { re: number; ok: false; error: ErrorCode; message?: string }
type Push = { type: string; [k: string]: unknown }                     // host → app, no reply
```

- **The SDK wraps all of this.** Apps call `host.publish(...)` and get a Promise back.
- **Unknown request types** get `{ok: false, error: "unsupported"}`.
- **Malformed messages are dropped** without a reply. A request with a non-integer `id` counts as malformed.

## Host → app pushes

| `type` | Payload | When |
|---|---|---|
| `init` | see below | Once, before anything else |
| `events` | `{events: NostrEvent[]}`: complete signed events, signatures already verified by the host | The whole backlog first (sorted by `(created_at, id)`), then new events as they arrive |
| `participants` | `{participants: Participant[]}` | When joins, leaves or profiles change |
| `visibility` | `{visible: boolean}` | The modal is hidden or shown. Realtime apps should pause. |
| `env` | `{locale, theme}` | The user changed the language or theme |

```ts
interface Init {
  api: 1
  app: { address: string; title: string; version?: string; author: string }
  session: {
    id: string                 // the create event id
    createdBy: string          // pubkey
    createdAt: number
    channelName: string        // display only; no relay URL, no group id
  }
  me: string | null            // pubkey, or null for a signed-out spectator
  participants: Participant[]
  paths: string[]              // what asset() can fetch, from the pinned `path` tags
  locale: 'en' | 'es' | 'pt'
  theme: { mode: 'dark' | 'light'; accent: string }   // accent is a #rrggbb the host chose
  limits: { contentBytes: number; publishPerSecond: number; storageBytes: number }
}

interface Participant {
  pubkey: string
  name: string                 // display name, NIP-05 or short npub; never raw hex
  avatar?: Blob                // fetched by the host; the app never sees the URL
}
```

## App → host requests

### `publish`

```ts
host.publish({ op: string; content?: string; n?: number }): Promise<{ id: string; created_at: number }>
```

The host builds the event itself. The app doesn't supply a kind or tags:

```
kind 2390
tags ["h", <session channel>] ["t","obelisk-app"] ["op", op] ["e", <session id>, "", "root"] (+ ["n", String(n)])
content  content ?? ""
```

The host rejects a publish when:

| Error | Condition |
|---|---|
| `forbidden-op` | `op` is `create` or doesn't match `^[a-z][a-z0-9-]{0,31}$`. `join`, `leave`, `cancel` and `status` are allowed; the SDK exposes helpers for them. |
| `too-large` | `content` > `limits.contentBytes` (64 KiB), or a `status` text > 140 chars |
| `bad-n` | `n` isn't a safe non-negative integer |
| `rate-limited` | Token bucket, 20 deep, refilling 5/s (*tunable*). This is sized for Stacker, which flushes every 250 ms. |
| `signed-out` | `me === null` |
| `signer-rejected` | The user's signer (NIP-07 or bunker) refused or timed out |
| `closed` | The session was cancelled, or the frame is closing |

The host echoes the signed event back in the next `events` push, so apps render from the log and not from the promise.

Signing prompts: a NIP-07 extension may ask the user to approve each event. The host is the one asking, so the prompt names obelisk.ar, not the app. An app that publishes on every frame will drown an extension user in prompts; the rate limit is what stops that.

### `asset`

```ts
host.asset(path: string): Promise<Blob>
```

- **Only pinned files:** `path` must be one of `init.paths`.
- **Verified before it's handed over:** the host fetches the blob from the manifest's `server` hints, then Blossom's default servers. It checks the sha256 against the pinned `path` tag, caches it by hash, and returns it with the right MIME type.
- **Errors:** `not-found` for a path not in `init.paths`, `unavailable` when no server has it, `hash-mismatch`.

### `storage.get` / `storage.set`

```ts
host.storage.get(key: string): Promise<string | null>
host.storage.set(key: string, value: string | null): Promise<void>
```

- **Scope:** per app and per user, kept in the host's localStorage under `obelisk-dex/app-storage/{appAddress}/{me}`.
- **Size:** at most `limits.storageBytes` (256 KiB) for the whole namespace (error `quota`).
- **Signed-out users** get a scratch store that is thrown away with the frame.
- **Use it** for key bindings, audio settings and similar. It is not shared state; that goes in session events.

### `profiles`

```ts
host.profiles(pubkeys: string[]): Promise<Participant[]>
```

This resolves display names and avatars for up to 32 pubkeys. The host only answers for pubkeys that authored an event in this session, and returns `{pubkey, name: shortNpub}` for anyone else. This stops an app from using the host as a way to look up profiles.

### `ui.*`

| Request | Effect |
|---|---|
| `ui.resize {height}` | Widgets only: asks for a frame height between 120 and 720 px. Modal apps get the full modal. |
| `ui.toast {text, tone: 'info' \| 'error'}` | ≤ 120 chars, at most 1 every 3 s. It is shown in the host's toast stack prefixed with the app's title, so it can't pose as Obelisk. |
| `ui.close {}` | Closes the modal |

## What is deliberately not in v1

The reason for each is in [security.md](security.md#not-exposed).

- **Signing anything other than the fixed kind 2390 template,** including NIP-04/44 encryption, zaps or payments.
- **Reading chat messages, DMs, the member list or the user's relay list.**
- **Network access of any kind,** including image URLs. Avatars and assets arrive as Blobs.
- **Popups, top-level navigation, forms, clipboard, camera, microphone, geolocation, fullscreen.**

These may be added later as **permissions declared in the manifest** (`["permission", "<name>"]`), which the user approves per app. That is v2 and has no design yet.

## Versioning

- **Additions** are new request types, new optional push fields or new error codes. They can go into v1 at any time. The SDK treats `unsupported` as "this host is older" and degrades.
- **Anything that changes the meaning of an existing message** is v2. Hosts should support every major version still in use; the catalog shows how many apps declare each one.
