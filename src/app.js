import { qdlDevice } from '@commaai/qdl';
import { usbClass } from '@commaai/qdl/usblib';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { flashRelease, planFlash } from './flash.js';
import { downloadImage } from './images.js';
import { loadForkRelease, loadRelease, verifyForkBootChain } from './release.js';
import { resolveFork, validRef } from './github.js';
import { stageFork } from './fork.js';
import { imagesForDevice } from './devices.js';
import { eraseInstallData, planClean } from './clean.js';
import { readGpts } from './gpt.js';
import { errorReport } from './diagnostics.js';
import { BundleUnavailable, bundleGeometry, stageUserdata, validUsername, validWifi, writeUserdata } from './userdata.js';

const PROGRAMMER = 'https://raw.githubusercontent.com/commaai/flash/d604aa7490be4bc2bc53da128bd05dd597427cd5/src/QDL/programmer.bin';
const PROGRAMMER_HASH = '5e9d300470a8046c26657277b47ce0fc5de8c1168719b98311aeda0c3ce2e013';
const $ = id => document.getElementById(id);
const supported = Boolean(navigator.usb && navigator.storage?.getDirectory);
const actions = ['flash', 'erase', 'install', 'preload'];
const choices = [...actions, 'branch', 'username', 'wifi', 'wifi-name', 'wifi-password', 'other', 'fork-owner', 'fork-branch'];
let releaseCheck;
let releaseTimer;
let attempt;
let savedErrorLog;

function reportContext() {
  return {startedAt:new Date().toISOString(), build:new URL(import.meta.url).searchParams.get('v'),
    browser:navigator.userAgent, steps:[]};
}

function selectedFork() {
  return $('other').checked ? {owner:$('fork-owner').value.trim(), branch:$('fork-branch').value.trim()} : null;
}

function refreshRelease(delay = 0) {
  clearTimeout(releaseTimer);
  releaseCheck = null;
  const fork = selectedFork();
  if (fork && (!validUsername(fork.owner) || !validRef(fork.branch))) {
    $('version').textContent = '—';
    return;
  }
  const branch = $('branch').value;
  const flash = $('flash').checked;
  $('version').textContent = '…';
  function lookup() {
    const check = fork ? resolveFork(fork.owner,fork.branch).then(target => loadForkRelease(target,flash)) : loadRelease(branch);
    releaseCheck = check;
    check.then(
      release => { if (releaseCheck === check) $('version').textContent = release.version ?? 'unavailable'; },
      () => {
        if (releaseCheck !== check) return;
        releaseCheck = null;
        $('version').textContent = 'unavailable';
      },
    );
  }
  if (delay) releaseTimer = setTimeout(lookup,delay);
  else lookup();
}

function status(message, bytes, total) {
  if (attempt) {
    const step = {message, ...(total ? {completed:bytes, total} : {})};
    if (attempt.steps.at(-1)?.message === message) attempt.steps[attempt.steps.length - 1] = step;
    else {
      attempt.steps.push(step);
      if (attempt.steps.length > 30) attempt.steps.shift();
    }
  }
  if ($('status').textContent !== message) $('status').textContent = message;
  $('progress').hidden = !total;
  if (total) $('progress').value = bytes / total * 100;
}

function error(reason, secrets) {
  savedErrorLog = errorReport(attempt ?? reportContext(), reason, secrets);
  $('download-error-log').hidden = false;
  $('error').textContent = reason?.message ?? String(reason);
  $('error').hidden = false;
  $('progress').hidden = true;
}

function updateControls(busy = false) {
  for (const id of choices) $(id).disabled = !supported || busy;
  const erase = $('erase').checked;
  for (const id of ['install', 'preload', 'wifi']) $(id).disabled ||= !erase;
  const preload = erase && $('preload').checked;
  const savingWifi = erase && $('wifi').checked;
  $('username-row').hidden = !preload;
  $('username').disabled ||= !preload;
  $('wifi-fields').hidden = !savingWifi;
  $('wifi-name').disabled ||= !savingWifi;
  $('wifi-password').disabled ||= !savingWifi;
  const fork = selectedFork();
  const other = Boolean(fork);
  const validFork = other && validUsername(fork.owner) && validRef(fork.branch);
  $('branch').disabled ||= other;
  $('fork-fields').hidden = !other;
  $('fork-owner').disabled ||= !other;
  $('fork-branch').disabled ||= !other;
  $('install-label').textContent = validFork ? `Install ${fork.owner} (${fork.branch})` : other ? 'Install fork' : 'Install StarPilot';
  const needsFork = other && !validFork && ($('flash').checked || (erase && $('install').checked));
  const needsWifi = savingWifi && !validWifi({name: $('wifi-name').value, password: $('wifi-password').value});
  const needsUsername = preload && !validUsername($('username').value.trim());
  $('start').disabled = !supported || busy || needsUsername || needsWifi || needsFork || (!$('flash').checked && !erase);
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
  attempt.usb = {vendorId:usb.device.vendorId, productId:usb.device.productId, phase:'open'};
  await usb.device.open();
  attempt.usb.phase = 'configuration';
  await usb.device.selectConfiguration(1);
  const endpoints = usb.device.configuration.interfaces.find(i => i.interfaceNumber === 0)?.alternate.endpoints ?? [];
  usb.epIn = endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
  usb.epOut = endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
  if (endpoints.length !== 2 || !usb.epIn || !usb.epOut) throw new Error('Unexpected USB recovery interface');
  usb.maxSize = usb.epIn.packetSize;
  Object.assign(attempt.usb,{inputPacketBytes:usb.epIn.packetSize, outputPacketBytes:usb.epOut.packetSize});
  await usb.device.claimInterface(0);
  attempt.usb.phase = 'download programmer';
  status('Checking the device and its storage');
  const response = await fetch(PROGRAMMER, {credentials:'omit'});
  if (!response.ok) throw new Error('Could not download the comma USB programmer');
  const programmer = await response.arrayBuffer();
  if (bytesToHex(sha256(new Uint8Array(programmer))) !== PROGRAMMER_HASH) throw new Error('The USB programmer checksum does not match');
  attempt.usb.phase = 'programmer handshake';
  const device = new qdlDevice(programmer);
  await device.connect(usb);
  Object.assign(attempt.usb, {phase:'connected', sectorBytes:device.firehose.cfg.SECTOR_SIZE_IN_BYTES, luns:device.firehose.luns});
  return device;
}

async function runRecovery(flash, erase, setup, selectedRelease) {
  const usb = new usbClass();
  let root, folder;
  try {
    const device = await connectRecovery(usb);
    const deviceType = String(await device.getDeviceType());
    attempt.deviceType = deviceType;
    if (!['32', '33', '34'].includes(deviceType) || device.firehose.cfg.SECTOR_SIZE_IN_BYTES !== 4096) {
      throw new Error('This device does not support StarPilot recovery');
    }

    const release = await selectedRelease;
    if (release) Object.assign(attempt.release, {agnos:release.version, revision:release.revision});
    const images = flash ? imagesForDevice(release,deviceType) : [];
    if (flash && setup.fork) verifyForkBootChain(images,imagesForDevice(await loadRelease('stable'),deviceType));
    const plan = flash ? await planFlash(device,images,deviceType) : null;
    if (plan) attempt.slots = {active:plan.active, target:plan.target};
    root = await navigator.storage.getDirectory();
    folder = 'recovery-' + crypto.randomUUID();
    const directory = await root.getDirectoryHandle(folder,{create:true});

    let offline, userdata;
    if (erase) {
      const tables = await readGpts(device);
      userdata = planClean(tables.flatMap(table => table.primary.parts),device.firehose).find(part => part.name === 'userdata');
      const blocks = bundleGeometry(userdata.sectors);
      const stage = (variant, fork) => stageUserdata(
        new URL(`./bundles/${variant}/${blocks}/`,location.href),
        userdata,directory,status,setup.username,setup.wifi,blocks,fork,
      );
      if (setup.fork && setup.branch) {
        offline = await stage('other',await stageFork(release,directory,status));
      } else {
        try {
          offline = await stage(setup.branch ? release.revision : 'clean');
        } catch (cause) {
          if (!setup.branch || !(cause instanceof BundleUnavailable)) throw cause;
          const fork = {repo:'StarPilotHQ/StarPilot',branch:setup.branch,revision:release.revision};
          offline = await stage('other',await stageFork(fork,directory,status));
        }
      }
      $('wifi-password').value = '';
    }

    async function replaceUserdata() {
      const tables = await readGpts(device);
      const parts = tables.flatMap(table => table.primary.parts);
      const actual = planClean(parts,device.firehose).find(part => part.name === 'userdata');
      if (actual.lun !== userdata.lun || actual.start !== userdata.start || actual.sectors !== userdata.sectors) {
        throw new Error('Userdata changed before recovery could write it');
      }
      await eraseInstallData(device,parts,status);
      await writeUserdata(device.firehose,userdata,offline,status);
    }

    if (flash) {
      const {quota, usage} = await navigator.storage.estimate();
      const needed = images.reduce((sum,image) => sum+image.size,0);
      if (Number.isFinite(quota) && Number.isFinite(usage) && quota-usage<needed) {
        throw new Error('Free at least 5 GB of browser storage before flashing.');
      }
      await flashRelease(device,images,plan,image => downloadImage(image,directory,status),status,erase ? replaceUserdata : undefined);
    } else {
      await replaceUserdata();
      status('Restarting your comma');
      await device.reset();
    }
    status(setup.branch
      ? `USB writes complete. Your comma installs ${setup.fork ? release.repo + '/' + release.branch : 'StarPilot ' + setup.branch} when AGNOS boots.`
      : 'USB writes complete. Your comma is restarting.');
  } finally {
    if (root && folder) await root.removeEntry(folder,{recursive:true}).catch(() => {});
    if (usb.device?.opened) await usb.device.close().catch(() => {});
  }
}

updateControls();
refreshRelease();
if (!supported) error('Open this page in desktop Chrome or Edge over HTTPS. This browser cannot access USB or local recovery storage.');
for (const id of choices) $(id).addEventListener('change',() => updateControls());
for (const id of ['username', 'wifi-name', 'wifi-password', 'fork-owner', 'fork-branch']) $(id).addEventListener('input',() => updateControls());
for (const id of ['branch', 'other']) $(id).addEventListener('change',() => refreshRelease());
for (const id of ['fork-owner', 'fork-branch']) $(id).addEventListener('input',() => refreshRelease(350));
$('flash').addEventListener('change',() => { if (selectedFork()) refreshRelease(); });
$('download-error-log').addEventListener('click', () => {
  if (!savedErrorLog) return;
  const url = URL.createObjectURL(new Blob([savedErrorLog], {type:'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ground-control-error.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('start').addEventListener('click',async () => {
  const flash = $('flash').checked;
  const erase = $('erase').checked;
  const fork = selectedFork();
  const setup = {
    fork,
    branch: erase && $('install').checked ? fork?.branch ?? $('branch').value : null,
    username: erase && $('preload').checked ? $('username').value.trim().toLowerCase() : null,
    wifi: erase && $('wifi').checked ? {name: $('wifi-name').value, password: $('wifi-password').value} : null,
  };
  if (erase && !confirm('Erase installed software, settings, and recordings stored on userdata? Back up anything you need first.')) return;
  attempt = {...reportContext(),
    operations:{flash, erase, install:Boolean(setup.branch), preloadSsh:Boolean(setup.username), saveWifi:Boolean(setup.wifi)},
    release:{repo:fork ? fork.owner + '/openpilot' : 'StarPilotHQ/StarPilot', branch:fork?.branch ?? $('branch').value},
  };
  savedErrorLog = undefined;
  $('download-error-log').hidden = true;
  updateControls(true);
  $('error').hidden = true;
  addEventListener('beforeunload',guardExit);
  try {
    if ((flash || setup.branch) && !releaseCheck) refreshRelease();
    await runRecovery(flash,erase,setup,flash || setup.branch ? releaseCheck : null);
  } catch (reason) {
    error(reason, [setup.username, setup.wifi?.name, setup.wifi?.password]);
    status('Recovery stopped');
  } finally {
    attempt = undefined;
    removeEventListener('beforeunload',guardExit);
    updateControls();
  }
});
