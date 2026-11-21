import { XzReadableStream } from 'xz-decompress';
import { unpack } from '../src/images.js';
import release from '../src/release.json';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the directory containing the verified boot and system .img.xz archives');
for (const image of release.images.filter(image => image.name === 'boot' || image.name === 'system')) {
  const filename = new URL(image.url).pathname.split('/').at(-1);
  const source = Bun.file(`${directory}/${filename}`);
  await unpack(new XzReadableStream(source.stream()),image,async () => {});
  console.log(`${image.name}: browser decoder verified archive and raw image SHA-256`);
}
