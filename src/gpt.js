import { buf as crc32 } from 'crc-32';
import slotTypes from './slot-types.json';

const PRIORITY = 3n << 48n;
const ACTIVE = 1n << 50n;
const RETRIES = 7n << 51n;
const SUCCESS = 1n << 54n;
const UNBOOTABLE = 1n << 55n;
const BOOT_LUNS = [1, 2, 4];
const SECTOR = 4096;

function guid(bytes) {
  const parts = [[3,2,1,0],[5,4],[7,6],[8,9],[10,11,12,13,14,15]];
  return parts.map(part => part.map(i => bytes[i].toString(16).padStart(2,'0')).join('')).join('-');
}

function encodeGuid(text) {
  const bytes = Uint8Array.from(text.replaceAll('-','').match(/../g), value => Number.parseInt(value,16));
  return Uint8Array.from([3,2,1,0,5,4,7,6,8,9,10,11,12,13,14,15], i => bytes[i]);
}

function same(a, b) {
  return a.length === b.length && a.every((v,i) => v === b[i]);
}

async function readTable(firehose, lun, lba) {
  const header = await firehose.cmdReadBuffer(lun, lba, 1);
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length !== SECTOR || new TextDecoder().decode(header.subarray(0,8)) !== 'EFI PART') {
    throw new Error(`Invalid GPT on LUN ${lun}`);
  }
  const length = h.getUint32(12,true);
  const copy = header.slice(0,length);
  new DataView(copy.buffer).setUint32(16,0,true);
  const current = h.getBigUint64(24,true);
  const alternate = h.getBigUint64(32,true);
  const low = h.getBigUint64(40,true);
  const high = h.getBigUint64(48,true);
  const firstEntry = h.getBigUint64(72,true);
  const count = h.getUint32(80,true);
  const entrySize = h.getUint32(84,true);
  const sectors = Math.ceil(count * entrySize / SECTOR);
  if (length < 92 || length > SECTOR || crc32(copy) !== h.getInt32(16,true)
      || current !== lba || current === alternate || count === 0 || count > 128 || entrySize !== 128
      || low > high || firstEntry < 2n || (firstEntry <= high && firstEntry + BigInt(sectors) > low)) {
    throw new Error(`Invalid GPT metadata on LUN ${lun}`);
  }
  const data = await firehose.cmdReadBuffer(lun, firstEntry, sectors);
  if (data.length !== sectors * SECTOR || crc32(data.subarray(0,count * entrySize)) !== h.getInt32(88,true)) {
    throw new Error(`Invalid GPT entries on LUN ${lun}`);
  }
  const parts = [];
  for (let i=0;i<count;i++) {
    const offset = i * entrySize;
    const type = data.subarray(offset,offset+16);
    if (!type.some(Boolean)) continue;
    const entry = new DataView(data.buffer,data.byteOffset+offset,entrySize);
    const start = entry.getBigUint64(32,true);
    const end = entry.getBigUint64(40,true);
    const name = new TextDecoder('utf-16le').decode(data.subarray(offset+56,offset+128)).replace(/\0+$/,'');
    if (start < low || end > high || start > end) throw new Error(`Invalid sector range for ${name}`);
    parts.push({name,start,end,sectors:end-start+1n,attributes:entry.getBigUint64(48,true),type:guid(type),lun,offset});
  }
  return {header,h,length,firstEntry,alternate,data,parts,count};
}

export async function readGpts(device) {
  const unit = device.firehose;
  if (unit.cfg.SECTOR_SIZE_IN_BYTES !== SECTOR || !BOOT_LUNS.every(lun => unit.luns.includes(lun))) {
    throw new Error('Unexpected recovery storage geometry');
  }
  const tables = [];
  for (const lun of unit.luns) {
    const primary = await readTable(unit,lun,1n);
    const backup = await readTable(unit,lun,primary.alternate);
    if (backup.alternate !== 1n || primary.count !== backup.count || !same(primary.data,backup.data)) {
      throw new Error(`Primary and backup partition tables disagree on LUN ${lun}`);
    }
    tables.push({lun,primary,backup});
  }
  return tables;
}

export function getBootSlot(partitions) {
  const boots = partitions.filter(p => p.name === 'boot_a' || p.name === 'boot_b');
  const eligible = boots.filter(p =>
    p.type === slotTypes.boot[0] && (p.attributes & PRIORITY) === PRIORITY &&
    (p.attributes & ACTIVE) && !(p.attributes & UNBOOTABLE));
  if (boots.length !== 2 || new Set(boots.map(p => p.name)).size !== 2 || eligible.length !== 1) {
    throw new Error('The boot slot could not be identified safely');
  }
  return eligible[0].name.endsWith('_a') ? 'a' : 'b';
}

export async function activate(device, tables, slot, oldSlot) {
  const parts = tables.filter(t => BOOT_LUNS.includes(t.lun)).flatMap(t => t.primary.parts);
  if (getBootSlot(parts) !== oldSlot) throw new Error('The active slot changed during flashing');
  for (const base of Object.keys(slotTypes)) {
    const matches = parts.filter(p => p.name === `${base}_a` || p.name === `${base}_b`);
    if (matches.length && (matches.length !== 2 || matches[0].name === matches[1].name)) {
      throw new Error(`Incomplete ${base} slot pair`);
    }
  }

  for (const {lun,primary,backup} of tables.filter(t => BOOT_LUNS.includes(t.lun))) {
    for (const table of [backup,primary]) {
      for (const {name,offset,attributes} of table.parts) {
        const suffix = name.slice(-2);
        const base = name.slice(0,-2);
        if ((suffix !== '_a' && suffix !== '_b') || !Object.hasOwn(slotTypes,base)) continue;
        const chosen = suffix === `_${slot}`;
        const type = slotTypes[base]?.[chosen ? 0 : 1];
        if (type) table.data.set(encodeGuid(type),offset);
        const flags = chosen ? (attributes & ~(SUCCESS | UNBOOTABLE)) | ACTIVE | PRIORITY | RETRIES
          : (attributes & ~PRIORITY) | (1n << 48n);
        new DataView(table.data.buffer,table.data.byteOffset+offset,128).setBigUint64(48,flags,true);
      }
      table.h.setInt32(88,crc32(table.data.subarray(0,table.count*128)),true);
      table.h.setInt32(16,0,true);
      table.h.setInt32(16,crc32(table.header.subarray(0,table.length)),true);
      const current = table.h.getBigUint64(24,true);
      const {firehose} = device;
      if (!await firehose.cmdProgram(lun,table.firstEntry,new Blob([table.data])) ||
          !await firehose.cmdProgram(lun,current,new Blob([table.header]))) {
        throw new Error(`The device rejected slot metadata on LUN ${lun}`);
      }
      const written = await readTable(firehose,lun,current);
      if (!same(written.header,table.header) || !same(written.data,table.data)) {
        throw new Error(`The slot metadata did not verify on LUN ${lun}`);
      }
    }
  }
  const verified = await readGpts(device);
  if (getBootSlot(verified.flatMap(t => t.primary.parts)) !== slot) throw new Error('New boot slot did not verify');
  if (!await device.firehose.cmdSetBootLunId(slot === 'a' ? 1 : 2)) throw new Error('The device rejected the new boot LUN');
}
