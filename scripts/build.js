import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', {recursive: true});
await Promise.all([copyFile('style.css', 'dist/style.css'), copyFile('scripts/pages-worker.js', 'dist/_worker.js')]);
await cp('assets', 'dist/assets', {recursive: true});
const result = await Bun.build({entrypoints: ['src/app.js'], outdir: 'dist', target: 'browser', minify: true});
if (!result.success) throw new AggregateError(result.logs, 'Build failed');

let html = await readFile('index.html', 'utf8');
for (const file of ['app.js', 'style.css']) {
  const fingerprint = createHash('sha256').update(await readFile('dist/' + file)).digest('hex').slice(0, 12);
  html = html.replace('./' + file, './' + file + '?v=' + fingerprint);
}
await writeFile('dist/index.html', html);
