// Testing adapter only. Cloudflare runs worker.js directly without Node modules.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import worker from './worker.js';

export function createProxyServer({ env = {} } = {}) {
  return createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    incoming.once('aborted', abort);
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) abort();
    });
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      const options = { method: incoming.method, headers, signal: controller.signal };
      if (!['GET', 'HEAD'].includes(incoming.method)) {
        options.body = Readable.toWeb(incoming);
        options.duplex = 'half';
      }
      // Preserve the raw request target; never resolve it against an untrusted Host.
      const request = new Request(`http://127.0.0.1${incoming.url}`, options);
      const response = await worker.fetch(request, env, { waitUntil(promise) { void promise; } });
      if (outgoing.destroyed) {
        await response.body?.cancel();
        return;
      }
      const responseHeaders = Object.fromEntries(response.headers);
      // Node fetch decodes gzip/br/deflate. Its HTTP adapter must remove stale framing.
      // This is deliberately confined to Node; the production Worker forwards its body.
      if (/^(?:gzip|deflate|br)$/i.test(responseHeaders['content-encoding'] || '')) {
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
      }
      outgoing.writeHead(response.status, response.statusText, responseHeaders);
      outgoing.flushHeaders();
      if (response.body && incoming.method !== 'HEAD') {
        await pipeline(Readable.fromWeb(response.body), outgoing, { signal: controller.signal });
      } else {
        await response.body?.cancel();
        outgoing.end();
      }
    } catch {
      if (controller.signal.aborted || outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy();
      } else {
        outgoing.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        outgoing.end(JSON.stringify({ error: { code: 'LOCAL_ADAPTER_ERROR', message: 'The local adapter could not complete this request.' } }));
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let host = '127.0.0.1';
  let port = 8787;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--host' && args[i + 1]) host = args[i + 1];
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[i + 1]);
    else throw new Error('Usage: node proxy/local.mjs [--host 127.0.0.1] [--port 8787]');
  }
  if (port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535.');
  const server = createProxyServer({ env: { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '' } });
  server.on('error', () => {
    console.error('The local proxy could not listen on the configured host and port.');
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Local test proxy: http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`);
  });
}
