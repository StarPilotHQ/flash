import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installerCommand } from './install.js';

test('rejects an unknown app channel', () => {
  expect(() => installerCommand('stable; reboot')).toThrow('Unknown');
});

test('queues the matching installer atomically and preserves an existing app', async () => {
  const root = await mkdtemp(tmpdir()+'/starpilot-recovery-');
  try {
    for (const dir of ['data','tmp','tools']) await mkdir(root+'/'+dir);
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
      await writeFile(root+'/tools/curl',[
        '#!/bin/bash',
        'case "$*" in',
        '*installer.comma.ai/starpilothq/'+branch+'*) cp "'+root+'/fixture" "$'+'{@: -1}" ;;',
        '*) exit 1 ;;',
        'esac',
      ].join('\n')+'\n');
      await chmod(root+'/tools/curl',0o755);
      const script = installerCommand(branch)
        .replaceAll('/AGNOS',root+'/AGNOS').replaceAll('/VERSION',root+'/VERSION')
        .replaceAll('/tmp/',root+'/tmp/').replaceAll('/data',root+'/data')
        .replaceAll('/sys/firmware/devicetree/base/model',root+'/model');
      const run = () => spawnSync('/bin/bash',['-c',script],
        {encoding:'utf8',env:{...process.env,PATH:root+'/tools:'+process.env.PATH}});
      const first = run();
      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('STARPILOT_INSTALL_QUEUED');
      expect(await readFile(root+'/tmp/installer')).toEqual(await readFile(root+'/fixture'));
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
