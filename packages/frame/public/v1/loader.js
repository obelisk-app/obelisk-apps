// Obelisk app frame loader, host API v1 (docs/host-api.md § Topology).
//
// This page runs inside <iframe sandbox="allow-scripts">, so its origin is
// opaque and it holds nothing worth stealing. Its only job: wait for exactly
// one `boot` from an allowed parent, import the verified entry the host sent
// as a Blob, and hand the app its MessagePort. Everything after that talks
// over the port, which dies with this document if the app navigates away.

const LOADER_VERSION = '1.0.0';

const ALLOWED_PARENTS = new Set([
  'https://obelisk.ar',
  'https://dex.obelisk.ar',
  'https://test.obelisk.ar',
  'https://games.obelisk.ar',
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:3000',
]);

let booted = false;

async function onMessage(event) {
  if (booted) return;
  if (event.source !== window.parent) return;
  if (!ALLOWED_PARENTS.has(event.origin)) return;
  const msg = event.data;
  if (!msg || msg.obelisk !== 1 || msg.type !== 'boot') return;
  const port = event.ports && event.ports[0];
  if (!(port instanceof MessagePort) || !(msg.entry instanceof Blob)) return;

  booted = true;
  window.removeEventListener('message', onMessage);

  const root = document.getElementById('app');
  const url = URL.createObjectURL(new Blob([msg.entry], { type: 'text/javascript' }));
  try {
    const mod = await import(url);
    if (typeof mod.default !== 'function') throw new Error('entry has no default export');
    await mod.default({ port, root });
  } catch (err) {
    port.postMessage({ type: 'fatal', message: String(err && err.message || err).slice(0, 500) });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Opened directly rather than embedded: say what this is instead of a blank page.
if (window.parent === window) {
  const root = document.getElementById('app');
  root.className = 'standalone';
  root.textContent = 'This is the Obelisk Apps sandbox. It stays empty until Obelisk opens an app inside it; there is nothing to see here on its own.';
} else {
  window.addEventListener('message', onMessage);
  window.parent.postMessage({ obelisk: 1, type: 'hello', loader: LOADER_VERSION }, '*');
}
