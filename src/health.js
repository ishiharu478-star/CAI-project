import { createServer } from 'node:http';
import { VERSION } from './util.js';

export function createHealthServer({ client, isStopping = () => false, dbReady = () => true }) {
  return createServer((request, response) => {
    if (request.url !== '/health' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found'); return;
    }
    // Discord reconnects must not trigger a Render restart loop. Liveness and
    // Discord connectivity are separate; no API or DB call for health probes.
    const ok = !isStopping() && dbReady();
    response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok, version: VERSION, discord: client.isReady() ? 'ready' : 'connecting' }));
  });
}
