// pm2 definitions for blossom.obelisk.ar on this host.
//
//   obelisk-blossom      the server: obelisk-app/blossom-server (fork of
//                        hzrd149/blossom-server, branch wot-pubkeys-file),
//                        checked out at /root/obelisk-blossom-server.
//   obelisk-blossom-wot  this package: rewrites the server's pubkeysFile
//                        allowlists from the follow graph, and empties them
//                        when the disk guard trips.
//
// Everything stateful is on the mounted volume, never on / (the root disk is
// near-full and also holds both relays). Deno and its cache live there too.
const VOL = '/mnt/HC_Volume_105554531';
const DATA = `${VOL}/obelisk-blossom`;

module.exports = {
  apps: [
    {
      name: 'obelisk-blossom',
      cwd: '/root/obelisk-blossom-server',
      script: `${VOL}/deno/bin/deno`,
      args: ['run', '-P', 'main.ts', `${DATA}/server/config.yml`],
      interpreter: 'none',
      env: { DENO_DIR: `${VOL}/deno/cache`, DENO_NO_UPDATE_CHECK: '1' },
      max_memory_restart: '700M',
    },
    {
      name: 'obelisk-blossom-wot',
      cwd: __dirname,
      script: 'dist/index.js',
      node_args: '--max-old-space-size=512',
      env: {
        WOT_STATE_DIR: DATA,
        WOT_TIER_DIR: `${DATA}/wot`,
        WOT_BLOB_DIR: `${DATA}/server/blobs`,
        WOT_MAX_HOPS: '2',
        WOT_TOTAL_CAP_GIB: '3',
        WOT_MIN_FREE_GIB: '1',
      },
      max_memory_restart: '600M',
    },
  ],
};
