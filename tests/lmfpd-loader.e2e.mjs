import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, mkdir, realpath, stat, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from the repository root: node tests/lmfpd-loader.e2e.mjs
// Real Chrome SRI, Web Crypto, IndexedDB and local HTTP; no fetch replacement.
const root = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = '/tmp/opencode';
const corePath = '/assets/vendor/lmfpd/lmfpd-core.js';
const versionPath = '/assets/data/lmfpd/VERSION.json';
const modelsPath = '/assets/data/lmfpd/models.json';
const detectorPath = '/assets/data/lmfpd/shared_detector.bin';
const chromeBin = process.env.APITEST_E2E_CHROME || '/usr/bin/google-chrome';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(probe, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), pause(1500).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, pause(1500)]);
}

class CDP {
  constructor(socket) {
    Object.assign(this, { socket, serial: 0, pending: new Map(), requests: [], logs: [], exceptions: [], consoleErrors: [] });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method === 'Network.requestWillBeSent') {
        const { url, method } = message.params.request;
        this.requests.push({ url, method });
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        const { source, text, url } = message.params.entry;
        this.logs.push({ source, text, url });
      } else if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails;
        this.exceptions.push(detail.exception?.description || detail.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description));
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP closed'));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function sourceHashes() {
  const files = ['index.html', 'assets/js/script.js', 'assets/js/fingerprint.js', 'assets/js/capability.js',
    corePath.slice(1), versionPath.slice(1), modelsPath.slice(1), detectorPath.slice(1), 'assets/vendor/lmfpd/LICENSE'];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, file)))])));
}

async function main() {
  assert.ok((await stat(tempRoot)).isDirectory());
  assert.equal(await realpath(tempRoot), tempRoot);
  const artifacts = await mkdtemp(path.join(tempRoot, 'lmfpd-loader-e2e-'));
  const profileDir = path.join(artifacts, 'chrome-profile');
  await mkdir(profileDir);
  console.log(`Artifacts: ${artifacts}`);
  const report = { command: 'node tests/lmfpd-loader.e2e.mjs', artifacts, checks: [], observations: {}, screenshots: [],
    runtime: 'Native Chrome + local HTTP assets, actual browser SRI/Web Crypto/IndexedDB; no external API or deployed-update claim',
    limitations: ['Second bundle is a local byte-change fixture with the same algorithm and dataset, not a validated upstream release.',
      'SHA calls are observed through a wrapper that delegates every call to the native SubtleCrypto implementation.'] };
  const network = [], cases = [], expectedLogs = [];
  let chrome, cdp, watchdog;
  const check = async (name, action) => {
    try { await action(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); return true; }
    catch (error) {
      report.checks.push({ name, passed: false, error: error.stack || error.message });
      console.error(`FAIL ${name}\n${error.stack || error.message}`);
      if (cdp) await cdp.evaluate(() => document.getElementById('stopTestBtn')?.click()).catch(() => {});
      for (const item of cases) item.releaseAll();
      return false;
    }
  };
  try {
    report.sourceHashes = await sourceHashes();
    const [core, models, detector, versionBytes, fixtureBytes] = await Promise.all([
      corePath, modelsPath, detectorPath, versionPath, '/tests/fixtures/lmfpd-sync/analyze-supported.json',
    ].map(file => readFile(path.join(root, file))));
    const manifestA = JSON.parse(versionBytes);
    assert.equal(sha(core), manifestA.bundle_sha256);
    assert.equal(sha(models), manifestA.models_sha256);
    assert.equal(sha(detector), manifestA.detector_sha256);
    const coreB = Buffer.concat([core, Buffer.from('\n/* Local E2E second-bundle fixture; algorithm and bank unchanged. */\n')]);
    const manifestB = { ...manifestA, upstream_ref: 'b'.repeat(40), bundle_sha256: sha(coreB) };
    const legacy = { ...manifestA };
    delete legacy.bundle_sha256; delete legacy.license_sha256;
    const wrongCore = Buffer.concat([core, Buffer.from('\n;globalThis.__wrongBundleExecuted = true;\n')]);
    const badModels = Buffer.concat([models, Buffer.from('\n ')]);
    const badDetector = Buffer.from(detector);
    badDetector[badDetector.length - 1] ^= 1;
    const fixture = JSON.parse(fixtureBytes).cases.find(item => item.expected.decision === 'scored' && item.outputs.length === 3);
    assert.ok(fixture, 'Supported conformance fixture must have three scored outputs');
    const cacheKey = manifestA.built_at + ':' + manifestA.detector_sha256;
    const unrelatedKey = 'loader-e2e-unrelated-version';
    report.observations.fixtures = { current: manifestA, secondBundle: manifestB, byteSizes: {
      core: core.length, models: models.length, detector: detector.length }, manualFixture: fixture.name };

    chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      '--window-size=1280,1100', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let chromeDiagnostic = '';
    chrome.stderr.on('data', chunk => { chromeDiagnostic = (chromeDiagnostic + chunk).slice(-5000); });
    chrome.on('error', error => { chromeDiagnostic += error.message; });
    watchdog = setTimeout(() => { void terminate(chrome); }, 150000);
    const port = await until(async () => {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chromeDiagnostic}`);
      try { return Number((await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }, 'Chrome debugging port');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await Promise.race([once(ws, 'open'), pause(5000).then(() => { throw new Error('CDP open timeout'); })]);
    cdp = new CDP(ws);
    await Promise.all(['Runtime.enable', 'Page.enable', 'Network.enable', 'Log.enable'].map(method => cdp.send(method)));
    report.observations.browser = await cdp.send('Browser.getVersion');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__loaderHashes = [];
      const nativeDigest = SubtleCrypto.prototype.digest;
      SubtleCrypto.prototype.digest = function (algorithm, data) {
        const entry = { algorithm: typeof algorithm === 'string' ? algorithm : algorithm.name,
          bytes: data.byteLength, audit: !!window.__loaderAudit };
        window.__loaderHashes.push(entry);
        return Reflect.apply(nativeDigest, this, [algorithm, data]).then(result => {
          entry.sha256 = Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('');
          return result;
        });
      };
    })();` });

    const serve = async (label, options = {}) => {
      const state = { manifest: manifestA, failVersion: 0, overrideCore: null, overrideModels: null, overrideDetector: null,
        holdPath: null, held: [], ...options };
      const sockets = new Set();
      const records = [];
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const record = { id: network.length + 1, case: label, method: req.method, path: url.pathname, url: req.url, startedAt: Date.now() };
        network.push(record); records.push(record);
        res.on('finish', () => { record.finishedAt = Date.now(); });
        try {
          if (req.method !== 'GET') {
            record.modelRequest = true;
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: fixture.outputs[0].text } }] }));
            return;
          }
          if (url.pathname === versionPath && state.failVersion > 0) {
            state.failVersion--; record.status = 503;
            res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":"local version failure"}');
            return;
          }
          let bytes;
          if (url.pathname === versionPath) bytes = Buffer.from(JSON.stringify(state.manifest));
          else if (url.pathname === corePath) bytes = state.overrideCore || (url.searchParams.get('v') === manifestB.bundle_sha256 ? coreB : core);
          else if (url.pathname === modelsPath) bytes = state.overrideModels || models;
          else if (url.pathname === detectorPath) bytes = state.overrideDetector || detector;
          else {
            const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
            const file = path.resolve(root, '.' + pathname);
            if (!file.startsWith(root) || (pathname !== '/index.html' && !pathname.startsWith('/assets/'))) {
              res.writeHead(403).end(); return;
            }
            bytes = await readFile(file);
          }
          record.bytes = bytes.length;
          record.sha256 = sha(bytes);
          const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
          const release = () => {
            if (res.destroyed || res.writableEnded) return;
            record.status = 200;
            res.writeHead(200, { 'Content-Type': mime[path.extname(url.pathname)] || 'application/octet-stream',
              'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
            res.end(bytes);
          };
          if (state.holdPath === url.pathname) {
            state.holdPath = null;
            const timer = setTimeout(release, 12000);
            res.once('close', () => clearTimeout(timer));
            state.held.push({ record, release() { clearTimeout(timer); release(); } });
          } else release();
        } catch (error) {
          record.error = error.message;
          if (!res.headersSent) res.writeHead(500).end('Local loader harness failed');
          else res.destroy();
        }
      });
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      const item = { label, state, records, origin, count: pathname => records.filter(req => req.path === pathname).length,
        releaseAll() { state.held.forEach(held => held.release()); },
        async close() {
          item.releaseAll(); const closed = new Promise(resolve => server.close(resolve));
          server.closeAllConnections(); sockets.forEach(socket => socket.destroy());
          await Promise.race([closed, pause(1000)]);
        } };
      cases.push(item);
      return item;
    };
    const navigate = async env => {
      const before = await cdp.evaluate(() => performance.timeOrigin);
      await cdp.send('Page.navigate', { url: env.origin + '/index.html' });
      await until(() => cdp.evaluate(previous => performance.timeOrigin !== previous && document.readyState === 'complete' &&
        !!window.APITestBridge, before), 'fresh application document');
    };
    const select = id => cdp.evaluate(id => document.querySelector(`#testType [data-scenario="${id}"]`).click(), id);
    const settled = async () => cdp.evaluate(async () => {
      await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const ready = () => until(() => cdp.evaluate(() => document.getElementById('fingerprintDataRow').classList.contains('is-ready') &&
      document.querySelectorAll('.fingerprint-sample').length === 3), 'verified real reference ready', 25000);
    const errorState = async pattern => {
      await until(() => cdp.evaluate(() => document.getElementById('fingerprintDataRow').classList.contains('is-error')), 'visible reference failure');
      const state = await cdp.evaluate(() => ({ error: document.getElementById('fingerprintError').textContent,
        visible: !document.getElementById('fingerprintError').hidden,
        retry: !document.getElementById('fingerprintDataRetryBtn').hidden,
        scored: !!document.querySelector('.fingerprint-prediction') }));
      assert.match(state.error, pattern); assert.equal(state.visible, true); assert.equal(state.retry, true); assert.equal(state.scored, false);
      return state;
    };
    const retry = async env => {
      const before = env.count(modelsPath) + env.count(corePath) + env.count(versionPath);
      // Exercise the explicit force-revalidation path, also when the ready UI
      // normally hides this retry control. No loader internals are exposed.
      await cdp.evaluate(() => document.getElementById('fingerprintDataRetryBtn').click());
      await until(() => env.count(modelsPath) + env.count(corePath) + env.count(versionPath) > before, 'retry issues native request');
      await ready();
    };
    const descriptor = () => cdp.evaluate(() => Array.from(document.scripts).filter(script => script.src.includes('/lmfpd/lmfpd-core.js'))
      .map(script => ({ src: script.src, integrity: script.integrity, crossOrigin: script.crossOrigin })));
    const hashes = () => cdp.evaluate(() => window.__loaderHashes.filter(entry => !entry.audit));
    const assertDataQueries = env => {
      for (const [pathname, hash] of [[modelsPath, manifestA.models_sha256], [detectorPath, manifestA.detector_sha256]]) {
        for (const request of env.records.filter(req => req.path === pathname)) assert.equal(new URL(request.url, env.origin).searchParams.get('v'), hash);
      }
    };
    const noModels = env => assert.equal(env.records.filter(req => req.modelRequest).length, 0, 'Reference load/manual score/cancel must not call model API');
    const seedIDB = (entries, clear = true) => cdp.evaluate(({ entries, clear }) => new Promise((resolve, reject) => {
      const request = indexedDB.open('apitest-lmfpd', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('detector');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('detector', 'readwrite'), store = tx.objectStore('detector');
        if (clear) store.clear();
        entries.forEach(([key, bytes]) => store.put(Uint8Array.from(bytes).buffer, key));
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }), { entries, clear });
    const cacheAudit = key => cdp.evaluate(key => new Promise((resolve, reject) => {
      const request = indexedDB.open('apitest-lmfpd', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('detector');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('detector', 'readonly'), get = tx.objectStore('detector').get(key);
        tx.oncomplete = () => db.close();
        get.onerror = () => reject(get.error);
        get.onsuccess = async () => {
          if (!get.result) { resolve(null); return; }
          const bytes = new Uint8Array(get.result);
          window.__loaderAudit = true;
          try {
            const result = await crypto.subtle.digest('SHA-256', bytes);
            resolve({ bytes: bytes.length, sha256: Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('') });
          } catch (error) { reject(error); }
          finally { window.__loaderAudit = false; }
        };
      };
    }), key);
    const manualScore = async env => {
      await ready();
      await cdp.evaluate(outputs => {
        document.getElementById('apiKey').value = '';
        document.querySelector('#fingerprintMode [data-mode="manual"]').click();
        document.querySelectorAll('.fingerprint-sample-textarea').forEach((el, i) => {
          el.value = outputs[i]; el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        document.getElementById('testBtn').click();
      }, fixture.outputs.map(output => output.text));
      await until(() => cdp.evaluate(() => !document.getElementById('testBtn').disabled &&
        document.getElementById('fingerprintStatus').textContent.includes('\u8bc4\u5206\u5b8c\u6210')), 'real manual scoring finished');
      const result = await cdp.evaluate(() => ({ status: document.getElementById('fingerprintStatus').textContent,
        prediction: document.querySelector('.fingerprint-prediction-name')?.textContent,
        text: document.getElementById('fingerprintResult').textContent,
        error: document.getElementById('fingerprintError').textContent }));
      assert.equal(result.error, ''); assert.ok(JSON.parse(models).models.some(model => model.display_name === result.prediction));
      assert.match(result.text, /3 \/ 3/); assert.match(result.text, /shared-detector-v2/); noModels(env);
      return { status: result.status, prediction: result.prediction };
    };

    await check('lazy VERSION acquisition shared by activation/data/manual run; native SRI and real 63-model scoring', async () => {
      const env = await serve('lazy-shared', { holdPath: versionPath }); await navigate(env);
      assert.equal(env.count(versionPath), 0); assert.equal(env.count(corePath), 0); assert.equal(env.count(detectorPath), 0);
      assert.equal(await cdp.evaluate(() => typeof window.LMFPD), 'undefined');
      assert.equal(await cdp.evaluate(() => /\[native code\]/.test(fetch.toString())), true);
      await select('fingerprint'); const held = await until(() => env.state.held[0], 'VERSION held before core');
      await cdp.evaluate(() => {
        document.querySelector('#fingerprintMode [data-mode="manual"]').click();
        document.getElementById('testBtn').click();
      });
      await settled(); assert.equal(env.count(versionPath), 1); assert.equal(env.count(corePath), 0); assert.equal(env.count(detectorPath), 0);
      held.release(); await ready();
      await until(() => cdp.evaluate(() => !document.getElementById('testBtn').disabled), 'initial shared manual operation settled');
      assert.equal(env.count(versionPath), 1); assert.equal(env.count(corePath), 1);
      assert.deepEqual(await descriptor(), [{ src: env.origin + corePath + '?v=' + manifestA.bundle_sha256,
        integrity: sri(core), crossOrigin: 'anonymous' }]);
      const version = env.records.find(req => req.path === versionPath), coreRequest = env.records.find(req => req.path === corePath);
      assert.ok(version.finishedAt <= coreRequest.startedAt, 'Core HTTP request starts only after VERSION response');
      assertDataQueries(env);
      const digests = await hashes();
      assert.ok(digests.some(item => item.sha256 === manifestA.models_sha256));
      assert.ok(digests.some(item => item.sha256 === manifestA.detector_sha256));
      report.observations.shared = { ...await manualScore(env), resources: env.records.filter(req => req.path.includes('lmfpd/')), digests };
    });
    await check('same-page reentry/force retry/score pins snapshot; new document adopts different valid bundle hash and SRI', async () => {
      const env = await serve('page-snapshot'); await navigate(env); await select('fingerprint'); await ready();
      await cdp.evaluate(() => { window.__initialLoaderCore = window.LMFPD; });
      env.state.manifest = manifestB;
      await select('iq_test_3'); await select('fingerprint'); await ready();
      await retry(env); const score = await manualScore(env);
      assert.equal(env.count(versionPath), 1); assert.equal(env.count(corePath), 1); assert.equal(env.count(detectorPath), 1);
      assert.equal(await cdp.evaluate(() => window.LMFPD === window.__initialLoaderCore), true);
      assert.ok((await hashes()).filter(item => item.sha256 === manifestA.detector_sha256).length >= 2, 'Memory cache is rehashed on retry');
      await navigate(env); await select('fingerprint'); await ready();
      assert.equal(env.count(versionPath), 2); assert.equal(env.count(corePath), 2);
      assert.deepEqual(await descriptor(), [{ src: env.origin + corePath + '?v=' + manifestB.bundle_sha256,
        integrity: sri(coreB), crossOrigin: 'anonymous' }]);
      assert.equal(env.records.filter(req => req.path === corePath).at(-1).sha256, manifestB.bundle_sha256);
      assert.equal(env.count(detectorPath), 1, 'Same verified bank may be reused from IndexedDB after core version changes');
      report.observations.pageSnapshot = { beforeRefresh: score, afterRefresh: await manualScore(env),
        oldBundle: manifestA.bundle_sha256, newBundle: manifestB.bundle_sha256 };
    });
    await check('wrong bundle bytes are blocked by Chrome SRI; unrelated window.LMFPD cannot bypass; pinned retry recovers', async () => {
      const env = await serve('native-sri', { overrideCore: wrongCore }); await navigate(env);
      await cdp.evaluate(() => {
        window.__unboundCoreCalls = 0;
        const unbound = () => { window.__unboundCoreCalls++; throw new Error('Unbound core was used'); };
        window.LMFPD = { parseNumbers: unbound, generateChallenges: unbound, decodeDetector: unbound, analyzeSharedOutputs: unbound };
      });
      const logStart = cdp.logs.length;
      await select('fingerprint'); const error = await errorState(/SHA-256/);
      assert.equal(await cdp.evaluate(() => window.__wrongBundleExecuted === true), false);
      assert.equal(await cdp.evaluate(() => window.__unboundCoreCalls), 0);
      assert.equal(await cdp.evaluate(() => typeof window.LMFPD), 'undefined'); assert.deepEqual(await descriptor(), []);
      assert.equal(env.count(modelsPath), 0); assert.equal(env.count(detectorPath), 0); noModels(env);
      const message = await until(() => cdp.logs.slice(logStart).find(log => log.text.includes('integrity')), 'native Chrome SRI security error');
      const resource = env.origin + corePath + '?v=' + manifestA.bundle_sha256;
      assert.equal(message.source, 'security');
      assert.equal(message.text, `Failed to find a valid digest in the 'integrity' attribute for resource '${resource}' with computed SHA-256 integrity '${createHash('sha256').update(wrongCore).digest('base64')}'. The resource has been blocked.`);
      assert.equal(cdp.logs.length - logStart, 1); expectedLogs.push(message);
      const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const screenshot = path.join(artifacts, 'sri-failure.png'); await writeFile(screenshot, Buffer.from(image.data, 'base64'));
      report.screenshots.push(screenshot);
      env.state.overrideCore = null; env.state.manifest = manifestB;
      await retry(env);
      assert.equal(env.count(versionPath), 1); assert.equal(env.count(corePath), 2);
      assert.ok(env.records.filter(req => req.path === corePath).every(req => req.url.endsWith(manifestA.bundle_sha256)));
      report.observations.sriBlock = { error, browserSecurityLog: message, recovered: await manualScore(env) };
    });
    for (const file of ['models', 'detector']) await check(`fresh ${file} wrong bytes fail SHA-256 visibly before model requests/scoring; retry pins VERSION`, async () => {
      const pathname = file === 'models' ? modelsPath : detectorPath;
      const env = await serve(`fresh-bad-${file}`, file === 'models' ? { overrideModels: badModels } : { overrideDetector: badDetector });
      await navigate(env); await select('fingerprint'); const error = await errorState(new RegExp((file === 'models' ? 'models\\.json' : 'shared_detector\\.bin') + ' SHA-256'));
      assert.equal(env.count(pathname), 1); noModels(env);
      if (file === 'models') assert.equal(env.count(detectorPath), 0);
      assert.equal(await cacheAudit(cacheKey), null, 'Fresh invalid bytes are never saved to IndexedDB');
      env.state.overrideModels = null; env.state.overrideDetector = null; await retry(env);
      assert.equal(env.count(versionPath), 1); assert.equal(env.count(pathname), 2);
      assertDataQueries(env); report.observations[`fresh-${file}`] = { error, recovered: await manualScore(env) };
    });
    await check('corrupt exact IndexedDB key refetches once and replaces only that key before real scoring', async () => {
      const env = await serve('corrupt-cache-repair'); await navigate(env);
      await seedIDB([[cacheKey, [9, 8, 7]], [unrelatedKey, [11, 12, 13]]]);
      await select('fingerprint'); await ready(); assert.equal(env.count(detectorPath), 1);
      assert.deepEqual(await cacheAudit(cacheKey), { bytes: detector.length, sha256: manifestA.detector_sha256 });
      assert.deepEqual(await cacheAudit(unrelatedKey), { bytes: 3, sha256: sha(Buffer.from([11, 12, 13])) });
      report.observations.cacheRepair = { detectorDownloads: env.count(detectorPath), scored: await manualScore(env) };
    });
    await check('corrupt IndexedDB plus corrupt fresh download refuses fallback; one explicit retry repairs same pinned version', async () => {
      const env = await serve('corrupt-cache-and-network', { overrideDetector: badDetector }); await navigate(env);
      await seedIDB([[cacheKey, [4, 5, 6]], [unrelatedKey, [11, 12, 13]]]);
      await select('fingerprint'); const error = await errorState(/shared_detector\.bin SHA-256/);
      assert.equal(env.count(detectorPath), 1); noModels(env);
      assert.deepEqual(await cacheAudit(cacheKey), { bytes: 3, sha256: sha(Buffer.from([4, 5, 6])) });
      env.state.overrideDetector = null; await retry(env);
      assert.equal(env.count(versionPath), 1); assert.equal(env.count(detectorPath), 2);
      assert.deepEqual(await cacheAudit(cacheKey), { bytes: detector.length, sha256: manifestA.detector_sha256 });
      assert.deepEqual(await cacheAudit(unrelatedKey), { bytes: 3, sha256: sha(Buffer.from([11, 12, 13])) });
      report.observations.noStaleFallback = { error, recovered: await manualScore(env) };
    });
    await check('new-document correct IndexedDB hit avoids binary HTTP and invokes real native SHA-256 again', async () => {
      const env = await serve('valid-idb'); await navigate(env); await select('fingerprint'); await ready();
      assert.equal(env.count(detectorPath), 1); await cacheAudit(cacheKey);
      await navigate(env); await select('fingerprint'); await ready();
      assert.equal(env.count(versionPath), 2); assert.equal(env.count(modelsPath), 2); assert.equal(env.count(detectorPath), 1);
      const verification = (await hashes()).filter(item => item.bytes === detector.length);
      assert.equal(verification.length, 1); assert.equal(verification[0].sha256, manifestA.detector_sha256);
      assert.equal(verification[0].algorithm, 'SHA-256');
      report.observations.verifiedIdbHit = { binaryRequestsAcrossDocuments: env.count(detectorPath), nativeDigest: verification[0], scored: await manualScore(env) };
    });
    await check('legacy manifest uses upstream-ref core query and still rejects bad data hashes before retry/scoring', async () => {
      const env = await serve('legacy', { manifest: legacy, overrideModels: badModels }); await navigate(env);
      await select('fingerprint'); await errorState(/models\.json SHA-256/);
      assert.deepEqual(await descriptor(), [{ src: env.origin + corePath + '?v=' + legacy.upstream_ref, integrity: '', crossOrigin: null }]);
      assert.equal(env.count(detectorPath), 0); noModels(env);
      env.state.overrideModels = null; await retry(env); assert.equal(env.count(versionPath), 1); assert.equal(env.count(corePath), 1);
      assertDataQueries(env); report.observations.legacy = await manualScore(env);
    });
    await check('VERSION HTTP failure remains retryable; only failed acquisition may fetch a newer manifest', async () => {
      const env = await serve('manifest-retry', { failVersion: 1 }); await navigate(env);
      const logStart = cdp.logs.length; await select('fingerprint'); await errorState(/VERSION\.json HTTP 503/);
      assert.equal(env.count(corePath), 0); assert.equal(env.count(versionPath), 1); noModels(env);
      const message = await until(() => cdp.logs.slice(logStart).find(log => log.source === 'network' && log.url === env.origin + versionPath), 'expected VERSION 503 browser log');
      assert.equal(message.text, 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)');
      assert.equal(cdp.logs.length - logStart, 1); expectedLogs.push(message);
      env.state.manifest = manifestB; await retry(env);
      assert.equal(env.count(versionPath), 2);
      assert.equal((await descriptor())[0].integrity, sri(coreB));
      report.observations.manifestRetry = { expectedNetworkLog: message, scored: await manualScore(env) };
    });
    await check('exit while verified-version binary is held never produces delayed automatic samples or scoring', async () => {
      const env = await serve('loading-exit', { holdPath: detectorPath }); await navigate(env); await select('fingerprint');
      const held = await until(() => env.state.held[0], 'actual binary request held');
      await cdp.evaluate(origin => {
        document.querySelector('#fingerprintMode [data-mode="api"]').click();
        document.getElementById('apiUrl').value = origin;
        document.getElementById('apiKey').value = 'local-loader-cancel-fixture';
        document.getElementById('model').value = 'local-loader-fixture';
        document.getElementById('streamToggle').checked = false;
        document.getElementById('testBtn').click();
      }, env.origin);
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), true);
      await select('iq_test_3'); held.release();
      await until(() => cdp.evaluate(() => document.getElementById('fingerprintDataRow').classList.contains('is-ready')), 'background local reference load complete');
      await settled(); noModels(env);
      assert.equal(await cdp.evaluate(() => document.getElementById('testBtn').disabled), false);
      assert.equal(await cdp.evaluate(() => document.getElementById('fingerprintPanel').hidden), true);
      assert.equal(await cdp.evaluate(() => document.querySelectorAll('.fingerprint-prediction').length), 0);
      assert.equal(env.count(versionPath), 1);
    });
    await check('source stable, fetch native, no model/external requests or unexpected console/runtime errors', async () => {
      assert.deepEqual(await sourceHashes(), report.sourceHashes, 'Source changed during focused browser run');
      assert.deepEqual(cdp.exceptions, []); assert.deepEqual(cdp.consoleErrors, []); assert.deepEqual(cdp.logs, expectedLogs);
      assert.equal(expectedLogs.length, 2, 'Only the exact SRI failure and VERSION 503 are expected');
      assert.equal(network.filter(req => req.modelRequest).length, 0);
      assert.deepEqual(network.filter(req => req.error), []);
      assert.deepEqual(cdp.requests.filter(req => /^https?:/.test(req.url) && new URL(req.url).hostname !== '127.0.0.1'), []);
      assert.equal(await cdp.evaluate(() => /\[native code\]/.test(fetch.toString())), true);
    });
  } catch (error) {
    report.checks.push({ name: 'harness setup/execution', passed: false, error: error.stack || error.message });
    console.error(error.stack || error.message);
  } finally {
    clearTimeout(watchdog);
    if (cdp) await cdp.send('Browser.close').catch(() => {});
    cdp?.close(); await terminate(chrome);
    await Promise.all(cases.map(env => env.close()));
    assert.equal(path.dirname(profileDir), artifacts);
    report.counts = { passed: report.checks.filter(item => item.passed).length, failed: report.checks.filter(item => !item.passed).length,
      versionRequests: network.filter(req => req.path === versionPath).length,
      coreRequests: network.filter(req => req.path === corePath).length,
      detectorRequests: network.filter(req => req.path === detectorPath).length,
      modelRequests: network.filter(req => req.modelRequest).length,
      runtimeExceptions: cdp?.exceptions.length || 0, expectedBrowserErrors: expectedLogs.length };
    await writeFile(path.join(artifacts, 'network-evidence.json'), JSON.stringify({ serverRequests: network, browserRequests: cdp?.requests || [],
      browserErrors: cdp?.logs || [], consoleErrors: cdp?.consoleErrors || [] }, null, 2) + '\n');
    await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log(JSON.stringify(report.counts)); console.log(`Report: ${path.join(artifacts, 'report.json')}`);
    process.exitCode = report.counts.failed ? 1 : 0;
  }
}

await main();
