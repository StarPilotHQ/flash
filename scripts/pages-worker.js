import { COMMIT, packRequest, validRepo } from '../src/github.js';

const ROOT = 'https://github.com/StarPilotHQ/flash/releases/download/';
const BUNDLE = /^\/bundles\/(clean|other|[a-f0-9]{40})\/(23330816|23592960)\/(userdata\.(json|bin))$/;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
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
