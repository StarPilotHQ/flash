import { qdlDevice } from '@commaai/qdl';
import { usbClass } from '@commaai/qdl/usblib';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { flashRelease, planFlash } from './flash.js';
import { downloadImage } from './images.js';
import { loadRelease } from './release.js';
import { imagesForDevice } from './devices.js';
import { eraseInstallData, planClean } from './clean.js';
import { readGpts } from './gpt.js';
import { finishSetup, validUsername } from './install.js';

const PROGRAMMER = 'https://raw.githubusercontent.com/commaai/flash/d604aa7490be4bc2bc53da128bd05dd597427cd5/src/QDL/programmer.bin';
const PROGRAMMER_HASH = '5e9d300470a8046c26657277b47ce0fc5de8c1168719b98311aeda0c3ce2e013';
const $ = id => document.getElementById(id);
const supported = Boolean(navigator.usb && navigator.storage?.getDirectory);
const actions = ['flash', 'erase', 'install', 'preload'];
const choices = [...actions, 'branch', 'username'];
let pendingSetup = null;
let releaseCheck;

function refreshRelease() {
  const branch = $('branch').value;
  const check = loadRelease(branch);
  releaseCheck = check;
  $('version').textContent = '…';
  check.then(
    release => { if (releaseCheck === check) $('version').textContent = release.version; },
    () => { if (releaseCheck === check) $('version').textContent = 'unavailable'; },
  );
}

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

function updateControls(busy = false) {
  for (const id of choices) $(id).disabled = !supported || busy || Boolean(pendingSetup);
  $('username-row').hidden = !$('preload').checked;
  $('username').disabled = !supported || busy || !$('preload').checked;
  const needsUsername = $('preload').checked && !validUsername($('username').value.trim());
  $('start').disabled = !supported || busy || needsUsername || (!pendingSetup && !actions.some(id => $(id).checked));
  $('start').textContent = pendingSetup ? 'Continue recovery' : 'Start recovery';
}

function guardExit(event) {
  event.preventDefault();
  event.returnValue = '';
}

async function connectRecovery(usb) {
  status('Select your comma in the USB prompt');
  const filters = [0x05c6, 0x3801].map(vendorId => ({vendorId, productId:0x9008}));
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
  const response = await fetch(PROGRAMMER, {credentials:'omit'});
  if (!response.ok) throw new Error('Could not download the comma USB programmer');
  const programmer = await response.arrayBuffer();
  if (bytesToHex(sha256(new Uint8Array(programmer))) !== PROGRAMMER_HASH) throw new Error('The USB programmer checksum does not match');
  const device = new qdlDevice(programmer);
  await device.connect(usb);
  return device;
}

async function completeSetup({branch, username}) {
  try {
    await finishSetup(branch,username,status);
  } catch (reason) {
    if (branch && !username) {
      $('installer-link').textContent = 'starpilothq/' + branch;
      $('manual').hidden = false;
    }
    throw reason;
  }
  pendingSetup = null;
  $('after').hidden = true;
  status([
    username && 'SSH keys saved for ' + username + '.',
    branch && 'StarPilot ' + branch + ' installer started. Follow progress on your comma.',
  ].filter(Boolean).join(' '));
}

async function runRecovery(flash, erase, setup) {
  const usb = new usbClass();
  let root, folder;
  try {
    const device = await connectRecovery(usb);
    const deviceType = String(await device.getDeviceType());
    if (!['32', '33', '34'].includes(deviceType) || device.firehose.cfg.SECTOR_SIZE_IN_BYTES !== 4096) {
      throw new Error('This device does not support StarPilot recovery');
    }
    async function eraseSelected() {
      const tables = await readGpts(device);
      await eraseInstallData(device,tables.flatMap(table => table.primary.parts),status);
    }
    if (erase) {
      const tables = await readGpts(device);
      planClean(tables.flatMap(table => table.primary.parts),device.firehose);
    }
    if (flash) {
      status('Checking AGNOS for StarPilot ' + $('branch').value);
      const release = await releaseCheck;
      const images = imagesForDevice(release,deviceType);
      const plan = await planFlash(device,images,deviceType);
      root = await navigator.storage.getDirectory();
      const {quota, usage} = await navigator.storage.estimate();
      const needed = images.reduce((sum,image) => sum+image.size,0);
      if (Number.isFinite(quota) && Number.isFinite(usage) && quota-usage<needed) {
        throw new Error('Free at least 5 GB of browser storage before flashing.');
      }
      folder = 'recovery-' + crypto.randomUUID();
      const directory = await root.getDirectoryHandle(folder,{create:true});
      await flashRelease(device,images,plan,image => downloadImage(image,directory,status),status,erase ? eraseSelected : undefined);
    } else {
      await eraseSelected();
      status('Restarting your comma');
      await device.reset();
    }
    pendingSetup = setup.branch || setup.username ? setup : null;
    $('after').hidden = false;
    $('clean-next').hidden = !erase;
    $('setup-next').hidden = !pendingSetup;
    status(erase ? 'Old data and cache erased. The device is restarting.' : 'Verified AGNOS was written. The device is restarting.');
  } finally {
    if (root && folder) await root.removeEntry(folder,{recursive:true}).catch(() => {});
    if (usb.device?.opened) await usb.device.close().catch(() => {});
  }
}

updateControls();
refreshRelease();
if (!supported) error('Open this page in desktop Chrome or Edge over HTTPS. This browser cannot access USB or local recovery storage.');
for (const id of choices) $(id).addEventListener('change',() => updateControls());
$('username').addEventListener('input',() => updateControls());
$('branch').addEventListener('change',refreshRelease);

$('start').addEventListener('click',async () => {
  const flash = !pendingSetup && $('flash').checked;
  const erase = !pendingSetup && $('erase').checked;
  const setup = {
    branch: pendingSetup?.branch ?? ($('install').checked ? $('branch').value : null),
    username: $('preload').checked ? $('username').value.trim().toLowerCase() : null,
  };
  if (erase && !confirm('Erase installed software, settings, and caches on your comma? System Reset can also erase recordings. Back up anything you need first.')) return;
  updateControls(true);
  $('error').hidden = $('manual').hidden = true;
  addEventListener('beforeunload',guardExit);
  try {
    if (flash) refreshRelease();
    if (flash || erase) await runRecovery(flash,erase,setup);
    else await completeSetup(setup);
  } catch (reason) {
    status(flash || erase ? 'Recovery stopped' : 'Could not finish setup over USB');
    error(reason);
  } finally {
    removeEventListener('beforeunload',guardExit);
    updateControls();
  }
});
