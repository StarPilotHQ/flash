import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';

import { validBranch } from './release.js';

function quote(s) {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

export function validUsername(username) {
  return username.length <= 39 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(username);
}

function preloadCommand(username) {
  return `
params=/data/params/d
test -d "$params" || die 'Wait for AGNOS to finish setting up SSH.'
current="$params/GithubSshKeys"
if cmp -s "$current" /usr/comma/setup_keys; then
  setup_adb=1
elif [ -e "$current" ] && [ "$(cat "$params/GithubUsername" 2>/dev/null || true)" != '${username}' ]; then
  die 'SSH keys are already configured for a different GitHub account.'
fi
key_file=$(mktemp /tmp/starpilot-ssh.XXXXXX)
curl --fail --silent --show-error --proto '=https' --connect-timeout 10 --max-time 20 --max-filesize 65536 'https://github.com/${username}.keys' -o "$key_file" || die 'Could not fetch GitHub keys. Check the username and Wi-Fi.'
python3 - "$key_file" "$params" '${username}' <<'PY'
from pathlib import Path
import os
import subprocess
import sys
import tempfile

source, params = map(Path, sys.argv[1:3])
try:
    keys = []
    for line in source.read_text(encoding='ascii').splitlines():
        if not line.strip():
            continue
        kind, encoded, *_ = line.split()
        if not kind.startswith(('ssh-', 'ecdsa-', 'sk-')):
            raise ValueError()
        key = f'{kind} {encoded}\\n'
        if subprocess.run(['ssh-keygen', '-lf', '/dev/stdin'], input=key, text=True, capture_output=True).returncode:
            raise ValueError()
        keys.append(key)
    if not keys:
        raise ValueError()
except ValueError:
    sys.exit('GitHub returned no usable SSH public keys.')

for name, value in (('GithubSshKeys', ''.join(dict.fromkeys(keys))), ('GithubUsername', sys.argv[3]), ('SshEnabled', '1')):
    with tempfile.NamedTemporaryFile(mode='w', dir=params.parent, delete=False) as temp:
        temp.write(value)
        temp.flush()
        os.fsync(temp.fileno())
    try:
        os.replace(temp.name, params / name)
    finally:
        Path(temp.name).unlink(missing_ok=True)
PY
`;
}

export function installerCommand(branch, username = null) {
  if (branch !== null && !validBranch(branch)) throw new Error('Unknown StarPilot branch');
  if (username !== null && !validUsername(username)) throw new Error('Invalid GitHub username');
  if (!branch && !username) throw new Error('Select a setup operation');
  const script = `
set -eu
die() { printf '%s\\n' "$1" >&2; exit 1; }
test -f /AGNOS && mountpoint -q /data || die 'Boot AGNOS and complete System Reset first.'
test ! -e /data/continue.sh && test ! -e /data/openpilot || die 'An app is already installed. Start from clean AGNOS setup to use these USB options.'
model=$(tr -d '\\000' < /sys/firmware/devicetree/base/model)
case "$model" in
  'comma tici'|'comma tizi'|'comma mici') model=\${model#comma } ;;
  *) die 'This device is not supported by the StarPilot installer.' ;;
esac
version=$(cat /VERSION)
exec 9>/tmp/starpilot-recovery-install.lock
flock -n 9 || die 'Another installation is in progress.'
test ! -e /tmp/installer || die 'AGNOS already has an installer queued.'
pgrep -f '(^|[[:space:]])/usr/comma/setup([[:space:]]|$)' >/dev/null || die 'Wait for AGNOS to show the setup screen.'
file=
key_file=
setup_adb=
trap 'rm -f -- "$file" "$key_file"' EXIT
${branch ? `
file=$(mktemp /tmp/starpilot-installer.XXXXXX)
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \\
  --connect-timeout 10 --max-time 60 -A "AGNOSSetup-$version" -H "X-openpilot-device-type: $model" \\
  'https://installer.comma.ai/starpilothq/${branch}' -o "$file" || die 'Connect the comma to Wi-Fi and try again.'
python3 - "$file" <<'PY'
from pathlib import Path
import sys
image = Path(sys.argv[1]).read_bytes()
assert image.startswith(b"\\x7fELF\\x02\\x01") and image[18:20] == b"\\xb7\\x00", "Wrong installer architecture"
assert b"https://github.com/starpilothq/openpilot.git?" in image, "Wrong installer repository"
assert b"${branch}?     " in image, "Wrong installer branch"
PY
chmod 755 "$file"
` : ''}
test ! -e /data/continue.sh && test ! -e /data/openpilot && test ! -e /tmp/installer || die 'Another app installation started.'
${username ? preloadCommand(username) : ''}
${branch ? `ln "$file" /tmp/installer || die 'AGNOS already has an installer queued.'` : ''}
# Replacing the built-in keys bypasses AGNOS's regular setup ADB cleanup.
if [ "$setup_adb" = 1 ]; then
  nohup bash -c 'sleep 5; p=/data/params/d/AdbEnabled; if [ -f "$p" ] && [ "$(cat "$p")" = 1 ]; then printf 0 > "$p"; fi' 9>&- </dev/null >/dev/null 2>&1 &
fi
printf 'STARPILOT_SETUP_READY\\n'
`;
  const argument = quote(script);
  return `if [ "$(id -u)" = 0 ]; then exec runuser -u comma -- bash -c ${argument}; else exec bash -c ${argument}; fi`;
}

export async function finishSetup(branch, username, status) {
  const command = installerCommand(branch, username);
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) throw new Error('USB app install requires desktop Chrome or Edge.');
  const options = {filters:[{vendorId:0x04d8, productId:0x1234, classCode:0xff, subclassCode:0x42, protocolCode:1}]};
  const permitted = await manager.getDevices(options);
  const selected = permitted.length === 1 ? permitted[0] : await manager.requestDevice(options);
  if (!selected) throw new Error('Select the comma in AGNOS setup mode.');
  status('Connecting to AGNOS setup over USB');
  const connection = await selected.connect();
  let adb;
  try {
    const transport = await AdbDaemonTransport.authenticate({serial:selected.serial,connection,
      credentialStore:new AdbWebCredentialStore('StarPilot Recovery')});
    adb = new Adb(transport);
    status(username ? 'Preparing GitHub SSH keys on your comma' : `Preparing the StarPilot ${branch} installer`);
    const shell = adb.subprocess.shellProtocol;
    if (!shell) throw new Error('This AGNOS version does not support the USB installer.');
    const result = await shell.spawnWaitText(command);
    if (result.exitCode !== 0 || !result.stdout.includes('STARPILOT_SETUP_READY')) {
      throw new Error(result.stderr.trim() || 'AGNOS could not finish the selected setup options.');
    }
  } finally {
    if (adb) await adb.close().catch(() => {});
    else {
      await connection.readable.cancel().catch(() => {});
      await connection.writable.abort().catch(() => {});
    }
  }
}
