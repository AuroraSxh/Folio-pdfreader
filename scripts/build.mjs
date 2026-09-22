await import('./build-apple-speech.mjs');
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { cp, mkdir } from 'node:fs/promises';
await bundle({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
await build();
await mkdir('dist/pdf-assets', { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/pdf-assets/${folder}`, { recursive: true }).catch(e => { if(e.code !== 'ENOENT') throw e; });
}
