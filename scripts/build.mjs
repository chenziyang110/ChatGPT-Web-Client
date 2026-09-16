import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rm } from 'node:fs/promises';
await rm('dist-electron', { recursive: true, force: true });
await Promise.all([
  build({ entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/cli/index.ts'], outfile: 'dist-electron/cli.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  viteBuild()
]);
