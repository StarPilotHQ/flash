const SOURCE = 'https://raw.githubusercontent.com/StarPilotHQ/StarPilot';
const HARDWARE = 'openpilot/common/hardware/comma';
const PARTITIONS = ['xbl', 'xbl_config', 'abl', 'aop', 'devcfg', 'boot', 'system'];
const HASH = /^[0-9a-f]{64}$/;
const NEWER_ABL = '29fd7ed1c012e599420764840f9f11286d34dbff4adaf102a447f06d8c5e0b35';

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
  const {sha} = await read('https://api.github.com/repos/StarPilotHQ/StarPilot/commits/' + branch, 'json', {cache:'no-cache'});
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
  return {version, images, c3Images};
}
