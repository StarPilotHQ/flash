import {expect, test} from 'bun:test';
import {sha1} from '@noble/hashes/sha1';
import {copyGitPack, moduleUrls} from './fork.js';
import {submoduleRepo, validRef} from './github.js';
import {planForkSpace} from './userdata.js';
import {imagesForDevice} from './devices.js';
import {verifyForkBootChain} from './release.js';

test('resolves public GitHub submodule URLs and rejects unsafe locations', () => {
  expect(submoduleRepo('commaai/openpilot','../panda.git')).toBe('commaai/panda');
  expect(submoduleRepo('commaai/openpilot','git@github.com:tinygrad/tinygrad.git')).toBe('tinygrad/tinygrad');
  for (const url of ['file:///data/repo','https://elsewhere.invalid/repo','https://user@github.com/org/repo']) {
    expect(() => submoduleRepo('commaai/openpilot',url)).toThrow('public GitHub');
  }
  expect(validRef('release/test')).toBe(true);
  expect(validRef('-testing')).toBe(false);
  expect(validRef('foo/../bar')).toBe(false);
  expect(moduleUrls('[submodule "panda"]\n path = panda\n url = ../../commaai/panda.git # note\n').get('panda')).toBe('../../commaai/panda.git');
});

test('strips Git pkt-lines and verifies Git pack bytes before allowing them to stage', async () => {
  const content = new TextEncoder().encode('PACK0123456789');
  const pack = new Uint8Array([...content,...sha1(content)]);
  const prefix = new TextEncoder().encode('00000008NAK\n');
  const wire = new Uint8Array([...prefix,...pack]);
  const stored = [];
  const writer = {async write(bytes) {stored.push(...bytes);}};
  const parts = [wire.slice(0,3),wire.slice(3,13),wire.slice(13,21),wire.slice(21)];
  expect(await copyGitPack(parts,writer,100)).toBe(pack.length);
  expect(new Uint8Array(stored)).toEqual(pack);
  wire[wire.length-1] ^= 1;
  await expect(copyGitPack([wire],writer,100)).rejects.toThrow('checksum');
  await expect(copyGitPack([wire],writer,10)).rejects.toThrow('exceed');
});

test('protects existing metadata and rejects unknown fork boot firmware', () => {
  const part = {start:2000n};
  const write = {sector:2010n,length:4096};
  expect(planForkSpace([[11,262144]],part,300000,[write])[0].sector).toBe(2011n);
  expect(() => planForkSpace([[10,262144]],part,300000,[write])).toThrow('overlaps');
  expect(() => verifyForkBootChain([{name:'abl',hash_raw:'fork'}],[{name:'abl',hash_raw:'hardware'}])).toThrow('hardware');
});

test('allows the complete official recovery boot chain on comma 3X and four', () => {
  const images = Object.entries({
    xbl: 'e8acf2a9cc7f0ce84cb803bfea9477f765c0d7b4daf26048e59651b9e6a7bfbb',
    xbl_config: '758552ecf92b5569677197783bf0ccb73d7f961685308e45d3276ac9dd974f85',
    abl: 'b6fba807b9bcd66a31f2afb0eba5163ec239693ad32e2e4200f6c356adfe098c',
    aop: '78b2287ca219a0811b3004c523fa0f4749e4d1fd92be3aba61699305b7943ad1',
    devcfg: 'f71df3a86958c093ba3969254c4db025187eef9385427f1ade946742939b43cc',
  }).map(([name, hash_raw]) => ({name, hash_raw}));
  const reference = images.map(image => image.name === 'abl'
    ? {...image, hash_raw:'29fd7ed1c012e599420764840f9f11286d34dbff4adaf102a447f06d8c5e0b35'} : image);
  const release = {images, c3Images:images.map(image => ({...image, hash_raw:'c'.repeat(64)}))};

  for (const type of ['33', '34']) {
    expect(() => verifyForkBootChain(imagesForDevice(release,type),reference,type)).not.toThrow();
    expect(() => verifyForkBootChain(reference,reference,type)).not.toThrow();
    for (const name of images.map(image => image.name)) {
      const invalid = images.map(image => image.name === name ? {...image, hash_raw:'0'.repeat(64)} : image);
      expect(() => verifyForkBootChain(invalid,reference,type)).toThrow('hardware');
    }
    expect(() => verifyForkBootChain(images.slice(1),reference,type)).toThrow('hardware');
  }
  expect(() => verifyForkBootChain(images,release.c3Images,'32')).toThrow('hardware');
  expect(() => verifyForkBootChain(imagesForDevice(release,'32'),release.c3Images,'32')).not.toThrow();
});
