const ACCOUNT = /^[a-z\d]+(?:-[a-z\d]+)*$/i;
const REPO_PATH = /^([a-z\d-]+)\/([a-z\d_.-]+)$/i;
export const COMMIT = /^[a-f0-9]{40}$/;

export function validAccount(value) {
  return value.length <= 39 && ACCOUNT.test(value);
}

export function validRef(ref) {
  return ref.length <= 160 && /^[a-z\d_][\w./-]*$/i.test(ref) && !ref.includes('..')
    && ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock') && !part.endsWith('.'));
}

export function validRepo(path) {
  const match = path.match(REPO_PATH);
  return match && validAccount(match[1]) && match[2] !== '.' && match[2] !== '..';
}

export function submoduleRepo(parent, value) {
  const address = value.replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^(?:ssh:\/\/git@|git:\/\/)github\.com\//i, 'https://github.com/');
  const url = new URL(address, 'https://github.com/' + parent + '.git/');
  const slug = url.pathname.slice(1).replace(/\.git$/, '');
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !validRepo(slug)) {
    throw new Error('Offline recovery requires public GitHub submodules');
  }
  return slug;
}

export async function github(repo, path, type = 'json') {
  if (!validRepo(repo)) throw new Error('Invalid GitHub repository');
  const root = type === 'json' ? 'https://api.github.com/repos/' : 'https://raw.githubusercontent.com/';
  const response = await fetch(root + repo + (path ? '/' + path : ''), {credentials:'omit', signal:AbortSignal.timeout(15000)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('GitHub could not read ' + repo + ' (HTTP ' + response.status + ')');
  return response[type]();
}

export async function resolveFork(owner, branch) {
  if (!validAccount(owner) || !validRef(branch)) throw new Error('Enter a GitHub username and a branch');
  const info = await github(owner + '/openpilot', '');
  if (!info || info.private || !validRepo(info.full_name)) throw new Error('Public GitHub repository not found at ' + owner + '/openpilot');
  const ref = await github(info.full_name, 'git/ref/heads/' + branch.split('/').map(encodeURIComponent).join('/'));
  const revision = ref?.object?.sha;
  if (!COMMIT.test(revision ?? '') || ref.ref !== 'refs/heads/' + branch) throw new Error('Branch not found in ' + info.full_name);
  return {repo:info.full_name, branch, revision};
}

export function packRequest(revision) {
  if (!COMMIT.test(revision)) throw new Error('Invalid Git revision');
  const packet = value => (value.length + 4).toString(16).padStart(4,'0') + value;
  return packet('want ' + revision + ' ofs-delta\n') + packet('deepen 1\n') + '0000' + packet('done\n');
}
