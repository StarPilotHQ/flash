import { expect, test } from 'bun:test';
import { planUserdata, validWifi, wifiProfile, writeUserdata } from './userdata.js';

const partition = {lun:0, start:80000n, sectors:8000n};
const manifest = {blocks:8000, hash:'a'.repeat(64), size:8192, extents:[[0,1],[7999,1]]};

test('offline userdata can only write sorted, disjoint extents inside the exact partition', () => {
  expect(planUserdata(manifest,partition).map(write => write.sector)).toEqual([80000n,87999n]);
  for (const extents of [[[0,1],[8000,1]], [[0,1],[0,1]], [[1,1],[2,1]]]) {
    expect(() => planUserdata({...manifest,extents},partition)).toThrow();
  }
  expect(() => planUserdata({...manifest,blocks:7999},partition)).toThrow();
});

test('an unverified userdata header aborts recovery before the SSH write', async () => {
  const calls = [];
  const firehose = {
    async cmdProgram(lun, start) { calls.push([lun,start]); return true; },
    async cmdReadBuffer() { return new Uint8Array(4096).fill(2); },
  };
  const image = {
    writes: planUserdata(manifest,partition),
    payload: new Blob([new Uint8Array(8192)]),
    accessSector:87999n,
    settings:new Uint8Array(4096),
  };
  await expect(writeUserdata(firehose,partition,image,() => {})).rejects.toThrow('superblock');
  expect(calls).toEqual([[0,80000n],[0,87999n]]);
});

test('turns a WPA2 passphrase into the standard PSK without carrying the passphrase', async () => {
  expect(await wifiProfile({name:'IEEE', password:'password'})).toEqual({
    ssid:[73,69,69,69],
    psk:'f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e',
  });
  expect(validWifi({name:'é'.repeat(17), password:'password'})).toBe(false);
  expect(validWifi({name:'Home', password:'7short'})).toBe(false);
});
