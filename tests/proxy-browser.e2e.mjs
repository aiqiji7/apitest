import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, mkdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from '../proxy/local.mjs';

// Run from the repository root: node tests/proxy-browser.e2e.mjs
// All application requests use native fetch, actual proxy code and loopback servers.
const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = '/tmp/opencode';
const controlHeader = 'x-apitest-override-headers';
const chromeBin = process.env.APITEST_E2E_CHROME || '/usr/bin/google-chrome';
const protocols = ['chat_completions', 'responses', 'anthropic', 'google'];
const profiles = ['default', 'codex', 'claude', 'gemini'];
const diagnostics = ['structured', 'needle', 'capacity'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ua = {
  codex: 'codex_cli_rs/0.164.0 (Windows 10.0; x86_64)',
  claude: 'claude-cli/2.1.306 (external, cli)',
  gemini: 'GeminiCLI/0.65.0/test-model (win32; x64; cli)',
};
const beta = ['claude-code-20250219', 'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13', 'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05', 'effort-2025-11-24'].join(',');
const stainless = {
  'x-stainless-lang': 'js', 'x-stainless-package-version': '0.128.0',
  'x-stainless-os': 'Windows', 'x-stainless-arch': 'x64', 'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.3.0', 'x-stainless-retry-count': '0', 'x-stainless-timeout': '600',
};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKZkAAAAASUVORK5CYII=';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function until(probe, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), pause(1800).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, pause(1800)]);
}

async function runProcess(bin, args, { timeout = 240000, onOutput, ...options } = {}) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const collect = chunk => onOutput?.(String(chunk));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => { void terminate(child); }, timeout);
  try { return (await once(child, 'exit'))[0]; }
  finally { clearTimeout(timer); await terminate(child); }
}

async function bootstrap() {
  assert.ok((await stat(tempRoot)).isDirectory());
  assert.equal(await realpath(tempRoot), tempRoot, 'Temporary parent must not be a symlink');
  const artifacts = await mkdtemp(path.join(tempRoot, 'proxy-ua-e2e-'));
  const keyPath = path.join(artifacts, 'loopback-key.pem');
  const certPath = path.join(artifacts, 'loopback-cert.pem');
  console.log(`Artifacts: ${artifacts}`);
  try {
    assert.equal(await runProcess('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=apitest-loopback-e2e', '-keyout', keyPath, '-out', certPath,
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign'], { timeout: 15000 }), 0);
    const code = await runProcess(process.execPath, [script, '--trusted-run', artifacts], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, onOutput: text => process.stdout.write(text),
    });
    process.exitCode = code === 0 ? 0 : 1;
  } finally {
    await Promise.all([keyPath, certPath].map(file => unlink(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
  }
}

class CDP {
  constructor(ws) {
    Object.assign(this, { ws, id: 0, pending: new Map(), exceptions: [], consoleErrors: [], requests: [], responses: [], loadingFailures: [] });
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map(arg => ({ type: arg.type, text: String(arg.value ?? arg.description ?? '') })));
      } else if (message.method === 'Network.requestWillBeSent') {
        const { request, initiator } = message.params;
        this.requests.push({ url: request.url, method: request.method, initiator: initiator.type });
      } else if (message.method === 'Network.responseReceived') {
        const { url, status, statusText, protocol } = message.params.response;
        this.responses.push({ requestId: message.params.requestId, url, status, statusText, protocol });
      } else if (message.method === 'Network.loadingFailed') {
        const { requestId, canceled, errorText } = message.params;
        this.loadingFailures.push({ requestId, canceled, errorText });
      }
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP closed during ${pending.method}`));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP closed before ${method}`));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function track(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await Promise.race([closed, pause(1500)]);
  };
}

function promptFrom(body) {
  const messages = body?.messages || body?.input || body?.contents || [];
  if (typeof messages === 'string') return messages;
  return messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string'
    ? message.content : (message.content || message.parts || []).map(part => part.text || '').join('')).join('\n');
}

function fingerprintAnswer(prompt) {
  const count = Number(prompt.match(/\b(29[2-9]|3[0-2][0-9]|33[0-2])\b/)?.[1] || 300);
  let seed = parseInt(hash(prompt).slice(0, 8), 16);
  return Array.from({ length: count }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % 355 + 1;
  }).join(', ');
}

function makeMock(records, state) {
  return async (req, res) => {
    const record = { id: records.length + 1, scheme: req.socket.encrypted ? 'https' : 'http',
      method: req.method, url: req.url, headers: { ...req.headers }, rawHeaders: req.rawHeaders.slice(), startedAt: Date.now() };
    records.push(record);
    res.on('finish', () => { record.finishedAt = Date.now(); });
    res.on('close', () => { record.closedAt = Date.now(); if (!res.writableFinished) record.abortedAt = Date.now(); });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, content-type', 'Cache-Control': 'no-store' };
    if (req.method === 'OPTIONS') { record.kind = 'preflight'; res.writeHead(204, cors).end(); return; }
    const sendJson = (status, body, statusText) => {
      record.status = status;
      const headers = { ...cors, 'Content-Type': 'application/json' };
      if (statusText === undefined) res.writeHead(status, headers);
      else res.writeHead(status, statusText, headers);
      record.statusText = res.statusMessage;
      res.end(JSON.stringify(body));
    };
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert.ok(bytes < 12 * 1024 * 1024, 'Unexpectedly large mock request');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString();
      const multipart = /^multipart\/form-data/i.test(req.headers['content-type'] || '');
      record.body = text ? (multipart ? { multipart: text } : JSON.parse(text)) : null;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.endsWith('/v1/models')) {
        record.kind = 'models'; sendJson(200, { data: [{ id: 'test-model', object: 'model', owned_by: 'local-e2e' }] }); return;
      }
      if (url.pathname.includes('/v1/images/')) {
        record.kind = multipart ? 'images-multipart' : 'images-json';
        sendJson(200, { data: [{ b64_json: png }] }); return;
      }
      const protocol = url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent')
        ? 'google' : url.pathname.endsWith('/messages') ? 'anthropic'
          : url.pathname.endsWith('/responses') ? 'responses' : 'chat_completions';
      record.protocol = protocol;
      const prompt = promptFrom(record.body);
      const toolNames = JSON.stringify(record.body?.tools || []);
      record.kind = prompt.includes('Return only the archive code for record') ? 'needle'
        : prompt.startsWith('Reference note ') ? 'capacity'
          : prompt.includes('Return JSON describing the city of Lisbon') ? 'structured'
            : prompt.includes('355') && /\b(29[2-9]|3[0-2][0-9]|33[0-2])\b/.test(prompt) ? 'fingerprint'
              : toolNames.includes('convert_base') ? 'tools' : 'text';
      let answer = record.kind === 'fingerprint' ? fingerprintAnswer(prompt) : 'OK';
      if (record.kind === 'needle') {
        const key = prompt.match(/Return only the archive code for record "(archive-[0-9a-f]+)"/)?.[1];
        assert.ok(key, 'Needle question must identify a record');
        answer = prompt.match(new RegExp(`Record "${key}" has archive code "([0-9a-f]{32})"`))?.[1];
        assert.ok(answer, 'Needle answer must come from the actual decoded prompt');
        record.needle = { key, answer };
      }
      const city = { city: 'Lisbon', population: 545000, coastal: true };
      if (record.kind === 'structured') answer = JSON.stringify(city);
      record.inputTokens = Math.ceil(prompt.length / 4);
      const reply = () => {
        if (res.destroyed) return;
        if (state.delayedJsonNext) {
          const { status, marker } = state.delayedJsonNext;
          state.delayedJsonNext = null;
          const payload = status === 200
            ? { choices: [{ message: { role: 'assistant', content: marker } }] }
            : { error: { message: marker } };
          const serialized = JSON.stringify(payload);
          const prefix = serialized.slice(0, -1) + ' '.repeat(4096);
          const tail = serialized.slice(-1);
          record.status = status;
          record.delayedJson = { marker, prefixBytes: Buffer.byteLength(prefix), headersFlushedAt: Date.now() };
          res.writeHead(status, { ...cors, 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(prefix + tail) });
          record.statusText = res.statusMessage;
          res.flushHeaders();
          res.write(prefix);
          const timer = setTimeout(() => res.destroy(), 12000);
          res.once('close', () => clearTimeout(timer));
          state.delayedBodies.push({ record, res, release() {
            clearTimeout(timer);
            if (record.delayedJson.releaseAttemptAt) return;
            record.delayedJson.releaseAttemptAt = Date.now();
            record.delayedJson.disconnectedAtRelease = res.destroyed;
            if (!res.destroyed && !res.writableEnded) res.end(tail);
          } });
          return;
        }
        if (state.redirectNext) {
          state.redirectNext = false;
          record.status = 302;
          res.writeHead(302, { ...cors, Location: '/redirect-target' }).end();
          return;
        }
        if (state.echoNext) {
          const echo = state.echoNext;
          state.echoNext = false;
          const value = record.headers[echo.header || 'authorization'] || '';
          const credential = echo.tokenOnly ? value.replace(/^Bearer[ \t]+/i, '') : value;
          const error = echo.composite ? { message: 'synthetic composite echo',
            'X-APITest-Override-Headers': { authorization: value }, nested: JSON.stringify({ authorization: value }) }
            : { message: `credential rejected: ${credential}`, detail: `encoded echo: ${encodeURIComponent(credential)}`,
              nested: JSON.stringify({ message: `nested echo: ${credential}` }) };
          sendJson(401, { error }, echo.emptyStatusText ? '' : undefined);
          return;
        }
        if (record.kind === 'capacity' && record.inputTokens > (state.capacityLimit ?? 6000)) {
          sendJson(400, { error: { message: 'maximum context length is 6000 tokens', code: 'context_length_exceeded' } }); return;
        }
        if (record.body?.stream || url.pathname.includes(':streamGenerateContent')) {
          record.stream = true;
          res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
          const frame = value => protocol === 'google' ? { candidates: [{ content: { parts: [{ text: value }] } }] }
            : protocol === 'anthropic' ? { type: 'content_block_delta', delta: { type: 'text_delta', text: value } }
              : protocol === 'responses' ? { type: 'response.output_text.delta', delta: value }
                : { choices: [{ delta: { content: value } }] };
          const first = record.kind === 'fingerprint' ? answer.slice(0, Math.floor(answer.length / 2)) : 'first-chunk';
          const last = record.kind === 'fingerprint' ? answer.slice(first.length) : '-last-chunk';
          res.write(`data: ${JSON.stringify(frame(first))}\n\n`);
          record.firstWrittenAt = Date.now();
          const timer = setTimeout(() => res.destroy(), 12000);
          res.once('close', () => clearTimeout(timer));
          const session = { record, res, release() {
            clearTimeout(timer); record.releasedAt = Date.now();
            res.end(`data: ${JSON.stringify(frame(last))}\n\ndata: [DONE]\n\n`);
          } };
          state.streams.push(session);
          if (record.kind === 'fingerprint') setTimeout(() => session.release(), 30);
          return;
        }
        if (record.kind === 'tools') {
          const hasOutput = JSON.stringify(record.body).includes('function_call_output') ||
            JSON.stringify(record.body).includes('tool_result') || JSON.stringify(record.body).includes('functionResponse') ||
            record.body.messages?.some(message => message.role === 'tool');
          record.toolRound = hasOutput ? 2 : 1;
          if (!hasOutput) {
            const args = { number: 'f', from_base: 16, to_base: 10 };
            if (protocol === 'responses') sendJson(200, { output: [{ type: 'function_call', id: 'fc-local',
              call_id: 'call-local', name: 'convert_base', arguments: JSON.stringify(args) }] });
            else if (protocol === 'anthropic') sendJson(200, { type: 'message', role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-local', name: 'convert_base', input: args }], stop_reason: 'tool_use' });
            else if (protocol === 'google') sendJson(200, { candidates: [{ content: { role: 'model',
              parts: [{ functionCall: { name: 'convert_base', args } }] } }] });
            else sendJson(200, { choices: [{ message: { role: 'assistant', content: null,
              tool_calls: [{ id: 'call-local', type: 'function', function: { name: 'convert_base', arguments: JSON.stringify(args) } }] } }] });
            return;
          }
        }
        if (protocol === 'google') sendJson(200, { candidates: [{ content: { role: 'model', parts: [{ text: answer }] } }],
          usageMetadata: { promptTokenCount: record.inputTokens, candidatesTokenCount: 1 } });
        else if (protocol === 'anthropic') sendJson(200, { type: 'message', role: 'assistant', content: record.kind === 'structured'
          ? [{ type: 'tool_use', id: 'tool-local-e2e', name: 'emit_city', input: city }] : [{ type: 'text', text: answer }],
        usage: { input_tokens: record.inputTokens, output_tokens: 1 } });
        else if (protocol === 'responses') sendJson(200, { output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: record.inputTokens, output_tokens: 1 } });
        else sendJson(200, { choices: [{ message: { role: 'assistant', content: answer } }],
          usage: { prompt_tokens: record.inputTokens, completion_tokens: 1 } });
      };
      if (state.holdCount > 0) {
        state.holdCount--;
        const timer = setTimeout(() => res.destroy(), 12000);
        res.once('close', () => clearTimeout(timer));
        state.held.push({ record, release() { clearTimeout(timer); reply(); } });
      } else reply();
    } catch (error) {
      if (record.abortedAt) return;
      state.errors.push(error.message);
      if (!res.headersSent) sendJson(500, { error: { message: 'Local e2e mock failed' } });
      else res.destroy();
    }
  };
}

async function sourceHashes() {
  const files = ['index.html', 'assets/css/styles.css', 'assets/js/script.js', 'assets/js/capability.js',
    'assets/js/fingerprint.js', 'assets/js/testing-core.js', 'proxy/local.mjs', 'proxy/worker.js'];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
}

async function main(artifacts) {
  assert.equal(path.dirname(artifacts), tempRoot);
  assert.ok(path.basename(artifacts).startsWith('proxy-ua-e2e-'));
  assert.equal(await realpath(artifacts), artifacts);
  const profileDir = path.join(artifacts, 'chrome-profile');
  await mkdir(profileDir);
  const fakeKey = `sk-e2e-${randomUUID().replaceAll('-', '')}`;
  const customToken = `local-custom-${randomUUID()}`;
  const secrets = [fakeKey, customToken];
  const redactText = text => secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])
    .sort((a, b) => b.length - a.length).reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), String(text));
  const safe = value => JSON.parse(JSON.stringify(value, (name, item) => {
    if (/^(?:authorization|x-api-key|api-key|key|cookie)$/i.test(name)) return '[REDACTED]';
    return typeof item === 'string' ? redactText(item) : item;
  }));
  const report = { command: 'node tests/proxy-browser.e2e.mjs', artifacts,
    runtime: 'Native Chrome -> actual proxy/local.mjs Node adapter -> local HTTP/HTTPS mock; no workerd or external model claim',
    checks: [], screenshots: [], observations: {}, limitations: ['Sampled ordinary scenarios; not an exhaustive test of every IQ/search/image variant.'] };
  const upstream = [], proxyRequests = [], staticRequests = [], expectedConsoleErrors = [], shutdown = [];
  const mock = { streams: [], held: [], delayedBodies: [], delayedJsonNext: null, errors: [], holdCount: 0, echoNext: false };
  const staticState = { holdNextVersion: false, held: [] };
  let chrome, cdp, watchdog;
  const check = async (name, action) => {
    try { await action(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); return true; }
    catch (error) {
      const message = redactText(error.stack || error.message);
      report.checks.push({ name, passed: false, error: message });
      console.error(`FAIL ${name}\n${message}`);
      mock.holdCount = 0; mock.echoNext = false; mock.delayedJsonNext = null;
      if (cdp) await cdp.evaluate(() => document.getElementById('stopTestBtn').click()).catch(() => {});
      for (const held of [...mock.held, ...mock.delayedBodies, ...staticState.held]) held.release();
      return false;
    }
  };
  try {
    report.sourceHashes = await sourceHashes();
    const cert = await readFile(path.join(artifacts, 'loopback-cert.pem'));
    const key = await readFile(path.join(artifacts, 'loopback-key.pem'));
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const staticServer = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root) || (!pathname.startsWith('/assets/') && !['/', '/index.html'].includes(pathname))) {
          res.writeHead(403).end(); return;
        }
        const record = { url: req.url, headers: { ...req.headers }, startedAt: Date.now() };
        staticRequests.push(record);
        const body = await readFile(file);
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml', '.json': 'application/json' };
        const release = () => {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
          res.end(body); record.finishedAt = Date.now();
        };
        if (staticState.holdNextVersion && pathname.endsWith('/lmfpd/VERSION.json')) {
          staticState.holdNextVersion = false;
          const timer = setTimeout(release, 12000);
          res.once('close', () => clearTimeout(timer));
          staticState.held.push({ record, release() { clearTimeout(timer); release(); } });
        } else release();
      } catch { res.writeHead(404).end(); }
    });
    shutdown.push(track(staticServer));
    const pageOrigin = `http://127.0.0.1:${await listen(staticServer)}`;
    const handler = makeMock(upstream, mock);
    const tlsServer = https.createServer({ key, cert }, handler);
    shutdown.push(track(tlsServer));
    const tlsOrigin = `https://127.0.0.1:${await listen(tlsServer)}`;
    const plainServer = http.createServer(handler);
    shutdown.push(track(plainServer));
    const httpOrigin = `http://127.0.0.1:${await listen(plainServer)}`;
    const proxy = createProxyServer();
    proxy.prependListener('request', (req, res) => {
      const record = { method: req.method, url: req.url, headers: { ...req.headers }, startedAt: Date.now() };
      proxyRequests.push(record);
      res.once('finish', () => { record.status = res.statusCode; record.statusText = res.statusMessage; record.finishedAt = Date.now(); });
      res.once('close', () => { record.closedAt = Date.now(); });
    });
    shutdown.push(track(proxy));
    const proxyOrigin = `http://127.0.0.1:${await listen(proxy)}`;
    chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      `--ignore-certificate-errors-spki-list=${spki}`, '--window-size=1440,1100', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let chromeDiagnostic = '';
    chrome.stderr.on('data', chunk => { chromeDiagnostic = (chromeDiagnostic + chunk).slice(-6000); });
    chrome.on('error', error => { chromeDiagnostic += error.message; });
    watchdog = setTimeout(() => { void terminate(chrome); }, 210000);
    const debugPort = await until(async () => {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chromeDiagnostic}`);
      try { return Number((await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }, 'Chrome debugging port');
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await Promise.race([once(ws, 'open'), pause(5000).then(() => { throw new Error('CDP connection timeout'); })]);
    cdp = new CDP(ws);
    await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Network.enable')]);
    const paint = () => cdp.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const navigate = async () => {
      const previous = await cdp.evaluate(() => performance.timeOrigin);
      await cdp.send('Page.navigate', { url: `${pageOrigin}/index.html` });
      await until(() => cdp.evaluate(time => performance.timeOrigin !== time && document.readyState === 'complete' &&
        !!window.APITestBridge && !!window.TestingCore, previous), 'new document and bridge');
    };
    await navigate();
    report.observations.browser = await cdp.send('Browser.getVersion');
    report.observations.origins = { pageOrigin, tlsOrigin, httpOrigin, proxyOrigin };
    const browserUa = await cdp.evaluate(() => navigator.userAgent);
    const mark = () => ({ upstream: upstream.length, proxy: proxyRequests.length });
    const captured = cursor => ({ upstream: upstream.slice(cursor.upstream).filter(req => req.method !== 'OPTIONS'),
      proxy: proxyRequests.slice(cursor.proxy).filter(req => req.method !== 'OPTIONS') });
    const assertRoute = (records, proxied = true, override = false) => {
      assert.ok(records.upstream.length > 0, 'Actual upstream requests are required');
      assert.equal(records.proxy.length, proxied ? records.upstream.length : 0, 'Real proxy ingress count');
      records.upstream.forEach((request, index) => {
        const target = (request.scheme === 'https' ? tlsOrigin : httpOrigin) + request.url;
        assert.equal(request.headers[controlHeader], undefined, 'Internal control must never reach upstream');
        assert.ok(cdp.requests.some(req => req.method === request.method && req.url === (proxied ? proxyOrigin + '/proxy/' : '') + target),
          'Native browser must observe the same actual API request');
        if (proxied) {
          const incoming = records.proxy[index];
          assert.equal(incoming.url, '/proxy/' + target);
          assert.equal(incoming.method, request.method);
          assert.equal(Boolean(incoming.headers[controlHeader]), override, 'Override contract on real proxy ingress');
          if (override) for (const [name, value] of Object.entries(JSON.parse(incoming.headers[controlHeader]))) {
            assert.equal(request.headers[name.toLowerCase()], value, `Real upstream header ${name}`);
          }
        }
      });
    };
    const selectScenario = scenario => cdp.evaluate(id => {
      const button = document.querySelector(`#testType [data-scenario="${id}"]`);
      if (!button) throw new Error(`Scenario absent: ${id}`);
      button.click();
    }, scenario);
    const configure = async ({ target = tlsOrigin, proxyUrl = proxyOrigin, enabled = true, profile = 'default',
      protocol = 'chat_completions', scenario = 'iq_test_3', enhanced = true, custom = {}, model = 'test-model',
      stream = false, apiKey = fakeKey, images = false } = {}) => {
      await cdp.evaluate(settings => {
        const $ = id => document.getElementById(id);
        if (!$('stopTestBtn').disabled) $('stopTestBtn').click();
        document.querySelector('[data-profile="default"]').click();
        const vendor = ['anthropic', 'google'].includes(settings.protocol) ? settings.protocol : 'openai';
        document.querySelector(`#vendorType [data-vendor="${vendor}"]`).click();
        if (vendor === 'openai') document.querySelector(`#openaiProtocol [data-protocol="${settings.protocol}"]`).click();
        const fill = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input', { bubbles: true })); };
        fill('apiUrl', settings.target); fill('apiKey', settings.apiKey); fill('model', settings.model);
        fill('httpProxyUrl', settings.proxyUrl);
        if ($('httpsProxyToggle').checked !== settings.enabled) $('httpsProxyToggle').click();
        if ($('httpProxyRow').hidden) $('proxyToggle').click();
        document.querySelector(`[data-profile="${settings.profile}"]`).click();
        $('profileAdvancedDetails').open = true;
        $('profileCustomHeadersDetails').open = true;
        if (settings.profile !== 'default') {
          $(settings.enhanced ? 'profileEnhanced' : 'profileBasic').click();
          fill('profileCustomHeaders', JSON.stringify(settings.custom));
        }
        if (settings.images) document.querySelector('[data-vendor="images"]').click();
        const scenario = document.querySelector(`#testType [data-scenario="${settings.scenario}"]`);
        if (!scenario) throw new Error(`Scenario absent: ${settings.scenario}`);
        scenario.click();
        $('streamToggle').checked = settings.stream;
        $('thinkingToggle').checked = false;
        fill('needleTokens', '2048'); fill('capacityStart', '8192'); fill('capacityResolution', '1024');
        if (settings.scenario === 'iq_test_3') fill('userInput', 'ordinary native UI text');
        $('modelDropdown').style.display = 'none'; $('recentDropdown').style.display = 'none';
      }, { target, proxyUrl, enabled, profile, protocol, scenario, enhanced, custom, model, stream, apiKey, images });
    };
    const start = () => cdp.evaluate(() => { document.getElementById('testBtn').click(); return document.getElementById('testBtn').disabled; });
    const results = () => cdp.evaluate(() => ({
      status: document.getElementById('capabilityStatus').textContent,
      error: document.getElementById('capabilityError').textContent,
      mainError: document.getElementById('errorMessage').textContent,
      cards: Array.from(document.querySelectorAll('.capability-result')).map(card => ({ className: card.className, text: card.textContent })),
      attempts: Array.from(document.querySelectorAll('#capacityAttempts tr')).map(row => row.textContent),
      timeline: document.getElementById('messageTimeline').textContent,
      fingerprint: { status: document.getElementById('fingerprintStatus').textContent,
        error: document.getElementById('fingerprintError').textContent, result: document.getElementById('fingerprintResult').textContent,
        samples: Array.from(document.querySelectorAll('.fingerprint-sample')).map(el => ({ className: el.className,
          text: el.querySelector('.fingerprint-sample-output').textContent, stats: el.querySelector('.fingerprint-sample-stats').textContent })) },
    }));
    const finish = async () => {
      await until(() => cdp.evaluate(() => !document.getElementById('testBtn').disabled), 'shared run completion', 20000);
      return results();
    };
    const run = async () => { assert.equal(await start(), true, 'Shared run must start'); return finish(); };
    const runCaptured = async options => { await configure(options); const cursor = mark(); const result = await run(); return { ...captured(cursor), result }; };
    const assertDiagnostic = result => {
      assert.equal(result.error, ''); assert.equal(result.mainError, ''); assert.equal(result.cards.length, 1);
      assert.ok(result.cards[0].className.includes('is-pass'), result.cards[0].text);
    };
    const assertIdentity = (request, profile, expectedModel = 'test-model') => {
      const h = request.headers, body = request.body;
      assert.equal(h['user-agent'], profile === 'gemini' ? `GeminiCLI/0.65.0/${expectedModel} (win32; x64; cli)` : ua[profile]);
      if (profile === 'codex') {
        assert.equal(h.originator, 'codex_cli_rs');
        for (const name of ['session-id', 'thread-id', 'x-client-request-id']) assert.match(h[name], uuidPattern);
        assert.equal(h['x-client-request-id'], h['thread-id']); assert.equal(h['x-codex-window-id'], h['thread-id'] + ':0');
        const metadata = JSON.parse(h['x-codex-turn-metadata']);
        assert.deepEqual(Object.keys(metadata).sort(), ['installation_id', 'session_id', 'thread_id', 'window_id', 'window_number',
          'turn_id', 'root_turn_id', 'request_kind', 'history_initialization', 'model', 'turn_started_at_unix_ms'].sort());
        assert.match(metadata.installation_id, uuidPattern); assert.match(metadata.turn_id, uuidPattern);
        assert.equal(metadata.session_id, h['session-id']); assert.equal(metadata.thread_id, h['thread-id']);
        assert.equal(metadata.window_id, h['x-codex-window-id']); assert.equal(metadata.root_turn_id, metadata.turn_id);
        assert.equal(metadata.window_number, 0); assert.equal(metadata.request_kind, 'turn');
        assert.equal(metadata.history_initialization, 'new'); assert.equal(metadata.model, expectedModel);
        assert.ok(metadata.turn_started_at_unix_ms <= request.startedAt && metadata.turn_started_at_unix_ms >= request.startedAt - 5000);
        assert.equal(body.client_metadata['x-codex-turn-metadata'], h['x-codex-turn-metadata']);
        assert.equal(body.client_metadata['x-codex-installation-id'], metadata.installation_id);
        assert.equal(body.client_metadata.session_id, h['session-id']); assert.equal(body.client_metadata.thread_id, h['thread-id']);
        assert.equal(body.client_metadata['x-codex-window-id'], h['x-codex-window-id']); assert.equal(body.prompt_cache_key, h['session-id']);
        assert.equal(body.store, false); assert.ok(body.include.includes('reasoning.encrypted_content'));
        assert.equal(body.input.filter(item => item.role === 'developer' && JSON.stringify(item).includes('Codex CLI')).length, 1, 'One Codex identity injection');
      } else if (profile === 'claude') {
        assert.equal(h['x-app'], 'cli'); assert.equal(h['anthropic-version'], '2023-06-01');
        assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true'); assert.match(h['x-claude-code-session-id'], uuidPattern);
        for (const [name, value] of Object.entries(stainless)) assert.equal(h[name], value);
        assert.equal(h['anthropic-beta'], beta);
        assert.equal(JSON.parse(body.metadata.user_id).session_id, h['x-claude-code-session-id']);
        assert.equal(body.system.filter(item => item.text.includes("You are Claude Code, Anthropic's official CLI tool.")).length, 1);
        assert.equal(new URL(request.url, tlsOrigin).searchParams.get('beta'), 'true');
      } else {
        assert.equal(h['x-goog-api-client'], 'genai-js/0.65.0');
        assert.equal(new URL(request.url, tlsOrigin).searchParams.get('key'), fakeKey);
        assert.equal(body.systemInstruction.parts.filter(item => item.text.includes('You are Gemini CLI')).length, 1);
      }
    };
    const debugBlocks = () => cdp.evaluate(() => Array.from(document.querySelectorAll('#blocksContainer .code-block'))
      .filter(el => el.querySelector('.code-section-label')).map(el => {
        const pres = el.querySelectorAll('pre');
        return { headers: JSON.parse(pres[0].textContent), body: pres[1].textContent };
      }));
    const assertDebugMatches = async requests => {
      const blocks = await debugBlocks();
      assert.equal(blocks.length, requests.length, 'One actual prepared debug block per model request');
      requests.forEach((request, i) => {
        assert.deepEqual(JSON.parse(blocks[i].body), request.body, 'Debug body equals actual prepared network body');
        if (request.headers['x-codex-turn-metadata']) assert.equal(blocks[i].headers['x-codex-turn-metadata'], request.headers['x-codex-turn-metadata']);
        const control = Object.keys(blocks[i].headers).find(name => name.toLowerCase() === controlHeader);
        if (control) assert.equal(blocks[i].headers[control], '***');
        if (blocks[i].headers.authorization) assert.match(blocks[i].headers.authorization, /^(?:Bearer )?\*\*\*$/);
      });
    };
    const surfaces = () => cdp.evaluate(async () => {
      const copied = [];
      const original = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => copied.push(text) });
      try { document.querySelectorAll('#blocksContainer .copy-btn').forEach(button => button.click()); await Promise.resolve(); }
      finally { if (original) Object.defineProperty(navigator.clipboard, 'writeText', original); else delete navigator.clipboard.writeText; }
      const errors = Array.from(document.querySelectorAll('.error-inline'));
      return { results: document.getElementById('capabilityResults').textContent,
        title: errors.map(el => Array.from(el.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('')).join('\n'),
        raw: Array.from(document.querySelectorAll('.error-inline pre,.capability-result-detail pre')).map(el => el.textContent).join('\n'),
        timeline: document.getElementById('messageTimeline').textContent, debug: document.getElementById('blocksContainer').textContent,
        history: document.getElementById('recentDropdown').textContent, copied: copied.join('\n'), copiedCount: copied.length,
        localStorage: JSON.stringify({ ...localStorage }), sessionStorage: JSON.stringify({ ...sessionStorage }) };
    });
    const assertNoSecret = (values, tokens) => {
      for (const [surface, value] of Object.entries(values)) for (const token of tokens) {
        for (const variant of [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)]) {
          assert.ok(!String(value).includes(variant), `Secret leaked in ${surface}`);
        }
      }
    };

    await check('initial DOM: global profile, only true vendors, shared actions and lazy fingerprint data/core', async () => {
      const initial = await cdp.evaluate(() => ({
        vendors: Array.from(document.querySelectorAll('#vendorType [data-vendor]')).map(el => el.dataset.vendor),
        global: !!document.querySelector('.config-section #globalProfileSettings') && !document.querySelector('.test-section #profileSelect'),
        obsolete: ['capabilityRunBtn', 'capabilityStopBtn', 'capabilityReturnBtn', 'fingerprintFormat', 'fingerprintStartBtn',
          'fingerprintStopBtn', 'fingerprintScoreBtn'].filter(id => document.getElementById(id)),
        actions: ['testBtn', 'stopTestBtn', 'clearBtn'].map(id => document.querySelectorAll('#' + id).length),
        nativeFetch: /\[native code\]/.test(fetch.toString()), lmfpd: typeof window.LMFPD,
        proxyUrl: document.getElementById('httpProxyUrl').value,
        enabled: document.getElementById('httpsProxyToggle').checked, storage: { ...localStorage },
      }));
      assert.deepEqual(initial.vendors, ['openai', 'anthropic', 'google', 'images']); assert.equal(initial.global, true);
      assert.deepEqual(initial.obsolete, []); assert.deepEqual(initial.actions, [1, 1, 1]);
      assert.equal(initial.nativeFetch, true); assert.equal(initial.lmfpd, 'undefined');
      assert.equal(initial.enabled, false); assert.deepEqual(initial.storage, {});
      assert.equal(initial.proxyUrl, 'https://apiprox.160006.xyz');
      assert.ok(!cdp.requests.some(req => /lmfpd\//.test(req.url)));
    });
    await check('four model protocols expose peer diagnostics/fingerprint and IQ; Images excludes them', async () => {
      for (const protocol of protocols) {
        await configure({ protocol });
        const nav = await cdp.evaluate(() => ({ protocol: window.APITestBridge.getRequestContext().protocol,
          scenarios: Array.from(document.querySelectorAll('#testType [data-scenario]')).map(el => el.dataset.scenario),
          selected: document.querySelector('#testType .active').dataset.scenario }));
        assert.equal(nav.protocol, protocol); assert.equal(nav.selected, 'iq_test_3');
        for (const scenario of [...diagnostics, 'fingerprint']) assert.equal(nav.scenarios.filter(id => id === scenario).length, 1);
      }
      await configure({ images: true, scenario: 'images_generate' });
      assert.deepEqual(await cdp.evaluate(() => Array.from(document.querySelectorAll('#testType [data-scenario]')).map(el => el.dataset.scenario)),
        ['images_generate', 'images_edit']);
    });
    await check('scenario-specific parameters, single result surface and diagnostic protocol retention', async () => {
      await configure({ scenario: 'structured' });
      for (const scenario of diagnostics) {
        await selectScenario(scenario);
        const shown = await cdp.evaluate(() => ['structured', 'needle', 'capacity'].filter(id => !document.getElementById(id + 'Params').hidden));
        assert.deepEqual(shown, [scenario]);
      }
      await cdp.evaluate(() => document.querySelector('[data-vendor="google"]').click());
      assert.equal(await cdp.evaluate(() => document.querySelector('#testType .active').dataset.scenario), 'capacity');
      assert.ok(await cdp.evaluate(() => document.getElementById('capacityBudgetHint').textContent.includes('10')));
      await selectScenario('iq_test_3');
      assert.equal(await cdp.evaluate(() => document.getElementById('capabilityPanel').hidden), true);
      assert.equal(await cdp.evaluate(() => document.getElementById('userInput').getClientRects().length > 0), true);
    });
    await check('HTTPS off: native direct IQ with no CLI UA or proxy/control, including configured proxy', async () => {
      for (const proxyUrl of ['', proxyOrigin]) {
        const records = await runCaptured({ enabled: false, proxyUrl });
        assertRoute(records, false, false); assert.equal(records.upstream.length, 1);
        assert.equal(records.upstream[0].headers['user-agent'], browserUa); assert.equal(records.upstream[0].status, 200);
      }
    });
    await check('HTTPS on: actual proxy default IQ and model GET; model listing ignores selected CLI profile', async () => {
      const records = await runCaptured(); assertRoute(records); assert.equal(records.upstream[0].headers['user-agent'], browserUa);
      await configure({ profile: 'codex' });
      const cursor = mark();
      await cdp.evaluate(() => document.getElementById('fetchModelsBtn').click());
      await until(() => cdp.evaluate(() => !!document.querySelector('#modelDropdown [data-model="test-model"]')), 'model GET rendered');
      const models = captured(cursor); assertRoute(models); assert.equal(models.upstream.length, 1);
      assert.equal(models.upstream[0].kind, 'models'); assert.equal(models.upstream[0].headers['user-agent'], browserUa);
      assert.equal(models.upstream[0].headers.originator, undefined);
    });
    await check('no configured proxy never leaks control; HTTP legacy proxy remains with HTTPS switch off', async () => {
      let records = await runCaptured({ profile: 'codex', proxyUrl: '' }); assertRoute(records, false, false);
      records = await runCaptured({ target: httpOrigin, profile: 'codex', enabled: false });
      assertRoute(records, true, false); assert.equal(records.upstream[0].scheme, 'http');
    });
    for (const profile of profiles.slice(1)) await check(`global enhanced ${profile}: ordinary IQ exact UA and one identity injection`, async () => {
      const records = await runCaptured({ profile }); assertRoute(records, true, true);
      assert.equal(records.upstream.length, 1); assertIdentity(records.upstream[0], profile);
      assert.equal(records.result.mainError, ''); assert.equal(records.upstream[0].status, 200);
      await assertDebugMatches(records.upstream);
      report.observations[profile] = { requestId: records.upstream[0].id, headers: records.upstream[0].headers, body: records.upstream[0].body };
    });
    await check('global profile implies protocol; manual incompatible protocol restores default with visible note', async () => {
      await configure({ profile: 'codex', scenario: 'needle' });
      await cdp.evaluate(() => document.querySelector('[data-vendor="anthropic"]').click());
      const state = await cdp.evaluate(() => ({ profile: document.querySelector('#profileSelect .active').dataset.profile,
        notice: document.getElementById('profileProtocolNotice').textContent, visible: !document.getElementById('profileProtocolNotice').hidden,
        scenario: document.querySelector('#testType .active').dataset.scenario }));
      assert.equal(state.profile, 'default'); assert.equal(state.visible, true); assert.match(state.notice, /\u4e0d\u517c\u5bb9/);
      assert.equal(state.scenario, 'needle');
      const cursor = mark(); assertDiagnostic(await run()); assertRoute(captured(cursor));
      assert.equal(captured(cursor).upstream[0].headers['x-app'], undefined);
    });
    await check('custom UA/Authorization are case-insensitive, exact upstream and masked in actual debug/copy', async () => {
      const records = await runCaptured({ profile: 'codex', custom: { 'User-Agent': 'LocalBrowserOverride/1.0', Authorization: `Bearer ${customToken}` } });
      assertRoute(records, true, true);
      const request = records.upstream[0]; assert.equal(request.headers['user-agent'], 'LocalBrowserOverride/1.0');
      assert.equal(request.headers.authorization, `Bearer ${customToken}`);
      assert.equal(request.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === 'authorization').length, 1);
      const display = await surfaces(); assert.ok(display.copiedCount > 0); assert.match(display.debug, /Bearer \*\*\*/);
      // Browser transport removes UA and masks its composite control payload.
      // The actual upstream equality assertion establishes the requested UA.
      await assertDebugMatches(records.upstream);
      assert.match(display.copied, /Bearer \*\*\*/);
      assertNoSecret(display, [customToken]);
      report.observations.customOverride = { requestId: request.id, ua: request.headers['user-agent'], authorization: '[REDACTED; equality checked in memory]' };
    });
    for (const [header, profile, tokenOnly] of [['X-Api-Key', 'claude', false], ['Authorization', 'codex', true]]) {
      await check(`OWS ${header}: real normalized credential and raw/JSON/URI error echoes stay masked`, async () => {
        const token = `fresh-${randomUUID()}${tokenOnly ? '+/=' : ''}`; secrets.push(token);
        const normalized = tokenOnly ? `Bearer ${token}` : token;
        await configure({ profile, scenario: 'structured', custom: { [header]: ` \t${normalized}\t ` } });
        mock.echoNext = { header: header.toLowerCase(), tokenOnly };
        const cursor = mark(); const result = await run(); const records = captured(cursor); assertRoute(records, true, true);
        assert.equal(records.upstream[0].headers[header.toLowerCase()], normalized); assert.equal(records.upstream[0].status, 401);
        assert.ok(result.cards[0].className.includes('is-fail')); assert.match(result.cards[0].text, /credential rejected/);
        assertNoSecret(await surfaces(), [token]);
      });
    }
    await check('nested composite control payload and independent bridge secret variants are fully masked', async () => {
      await configure({ profile: 'codex', scenario: 'structured', custom: { Authorization: `Bearer ${customToken}` } });
      mock.echoNext = { composite: true }; const result = await run();
      assert.ok(result.cards[0].className.includes('is-fail')); assert.match(result.cards[0].text, /synthetic composite/);
      assertNoSecret(await surfaces(), [customToken]);
      for (const header of ['X-Api-Key', 'Authorization']) {
        const token = `bridge${randomUUID()}"\\+/=`; secrets.push(token);
        const variants = await cdp.evaluate(({ header, token }) => {
          const b = window.APITestBridge, value = header === 'Authorization' ? `Bearer ${token}` : token;
          b.prepareProfileTransport({ url: 'https://127.0.0.1/unused', headers: { [header]: ` \t${value}\t ` } });
          return [value, token, JSON.stringify(value).slice(1, -1), JSON.stringify(token).slice(1, -1),
            encodeURIComponent(value), encodeURIComponent(token)].map(text => b.sanitizeSensitiveText(`echo: ${text}`));
        }, { header, token });
        assert.ok(variants.every(text => text === 'echo: ***'));
      }
    });
    await check('invalid global custom JSON blocks real network; default ignores stale invalid options', async () => {
      await configure({ profile: 'codex' });
      await cdp.evaluate(() => { const el = document.getElementById('profileCustomHeaders'); el.value = '{invalid'; el.dispatchEvent(new Event('input')); });
      const cursor = mark(); await start();
      const invalid = await cdp.evaluate(() => ({ visible: !document.getElementById('profileCustomHeadersError').hidden,
        invalid: document.getElementById('profileCustomHeaders').getAttribute('aria-invalid'),
        open: document.getElementById('profileAdvancedDetails').open && document.getElementById('profileCustomHeadersDetails').open }));
      assert.deepEqual(invalid, { visible: true, invalid: 'true', open: true });
      assert.equal(captured(cursor).upstream.length, 0); assert.equal(captured(cursor).proxy.length, 0);
      await cdp.evaluate(() => { document.querySelector('[data-profile="default"]').click(); document.getElementById('profileCustomHeaders').value = '{stale'; });
      await run(); const records = captured(cursor); assertRoute(records); assert.equal(records.upstream[0].headers.originator, undefined);
    });
    await check('Claude custom beta is final; raw encoded/duplicate query fields survive centralized application', async () => {
      await configure({ profile: 'claude', custom: { 'Anthropic-Beta': 'custom-one,custom-two' } });
      const cursor = mark();
      await cdp.evaluate(async () => {
        const b = window.APITestBridge, ctx = b.captureRunContext();
        await b.fetchAndStream(b.buildAnthropicEndpoint(ctx.apiUrl) + '?tenant=a%2Fb&dup=one&dup=two&beta=false', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ctx.apiKey },
          body: JSON.stringify({ model: ctx.model, messages: [{ role: 'user', content: 'query check' }], stream: false }),
        }, null, null, null, { runContext: ctx });
      });
      const records = captured(cursor); assertRoute(records, true, true);
      assert.equal(records.upstream[0].url, '/v1/messages?tenant=a%2Fb&dup=one&dup=two&beta=true');
      assert.equal(records.upstream[0].headers['anthropic-beta'], 'custom-one,custom-two');
    });
    await check('Codex custom identities normalize SP/HTAB once and agree in actual headers/body/cache/metadata', async () => {
      const records = await runCaptured({ profile: 'codex', custom: {
        'Session-ID': ' \tchosen-session\t ', 'Thread-ID': ' \tchosen-thread\t ',
        'X-Codex-Window-ID': '\tchosen-window ', 'X-Client-Request-ID': ' chosen-request\t',
      } });
      assertRoute(records, true, true);
      const { headers: h, body } = records.upstream[0], metadata = JSON.parse(h['x-codex-turn-metadata']);
      assert.equal(h['session-id'], 'chosen-session'); assert.equal(h['thread-id'], 'chosen-thread');
      assert.equal(h['x-codex-window-id'], 'chosen-window'); assert.equal(h['x-client-request-id'], 'chosen-request');
      assert.equal(body.prompt_cache_key, h['session-id']); assert.equal(body.client_metadata.session_id, h['session-id']);
      assert.equal(body.client_metadata.thread_id, h['thread-id']); assert.equal(body.client_metadata['x-codex-window-id'], h['x-codex-window-id']);
      assert.equal(metadata.session_id, h['session-id']); assert.equal(metadata.thread_id, h['thread-id']); assert.equal(metadata.window_id, h['x-codex-window-id']);
      assert.equal(body.client_metadata['x-codex-turn-metadata'], h['x-codex-turn-metadata']);
      await assertDebugMatches(records.upstream);
    });
    await check('upstream redirect is a readable proxy error with no browser escape or destination hit', async () => {
      await configure({ scenario: 'structured' }); mock.redirectNext = true; const cursor = mark();
      const result = await run(), records = captured(cursor); assertRoute(records);
      assert.equal(records.upstream.length, 1); assert.equal(records.upstream[0].status, 302); assert.equal(records.proxy[0].status, 502);
      assert.ok(result.cards[0].className.includes('is-fail')); assert.match(result.cards[0].text, /UPSTREAM_REDIRECT/);
      assert.equal(upstream.filter(req => req.url === '/redirect-target').length, 0);
      assert.ok(!cdp.requests.some(req => req.url.endsWith('/redirect-target')));
    });
    for (const [i, protocol] of protocols.entries()) for (const scenario of diagnostics) {
      await check(`${protocol} ${scenario}: separate shared run, protocol payload, global profile and single result`, async () => {
        const profile = profiles[i], records = await runCaptured({ profile, protocol, scenario });
        assertRoute(records, true, profile !== 'default'); assertDiagnostic(records.result);
        assert.ok(records.upstream.every(req => req.protocol === protocol && req.kind === scenario && !req.stream));
        if (profile !== 'default') records.upstream.forEach(req => assertIdentity(req, profile));
        if (scenario === 'needle') assert.match(records.upstream[0].needle.answer, /^[0-9a-f]{32}$/);
        if (scenario === 'capacity') {
          assert.ok(records.upstream.some(req => req.status === 200)); assert.ok(records.upstream.some(req => req.status === 400));
          assert.match(records.result.cards[0].text, /\u672c\u5730\u4f30\u7b97\u63a5\u53d7\u4e0b\u754c/);
          assert.match(records.result.cards[0].text, /\u672c\u5730\u4f30\u7b97\u62d2\u7edd\u4e0a\u754c/);
          assert.ok(records.result.attempts.some(text => text.includes('\u670d\u52a1\u7aef\u62a5\u544a\u8f93\u5165')));
          assert.ok(!/\u771f\u5b9e\u4e0a\u9650|\u5df2\u786e\u8ba4\u53ef\u7528|\u9996\u6b21\u8d85\u9650/.test(records.result.cards[0].text));
        } else assert.equal(records.upstream.length, 1);
      });
    }
    await check('capacity all-accepted case has no rejection bound and preserves provider usage separately', async () => {
      await configure({ scenario: 'capacity' });
      const previous = await cdp.evaluate(() => { const n = window.TestingCore.CAPACITY_DEFAULTS.maxTokens;
        window.TestingCore.CAPACITY_DEFAULTS.maxTokens = 65536; return n; });
      mock.capacityLimit = Infinity;
      try {
        const cursor = mark(), result = await run(); assertRoute(captured(cursor));
        assert.ok(captured(cursor).upstream.every(req => req.status === 200));
        assert.match(result.cards[0].text, /\u672c\u5730\u4f30\u7b97\u62d2\u7edd\u4e0a\u754c\uff1a\u672a\u89c2\u5bdf\u5230/);
        assert.match(result.cards[0].text, /\u5c1a\u672a\u89c2\u5bdf\u5230\u5bb9\u91cf\u62d2\u7edd/);
      } finally { delete mock.capacityLimit; await cdp.evaluate(n => { window.TestingCore.CAPACITY_DEFAULTS.maxTokens = n; }, previous); }
    });
    for (const [profile, protocol, scenario] of [['codex', 'responses', 'responses_tools'], ['claude', 'anthropic', 'anthropic_tools'],
      ['gemini', 'google', 'gemini_tools']]) await check(`${profile} ordinary tools: real two-round function flow and snapshot`, async () => {
      await configure({ profile, protocol, scenario, custom: { 'X-Run-Snapshot': 'original' } });
      mock.holdCount = 1; const cursor = mark(), heldIndex = mock.held.length;
      await start(); const held = await until(() => mock.held[heldIndex], 'first tool round held');
      await cdp.evaluate(() => { document.getElementById('model').value = 'changed-mid-run';
        document.getElementById('profileCustomHeaders').value = '{"X-Run-Snapshot":"changed"}';
        document.getElementById('streamToggle').checked = true; });
      held.release(); await finish(); const records = captured(cursor); assertRoute(records, true, true);
      assert.equal(records.upstream.length, 2); assert.deepEqual(records.upstream.map(req => req.toolRound), [1, 2]);
      records.upstream.forEach(req => { assertIdentity(req, profile); assert.equal(req.headers['x-run-snapshot'], 'original');
        assert.ok(JSON.stringify(req.body.tools).includes('convert_base')); assert.ok(JSON.stringify(req.body.tools).includes('submit_answer')); assert.ok(!req.stream); });
      assert.ok(JSON.stringify(records.upstream[1].body).includes('15'), 'Local tool output survives the next prepared body');
      if (protocol !== 'google') assert.equal(records.upstream[1].body.model, 'test-model');
      await assertDebugMatches(records.upstream);
    });
    await check('capacity captures model, credential, profile options and parameters for all attempts', async () => {
      await configure({ profile: 'codex', scenario: 'capacity', custom: { 'X-Run-Snapshot': 'capacity-original' } });
      mock.holdCount = 1; const cursor = mark(), index = mock.held.length; await start();
      const held = await until(() => mock.held[index], 'capacity first request held');
      await cdp.evaluate(() => { document.getElementById('model').value = 'next-model'; document.getElementById('apiKey').value = 'next-key';
        document.getElementById('profileCustomHeaders').value = '{"X-Run-Snapshot":"next"}'; document.getElementById('capacityStart').value = '1024'; });
      held.release(); assertDiagnostic(await finish()); const records = captured(cursor); assertRoute(records, true, true);
      assert.ok(records.upstream.length >= 3);
      for (const req of records.upstream) { assertIdentity(req, 'codex'); assert.equal(req.headers.authorization, 'Bearer ' + fakeKey);
        assert.equal(req.headers['x-run-snapshot'], 'capacity-original'); }
    });
    await check('ordinary search keeps native search tool definitions under Codex and Gemini profiles', async () => {
      for (const [profile, scenario, tool] of [['codex', 'responses_search', 'web_search'], ['gemini', 'gemini_search', 'googleSearch']]) {
        const records = await runCaptured({ profile, scenario }); assertRoute(records, true, true);
        assert.equal(records.upstream.length, 1); assertIdentity(records.upstream[0], profile);
        assert.ok(JSON.stringify(records.upstream[0].body.tools).includes(tool));
      }
    });
    const loadImage = async () => {
      await cdp.evaluate(base64 => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'local-e2e.png', { type: 'image/png' }));
        const input = document.getElementById('imageFileInput'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
      }, png);
      await until(() => cdp.evaluate(() => document.getElementById('previewImg').src.startsWith('data:image/png')), 'local UI image ready');
    };
    await check('ordinary image recognition preserves image payload and applies Claude profile once', async () => {
      await configure({ profile: 'claude', scenario: 'anthropic_image' }); await loadImage();
      const cursor = mark(); await run(); const records = captured(cursor); assertRoute(records, true, true);
      assertIdentity(records.upstream[0], 'claude');
      const image = records.upstream[0].body.messages[0].content.find(part => part.type === 'image');
      assert.deepEqual(image.source, { type: 'base64', media_type: 'image/png', data: png });
    });
    await check('central preparation preserves complex thinking/tool/image fields without manual pre-application', async () => {
      await configure({ profile: 'codex' }); const cursor = mark();
      await cdp.evaluate(async base64 => {
        const b = window.APITestBridge, ctx = b.captureRunContext();
        await b.fetchAndStream(b.buildResponsesEndpoint(ctx.apiUrl), { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.apiKey }, body: JSON.stringify({
            model: ctx.model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'complex payload' },
              { type: 'input_image', image_url: 'data:image/png;base64,' + base64 }] }], stream: false,
            reasoning: { effort: 'high' }, tools: [{ type: 'web_search' }], tool_choice: 'auto', metadata: { fixture: 'kept' },
          }) }, null, null, null, { runContext: ctx });
      }, png);
      const records = captured(cursor); assertRoute(records, true, true); const body = records.upstream[0].body;
      assertIdentity(records.upstream[0], 'codex'); assert.deepEqual(body.reasoning, { effort: 'high' });
      assert.deepEqual(body.tools, [{ type: 'web_search' }]); assert.equal(body.tool_choice, 'auto');
      assert.deepEqual(body.metadata, { fixture: 'kept' }); assert.equal(body.input[1].content[1].image_url, 'data:image/png;base64,' + png);
    });
    await check('Images JSON and multipart use real proxy but no global CLI/control headers', async () => {
      let records = await runCaptured({ profile: 'codex', images: true, scenario: 'images_generate' });
      assertRoute(records); assert.equal(records.upstream[0].kind, 'images-json'); assert.equal(records.upstream[0].headers.originator, undefined);
      assert.deepEqual(Object.keys(records.upstream[0].body).sort(), ['model', 'n', 'prompt', 'size']);
      await configure({ profile: 'codex', images: true, scenario: 'images_edit' }); await loadImage();
      const cursor = mark(); await run(); records = captured(cursor); assertRoute(records);
      assert.equal(records.upstream.length, 1); assert.equal(records.upstream[0].kind, 'images-multipart');
      assert.match(records.upstream[0].headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.match(records.upstream[0].body.multipart, /name="image"; filename="input.png"/);
      assert.match(records.upstream[0].body.multipart, /Content-Type: image\/png/);
      for (const field of ['model', 'prompt', 'n', 'size']) assert.ok(records.upstream[0].body.multipart.includes(`name="${field}"`));
      assert.equal(records.upstream[0].headers.originator, undefined); assert.equal(records.upstream[0].headers['user-agent'], browserUa);
    });
    for (const action of ['scenario', 'protocol', 'proxy', 'stop']) await check(`${action} change cancels an active diagnostic at real upstream`, async () => {
      await configure({ profile: 'codex', scenario: 'structured' }); mock.holdCount = 1;
      const index = mock.held.length; await start(); const held = await until(() => mock.held[index], 'diagnostic held for cancel');
      await cdp.evaluate(action => {
        if (action === 'scenario') document.querySelector('[data-scenario="iq_test_3"]').click();
        else if (action === 'protocol') document.querySelector('[data-vendor="google"]').click();
        else if (action === 'proxy') document.getElementById('httpsProxyToggle').click();
        else document.getElementById('stopTestBtn').click();
      }, action);
      await until(() => held.record.abortedAt, 'upstream diagnostic abort'); assert.equal(held.record.finishedAt, undefined);
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), false);
    });

    for (const action of ['scenario', 'stop']) await check(`fingerprint lazy-load race: ${action} exit prevents delayed API samples`, async () => {
      await navigate(); await configure({ profile: 'codex' });
      staticState.holdNextVersion = true; const dataIndex = staticState.held.length;
      const cursor = mark(); await selectScenario('fingerprint');
      const held = await until(() => staticState.held[dataIndex], 'held local reference VERSION request');
      assert.equal(await start(), true);
      await cdp.evaluate(action => {
        if (action === 'scenario') document.querySelector('[data-scenario="iq_test_3"]').click();
        else document.getElementById('stopTestBtn').click();
      }, action);
      held.release();
      await until(() => cdp.evaluate(() => document.getElementById('fingerprintDataRow').classList.contains('is-ready')), 'real local reference data decoded', 25000);
      await paint(); await pause(100);
      assert.equal(captured(cursor).upstream.length, 0); assert.equal(captured(cursor).proxy.length, 0);
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), false);
      assert.equal(await cdp.evaluate(() => document.querySelectorAll('.fingerprint-prediction').length), 0);
      const reference = staticRequests.filter(req => /assets\/(?:data|vendor)\/lmfpd\//.test(req.url));
      assert.ok(reference.some(req => req.url.includes('shared_detector.bin')));
      for (const req of reference) { assert.equal(req.headers[controlHeader], undefined); assert.equal(req.headers.originator, undefined); }
    });
    const readyFingerprint = async () => {
      await until(() => cdp.evaluate(() => document.getElementById('fingerprintDataRow').classList.contains('is-ready') &&
        document.querySelectorAll('.fingerprint-sample').length === 3), 'fingerprint data and challenges ready', 25000);
      await cdp.evaluate(() => document.querySelector('#fingerprintMode [data-mode="api"]').click());
    };
    const assertFingerprint = result => {
      assert.equal(result.fingerprint.error, ''); assert.match(result.fingerprint.status, /\u8bc4\u5206\u5b8c\u6210/);
      assert.equal(result.fingerprint.samples.length, 3);
      for (const sample of result.fingerprint.samples) assert.ok(sample.className.includes('is-done'), JSON.stringify(sample));
      assert.match(result.fingerprint.result, /3 \/ 3/);
      assert.ok(result.fingerprint.result.includes('shared-detector-v2'));
    };
    for (const [i, protocol] of protocols.entries()) await check(`fingerprint ${protocol}: three native API samples score with real core/reference and global profile`, async () => {
      const profile = profiles[i]; await configure({ profile, protocol, scenario: 'fingerprint' }); await readyFingerprint();
      await cdp.evaluate(() => { document.getElementById('fingerprintParallelToggle').checked = true; });
      const cursor = mark(); const result = await run(); const records = captured(cursor); assertRoute(records, true, profile !== 'default');
      assert.equal(records.upstream.length, 3); assertFingerprint(result);
      for (const req of records.upstream) { assert.equal(req.protocol, protocol); assert.equal(req.kind, 'fingerprint');
        if (profile !== 'default') assertIdentity(req, profile); }
      report.observations[`fingerprint-${protocol}`] = { requestIds: records.upstream.map(req => req.id), status: result.fingerprint.status };
    });
    for (const parallel of [true, false]) await check(`fingerprint ${parallel ? 'parallel' : 'serial'} snapshot and retry retain original round context`, async () => {
      await configure({ profile: 'codex', scenario: 'fingerprint', custom: { 'X-Run-Snapshot': 'fp-original' } }); await readyFingerprint();
      await cdp.evaluate(value => { document.getElementById('fingerprintParallelToggle').checked = value; }, parallel);
      mock.holdCount = parallel ? 3 : 1; const index = mock.held.length, cursor = mark(); await start();
      await until(() => mock.held.length === index + (parallel ? 3 : 1), 'fingerprint sample scheduling');
      if (parallel) assert.ok(mock.held.slice(index).every(held => !held.record.finishedAt));
      else assert.equal(captured(cursor).upstream.length, 1, 'Serial second sample waits for first response');
      await cdp.evaluate(() => { document.getElementById('model').value = 'changed-fp'; document.getElementById('apiKey').value = 'changed-key';
        document.getElementById('profileCustomHeaders').value = '{"X-Run-Snapshot":"changed"}'; });
      mock.held.slice(index).forEach(held => held.release()); assertFingerprint(await finish());
      const records = captured(cursor); assertRoute(records, true, true); assert.equal(records.upstream.length, 3);
      records.upstream.forEach(req => { assertIdentity(req, 'codex'); assert.equal(req.headers.authorization, 'Bearer ' + fakeKey);
        assert.equal(req.headers['x-run-snapshot'], 'fp-original'); });
      if (!parallel) assert.ok(records.upstream[1].startedAt >= records.upstream[0].finishedAt);
      const retryCursor = mark();
      await cdp.evaluate(() => document.querySelector('.fingerprint-sample [data-action="retry"]').click());
      await until(() => captured(retryCursor).upstream.length === 1, 'single sample retry sent'); assertFingerprint(await finish());
      const retry = captured(retryCursor); assertRoute(retry, true, true); assertIdentity(retry.upstream[0], 'codex');
      assert.equal(retry.upstream[0].headers['x-run-snapshot'], 'fp-original'); assert.equal(retry.upstream[0].headers.authorization, 'Bearer ' + fakeKey);
    });
    await check('fingerprint manual scores without API key/model requests and changes shared run label; regenerate and clear work', async () => {
      await configure({ scenario: 'fingerprint', apiKey: '' }); await readyFingerprint();
      await cdp.evaluate(() => document.querySelector('#fingerprintMode [data-mode="manual"]').click());
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').textContent), '\u8bc4\u5206');
      const cursor = mark();
      await cdp.evaluate(() => {
        document.querySelectorAll('.fingerprint-sample-textarea').forEach((el, index) => {
          let seed = 9341 + index;
          el.value = Array.from({ length: 320 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % 355 + 1; }).join(', ');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
      const result = await run(); assert.match(result.fingerprint.status, /\u8bc4\u5206\u5b8c\u6210/);
      assert.match(result.fingerprint.result, /3 \/ 3/); assert.equal(captured(cursor).upstream.length, 0);
      const before = await cdp.evaluate(() => document.querySelector('.fingerprint-sample-prompt pre').textContent);
      await cdp.evaluate(() => document.getElementById('fingerprintRegenerateBtn').click()); await finish();
      assert.notEqual(await cdp.evaluate(() => document.querySelector('.fingerprint-sample-prompt pre').textContent), before);
      await cdp.evaluate(() => document.getElementById('clearBtn').click());
      assert.equal(await cdp.evaluate(() => document.querySelectorAll('.fingerprint-prediction').length), 0);
    });
    await check('fingerprint sampling exits cancel real pending samples and leave no late scoring', async () => {
      await configure({ profile: 'gemini', scenario: 'fingerprint' }); await readyFingerprint();
      await cdp.evaluate(() => { document.getElementById('fingerprintParallelToggle').checked = true; });
      mock.holdCount = 3; const index = mock.held.length; await start();
      await until(() => mock.held.length === index + 3, 'three held fingerprint samples');
      await selectScenario('iq_test_3');
      await until(() => mock.held.slice(index).every(held => held.record.abortedAt), 'all fingerprint sample connections aborted');
      assert.equal(await cdp.evaluate(() => document.getElementById('fingerprintPanel').hidden), true);
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), false);
      assert.equal(await cdp.evaluate(() => document.querySelectorAll('.fingerprint-prediction').length), 0);
    });
    for (const action of ['protocol', 'proxy', 'stop', 'clear']) await check(`fingerprint ${action}: shared navigation/control cancels sampling without late requests`, async () => {
      await configure({ profile: 'codex', scenario: 'fingerprint' }); await readyFingerprint();
      await cdp.evaluate(() => { document.getElementById('fingerprintParallelToggle').checked = false; });
      mock.holdCount = 1; const index = mock.held.length, cursor = mark(); await start();
      const held = await until(() => mock.held[index], 'serial fingerprint request held');
      await cdp.evaluate(action => {
        if (action === 'protocol') document.querySelector('[data-vendor="google"]').click();
        else if (action === 'proxy') document.getElementById('httpsProxyToggle').click();
        else document.getElementById(action === 'stop' ? 'stopTestBtn' : 'clearBtn').click();
      }, action);
      await until(() => held.record.abortedAt, 'fingerprint upstream cancellation'); await finish(); await paint();
      assert.equal(captured(cursor).upstream.length, 1, 'Serial remaining samples must never be sent');
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), false);
      assert.equal(await cdp.evaluate(() => document.querySelectorAll('.fingerprint-prediction').length), 0);
    });
    await check('fingerprint Gemini streaming inherits shared stream toggle and scores all three native SSE responses', async () => {
      await configure({ profile: 'gemini', scenario: 'fingerprint', stream: true }); await readyFingerprint();
      const cursor = mark(); assertFingerprint(await run()); const records = captured(cursor); assertRoute(records, true, true);
      assert.equal(records.upstream.length, 3);
      for (const req of records.upstream) { assert.equal(req.stream, true); assert.equal(req.protocol, 'google');
        assert.equal(new URL(req.url, tlsOrigin).searchParams.get('alt'), 'sse'); assertIdentity(req, 'gemini'); }
    });
    for (const profile of ['default', 'gemini']) await check(`ordinary ${profile} UI SSE delivers first valid chunk before explicit upstream EOF`, async () => {
      await configure({ profile, stream: true }); const index = mock.streams.length, cursor = mark();
      await start(); const session = await until(() => mock.streams[index], 'ordinary SSE upstream');
      await until(() => cdp.evaluate(() => document.querySelector('#messageTimeline .assistant .answer-content')?.textContent.includes('first-chunk')),
        'first parsed chunk visible in actual UI');
      assert.equal(session.res.writableEnded, false); assert.equal(session.record.finishedAt, undefined);
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), true);
      const observedAt = Date.now(); session.release(); await finish(); assertRoute(captured(cursor), true, profile !== 'default');
      assert.ok(await cdp.evaluate(() => document.getElementById('messageTimeline').textContent.includes('first-chunk-last-chunk')));
      if (profile === 'gemini') { assertIdentity(session.record, profile); assert.equal(new URL(session.record.url, tlsOrigin).searchParams.get('alt'), 'sse'); }
      report.observations[`sse-${profile}`] = { requestId: session.record.id, observedAt, upstreamReleasedAt: session.record.releasedAt };
    });
    await check('shared stop/clear cancel ordinary SSE and clear ordinary/diagnostic results', async () => {
      await configure({ stream: true }); const index = mock.streams.length; await start();
      const session = await until(() => mock.streams[index], 'SSE open for shared stop');
      await cdp.evaluate(() => document.getElementById('stopTestBtn').click());
      await until(() => session.record.abortedAt, 'ordinary stream upstream abort'); await finish();
      await cdp.evaluate(() => document.getElementById('clearBtn').click());
      assert.equal(await cdp.evaluate(() => document.getElementById('messageTimeline').textContent), '');
      await configure({ scenario: 'structured' }); assertDiagnostic(await run());
      await cdp.evaluate(() => document.getElementById('clearBtn').click());
      assert.equal(await cdp.evaluate(() => document.querySelectorAll('.capability-result').length), 0);
    });
    for (const status of [200, 401]) for (const action of ['stop', 'diagnostic', 'protocol', 'new-run']) {
      await check(`delayed JSON ${status}: UI ${action} cancels after headers without stale rendering or logs`, async () => {
        await configure();
        const oldMarker = `cancelled-json-${status}-${action}`;
        const nextMarker = `current-json-${status}-${action}`;
        const responseCursor = cdp.responses.length, consoleCursor = cdp.consoleErrors.length;
        const cursor = mark(), bodyIndex = mock.delayedBodies.length;
        await cdp.evaluate(marker => {
          document.getElementById('userInput').value = marker;
        }, oldMarker);
        mock.delayedJsonNext = { status, marker: oldMarker };
        assert.equal(await start(), true);
        const delayed = await until(() => mock.delayedBodies[bodyIndex], 'JSON prefix flushed without final byte');
        const browserResponse = await until(() => cdp.responses.slice(responseCursor).find(response =>
          response.status === status && response.url === proxyOrigin + '/proxy/' + tlsOrigin + '/v1/chat/completions'),
        'native browser received delayed JSON response headers');
        assert.equal(delayed.record.status, status);
        assert.ok(delayed.record.delayedJson.prefixBytes > 4096);
        assert.equal(delayed.res.writableEnded, false, 'Upstream must remain open at the body-read boundary');
        assert.equal(delayed.record.finishedAt, undefined);
        assert.equal(delayed.record.delayedJson.releaseAttemptAt, undefined);
        assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), true);
        assertRoute(captured(cursor));

        const snapshot = () => cdp.evaluate(() => {
          const $ = id => document.getElementById(id);
          return {
            protocol: window.APITestBridge.getRequestContext().protocol,
            scenario: document.querySelector('#testType .active').dataset.scenario,
            timeline: $('messageTimeline').textContent,
            debug: Array.from(document.querySelectorAll('#blocksContainer .code-block')).map(block => ({
              title: block.querySelector('.title').textContent,
              bodies: Array.from(block.querySelectorAll('pre')).map(pre => pre.textContent),
            })),
            errors: Array.from(document.querySelectorAll('.error-inline')).map(el => el.textContent),
            mainError: $('errorMessage').textContent,
            waiting: $('waitingContainer').textContent.replace(/\d+:\d+/g, '<elapsed>'),
            diagnosticStatus: $('capabilityStatus').textContent,
            diagnosticResults: $('capabilityResults').textContent,
            runDisabled: $('testBtn').disabled, runLabel: $('testBtn').textContent,
            stopDisabled: $('stopTestBtn').disabled,
          };
        });
        const settle = () => cdp.evaluate(async () => {
          await Promise.resolve();
          await new Promise(resolve => setTimeout(resolve, 0));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.resolve();
        });
        const heldIndex = mock.held.length;
        if (action === 'new-run') mock.holdCount = 1;
        await cdp.evaluate(({ action, nextMarker }) => {
          if (action === 'diagnostic') document.querySelector('#testType [data-scenario="structured"]').click();
          else if (action === 'protocol') document.querySelector('#vendorType [data-vendor="anthropic"]').click();
          else {
            document.getElementById('stopTestBtn').click();
            if (action === 'new-run') {
              document.getElementById('userInput').value = nextMarker;
              document.getElementById('testBtn').click();
            }
          }
        }, { action, nextMarker });

        // Capture the current owner immediately after the UI action. Compare
        // semantic content, excluding elapsed-time titles and timer text.
        const current = await snapshot();
        const next = action === 'new-run' ? await until(() => mock.held[heldIndex], 'new ordinary request held before headers') : null;
        await until(() => delayed.record.abortedAt, 'delayed JSON upstream disconnected by UI cancellation');
        const browserAbort = await until(() => cdp.loadingFailures.find(failure => failure.requestId === browserResponse.requestId),
          'native browser reported canceled response body');
        assert.equal(browserAbort.canceled, true);
        assert.equal(delayed.record.finishedAt, undefined);
        delayed.release();
        assert.equal(delayed.record.delayedJson.disconnectedAtRelease, true);
        await settle();
        const afterRelease = await snapshot();
        assert.deepEqual(afterRelease, current, 'Canceled request must not overwrite the current UI owner');
        assert.deepEqual(cdp.consoleErrors.slice(consoleCursor), [], 'Cancellation must not log a handled HTTP/network error');
        assert.deepEqual(afterRelease.errors, []);
        assert.equal(afterRelease.mainError, '');
        assert.equal(afterRelease.runDisabled, action === 'new-run');
        assert.equal(afterRelease.stopDisabled, action !== 'new-run');
        if (action === 'stop') {
          assert.equal(afterRelease.debug.length, 1, 'Stop preserves only the original request debug block');
          assert.equal(afterRelease.waiting, '');
          assert.equal(await cdp.evaluate(() => document.querySelectorAll('#messageTimeline .assistant').length), 0);
        } else {
          assert.ok(!JSON.stringify(afterRelease).includes(oldMarker), 'Old response/request must not reappear after navigation or rerun');
          if (action === 'diagnostic') {
            assert.equal(afterRelease.scenario, 'structured'); assert.equal(afterRelease.debug.length, 0);
          } else if (action === 'protocol') {
            assert.equal(afterRelease.protocol, 'anthropic'); assert.equal(afterRelease.debug.length, 0);
          }
        }
        if (next) {
          assert.ok(afterRelease.timeline.includes(nextMarker));
          assert.equal(afterRelease.debug.length, 1);
          next.release();
          const result = await finish();
          assert.equal(result.mainError, ''); assert.ok(result.timeline.includes('OK'));
          const completed = await snapshot(); await settle();
          assert.deepEqual(await snapshot(), completed, 'Old completion must not alter new completed messages or controls');
          assert.ok(!JSON.stringify(completed).includes(oldMarker));
          assert.equal(completed.errors.length, 0); assert.equal(completed.waiting, '');
        }
        assert.deepEqual(cdp.consoleErrors.slice(consoleCursor), []);
        assertRoute(captured(cursor));
        report.observations.delayedJsonCancellation ||= [];
        report.observations.delayedJsonCancellation.push({ status, action, requestId: delayed.record.id,
          browserRequestId: browserResponse.requestId, browserStatus: browserResponse.status,
          partialBytes: delayed.record.delayedJson.prefixBytes, abortedAt: delayed.record.abortedAt,
          releasedAt: delayed.record.delayedJson.releaseAttemptAt, nativeCanceled: browserAbort.canceled,
          newRequestId: next?.record.id, currentScenario: afterRelease.scenario });
      });
    }
    await check('ordinary empty/nonempty HTTP statusText errors mask title/raw/copy and exact handled console logs', async () => {
      for (const emptyStatusText of [true, false]) {
        await configure(); const cursor = mark(), consoleCursor = cdp.consoleErrors.length, responseCursor = cdp.responses.length;
        mock.echoNext = { header: 'authorization', tokenOnly: true, emptyStatusText }; await run();
        const records = captured(cursor); assertRoute(records); assert.equal(records.upstream[0].status, 401);
        const response = await until(() => cdp.responses.slice(responseCursor).find(item => item.status === 401), 'browser error response');
        assert.equal(response.statusText, emptyStatusText ? '' : 'Unauthorized');
        assert.equal(records.proxy[0].statusText, response.statusText); assert.equal(records.upstream[0].statusText, response.statusText);
        const expected = emptyStatusText ? 'HTTP 401: credential rejected: ***' : 'HTTP 401 Unauthorized';
        const display = await surfaces(); assert.equal(display.title, '\u9519\u8bef\uff1a' + expected);
        assert.match(display.raw, /credential rejected: \*\*\*/); assert.ok(display.copiedCount > 0);
        assert.match(display.copied, /Bearer \*\*\*/);
        const { localStorage, sessionStorage, ...visible } = display;
        // recentConnections already stores the main key; custom credentials
        // remain page-only. Every display, copy and log must mask both kinds.
        assertNoSecret({ ...visible, console: JSON.stringify(cdp.consoleErrors) }, secrets);
        assertNoSecret({ localStorage, sessionStorage }, secrets.filter(token => token !== fakeKey));
        const event = [{ type: 'string', text: expected }]; assert.deepEqual(cdp.consoleErrors.slice(consoleCursor), [event]);
        expectedConsoleErrors.push(event);
      }
    });
    await check('reload persists proxy settings alone beyond existing recent connections; profile/custom/enhanced never persist', async () => {
      await configure({ profile: 'codex', custom: { Authorization: `Bearer ${customToken}` } });
      const stored = await cdp.evaluate(() => ({ ...localStorage })); assert.equal(stored.httpProxyUrl, proxyOrigin); assert.equal(stored.httpsProxyEnabled, '1');
      assertNoSecret(stored, [customToken]);
      assert.deepEqual(Object.keys(stored).filter(name => name !== 'recentConnections').sort(), ['httpProxyUrl', 'httpsProxyEnabled']);
      await navigate();
      assert.deepEqual(await cdp.evaluate(() => ({ proxy: document.getElementById('httpProxyUrl').value,
        enabled: document.getElementById('httpsProxyToggle').checked, profile: document.querySelector('#profileSelect .active').dataset.profile,
        custom: document.getElementById('profileCustomHeaders').value, basic: document.getElementById('profileBasic').checked })),
      { proxy: proxyOrigin, enabled: true, profile: 'default', custom: '', basic: true });
    });
    await configure({ profile: 'codex', scenario: 'needle', custom: { 'x-client-name': 'browser-e2e' } });
    assertDiagnostic(await run());
    await cdp.evaluate(() => { document.getElementById('apiKey').value = ''; document.getElementById('modelDropdown').style.display = 'none';
      document.getElementById('recentDropdown').style.display = 'none'; });
    for (const width of [375, 768, 1024, 1440]) await check(`responsive ${width}px: global config/scenarios/shared controls reachable without overflow`, async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 375 }); await paint();
      const layout = await cdp.evaluate(() => {
        const selectors = ['#proxyToggle', '#httpProxyUrl', 'label[for="httpsProxyToggle"]', '#profileSelect [data-profile="codex"]',
          '#profileAdvancedDetails summary', 'label[for="profileEnhanced"]', '#profileCustomHeaders',
          '#testType [data-scenario="needle"]', '#needleTokens', '#testBtn', '#clearBtn'];
        const controls = selectors.map(selector => {
          const el = document.querySelector(selector); el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          const rect = el.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          const input = el.control || el; input.focus({ preventScroll: true });
          return { selector, left: rect.left, right: rect.right, width: rect.width, height: rect.height,
            inViewport: rect.top >= 0 && rect.bottom <= innerHeight, hit: !!hit && (hit === el || el.contains(hit)),
            focused: document.activeElement === input, disabled: !!input.disabled };
        });
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, controls };
      });
      assert.equal(layout.viewport, width); assert.ok(layout.documentWidth <= width + 1); assert.ok(layout.bodyWidth <= width + 1);
      for (const control of layout.controls) { assert.ok(control.width > 0 && control.height > 0); assert.ok(control.left >= -1 && control.right <= width + 1);
        assert.equal(control.inViewport, true, JSON.stringify(control)); assert.equal(control.hit, true, JSON.stringify(control));
        assert.equal(control.focused, true, JSON.stringify(control)); assert.equal(control.disabled, false, JSON.stringify(control)); }
      report.observations[`layout-${width}`] = layout;
    });
    await check('desktop/mobile artifacts show expanded global profile and selected diagnostic/fingerprint without secrets', async () => {
      for (const [name, width] of [['desktop', 1440], ['mobile', 375]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width === 375 });
        for (const [section, selector] of [['settings', '#globalProfileSettings'], ['diagnostic', '#needleParams'], ['fingerprint', '#fingerprintPanel']]) {
          if (section === 'fingerprint') { await selectScenario('fingerprint'); await readyFingerprint(); }
          else if (section === 'settings') await selectScenario('needle');
          await cdp.evaluate(selector => {
            document.getElementById('profileAdvancedDetails').open = true; document.getElementById('profileCustomHeadersDetails').open = true;
            document.querySelector(selector).scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }); document.activeElement?.blur();
          }, selector);
          await paint();
          const display = await cdp.evaluate(() => ({ text: document.body.textContent, key: document.getElementById('apiKey').value,
            custom: document.getElementById('profileCustomHeaders').value }));
          assert.equal(display.key, ''); assertNoSecret(display, secrets);
          const data = await cdp.send('Page.captureScreenshot', { format: 'png' }); const buffer = Buffer.from(data.data, 'base64');
          assert.equal(buffer.subarray(1, 4).toString(), 'PNG'); const file = path.join(artifacts, `${name}-${section}.png`);
          await writeFile(file, buffer); report.screenshots.push({ file, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
        }
      }
    });
    await check('stable source, native fetch, zero runtime/mock errors and only exact expected safe console messages', async () => {
      assert.deepEqual(await sourceHashes(), report.sourceHashes, 'Source changed during run: rerun after source is stable');
      assert.deepEqual(cdp.exceptions, []); assert.deepEqual(mock.errors, []); assert.equal(expectedConsoleErrors.length, 2);
      assert.deepEqual(cdp.consoleErrors, expectedConsoleErrors);
      assert.deepEqual(cdp.requests.filter(req => /^https?:/.test(req.url) && new URL(req.url).hostname !== '127.0.0.1'), []);
      assert.equal(await cdp.evaluate(() => /\[native code\]/.test(fetch.toString())), true);
      assertNoSecret({ console: JSON.stringify(cdp.consoleErrors) }, secrets);
    });
  } catch (error) {
    report.checks.push({ name: 'harness setup/execution', passed: false, error: redactText(error.stack || error.message) });
    console.error(redactText(error.stack || error.message));
  } finally {
    clearTimeout(watchdog); cdp?.close(); await terminate(chrome);
    for (const held of staticState.held) held.release();
    await Promise.all(shutdown.reverse().map(close => close()));
    assert.equal(path.dirname(profileDir), artifacts); await rm(profileDir, { recursive: true, force: true });
    report.counts = { passed: report.checks.filter(item => item.passed).length, failed: report.checks.filter(item => !item.passed).length,
      upstreamRequests: upstream.filter(req => req.method !== 'OPTIONS').length, proxyRequests: proxyRequests.filter(req => req.method !== 'OPTIONS').length,
      proxyPreflights: proxyRequests.filter(req => req.method === 'OPTIONS').length,
      runtimeExceptions: cdp?.exceptions.length || 0, consoleErrors: cdp?.consoleErrors.length || 0 };
    await writeFile(path.join(artifacts, 'network-evidence.json'), JSON.stringify(safe({ upstream, proxyRequests, staticRequests,
      browserRequests: cdp?.requests || [], browserResponses: cdp?.responses || [],
      browserLoadingFailures: cdp?.loadingFailures || [] }), null, 2) + '\n');
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n');
    console.log(JSON.stringify(report.counts)); console.log(`Report: ${path.join(artifacts, 'report.json')}`);
    report.screenshots.forEach(item => console.log(`Screenshot: ${item.file}`));
    process.exitCode = report.counts.failed ? 1 : 0;
  }
}

if (process.argv[2] === '--trusted-run') await main(process.argv[3]);
else await bootstrap();
