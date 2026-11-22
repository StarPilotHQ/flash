import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const SECTOR = 4096;
const MAX_EXTENT = 1024;
const encoder = new TextEncoder();
const GIB_SECTORS = 262144n;

export function bundleGeometry(sectors) {
  const size = sectors / GIB_SECTORS;
  if (size < 89n) throw new Error('This userdata size has no supported clean recovery image');
  return Number((size >= 90n ? 90n : 89n) * GIB_SECTORS);
}

export function validUsername(username) {
  return username.length <= 39 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(username);
}

export function validWifi({name, password}) {
  const length = encoder.encode(name).length;
  return length > 0 && length <= 32 && (/^[\x20-\x7e]{8,63}$/.test(password) || /^[a-f0-9]{64}$/i.test(password));
}

export async function wifiProfile(wifi) {
  if (!validWifi(wifi)) throw new Error('Enter a valid WPA2 network name and password');
  const ssid = encoder.encode(wifi.name);
  let psk = wifi.password.toLowerCase();
  if (psk.length !== 64) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(wifi.password), 'PBKDF2', false, ['deriveBits']);
    psk = bytesToHex(new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-1', salt: ssid, iterations: 4096,
    }, key, 256)));
  }
  return {ssid: Array.from(ssid), psk};
}

export function planUserdata(manifest, partition, expectedBlocks = Number(partition.sectors)) {
  const {blocks, size, hash, extents} = manifest;
  if (!Array.isArray(extents) || extents.length === 0 || extents.length > 100_000 ||
      !Number.isSafeInteger(blocks) || blocks !== expectedBlocks || BigInt(blocks) > partition.sectors ||
      !Number.isSafeInteger(size) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Offline image does not match this userdata partition');
  }
  let end = 0;
  let bytes = 0;
  const writes = extents.map(([start, count]) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1 ||
        count > MAX_EXTENT || start < end || start + count > blocks) {
      throw new Error('Invalid offline userdata extent');
    }
    end = start + count;
    const write = {sector: partition.start + BigInt(start), offset: bytes, length: count * SECTOR};
    bytes += write.length;
    return write;
  });
  if (bytes !== size || writes[0].sector !== partition.start) throw new Error('Incomplete offline userdata image');
  return writes;
}

export async function stageUserdata(base, partition, directory, status, username, wifi, expectedBlocks) {
  const response = await fetch(new URL('userdata.json', base), {credentials:'omit', cache:'no-cache'});
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Clean recovery image is unavailable for this branch and device. No data was erased.');
  }
  const manifest = await response.json();
  const writes = planUserdata(manifest, partition, expectedBlocks);
  const download = await fetch(new URL('userdata.bin', base), {credentials:'omit'});
  if (!download.ok || !download.body) throw new Error('Could not download the offline installer');
  const file = await directory.getFileHandle('userdata.bin', {create:true});
  const hash = sha256.create();
  let bytes = 0;
  await download.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.length;
      if (bytes > manifest.size) throw new Error('Offline installer exceeds its declared size');
      hash.update(chunk);
      controller.enqueue(chunk);
      status('Downloading clean userdata image', bytes, manifest.size);
    },
  })).pipeTo(await file.createWritable());
  if (bytes !== manifest.size || bytesToHex(hash.digest()) !== manifest.hash) {
    throw new Error('Offline installer checksum mismatch');
  }
  const payload = await file.getFile();
  const header = new DataView(await payload.slice(1024, 2048).arrayBuffer());
  if (header.getUint16(56, true) !== 0xef53 || header.getUint32(24, true) !== 2) {
    throw new Error('Offline installer is missing a mountable userdata filesystem');
  }
  if (!Number.isSafeInteger(manifest.access) || manifest.access < 1 || manifest.access >= manifest.blocks) {
    throw new Error('Offline installer is missing its SSH configuration sector');
  }
  const accessSector = partition.start + BigInt(manifest.access);
  const area = writes.find(write => accessSector >= write.sector && accessSector < write.sector + BigInt(write.length / SECTOR));
  if (!area) throw new Error('Offline installer is missing its SSH configuration file');
  const offset = area.offset + Number(accessSector - area.sector) * SECTOR;
  const placeholder = new Uint8Array(await payload.slice(offset, offset + SECTOR).arrayBuffer());
  if (!placeholder.every(byte => byte === 46)) throw new Error('Offline SSH configuration sector is invalid');
  const config = {};
  if (username) {
    status('Downloading GitHub public keys on this computer');
    const keys = await fetch('https://api.github.com/users/' + encodeURIComponent(username) + '/keys?per_page=100', {
      credentials:'omit', signal:AbortSignal.timeout(15000),
    });
    if (!keys.ok) throw new Error('Could not load the GitHub account’s public keys');
    const list = await keys.json();
    const lines = list.map(({key}) => key.match(/^(?:ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+(?=\s|$)/)?.[0]);
    if (!lines.length || lines.some(key => !key) || keys.headers.get('link')?.includes('rel="next"')) {
      throw new Error('The GitHub account does not have a usable set of public keys');
    }
    config.ssh = {username, keys:[...new Set(lines)]};
  }
  if (wifi) config.wifi = await wifiProfile(wifi);
  let settings;
  if (username || wifi) {
    const text = encoder.encode('STARPILOT_CONFIG\n' + JSON.stringify(config) + '\n');
    if (text.length > SECTOR) throw new Error('SSH and Wi-Fi settings are too large for offline recovery');
    settings = new Uint8Array(SECTOR).fill(10);
    settings.set(text);
  }
  return {writes, payload, accessSector, settings};
}

export async function writeUserdata(firehose, partition, {writes, payload, accessSector, settings}, status) {
  for (const {sector, offset, length} of writes) {
    const extent = payload.slice(offset, offset + length);
    if (!await firehose.cmdProgram(partition.lun, sector, extent)) {
      throw new Error('Device rejected offline userdata');
    }
    status('Writing clean userdata', offset + length, payload.size);
  }
  const data = await firehose.cmdReadBuffer(partition.lun, partition.start, 1);
  const expected = new Uint8Array(await payload.slice(0, SECTOR).arrayBuffer());
  if (data.length !== SECTOR || !data.every((byte, index) => byte === expected[index])) {
    throw new Error('Offline userdata superblock verification failed');
  }
  if (settings) {
    if (!await firehose.cmdProgram(partition.lun, accessSector, new Blob([settings]))) {
      throw new Error('Device rejected offline settings');
    }
    const saved = await firehose.cmdReadBuffer(partition.lun, accessSector, 1);
    if (saved.length !== SECTOR || !saved.every((byte, index) => byte === settings[index])) {
      throw new Error('Offline settings verification failed');
    }
  }
}
