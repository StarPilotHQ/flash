import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';

function quote(s) {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

export function installerCommand(branch) {
  if (branch !== 'stable' && branch !== 'testing') throw new Error('Unknown StarPilot branch');
  const script = `
set -eu
die() { printf '%s\\n' "$1" >&2; exit 1; }
test -f /AGNOS && mountpoint -q /data || die 'Boot AGNOS and complete System Reset first.'
test ! -e /data/continue.sh && test ! -e /data/openpilot || die 'An app is already installed. Use Delete Old Data before a clean install.'
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
file=$(mktemp /tmp/starpilot-installer.XXXXXX)
trap 'rm -f -- "$file"' EXIT
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
test ! -e /data/continue.sh && test ! -e /data/openpilot || die 'Another app installation started.'
ln "$file" /tmp/installer || die 'AGNOS already has an installer queued.'
printf 'STARPILOT_INSTALL_QUEUED\\n'
`;
  const argument = quote(script);
  return `if [ "$(id -u)" = 0 ]; then exec runuser -u comma -- bash -c ${argument}; else exec bash -c ${argument}; fi`;
}

export async function installBranch(branch, status) {
  const command = installerCommand(branch);
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
    status(`Preparing the StarPilot ${branch} installer`);
    const shell = adb.subprocess.shellProtocol;
    if (!shell) throw new Error('This AGNOS version does not support the USB installer.');
    const result = await shell.spawnWaitText(command);
    if (result.exitCode !== 0 || !result.stdout.includes('STARPILOT_INSTALL_QUEUED')) {
      throw new Error(result.stderr.trim() || 'AGNOS could not start the installer.');
    }
  } finally {
    if (adb) await adb.close().catch(() => {});
    else {
      await connection.readable.cancel().catch(() => {});
      await connection.writable.abort().catch(() => {});
    }
  }
}
