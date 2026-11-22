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

function gptFailure(message, gpt, cause) {
  return Object.assign(new Error(message, {cause}), {gpt});
}

async function readGptSectors(firehose, details, section, lba, sectors) {
  try {
    return await firehose.cmdReadBuffer(details.lun, lba, sectors);
  } catch (cause) {
    throw gptFailure(`Could not read GPT ${section} on LUN ${details.lun}`, {
      ...details, section, failure:'usb-read', lba:String(lba), sectors, expectedBytes:sectors * SECTOR,
    }, cause);
  }
}

async function readTable(firehose, lun, lba, table) {
  const details = {lun, table, headerLba:String(lba)};
  const header = await readGptSectors(firehose, details, 'header', lba, 1);
  if (header.length !== SECTOR || new TextDecoder().decode(header.subarray(0,8)) !== 'EFI PART') {
    throw gptFailure(`Invalid GPT on LUN ${lun}`, {
      ...details, section:'header', failure:header.length !== SECTOR ? 'byte-count' : 'signature',
      expectedBytes:SECTOR, receivedBytes:header.length,
    });
  }
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const length = h.getUint32(12,true);
  if (length < 92 || length > SECTOR) {
    throw gptFailure(`Invalid GPT metadata on LUN ${lun}`, {
      ...details, section:'header', failure:'header-size', headerBytes:length,
    });
  }
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
  if (crc32(copy) !== h.getInt32(16,true)
      || current !== lba || current === alternate || count === 0 || count > 128 || entrySize !== 128
      || low > high || firstEntry < 2n || (firstEntry <= high && firstEntry + BigInt(sectors) > low)) {
    throw gptFailure(`Invalid GPT metadata on LUN ${lun}`, {
      ...details, section:'header', failure:'metadata',
      currentLba:String(current), alternateLba:String(alternate),
      firstUsableLba:String(low), lastUsableLba:String(high), entriesLba:String(firstEntry),
      entryCount:count, entrySize, expectedCrc32:h.getUint32(16,true), actualCrc32:crc32(copy) >>> 0,
    });
  }
  const entries = {...details, entryCount:count, entrySize, alternateLba:String(alternate)};
  const data = await readGptSectors(firehose, entries, 'entries', firstEntry, sectors);
  const expectedCrc32 = h.getUint32(88,true);
  const actualCrc32 = crc32(data.subarray(0,count * entrySize)) >>> 0;
  if (data.length !== sectors * SECTOR || actualCrc32 !== expectedCrc32) {
    throw gptFailure(`Invalid GPT entries on LUN ${lun}`, {
      ...entries, section:'entries', failure:data.length !== sectors * SECTOR ? 'byte-count' : 'checksum',
      lba:String(firstEntry), sectors, expectedBytes:sectors * SECTOR, receivedBytes:data.length,
      expectedCrc32, actualCrc32,
    });
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
    if (start < low || end > high || start > end) {
      throw gptFailure(`Invalid sector range for ${name}`, {
        ...entries, section:'entries', failure:'partition-range', entryIndex:i,
        startLba:String(start), endLba:String(end), firstUsableLba:String(low), lastUsableLba:String(high),
      });
    }
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
    const primary = await readTable(unit,lun,1n,'primary');
    const backup = await readTable(unit,lun,primary.alternate,'backup');
    if (backup.alternate !== 1n || primary.count !== backup.count || !same(primary.data,backup.data)) {
      throw gptFailure(`Primary and backup partition tables disagree on LUN ${lun}`, {
        lun, section:'comparison', failure:'copies-disagree', backupLba:String(primary.alternate),
        primaryEntryCount:primary.count, backupEntryCount:backup.count,
        primaryCrc32:primary.h.getUint32(88,true), backupCrc32:backup.h.getUint32(88,true),
      });
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
      const written = await readTable(firehose,lun,current,table === primary ? 'primary' : 'backup');
      if (!same(written.header,table.header) || !same(written.data,table.data)) {
        throw new Error(`The slot metadata did not verify on LUN ${lun}`);
      }
    }
  }
  const verified = await readGpts(device);
  if (getBootSlot(verified.flatMap(t => t.primary.parts)) !== slot) throw new Error('New boot slot did not verify');
  if (!await device.firehose.cmdSetBootLunId(slot === 'a' ? 1 : 2)) throw new Error('The device rejected the new boot LUN');
}
