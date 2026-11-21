import { copyFile, cp, mkdir } from 'node:fs/promises';

await mkdir('dist', {recursive: true});
await Promise.all(['index.html', 'style.css'].map(file => copyFile(file, 'dist/' + file)));
await cp('assets', 'dist/assets', {recursive: true});
const result = await Bun.build({entrypoints: ['src/app.js'], outdir: 'dist', target: 'browser', minify: true});
if (!result.success) throw new AggregateError(result.logs, 'Build failed');
