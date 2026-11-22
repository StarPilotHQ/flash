import { expect, spyOn, test } from 'bun:test';
import { loadRelease } from './release.js';

test('uses one live revision for each branch and preserves its mirror order', async () => {
  const stable = '1'.repeat(40);
  const testing = '2'.repeat(40);
  const names = ['xbl','xbl_config','abl','aop','devcfg','boot','system'];
  let sameBootloader = false;
  const fetchMock = spyOn(globalThis,'fetch').mockImplementation(async url => {
    if (url.endsWith('/commits/stable')) return Response.json({sha:stable});
    if (url.endsWith('/commits/testing')) return Response.json({sha:testing});
    const revision = new URL(url).pathname.split('/')[3];
    expect([stable,testing]).toContain(revision);
    if (url.endsWith('/launch_env.sh')) {
      return new Response('  export AGNOS_VERSION="'+(revision === stable ? '20.5.3' : '20.6.1')+'"\n');
    }
    const family = !sameBootloader && url.endsWith('/agnos-c3.json') ? 'a' : 'b';
    return Response.json(names.map(name => ({
      name, size:4096, has_ab:true, sparse:false,
      hash:family.repeat(64), hash_raw:family.repeat(64),
      url:`https://www.dropbox.com/scl/fi/${revision}/${name}.img.xz?dl=1`,
      fallback_urls:['https://files.firestar.link/image','https://files-east.firestar.link/image'],
    })));
  });
  try {
    expect((await loadRelease('stable')).version).toBe('20.5.3');
    const release = await loadRelease('testing');
    expect(release.version).toBe('20.6.1');
    expect(release.images[5].url).toBe(`https://dl.dropboxusercontent.com/scl/fi/${testing}/boot.img.xz?dl=1`);
    expect(release.images[5].fallback_urls).toEqual(['https://files.firestar.link/image','https://files-east.firestar.link/image']);
    expect(release.c3Images[2].hash_raw).not.toBe(release.images[2].hash_raw);
    sameBootloader = true;
    await expect(loadRelease('testing')).rejects.toThrow('hardware families');
  } finally {
    fetchMock.mockRestore();
  }
});
