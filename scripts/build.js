import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', {recursive: true});
await copyFile('style.css', 'dist/style.css');
await cp('assets', 'dist/assets', {recursive: true});
const result = await Bun.build({entrypoints: ['src/app.js'], outdir: 'dist', target: 'browser', minify: true});
if (!result.success) throw new AggregateError(result.logs, 'Build failed');
const worker = await Bun.build({entrypoints: ['scripts/pages-worker.js'], target: 'browser', minify: true});
if (!worker.success) throw new AggregateError(worker.logs, 'Worker build failed');
await Bun.write('dist/_worker.js', worker.outputs[0]);

let html = await readFile('index.html', 'utf8');
for (const file of ['app.js', 'style.css']) {
  const fingerprint = createHash('sha256').update(await readFile('dist/' + file)).digest('hex').slice(0, 12);
  html = html.replace('./' + file, './' + file + '?v=' + fingerprint);
}
await writeFile('dist/index.html', html);
