import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import worker from './worker.js';
import { createProxyServer } from './local.mjs';

const origin = 'https://apitest.example';
const controlHeader = 'X-APITest-Override-Headers';
let upstream;
let proxy;
let upstreamUrl;
let proxyUrl;
let redirectHits = 0;
let requests = [];
const streaming = new Map();
let pendingAbort;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function direct(target, options = {}) {
  return new Request(`https://proxy.example/proxy/${target}`, options);
}

function via(target) {
  return `${proxyUrl}/proxy/${target}`;
}

// Unlike fetch, this client preserves Connection's dynamic header nominations.
function rawHttp(url, { body, ...options }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode,
        headers: response.headers,
      })));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  return body;
}

before(async () => {
  upstream = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/abort-before-headers') {
      pendingAbort?.started.resolve();
      res.on('close', () => pendingAbort?.closed.resolve());
      return;
    }
    if (path === '/gzip') {
      const compressed = gzipSync('{"compressed":true}');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
      res.end(compressed);
      return;
    }
    if (path === '/broken-stream') {
      const state = streaming.get(path);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      await state.release.promise;
      res.destroy();
      return;
    }
    if (path === '/response-headers') {
      res.writeHead(200, {
        Connection: 'close, x-upstream-private',
        'X-Upstream-Private': 'connection-only',
        'Set-Cookie': 'upstream_session=private',
        'Access-Control-Allow-Credentials': 'true',
        'X-Business': 'retained',
      });
      res.end('headers');
      return;
    }
    if (path === '/sse' || path === '/json-stream') {
      const state = streaming.get(path);
      res.writeHead(200, { 'Content-Type': path === '/sse' ? 'text/event-stream' : 'application/json' });
      res.write(path === '/sse' ? 'data: {"first":true}\n\n' : '{"first":true,');
      state.started.resolve();
      res.on('close', () => state.closed.resolve());
      await state.release.promise;
      state.ended = true;
      res.end(path === '/sse' ? 'data: [DONE]\n\n' : '"last":true}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (path === '/redirect-destination') redirectHits++;
    if (path.startsWith('/redirect/')) {
      res.writeHead(Number(path.split('/').at(-1)), { Location: `${upstreamUrl}/redirect-destination?key=secret` });
      res.end('redirect');
    } else if (path.startsWith('/status/')) {
      const status = Number(path.split('/').at(-1));
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Request-ID': 'upstream-request',
        'Anthropic-Ratelimit-Tokens-Remaining': '41',
        'X-Ratelimit-Remaining-Requests': '7',
        'Retry-After': '2',
        'Access-Control-Allow-Origin': 'https://wrong.example',
      });
      res.end(JSON.stringify({ status, from: 'upstream' }));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requests.at(-1)));
    }
  });
  upstreamUrl = await listen(upstream);
  proxy = createProxyServer();
  proxyUrl = await listen(proxy);
});

after(async () => {
  for (const state of streaming.values()) state.release.resolve();
  await Promise.all([close(proxy), close(upstream)]);
});

test('real upstream receives overridden UA, all identity fields, credentials and a streamed request body', async () => {
  const headers = {
    'User-Agent': 'custom-cli/1.0',
    originator: 'codex_cli_rs',
    'session-id': 'session-1',
    'thread-id': 'thread-1',
    'x-client-request-id': 'thread-1',
    'x-codex-window-id': 'thread-1:0',
    'x-codex-turn-metadata': JSON.stringify({ session_id: 'session-1', thread_id: 'thread-1' }),
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'x-claude-code-session-id': 'claude-session',
    'anthropic-beta': 'test-beta',
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.128.0',
    'x-stainless-os': 'Windows',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v26.3.0',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    Authorization: 'Bearer override-dummy',
    'x-api-key': 'dummy-api-key',
    'X-Custom-Business': 'custom value',
  };
  const response = await rawHttp(via(`${upstreamUrl}/v1/chat/completions`), {
    method: 'POST',
    headers: {
      [controlHeader]: JSON.stringify(headers),
      Authorization: 'Bearer original-dummy',
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: `${origin}/page`,
      Cookie: 'browser_session=private',
      'Sec-Fetch-Site': 'cross-site',
      Connection: 'keep-alive, x-connection-private',
      'X-Connection-Private': 'remove-me',
    },
    body: JSON.stringify({ model: 'test-model', stream: true }),
  });
  assert.equal(response.status, 200);
  const seen = await response.json();
  for (const [name, value] of Object.entries(headers)) assert.equal(seen.headers[name.toLowerCase()], value);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, '{"model":"test-model","stream":true}');
  for (const name of [controlHeader.toLowerCase(), 'cookie', 'origin', 'referer', 'sec-fetch-site', 'x-connection-private']) {
    assert.equal(seen.headers[name], undefined, name);
  }
  // The HTTP transport computes its own Host/framing/Connection fields.
  assert.equal(seen.headers.host, new URL(upstreamUrl).host);
  assert.notEqual(seen.headers.connection, 'keep-alive, x-connection-private');
});

test('raw target path/query escapes and fully encoded targets survive without double decoding', async () => {
  const tail = '/v1beta/models/a%2Fb:generateContent?key=dummy%2Bkey&x=%252F&x=%2f&space=a+b&literal=%23';
  for (const target of [`${upstreamUrl}${tail}`, encodeURIComponent(`${upstreamUrl}${tail}`)]) {
    const response = await fetch(via(target));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, tail);
  }
});

test('standard API methods, HEAD and no-override requests pass through', async () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(via(`${upstreamUrl}/echo`), {
      method,
      headers: { Authorization: 'Bearer ordinary-dummy' },
      ...(!['GET', 'HEAD'].includes(method) ? { body: 'payload' } : {}),
    });
    assert.equal(response.status, 200, method);
    const seen = requests.at(-1);
    assert.equal(seen.method, method);
    assert.equal(seen.headers.authorization, 'Bearer ordinary-dummy');
    assert.equal(seen.body, ['GET', 'HEAD'].includes(method) ? '' : 'payload');
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else await response.arrayBuffer();
  }
});

test('CORS preflight includes requested business and complete identity headers without fetching upstream', async () => {
  const count = requests.length;
  const response = await fetch(via(`${upstreamUrl}/echo`), {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization, X-APITest-Override-Headers, X-Organization-ID, X-Stainless-Timeout',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(requests.length, count);
  const allowed = response.headers.get('access-control-allow-headers').split(/,\s*/);
  for (const name of ['authorization', 'x-apitest-override-headers', 'x-organization-id', 'session-id', 'thread-id', 'x-codex-turn-metadata', 'x-claude-code-session-id', 'anthropic-beta', 'x-stainless-timeout']) {
    assert.ok(allowed.includes(name), name);
  }
  assert.ok(response.headers.get('access-control-allow-methods').includes('PATCH'));
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('ordinary upstream statuses and JSON remain intact with useful exposed response headers', async () => {
  for (const status of [200, 204, 304, 400, 401, 403, 404, 429, 500, 503]) {
    const response = await fetch(via(`${upstreamUrl}/status/${status}`));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-request-id'), 'upstream-request');
    const exposed = response.headers.get('access-control-expose-headers');
    for (const name of ['x-request-id', 'anthropic-ratelimit-tokens-remaining', 'x-ratelimit-remaining-requests', 'retry-after']) {
      assert.ok(exposed.includes(name), name);
    }
    if ([204, 304].includes(status)) assert.equal(await response.text(), '');
    else assert.deepEqual(await response.json(), { status, from: 'upstream' });
  }
});

test('every navigational redirect becomes a safe 502 and the second destination is never hit', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const response = await fetch(via(`${upstreamUrl}/redirect/${status}`), {
      headers: { Authorization: 'Bearer dummy' },
    });
    assert.equal(response.headers.get('location'), null);
    const error = await expectError(response, 502, 'UPSTREAM_REDIRECT');
    assert.ok(!JSON.stringify(error).includes('secret'));
  }
  assert.equal(redirectHits, 0);
});

for (const path of ['/sse', '/json-stream']) {
  test(`${path} first chunk arrives before upstream ends`, { timeout: 5000 }, async () => {
    const state = { started: Promise.withResolvers(), release: Promise.withResolvers(), closed: Promise.withResolvers(), ended: false };
    streaming.set(path, state);
    try {
      const response = await fetch(via(`${upstreamUrl}${path}`));
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.match(new TextDecoder().decode(first.value), /first/);
      assert.equal(state.ended, false);
      state.release.resolve();
      let rest = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      assert.match(rest, path === '/sse' ? /DONE/ : /last/);
    } finally {
      state.release.resolve();
    }
  });
}

test('client abort before headers closes the real upstream connection', { timeout: 5000 }, async () => {
  pendingAbort = { started: Promise.withResolvers(), closed: Promise.withResolvers() };
  const controller = new AbortController();
  const response = fetch(via(`${upstreamUrl}/abort-before-headers`), { signal: controller.signal });
  await pendingAbort.started.promise;
  controller.abort();
  await assert.rejects(response, { name: 'AbortError' });
  await pendingAbort.closed.promise;
});

test('cancelling a streaming reader closes the real upstream stream', { timeout: 5000 }, async () => {
  const state = { started: Promise.withResolvers(), release: Promise.withResolvers(), closed: Promise.withResolvers() };
  streaming.set('/sse', state);
  try {
    const response = await fetch(via(`${upstreamUrl}/sse`));
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await state.closed.promise;
  } finally {
    state.release.resolve();
  }
});

test('an upstream stream failure errors the client reader after its first chunk', { timeout: 5000 }, async () => {
  const state = { release: Promise.withResolvers() };
  streaming.set('/broken-stream', state);
  try {
    const response = await fetch(via(`${upstreamUrl}/broken-stream`));
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    state.release.resolve();
    await assert.rejects(reader.read());
  } finally {
    state.release.resolve();
  }
});

test('local adapter serves Node-decoded compressed bodies without stale compression metadata', async () => {
  const response = await fetch(via(`${upstreamUrl}/gzip`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.deepEqual(await response.json(), { compressed: true });
});

test('upstream connection nominees, cookies and credential CORS headers are removed from responses', async () => {
  const response = await fetch(via(`${upstreamUrl}/response-headers`));
  assert.equal(response.headers.get('x-upstream-private'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('x-business'), 'retained');
  assert.equal(await response.text(), 'headers');
});

test('invalid override maps fail with 400 before contacting upstream', async t => {
  const count = requests.length;
  const invalid = [
    '', 'not-json', 'null', '[]', '"string"', '{"number":2}', '{"x":null}', '{"x":{}}',
    JSON.stringify({ 'bad name': 'value' }), JSON.stringify({ '': 'value' }),
    JSON.stringify({ x: 'a\r\nb' }), JSON.stringify({ x: 'a\0b' }),
    JSON.stringify({ x: '\u4e2d\u6587' }).replace(/[\u4e2d\u6587]/g, c => `\\u${c.charCodeAt(0).toString(16)}`),
  ];
  for (let i = 0; i < invalid.length; i++) {
    await t.test(`invalid mapping ${i + 1}`, async () => {
      await expectError(await worker.fetch(direct(`${upstreamUrl}/echo`, {
        headers: { [controlHeader]: invalid[i] },
      })), 400, 'INVALID_OVERRIDE_HEADERS');
    });
  }
  assert.equal(requests.length, count);
});

test('reserved, browser, hop and dynamically nominated fields cannot be resurrected by overrides', async t => {
  for (const name of [controlHeader, 'Host', 'Content-Length', 'Origin', 'Referer', 'Cookie', 'Sec-Fetch-Site', 'Connection', 'Keep-Alive', 'Proxy-Authorization', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade', 'Access-Control-Request-Headers', 'X-Private']) {
    await t.test(name, async () => {
      await expectError(await worker.fetch(direct(`${upstreamUrl}/echo`, {
        headers: { Connection: 'x-private', [controlHeader]: JSON.stringify({ [name]: 'forbidden' }) },
      })), 400, 'INVALID_OVERRIDE_HEADERS');
    });
  }
});

test('header normalization applies the last case-insensitive custom value', async () => {
  const response = await fetch(via(`${upstreamUrl}/echo`), {
    headers: { [controlHeader]: '{"User-Agent":"first","user-agent":"last","X-Mixed":"first","x-mixed":"last"}' },
  });
  const seen = await response.json();
  assert.equal(seen.headers['user-agent'], 'last');
  assert.equal(seen.headers['x-mixed'], 'last');
});

test('route, method and target errors are structured and never disclose the supplied URL', async () => {
  await expectError(await worker.fetch(new Request('https://proxy.example/elsewhere')), 404, 'NOT_FOUND');
  await expectError(await worker.fetch(direct(`${upstreamUrl}/echo`, { method: 'PROPFIND' })), 405, 'METHOD_NOT_ALLOWED');
  for (const target of ['', 'ftp://example.com/a', 'https://', 'https://user:secret@example.com/?key=secret', 'https%3A%2F%2Fbad%ZZ']) {
    const error = await expectError(await worker.fetch(direct(target)), 400, 'INVALID_TARGET');
    assert.ok(!JSON.stringify(error).includes('secret'));
  }
});

test('ALLOWED_ORIGINS reflects exact configured origins and rejects others before fetch', async () => {
  const env = { ALLOWED_ORIGINS: ` ${origin},https://second.example ` };
  const count = requests.length;
  const denied = await worker.fetch(direct(`${upstreamUrl}/echo`, { headers: { Origin: 'https://other.example' } }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await denied.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(requests.length, count);
  const allowed = await worker.fetch(direct(`${upstreamUrl}/echo`, { method: 'OPTIONS', headers: { Origin: origin } }), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.match(allowed.headers.get('vary'), /Origin/i);
  const invalid = await worker.fetch(direct('ftp://example.com', { headers: { Origin: origin } }), env);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('access-control-allow-origin'), origin);
  await invalid.arrayBuffer();
  const noOrigin = await worker.fetch(direct(`${upstreamUrl}/echo`), env);
  assert.equal(noOrigin.status, 200);
  await noOrigin.arrayBuffer();
});

test('invalid preflight method and reserved requested headers fail without upstream fetch', async () => {
  const count = requests.length;
  for (const headers of [
    { 'Access-Control-Request-Method': 'TRACE' },
    { 'Access-Control-Request-Headers': 'x-good, bad name' },
    { 'Access-Control-Request-Headers': 'cookie' },
  ]) {
    const response = await worker.fetch(direct(`${upstreamUrl}/echo`, { method: 'OPTIONS', headers }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    await response.arrayBuffer();
  }
  assert.equal(requests.length, count);
});

test('upstream failures and pre-aborted requests return stable messages without sensitive details', async () => {
  const unavailable = createServer();
  const unavailableUrl = await listen(unavailable);
  await close(unavailable);
  await expectError(await worker.fetch(direct(unavailableUrl)), 502, 'UPSTREAM_UNAVAILABLE');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('failed https://user:password@example.com/?key=sk-private Authorization: Bearer secret'); };
    const error = await expectError(await worker.fetch(direct('https://example.com/?key=sk-private')), 502, 'UPSTREAM_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(error), /sk-private|password|Bearer|secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const controller = new AbortController();
  controller.abort();
  await expectError(await worker.fetch(direct(`${upstreamUrl}/echo`, { signal: controller.signal })), 499, 'REQUEST_ABORTED');
});
