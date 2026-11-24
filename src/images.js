import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { XzReadableStream } from 'xz-decompress';

const CHUNK = 1024 * 1024;

async function sparseParts(read, size, write) {
  const header = new DataView((await read(28)).buffer);
  const block = header.getUint32(12, true);
  const count = header.getUint32(20, true);
  if (header.getUint32(0, true) !== 0xed26ff3a || header.getUint16(4, true) !== 1
      || header.getUint16(6, true) !== 0 || header.getUint16(8, true) !== 28
      || header.getUint16(10, true) !== 12 || block !== 4096 || count > size / block
      || header.getUint32(16, true) * block !== size) {
    throw new Error('Invalid sparse image header');
  }

  let offset = 0;
  for (let i = 0; i < count; i++) {
    const chunk = new DataView((await read(12)).buffer);
    const type = chunk.getUint16(0, true);
    const bytes = chunk.getUint32(4, true) * block;
    const dataBytes = chunk.getUint32(8, true) - 12;
    if (bytes === 0 || bytes > size - offset) throw new Error('Sparse chunk is outside the image');
    if (type === 0xcac1 && dataBytes === bytes) {
      for (let left = bytes; left > 0; left -= CHUNK) await write(await read(Math.min(CHUNK, left)));
    } else if (type === 0xcac2 && dataBytes === 4) {
      const value = new DataView((await read(4)).buffer).getUint32(0, true);
      const cover = new Uint8Array(Math.min(CHUNK, bytes));
      new Uint32Array(cover.buffer).fill(value);
      for (let left = bytes; left > 0; left -= cover.length) await write(cover.subarray(0, left));
    } else {
      throw new Error('Unexpected chunk in this AGNOS image');
    }
    offset += bytes;
  }
  if (offset !== size) throw new Error('Incomplete sparse image');
}

export async function unpack(source, image, write) {
  const encodedHash = sha256.create();
  const rawHash = sha256.create();
  const reader = source.getReader();
  let bytes = 0;
  let current = new Uint8Array();
  let complete = false;
  async function append(data) {
    bytes += data.length;
    if (bytes > image.size) throw new Error('Image exceeds its declared size');
    rawHash.update(data);
    await write(data);
  }
  async function read(size) {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (!current.length) {
        const step = await reader.read();
        if (step.done) throw new Error('Truncated sparse image');
        current = step.value;
        encodedHash.update(current);
      }
      const length = Math.min(current.length, size - offset);
      result.set(current.subarray(0, length), offset);
      offset += length;
      current = current.subarray(length);
    }
    return result;
  }
  try {
    if (image.sparse) {
      await sparseParts(read, image.size, append);
      if (current.length) throw new Error('Trailing sparse image data');
      for (let step = await reader.read(); !step.done; step = await reader.read()) {
        if (step.value.length) throw new Error('Trailing sparse image data');
      }
    } else {
      for (let step = await reader.read(); !step.done; step = await reader.read()) {
        encodedHash.update(step.value);
        await append(step.value);
      }
    }
    complete = true;
    if (bytes !== image.size || bytesToHex(encodedHash.digest()) !== image.hash
        || bytesToHex(rawHash.digest()) !== image.hash_raw) {
      throw new Error('Image checksum or size mismatch');
    }
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch { /* The decoder can already be closed. */ }
    }
  }
}

export async function downloadImage(image, directory, status) {
  const errors = [];
  for (const url of [image.url, ...(image.fallback_urls ?? [])]) {
    const host = new URL(url).hostname;
    const file = await directory.getFileHandle(image.name, {create: true});
    const writer = await file.createWritable();
    try {
      const message = `Preparing ${image.name} from ${host}`;
      status(message, 0, image.size);
      const response = await fetch(url, {credentials: 'omit'});
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      let prepared = 0;
      await unpack(new XzReadableStream(response.body), image, async data => {
        await writer.write(data);
        prepared += data.length;
        status(message, prepared, image.size);
      });
      await writer.close();
      return await file.getFile();
    } catch (error) {
      await writer.abort().catch(() => {});
      if (error.name === 'QuotaExceededError') throw error;
      errors.push(`${host}: ${error.message ?? error}`);
    }
  }
  throw new Error(`Could not verify ${image.name}. ${errors.join(' · ')}`);
}
