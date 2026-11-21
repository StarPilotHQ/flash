import {expect, test} from 'bun:test';
import {eraseInstallData, planClean} from './clean.js';

function partition(name,start,sectors) {
  return {name,lun:0,start,sectors,end:start+sectors-1n};
}
const persist = partition('persist',8n,8192n);
const cache = partition('cache',10000n,32768n);
const userData = partition('userdata',80000n,700000n);
const partitions = [persist,cache,userData];

function device(ack = true) {
  const calls = [];
  return {calls,firehose:{
    cfg:{FastErase:true,SECTOR_SIZE_IN_BYTES:4096},
    async cmdErase(...args) {calls.push(args);return ack;},
    async cmdReadBuffer() {return new Uint8Array(4096);},
  }};
}

test('erases cache and userdata within their exact bounds and never touches persist', async () => {
  const target = device();
  await eraseInstallData(target,partitions,() => {});
  expect(target.calls).toEqual([[0,10000n,32768],[0,80000n,524288],[0,604288n,175712]]);
  expect(target.calls.every(([,start,count]) => start > persist.end || start+BigInt(count) <= persist.start)).toBe(true);
});

test('rejects a conflicting userdata range before any erase', async () => {
  const target = device();
  const overlap = partition('userdata',persist.start+1n,10n);
  await expect(eraseInstallData(target,[persist,cache,overlap],() => {})).rejects.toThrow('overlaps');
  expect(target.calls).toEqual([]);
});

test('requires acknowledgement and never substitutes persist for a missing partition', async () => {
  const target = device(false);
  expect(() => planClean([persist,cache],target.firehose)).toThrow('userdata');
  await expect(eraseInstallData(target,partitions,() => {})).rejects.toThrow('rejected');
  expect(target.calls).toEqual([[0,10000n,32768]]);
});
