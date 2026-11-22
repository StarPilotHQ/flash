import {expect, test} from 'bun:test';
import {sha1} from '@noble/hashes/sha1';
import {copyGitPack, moduleUrls} from './fork.js';
import {submoduleRepo, validRef} from './github.js';
import {planForkSpace} from './userdata.js';
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
