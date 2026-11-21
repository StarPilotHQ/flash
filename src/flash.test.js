import {expect, spyOn, test} from 'bun:test';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {buf as crc32} from 'crc-32';
import {flashRelease, planFlash} from './flash.js';
import {downloadImage, unpack} from './images.js';
import {imagesForDevice} from './devices.js';
import release from './release.json';

const imageBytes = new Uint8Array(4096).fill(23);
const digest = bytesToHex(sha256(imageBytes));
const image = {name:'boot', size:4096, hash:digest, hash_raw:digest, sparse:false};

function fixture({type = '34', small = false, corrupt = false, noAck = false, systemNack = false} = {}) {
  const calls = [];
  const media = new Map();
  const luns = [1,2,4];
  for (const lun of luns) {
    const entries = new Uint8Array(4096);
    if (lun === 4) {
      const data = new DataView(entries.buffer);
      entries.set(Uint8Array.of(0x86,0x7f,0x11,0x20,0x85,0xe9,0x57,0x43,0xb9,0xee,0x37,0x4b,0xc1,0xd8,0x48,0x7d));
      entries[128] = 1;
      data.setBigUint64(32,7n,true);
      data.setBigUint64(40,7n,true);
      data.setBigUint64(48,(7n << 48n),true);
      data.setBigUint64(160,8n,true);
      data.setBigUint64(168,small ? 7n : 8n,true);
      [...'boot_a'].forEach((char,i) => entries[56+i*2]=char.charCodeAt(0));
      [...'boot_b'].forEach((char,i) => entries[184+i*2]=char.charCodeAt(0));
      for (const [index,name,lba] of [[2,'system_a',9n],[3,'system_b',10n]]) {
        const offset = index * 128;
        entries[offset] = 1;
        data.setBigUint64(offset+32,lba,true);
        data.setBigUint64(offset+40,lba,true);
        [...name].forEach((char,i) => entries[offset+56+i*2]=char.charCodeAt(0));
      }
    }
    for (const current of [1n,99n]) {
      const start = current === 1n ? 2n : 98n;
      const header = new Uint8Array(4096);
      header.set(new TextEncoder().encode('EFI PART'));
      const view = new DataView(header.buffer);
      view.setUint32(12,92,true);
      view.setBigUint64(24,current,true);
      view.setBigUint64(32,current === 1n ? 99n : 1n,true);
      view.setBigUint64(40,3n,true);
      view.setBigUint64(48,97n,true);
      view.setBigUint64(72,start,true);
      view.setUint32(80,4,true);
      view.setUint32(84,128,true);
      view.setInt32(88,crc32(entries.subarray(0,512)),true);
      view.setInt32(16,crc32(header.subarray(0,92)),true);
      media.set(`${lun}:${current}`,header);
      media.set(`${lun}:${start}`,entries.slice());
    }
  }
  const device = {
    getDeviceType: async () => type,
    firehose: {
      luns, cfg:{SECTOR_SIZE_IN_BYTES:4096},
      async cmdProgram(lun, start, blob) {
        const key = `${lun}:${start}`;
        if (start === 8n) calls.push('write inactive boot');
        if (start === 10n) {
          calls.push('write inactive system');
          if (systemNack) return false;
        }
        if (start === 98n && lun === 1 && noAck) return false;
        media.set(key,new Uint8Array(await blob.arrayBuffer()));
        return true;
      },
      async cmdReadBuffer(lun,start) {
        if (start === 10n) calls.push('read inactive system');
        if (start === 8n) {
          calls.push('read inactive boot');
          if (corrupt) return new Uint8Array(4096);
        }
        return media.get(`${lun}:${start}`).slice();
      },
      async cmdSetBootLunId(lun) { calls.push('set boot LUN '+lun); return true; },
    },
    async reset() { calls.push('reset'); },
  };
  return {device, calls};
}

const download = async () => new Blob([imageBytes]);
test('writes inactive boot and activates after verification', async () => {
  const {device,calls} = fixture();
  const plan = await planFlash(device,[image],'34');
  await flashRelease(device,[image],plan,download,() => {});
  expect(calls).toEqual(['write inactive boot','read inactive boot','set boot LUN 2','reset']);
});

test('blocks an unknown device or invalid target before writing', async () => {
  for (const settings of [{type:'33'},{small:true}]) {
    const {device,calls} = fixture(settings);
    await expect(planFlash(device,[image],'34')).rejects.toThrow();
    expect(calls).toEqual([]);
  }
});

test('a bad download leaves the device untouched', async () => {
  const {device,calls} = fixture();
  const plan = await planFlash(device,[image],'34');
  await expect(flashRelease(device,[image],plan,async () => { throw new Error('Download failed'); },() => {})).rejects.toThrow('Download failed');
  expect(calls).toEqual([]);
});

test('a read-back error prevents activation and reboot', async () => {
  const {device,calls} = fixture({corrupt:true});
  const plan = await planFlash(device,[image],'34');
  await expect(flashRelease(device,[image],plan,download,() => {})).rejects.toThrow('Read-back');
  expect(calls).toEqual(['write inactive boot','read inactive boot']);
});

test('a rejected slot metadata write prevents restart', async () => {
  const {device,calls} = fixture({noAck:true});
  const plan = await planFlash(device,[image],'34');
  await expect(flashRelease(device,[image],plan,download,() => {})).rejects.toThrow('metadata');
  expect(calls).toEqual(['write inactive boot','read inactive boot']);
});

test('unpacking rejects data that disagrees with the image digest', async () => {
  await expect(unpack(new Blob([new Uint8Array(4096)]).stream(),image,async () => {})).rejects.toThrow('checksum');
});

test('tries Dropbox, Firestar and Firestar East in that order', async () => {
  const compressed = Uint8Array.fromBase64('/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4A//ABldAAvv+7/+o7Fe5fg/sqomVfhocEFwFQ4kGM8AAAAAHrvAUk+aZNkAATWAIAAAAG9dNoaxxGf7AgAAAAAEWVo=');
  const urls = ['https://dl.dropboxusercontent.com/x','https://files.firestar.link/x','https://files-east.firestar.link/x'];
  const tried = [];
  const fetchMock = spyOn(globalThis,'fetch').mockImplementation(async url => {
    tried.push(url);
    if (tried.length === 1) return new Response(null,{status:503});
    return new Response(tried.length === 2 ? 'Failed mirror' : compressed);
  });
  let file;
  const directory = { async getFileHandle() {
    const chunks = [];
    return { async createWritable() {
      return { async write(bytes) { chunks.push(bytes.slice()); },
        async close() { file = new Blob(chunks); }, async abort() {} };
    }, async getFile() { return file; } };
  }};
  try {
    const downloaded = await downloadImage({...image,url:urls[0],fallback_urls:urls.slice(1)},directory,() => {});
    expect(tried).toEqual(urls);
    expect(bytesToHex(sha256(new Uint8Array(await downloaded.arrayBuffer())))).toEqual(digest);
  } finally {
    fetchMock.mockRestore();
  }
});

test('selects the correct boot chain and rejects unknown hardware', () => {
  const names = images => images.filter(image => !['boot','system'].includes(image.name));
  const early = imagesForDevice(release,'32');
  expect(early).toEqual(release.c3Images);
  expect(imagesForDevice(release,'33')).toEqual(release.images);
  expect(imagesForDevice(release,'34')).toEqual(release.images);
  expect(names(early).every((image,i) => image.hash !== names(release.images)[i].hash)).toBe(true);
  expect(() => imagesForDevice(release,'99')).toThrow();
});

test('requires system write acknowledgement without a second full system transfer', async () => {
  const images = [image, {...image,name:'system'}];
  const success = fixture();
  const successfulPlan = await planFlash(success.device,images,'34');
  await flashRelease(success.device,images,successfulPlan,download,() => {});
  expect(success.calls).toEqual(['write inactive boot','read inactive boot','write inactive system','set boot LUN 2','reset']);

  const failed = fixture({systemNack:true});
  const failedPlan = await planFlash(failed.device,images,'34');
  await expect(flashRelease(failed.device,images,failedPlan,download,() => {})).rejects.toThrow('system_b');
  expect(failed.calls).toEqual(['write inactive boot','read inactive boot','write inactive system']);
});
