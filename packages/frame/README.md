# Frame loader

The static page the host mounts in `<iframe sandbox="allow-scripts">`. It is
served from `https://frame.obelisk.ar/v1/`, an origin of its own that holds no
login session (see `../../docs/security.md`).

- `public/v1/`: the page. It is plain files with no build step, so what's
  reviewed is what's served.
- `Caddyfile.snippet`: the site block, including the CSP header. The CSP has
  to be sent as a header, not as a `<meta>`, because `frame-ancestors` is
  ignored in `<meta>`.

The contract is in `../../docs/host-api.md § Topology`. The entry's default
export is called as `main({ port, root })`. Apps normally pass that straight
to the SDK's `connect()`.

## Deploy (this host)

The files are served in place by Caddy from `/root/obelisk-apps/packages/frame/public`
on `127.0.0.1:8101`. The cloudflared `fabri-ssh` tunnel maps `frame.obelisk.ar`
to that port. After editing the files, nothing needs to be restarted.
