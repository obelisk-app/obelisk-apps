// pm2 definition for this host. Data lives on the mounted volume, never on
// the root disk (which is ~99% full and also holds both relays).
module.exports = {
  apps: [{
    name: 'obelisk-blossom',
    cwd: __dirname,
    script: 'dist/index.js',
    node_args: '--max-old-space-size=512',
    env: {
      BLOSSOM_HOST: '127.0.0.1',
      BLOSSOM_PORT: '3023',
      BLOSSOM_PUBLIC_URL: 'https://blossom.obelisk.ar',
      BLOSSOM_DATA_DIR: '/mnt/HC_Volume_105554531/obelisk-blossom',
      BLOSSOM_TOTAL_CAP_GIB: '3',
      BLOSSOM_MIN_FREE_GIB: '1',
      BLOSSOM_MAX_HOPS: '2',
    },
    max_memory_restart: '600M',
  }],
};
