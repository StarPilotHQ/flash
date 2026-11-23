import { COMMIT, packRequest, validRef, validRepo } from '../src/github.js';

const ROOT = 'https://github.com/StarPilotHQ/flash/releases/download/';
const BUNDLE = /^\/bundles\/(clean|other|[a-f0-9]{40})\/(7864320|23330816|23592960)\/(userdata\.(json|bin))$/;

export default {
  async fetch(request, env) {
    const target = new URL(request.url);
    const path = target.pathname;
    if (path.startsWith('/fork-ref/')) {
      const project = path.slice(10);
      const branch = target.searchParams.get('branch');
      if (request.method !== 'GET' || !validRepo(project) || !branch || !validRef(branch)) {
        return new Response(null,{status:404});
      }
      const refs = await fetch('https://github.com/' + project + '.git/info/refs?service=git-upload-pack');
      if (!refs.ok || !refs.headers.get('content-type')?.includes('git-upload-pack-advertisement')) {
        return new Response(null,{status:404});
      }
      const redirected = new URL(refs.url);
      const repo = redirected.pathname.match(/^\/(.*)\.git\/info\/refs$/)?.[1];
      if (redirected.origin !== 'https://github.com' || !repo || !validRepo(repo)) {
        return new Response(null,{status:502});
      }
      const stream = refs.body.getReader();
      const data = new TextDecoder();
      let pending = '';
      let total = 0;
      try {
        for (let next=await stream.read(); !next.done; next=await stream.read()) {
          total += next.value.length;
          if (total > 4 * 1024 * 1024) break;
          const lines = (pending + data.decode(next.value,{stream:true})).split('\n');
          pending = lines.pop();
          for (const line of lines) {
            const match = line.match(/^[0-9a-f]{4}([a-f0-9]{40}) (refs\/heads\/[^\0]+)$/);
            if (match?.[2] === 'refs/heads/' + branch) {
              return Response.json({repo,revision:match[1]}, {headers:{'cache-control':'no-store'}});
            }
          }
        }
      } finally {
        await stream.cancel().catch(() => {});
      }
      return new Response(null,{status:404});
    }
    if (path.startsWith('/fork-pack/')) {
      const [owner, repo, revision, extra] = path.slice(11).split('/');
      const project = owner + '/' + repo;
      if (request.method !== 'GET' || extra !== undefined || !validRepo(project) || !COMMIT.test(revision ?? '')) {
        return new Response(null, {status:404});
      }
      const options = {
        method:'POST',
        redirect:'manual',
        headers:{'content-type':'application/x-git-upload-pack-request','accept':'application/x-git-upload-pack-result'},
        body:packRequest(revision),
      };
      const url = 'https://github.com/' + project + '.git/git-upload-pack';
      let response = await fetch(url,options);
      if ([301,302,307,308].includes(response.status) && response.headers.has('location')) {
        const redirect = new URL(response.headers.get('location'),url);
        const path = redirect.pathname.match(/^\/(.*)\.git\/git-upload-pack$/)?.[1];
        if (redirect.origin === 'https://github.com' && path && validRepo(path) &&
            !redirect.username && !redirect.password && !redirect.search && !redirect.hash) {
          response = await fetch(redirect,options);
        }
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('git-upload-pack-result')) {
        return new Response(null, {status:502});
      }
      return new Response(response.body, {headers:{'content-type':'application/octet-stream','cache-control':'no-store'}});
    }
    if (!path.startsWith('/bundles/')) return env.ASSETS.fetch(request);
    const match = path.match(BUNDLE);
    if (!match || request.method !== 'GET') return new Response(null, {status:404});

    const [, revision, blocks, file, format] = match;
    const response = await fetch(ROOT + (revision === 'other' ? 'offline-v2-' : 'offline-v1-') + revision + '/' + blocks + '-' + file);
    if (!response.ok) return new Response(null, {status:response.status === 404 ? 404 : 502});

    return new Response(response.body, {headers:{
      'content-type': format === 'json' ? 'application/json' : 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
    }});
  },
};
