import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { activate, getBootSlot, readGpts } from './gpt.js';

const READ_SIZE = 1024 * 1024;

export async function planFlash(device, images, deviceType) {
  const reported = String(await device.getDeviceType());
  if (!['32', '33', '34'].includes(reported) || reported !== deviceType) {
    throw new Error('The connected device does not match a supported AGNOS release');
  }
  const sectorSize = device.firehose.cfg.SECTOR_SIZE_IN_BYTES;
  if (sectorSize !== 4096) throw new Error('Unexpected storage sector size');
  const tables = await readGpts(device);
  const partitions = tables.flatMap(table => table.primary.parts);
  const active = getBootSlot(partitions);
  const target = active === 'a' ? 'b' : 'a';
  const entries = images.map(image => {
    const matches = partitions.filter(p => p.name === `${image.name}_${target}`);
    if (matches.length !== 1 || matches[0].start < 2n
        || matches[0].sectors < BigInt(Math.ceil(image.size / sectorSize))) {
      throw new Error(`Missing or undersized ${image.name} partition`);
    }
    const partition = matches[0];
    if (partitions.some(p => p !== partition && p.lun === partition.lun &&
        p.start <= partition.end && p.end >= partition.start)) {
      throw new Error(`Overlapping partition for ${image.name}`);
    }
    return {image, partition};
  });
  return {active, target, entries, sectorSize, deviceType};
}

async function verify(device, {image, partition}, sectorSize, status) {
  const hash = sha256.create();
  for (let offset = 0; offset < image.size; offset += READ_SIZE) {
    const size = Math.min(image.size - offset, READ_SIZE);
    const count = Math.ceil(size / sectorSize);
    const data = await device.firehose.cmdReadBuffer(partition.lun, partition.start + BigInt(offset / sectorSize), count);
    if (data.length !== count * sectorSize) throw new Error(`Short read from ${partition.name}`);
    hash.update(data.subarray(0, size));
    status(`Verifying ${partition.name}`, offset + size, image.size);
  }
  return bytesToHex(hash.digest()) === image.hash_raw;
}

export async function flashRelease(device, images, selected, download, status, beforeActivate) {
  const plan = await planFlash(device, images, selected.deviceType);
  if (plan.active !== selected.active || plan.target !== selected.target) throw new Error('The boot slot changed. Reconnect before flashing.');
  const files = new Map();
  for (const entry of plan.entries) {
    files.set(entry.image.name, await download(entry.image));
  }
  // Use raw, bounded writes after every archive has passed its size and digest checks.
  for (const entry of plan.entries) {
    const {image, partition} = entry;
    const file = files.get(image.name);
    if (file.size !== image.size) throw new Error(`Unexpected image size for ${image.name}`);
    status(`Writing ${partition.name}`, 0, image.size);
    if (!await device.firehose.cmdProgram(partition.lun, partition.start, file,
      bytes => status(`Writing ${partition.name}`, bytes, image.size))) {
      throw new Error(`Device rejected ${partition.name}`);
    }
    if (image.name !== 'system' && !await verify(device, entry, plan.sectorSize, status)) {
      throw new Error(`Read-back checksum failed for ${partition.name}`);
    }
  }
  if (beforeActivate) await beforeActivate();
  status(`Activating slot ${plan.target.toUpperCase()}`);
  await activate(device, await readGpts(device), plan.target, plan.active);
  status('Restarting your comma');
  await device.reset();
}
