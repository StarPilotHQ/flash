import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex } from '@noble/hashes/utils';
import { COMMIT, github, submoduleRepo } from './github.js';

const CAPACITY = 1024 ** 3;

export function moduleUrls(source) {
  const entries = new Map();
  for (const section of source.split(/^\s*\[/m).slice(1)) {
    if (!/^submodule\s+"/.test(section)) continue;
    const values = {};
    for (const line of section.split('\n').slice(1)) {
      const match = line.match(/^\s*(path|url)\s*=\s*(.+?)\s*$/i);
      if (!match) continue;
      const value = match[2].trim();
      values[match[1].toLowerCase()] = value.startsWith('"')
        ? JSON.parse(value.match(/^"(?:[^"\\]|\\.)*"/)?.[0] ?? 'null')
        : value.replace(/\s+[;#].*$/, '');
    }
    if (values.path && values.url) entries.set(values.path,values.url);
  }
  return entries;
}

export async function discoverRepos(root) {
  const repos = [];
  async function collect(repo, revision, path, ancestry = []) {
    if (!COMMIT.test(revision) || repos.length >= 24 || ancestry.length >= 5 || ancestry.includes(repo + '@' + revision)) {
      throw new Error('Unsupported fork submodule layout');
    }
    repos.push({repo, revision, path});
    const tree = await github(repo, 'git/trees/' + revision + '?recursive=1');
    if (!tree || tree.truncated || !Array.isArray(tree.tree)) throw new Error('Could not read the complete Git tree for ' + repo);
    if (!path && !tree.tree.some(entry => entry.path === 'launch_openpilot.sh' && entry.mode === '100755')) {
      throw new Error('This branch does not contain an executable openpilot launcher');
    }
    const links = tree.tree.filter(entry => entry.mode === '160000' && entry.type === 'commit');
    if (!links.length) return;
    const modules = moduleUrls(await github(repo, revision + '/.gitmodules', 'text') ?? '');
    for (const entry of links) {
      if (entry.path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) {
        throw new Error('Invalid Git submodule path');
      }
      const url = modules.get(entry.path);
      if (!url) throw new Error('Could not resolve submodule ' + entry.path);
      await collect(submoduleRepo(repo,url), entry.sha, path ? path + '/' + entry.path : entry.path, [...ancestry,repo + '@' + revision]);
    }
  }
  await collect(root.repo,root.revision,'');
  return repos;
}

function packetPrefix(bytes) {
  let index = 0;
  const decoder = new TextDecoder();
  while (index + 4 <= bytes.length) {
    const header = decoder.decode(bytes.subarray(index,index+4));
    if (header === 'PACK') return index;
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error('GitHub did not return a Git pack');
    const length = Number.parseInt(header,16);
    if (length !== 0 && length < 4) throw new Error('Invalid Git pack header');
    if (length && index + length > bytes.length) break;
    if (decoder.decode(bytes.subarray(index+4,index+Math.max(4,length))).startsWith('ERR ')) {
      throw new Error('GitHub could not provide the pinned Git revision');
    }
    index += Math.max(4,length);
  }
  if (bytes.length > 65536) throw new Error('Git pack metadata exceeds the recovery limit');
  return -1;
}

function joinBytes(left,right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right,left.length);
  return output;
}

export async function copyGitPack(source, writer, max, progress = () => {}) {
  let prefix = new Uint8Array();
  let tail = new Uint8Array();
  let size = 0;
  const hash = sha1.create();
  let started = false;
  for await (let chunk of source) {
    if (!started) {
      prefix = joinBytes(prefix,chunk);
      const index = packetPrefix(prefix);
      if (index < 0) continue;
      chunk = prefix.subarray(index);
      prefix = new Uint8Array();
      started = true;
    }
    size += chunk.length;
    if (size > max) throw new Error('The fork and its submodules exceed 1 GiB of offline Git data');
    const checksummed = joinBytes(tail,chunk);
    const cut = Math.max(0,checksummed.length - 20);
    hash.update(checksummed.subarray(0,cut));
    tail = checksummed.subarray(cut);
    await writer.write(chunk);
    progress(size);
  }
  if (size < 32 || bytesToHex(hash.digest()) !== bytesToHex(tail)) throw new Error('Git pack checksum mismatch');
  return size;
}

export async function stageFork(fork, directory, status) {
  status('Reading ' + fork.repo + ' and its pinned submodules');
  const repos = await discoverRepos(fork);
  const packs = [];
  let remaining = CAPACITY - 65548;
  for (const [i, entry] of repos.entries()) {
    const response = await fetch('/fork-pack/' + entry.repo + '/' + entry.revision, {credentials:'omit'});
    if (!response.ok || !response.body) throw new Error('Could not download Git objects for ' + entry.repo);
    const file = await directory.getFileHandle('git-pack-' + i,{create:true});
    const writer = await file.createWritable();
    try {
      entry.size = await copyGitPack(response.body,writer,remaining,bytes => {
        status('Downloading ' + entry.repo + ' (' + Math.floor(bytes / 1048576) + ' MB)');
      });
      await writer.close();
    } catch (cause) {
      await writer.abort().catch(() => {});
      throw cause;
    }
    const stored = await file.getFile();
    if (stored.size !== entry.size) throw new Error('Incomplete local Git pack for ' + entry.repo);
    packs.push(stored);
    remaining -= entry.size;
  }
  const metadata = new TextEncoder().encode(JSON.stringify({branch:fork.branch,repos}));
  if (metadata.length > 65536) throw new Error('Fork recovery manifest exceeds 64 KiB');
  const size = new DataView(new ArrayBuffer(4));
  size.setUint32(0,metadata.length,true);
  const payload = new Blob(['SPFORK01',size.buffer,metadata,...packs]);
  if (payload.size !== 12 + metadata.length + repos.reduce((total,entry) => total+entry.size,0)) {
    throw new Error('Could not assemble the fork installer');
  }
  return payload;
}
