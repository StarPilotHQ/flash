import {browserRef, github} from './github.js';

const SOURCE = 'https://raw.githubusercontent.com/StarPilotHQ/StarPilot';
const HARDWARE = 'openpilot/common/hardware/comma';
const BOOT_CHAIN = ['xbl', 'xbl_config', 'abl', 'aop', 'devcfg'];
const PARTITIONS = [...BOOT_CHAIN, 'boot', 'system'];
const HASH = /^[0-9a-f]{64}$/;
const NEWER_ABL = '29fd7ed1c012e599420764840f9f11286d34dbff4adaf102a447f06d8c5e0b35';
// The shared chain in comma's release-tizi (52b2b626) and release-mici (f7db927c) recovery manifests.
const OFFICIAL_RECOVERY_CHAIN = {
  xbl: 'e8acf2a9cc7f0ce84cb803bfea9477f765c0d7b4daf26048e59651b9e6a7bfbb',
  xbl_config: '758552ecf92b5569677197783bf0ccb73d7f961685308e45d3276ac9dd974f85',
  abl: 'b6fba807b9bcd66a31f2afb0eba5163ec239693ad32e2e4200f6c356adfe098c',
  aop: '78b2287ca219a0811b3004c523fa0f4749e4d1fd92be3aba61699305b7943ad1',
  devcfg: 'f71df3a86958c093ba3969254c4db025187eef9385427f1ade946742939b43cc',
};

export function validBranch(branch) {
  return branch === 'stable' || branch === 'testing';
}

function directUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Image URL must use HTTPS');
  if (url.hostname === 'www.dropbox.com' && url.searchParams.get('dl') === '1') {
    url.hostname = 'dl.dropboxusercontent.com';
  }
  return url.href;
}

export function parseImages(images) {
  if (!Array.isArray(images) || images.length !== PARTITIONS.length) throw new Error('Incomplete AGNOS manifest');
  return PARTITIONS.map(name => {
    const image = images.find(entry => entry?.name === name);
    if (!image || !Number.isSafeInteger(image.size) || image.size <= 0 || image.has_ab !== true ||
        typeof image.sparse !== 'boolean' || ![image.hash, image.hash_raw].every(hash => HASH.test(hash)) ||
        (image.fallback_urls !== undefined && !Array.isArray(image.fallback_urls))) {
      throw new Error('Invalid AGNOS partition: ' + name);
    }
    return {...image, url: directUrl(image.url), fallback_urls: (image.fallback_urls ?? []).map(directUrl)};
  });
}

async function read(url, format, options = {}) {
  const response = await fetch(url, {credentials: 'omit', signal: AbortSignal.timeout(15000), ...options});
  if (!response.ok) throw new Error('Could not load StarPilot release data (HTTP ' + response.status + ')');
  return response[format]();
}

export async function loadRelease(branch) {
  if (!validBranch(branch)) throw new Error('Unknown StarPilot branch');
  const resolved = await browserRef('StarPilotHQ/StarPilot',branch);
  const sha = resolved?.revision ?? (await read('https://api.github.com/repos/StarPilotHQ/StarPilot/commits/' + branch, 'json', {cache:'no-cache'})).sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid StarPilot revision');
  const base = SOURCE + '/' + sha;
  const [env, main, c3] = await Promise.all([
    read(base + '/launch_env.sh', 'text'),
    read(base + '/' + HARDWARE + '/agnos.json', 'json'),
    read(base + '/' + HARDWARE + '/agnos-c3.json', 'json'),
  ]);
  const version = env.match(/^\s*export AGNOS_VERSION=["']?(\d+(?:\.\d+)+)["']?\s*$/m)?.[1];
  if (!version) throw new Error('Could not read the AGNOS version for ' + branch);
  const images = parseImages(main);
  const c3Images = parseImages(c3);
  const abl = list => list.find(image => image.name === 'abl').hash_raw;
  if (abl(c3Images) === NEWER_ABL || abl(c3Images) === abl(images)) {
    throw new Error('AGNOS bootloader manifests do not match the supported hardware families');
  }
  return {version, revision:sha, images, c3Images};
}

export async function loadForkRelease(fork, flash = true) {
  const base = fork.revision + '/';
  const env = await github(fork.repo, base + 'launch_env.sh', 'text');
  const version = env?.match(/^\s*export AGNOS_VERSION=["']?(\d+(?:\.\d+)+)["']?\s*$/m)?.[1];
  if (!flash) return {...fork, version};
  if (!version) throw new Error('This fork does not specify an AGNOS version');
  for (const directory of [HARDWARE, 'openpilot/system/hardware/comma',
    'system/hardware/tici', 'openpilot/system/hardware/tici']) {
    const json = await github(fork.repo, base + directory + '/agnos.json', 'text');
    if (!json || /^[\w/.-]+\.json\s*$/.test(json)) continue;
    const c3 = await github(fork.repo, base + directory + '/agnos-c3.json', 'text');
    const images = parseImages(JSON.parse(json));
    return {...fork, version, images, c3Images:c3 ? parseImages(JSON.parse(c3)) : images};
  }
  throw new Error('No supported AGNOS manifest was found in this fork');
}

export function verifyForkBootChain(images, reference, deviceType) {
  const matches = expected => BOOT_CHAIN.every(name => {
    const hash = images.find(image => image.name === name)?.hash_raw;
    return HASH.test(hash) && hash === expected(name);
  });
  if (matches(name => reference.find(image => image.name === name)?.hash_raw)) return;
  if (['33', '34'].includes(deviceType) && matches(name => OFFICIAL_RECOVERY_CHAIN[name])) return;
  throw new Error('This fork’s bootloader does not match the detected hardware. Nothing was written.');
}
