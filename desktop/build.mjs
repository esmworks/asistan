// Bundles the Electron main process and preload script into dist/.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // ws (under socket.io-client) loads these optional speedups only if present.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
};
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
