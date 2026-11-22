const ROOT = 'https://github.com/StarPilotHQ/flash/releases/download/';
const BUNDLE = /^\/bundles\/(clean|[a-f0-9]{40})\/(23330816|23592960)\/(userdata\.(json|bin))$/;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/bundles/')) return env.ASSETS.fetch(request);
    const match = path.match(BUNDLE);
    if (!match || request.method !== 'GET') return new Response(null, {status:404});

    const [, revision, blocks, file, format] = match;
    const response = await fetch(ROOT + 'offline-v1-' + revision + '/' + blocks + '-' + file);
    if (!response.ok) return new Response(null, {status:response.status === 404 ? 404 : 502});

    return new Response(response.body, {headers:{
      'content-type': format === 'json' ? 'application/json' : 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
    }});
  },
};
