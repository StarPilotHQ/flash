import { qdlDevice } from '@commaai/qdl';
import { usbClass } from '@commaai/qdl/usblib';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { flashRelease, planFlash } from './flash.js';
import { downloadImage } from './images.js';
import release from './release.json';
import { imagesForDevice } from './devices.js';
import { eraseInstallData } from './clean.js';
import { readGpts } from './gpt.js';
import { installBranch } from './install.js';

const PROGRAMMER = 'https://raw.githubusercontent.com/commaai/flash/d604aa7490be4bc2bc53da128bd05dd597427cd5/src/QDL/programmer.bin';
const PROGRAMMER_HASH = '5e9d300470a8046c26657277b47ce0fc5de8c1168719b98311aeda0c3ce2e013';
const $ = id => document.getElementById(id);
let device;
let plan;
let images;
let recoveryReady = false;
const actions = ['connect','flash','erase','stable','testing'];
$('version').textContent = release.version;

function status(message, bytes, total) {
  if ($('status').textContent !== message) $('status').textContent = message;
  $('progress').hidden = !total;
  if (total) $('progress').value = bytes / total * 100;
}

function error(reason) {
  $('error').textContent = reason?.message ?? String(reason);
  $('error').hidden = false;
  $('progress').hidden = true;
}

if (!navigator.usb || !navigator.storage?.getDirectory) {
  for (const id of actions) $(id).disabled = true;
  error('Open this page in desktop Chrome or Edge over HTTPS. This browser cannot access USB or local recovery storage.');
}

$('connect').addEventListener('click', async () => {
  $('error').hidden = true;
  busy(true);
  const usb = new usbClass();
  try {
    status('Select your comma in the USB prompt');
    const filters = [0x05c6, 0x3801].map(vendorId => ({vendorId, productId: 0x9008}));
    const allowed = (await navigator.usb.getDevices()).filter(d =>
      filters.some(f => f.vendorId === d.vendorId && f.productId === d.productId));
    usb.device = allowed.length === 1 ? allowed[0] : await navigator.usb.requestDevice({filters});
    await usb.device.open();
    await usb.device.selectConfiguration(1);
    const endpoints = usb.device.configuration.interfaces.find(i => i.interfaceNumber === 0)?.alternate.endpoints ?? [];
    usb.epIn = endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
    usb.epOut = endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
    if (endpoints.length !== 2 || !usb.epIn || !usb.epOut) throw new Error('Unexpected USB recovery interface');
    usb.maxSize = usb.epIn.packetSize;
    await usb.device.claimInterface(0);
    status('Checking the device and its storage');
    const response = await fetch(PROGRAMMER, {credentials: 'omit'});
    if (!response.ok) throw new Error('Could not download the comma USB programmer');
    const programmer = await response.arrayBuffer();
    if (bytesToHex(sha256(new Uint8Array(programmer))) !== PROGRAMMER_HASH) throw new Error('The USB programmer checksum does not match');
    device = new qdlDevice(programmer);
    await device.connect(usb);
    const deviceType = String(await device.getDeviceType());
    images = imagesForDevice(release, deviceType);
    plan = await planFlash(device, images, deviceType);
    $('slots').textContent = `Slot ${plan.target.toUpperCase()} will receive AGNOS ${release.version}. Slot ${plan.active.toUpperCase()} stays active until verification finishes.`;
    $('slots').hidden = false;
    recoveryReady = true;
    $('flash').disabled = $('erase').disabled = false;
    status('Device verified. Ready to flash.');
  } catch (reason) {
    if (usb.device?.opened) await usb.device.close().catch(() => {});
    status('USB connection could not be verified');
    error(reason);
  } finally {
    busy(false);
  }
});

function guardExit(event) {
  event.preventDefault();
  event.returnValue = '';
}

function busy(value) {
  for (const id of actions) $(id).disabled = value;
  if (!value) {
    $('connect').disabled = recoveryReady;
    $('flash').disabled = $('erase').disabled = !recoveryReady;
  }
}

async function recover(erase) {
  if (erase && !confirm('Erase installed software, settings, and caches on your comma? The following System Reset can also erase recordings. Back up anything you need first.')) return;
  addEventListener('beforeunload',guardExit);
  busy(true);
  $('error').hidden = true;
  $('manual').hidden = true;
  let root, folder;
  try {
    if (erase) {
      const tables = await readGpts(device);
      await eraseInstallData(device,tables.flatMap(table => table.primary.parts),status);
      status('Restarting your comma');
      await device.reset();
      status('Old data and cache erased. The device is restarting.');
    } else {
      root = await navigator.storage.getDirectory();
      const {quota, usage} = await navigator.storage.estimate();
      const needed = images.reduce((sum,image) => sum+image.size,0);
      if (Number.isFinite(quota) && Number.isFinite(usage) && quota-usage<needed) {
        throw new Error('Free at least 5 GB of browser storage before flashing.');
      }
      folder = `recovery-${crypto.randomUUID()}`;
      const directory = await root.getDirectoryHandle(folder,{create:true});
      await flashRelease(device,images,plan,image => downloadImage(image,directory,status),status);
      status('Verified AGNOS was written. The device is restarting.');
    }
    $('after').hidden = false;
    $('clean-next').hidden = !erase;
  } catch (reason) {
    error(reason);
    status('Recovery stopped. Reconnect the device before trying again.');
    if (device?.firehose.cdc.device?.opened) await device.firehose.cdc.device.close().catch(() => {});
  } finally {
    if (root && folder) await root.removeEntry(folder,{recursive:true}).catch(() => {});
    recoveryReady = false;
    $('slots').hidden = true;
    busy(false);
    removeEventListener('beforeunload',guardExit);
  }
}

$('flash').addEventListener('click', () => recover(false));
$('erase').addEventListener('click', () => recover(true));
for (const branch of ['stable','testing']) {
  $(branch).addEventListener('click',async () => {
    busy(true);
    $('error').hidden = true;
    $('manual').hidden = true;
    try {
      await installBranch(branch,status);
      status(`StarPilot ${branch} installer started. Follow progress on your comma.`);
    } catch (reason) {
      error(reason);
      status('Could not start the installer over USB');
      $('installer-link').textContent = `starpilothq/${branch}`;
      $('manual').hidden = false;
    } finally {
      busy(false);
    }
  });
}
