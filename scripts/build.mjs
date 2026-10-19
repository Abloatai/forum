// Adapted from Abloatai/coding apps/desktop/scripts/build-main.mjs.
import {build} from 'esbuild';
import {mkdir, copyFile} from 'node:fs/promises';
const shared = {bundle: true, platform: 'node', target: 'node24', sourcemap: true, external: ['electron'], format: 'cjs'};
await Promise.all([
  build({...shared, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs'}),
  build({...shared, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs'}),
  build({bundle: true, platform: 'browser', target: 'chrome146', entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer/index.js', format: 'iife'}),
]);
await mkdir('dist/renderer', {recursive: true});
await Promise.all(['index.html', 'style.css'].map(name => copyFile('src/renderer/'+name, 'dist/renderer/'+name)));
