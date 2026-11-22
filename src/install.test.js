import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installerCommand } from './install.js';

test('rejects an unknown app channel', () => {
  expect(() => installerCommand('stable; reboot')).toThrow('Unknown');
  expect(() => installerCommand(null, 'someone; reboot')).toThrow('Invalid');
});

test('queues the matching installer atomically and preserves an existing app', async () => {
  const root = await mkdtemp(tmpdir()+'/starpilot-recovery-');
  try {
    for (const dir of ['data/params/d','tmp','tools']) await mkdir(root+'/'+dir,{recursive:true});
    const params = root+'/data/params/d';
    const keygen = spawnSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',root+'/key']);
    expect(keygen.status).toBe(0);
    const key = (await readFile(root+'/key.pub','utf8')).split(' ').slice(0,2).join(' ')+'\n';
    await writeFile(root+'/setup_keys','built-in setup key');
    await writeFile(root+'/tools/ln',`#!/bin/bash
test "$(cat "${params}/GithubUsername")" = example-user || exit 1
test "$(cat "${params}/SshEnabled")" = 1 || exit 1
cmp "${params}/GithubSshKeys" "${root}/key-fixture" || exit 1
exec /bin/ln "$@"
`);
    await chmod(root+'/tools/ln',0o755);
    await writeFile(root+'/AGNOS','');
    await writeFile(root+'/VERSION','20.5.3\n');
    await writeFile(root+'/model','comma mici\0');
    for (const name of ['mountpoint','pgrep','flock']) {
      await writeFile(root+'/tools/'+name,'#!/bin/bash\nexit 0\n');
      await chmod(root+'/tools/'+name,0o755);
    }
    const elf = new Uint8Array(24);
    elf.set([0x7f,69,76,70,2,1]);
    elf.set([0xb7,0],18);
    for (const branch of ['stable','testing']) {
      const good = new Blob([elf,'https://github.com/starpilothq/openpilot.git? '+branch+'?     ']);
      await writeFile(root+'/fixture',new Uint8Array(await good.arrayBuffer()));
      await writeFile(params+'/GithubSshKeys','built-in setup key');
      await writeFile(params+'/AdbEnabled','1');
      await writeFile(root+'/key-fixture','command="unexpected" ssh-ed25519 bad\n');
      await writeFile(root+'/tools/curl',[
        '#!/bin/bash',
        'case "$*" in',
        '*installer.comma.ai/starpilothq/'+branch+'*) cp "'+root+'/fixture" "$'+'{@: -1}" ;;',
        '*github.com/example-user.keys*) cp "'+root+'/key-fixture" "$'+'{@: -1}" ;;',
        '*) exit 1 ;;',
        'esac',
      ].join('\n')+'\n');
      await chmod(root+'/tools/curl',0o755);
      const script = installerCommand(branch,'example-user')
        .replaceAll('/AGNOS',root+'/AGNOS').replaceAll('/VERSION',root+'/VERSION')
        .replaceAll('/tmp/',root+'/tmp/').replaceAll('/data',root+'/data')
        .replaceAll('/sys/firmware/devicetree/base/model',root+'/model')
        .replaceAll('/usr/comma/setup_keys',root+'/setup_keys')
        .replaceAll('sleep 5','sleep 0');
      const run = () => spawnSync('/bin/bash',['-c',script],
        {encoding:'utf8',env:{...process.env,PATH:root+'/tools:'+process.env.PATH}});
      expect(run().stderr).toContain('no usable SSH public keys');
      expect(await readFile(params+'/GithubSshKeys','utf8')).toBe('built-in setup key');
      expect(await readFile(params+'/AdbEnabled','utf8')).toBe('1');
      expect(await Bun.file(root+'/tmp/installer').exists()).toBe(false);
      await writeFile(root+'/key-fixture',key);
      const first = run();
      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('STARPILOT_SETUP_READY');
      expect(await readFile(root+'/tmp/installer')).toEqual(await readFile(root+'/fixture'));
      expect(await readFile(params+'/GithubSshKeys','utf8')).toBe(key);
      for (let i = 0; i < 20 && await readFile(params+'/AdbEnabled','utf8') !== '0'; i++) await Bun.sleep(25);
      expect(await readFile(params+'/AdbEnabled','utf8')).toBe('0');
      expect(run().stderr).toContain('installer queued');
      await rm(root+'/tmp/installer');
      await writeFile(root+'/data/continue.sh','existing');
      expect(run().stderr).toContain('already installed');
      await rm(root+'/data/continue.sh');
    }
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
