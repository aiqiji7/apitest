import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const controllerSource = await readFile(new URL('assets/js/fingerprint.js', ROOT), 'utf8');
const CORE = 'assets/vendor/lmfpd/lmfpd-core.js';
const DATA = 'assets/data/lmfpd/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check, label = 'loader settled') {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(label);
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.style = {};
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
    };
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  querySelectorAll() { return []; }
  closest(selector) { return selector === '.seg-btn' && this.attributes['data-mode'] ? this : null; }
  emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn({ target: this, ...event }); }
}

function fixture({ legacy = false, revision = 'a', mutateModels, mutateDetector } = {}) {
  const builtAt = revision === 'a' ? '2026-10-25T10:04:10.682171+00:00' : '2026-11-25T10:04:10.682171+00:00';
  const models = {
    schema: 'robust-number-fingerprint-bank', built_at: builtAt, model_count: 1,
    minimum_valid_numbers: 80, recommended_queries: 3,
    models: [{ id: 'model-' + revision, display_name: 'Model', family: 'test', family_name: 'Test', response_count: 1 }]
  };
  const detector = {
    schema: 'shared-detector-v2', bank_built_at: builtAt, model_ids: ['model-' + revision], response_counts: [1],
    base_sha256: 'c'.repeat(64), ranker: { values: [1, 2, 3] }
  };
  mutateModels?.(models);
  mutateDetector?.(detector);
  const core = Buffer.from(`globalThis.LMFPD = {
    parseNumbers: function (text) { return String(text).match(/\\d+/g) || []; },
    generateChallenges: function (count) { return Array.from({ length: count }, function () {
      return { prompt: 'fixture-${revision}', expected_count: 100 };
    }); },
    decodeDetector: function (bytes) { return JSON.parse(new TextDecoder().decode(bytes)); },
    analyzeSharedOutputs: function () { return { decision: 'unscorable', diagnostics: [], used_outputs: 0 }; }
  };`);
  const modelBytes = Buffer.from(JSON.stringify(models));
  const detectorBytes = Buffer.from(JSON.stringify(detector));
  const manifest = {
    upstream: 'Ikaleio/lm-detector', upstream_ref: revision.repeat(40), built_at: builtAt, model_count: 1,
    detector_sha256: sha(detectorBytes), models_sha256: sha(modelBytes), license: 'MIT',
    ...(!legacy ? { bundle_sha256: sha(core), license_sha256: sha('MIT fixture') } : {})
  };
  return { manifest, resources: new Map([[CORE, core], [DATA + 'models.json', modelBytes], [DATA + 'shared_detector.bin', detectorBytes]]) };
}

function fakeIDB(initial = new Map(), { failWrites = false } = {}) {
  const values = new Map(initial), reads = [], writes = [];
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {}, objectStoreNames: { contains: () => true },
          transaction(name, mode) {
            assert.equal(name, 'detector');
            const tx = {
              objectStore() {
                return {
                  get(key) {
                    reads.push(key);
                    const result = {};
                    queueMicrotask(() => { result.result = values.get(key); result.onsuccess?.(); tx.oncomplete?.(); });
                    return result;
                  },
                  put(value, key) {
                    assert.equal(mode, 'readwrite');
                    writes.push(key);
                    queueMicrotask(() => {
                      if (failWrites) { tx.error = new Error('quota'); tx.onerror?.(); }
                      else { values.set(key, value); tx.oncomplete?.(); }
                    });
                  }
                };
              }
            };
            return tx;
          }
        };
        request.onsuccess();
      });
      return request;
    }
  };
  return { indexedDB, values, reads, writes };
}

function browser(snapshot = fixture(), options = {}) {
  const names = ['Panel', 'Mode', 'RegenerateBtn', 'ParallelToggle', 'Status', 'DataRow', 'DataStatus',
    'DataMeta', 'DataRetryBtn', 'DataProgress', 'Error', 'Samples', 'ManualHint', 'Result'];
  const elements = Object.fromEntries(names.map(name => ['fingerprint' + name, new Element()]));
  elements.fingerprintParallelToggle.checked = true;
  const requests = [], scripts = [], modelRequests = [], states = [], pendingPaints = [];
  const head = new Element('head');
  let controller, context;
  const ctx = {
    scenario: 'fingerprint', protocol: 'chat_completions', stream: false,
    apiUrl: 'https://mock.invalid', apiKey: 'local-fixture-key', model: 'fixture',
    profile: { id: 'default', enhanced: false, custom: {} }, proxyUrl: '', httpsProxyEnabled: false
  };
  const sandbox = {
    crypto: options.noCrypto ? undefined : (options.crypto || webcrypto), TextDecoder, Uint8Array, AbortController, performance,
    setTimeout, clearTimeout, btoa: text => Buffer.from(text, 'binary').toString('base64'),
    document: {
      getElementById: id => elements[id] || null, createElement: tag => new Element(tag),
      createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
      createDocumentFragment: () => new Element('fragment'), head, activeElement: null
    },
    indexedDB: options.idb?.indexedDB,
    APITestBridge: {
      registerScenarioController(id, value) { assert.equal(id, 'fingerprint'); controller = value; },
      captureRunContext: () => clone(ctx), getRequestContext: () => clone(ctx), sanitizeSensitiveText: text => text,
      setScenarioRunState: (id, state) => states.push(clone(state)), bindRunContext: signal => signal,
      buildEndpoint: url => url + '/v1/chat/completions',
      async fetchAndStream(url, init) {
        modelRequests.push({ url, init });
        return { isStreamed: false, json: { choices: [{ message: { content: '17 '.repeat(100) } }] } };
      }
    },
    async fetch(url, init) {
      const pathname = url.split('?')[0];
      requests.push({ url, init });
      if (options.gates?.[pathname]) await options.gates[pathname].promise;
      const override = await options.fetch?.(url, requests.length);
      if (override) return override;
      const bytes = pathname === DATA + 'VERSION.json' ? Buffer.from(JSON.stringify(snapshot.manifest)) : snapshot.resources.get(pathname);
      if (!bytes) throw new Error('Unexpected request ' + url);
      return new Response(bytes);
    }
  };
  sandbox.window = sandbox;
  if (options.pausePaint) sandbox.requestAnimationFrame = callback => pendingPaints.push(callback);
  if (options.existingCore) sandbox.LMFPD = options.existingCore;
  context = vm.createContext(sandbox);
  head.appendChild = script => {
    Element.prototype.appendChild.call(head, script);
    scripts.push(script);
    void (async () => {
      if (options.gates?.[CORE]) await options.gates[CORE].promise;
      const bytes = snapshot.resources.get(CORE);
      if (options.failScript?.(scripts.length) || (script.integrity && script.integrity !== 'sha256-' + createHash('sha256').update(bytes).digest('base64'))) {
        script.onerror();
      } else {
        if (!options.noCoreExport) vm.runInContext(bytes.toString(), context);
        script.onload();
      }
    })().catch(error => script.onerror(error));
    return script;
  };
  vm.runInContext(controllerSource, context, { filename: 'fingerprint.js' });
  assert.ok(controller, 'scenario registered without loading reference assets');
  return {
    snapshot, controller, ctx, requests, scripts, modelRequests, states, elements, head, context, pendingPaints,
    activate: () => controller.activate(ctx),
    ready: () => until(() => elements.fingerprintDataRow.classList.contains('is-ready'), elements.fingerprintError.textContent || 'reference ready'),
    error: () => until(() => elements.fingerprintDataRow.classList.contains('is-error'), 'reference error'),
    async retry() { elements.fingerprintDataRetryBtn.emit('click'); await tick(); },
    mode(next) {
      const target = new Element('button'); target.setAttribute('data-mode', next);
      elements.fingerprintMode.emit('click', { target });
    },
    count: path => requests.filter(request => request.url.split('?')[0] === path).length,
    message: () => elements.fingerprintError.textContent,
    cards: () => elements.fingerprintSamples.children
  };
}

test('initial paint stays lazy; activation and run share VERSION before core/data, with hash queries and SRI', async () => {
  const gate = deferred();
  const h = browser(fixture(), { gates: { [DATA + 'VERSION.json']: gate } });
  assert.equal(h.requests.length, 0); assert.equal(h.scripts.length, 0);
  h.activate(); const run = h.controller.run(h.ctx);
  await tick();
  assert.equal(h.count(DATA + 'VERSION.json'), 1);
  assert.equal(h.scripts.length, 0, 'core must wait for VERSION');
  assert.equal(h.modelRequests.length, 0);
  gate.resolve(); await run; await h.ready();
  const version = h.snapshot.manifest;
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, CORE + '?v=' + version.bundle_sha256);
  assert.equal(h.scripts[0].integrity, 'sha256-' + Buffer.from(version.bundle_sha256, 'hex').toString('base64'));
  assert.equal(h.scripts[0].crossOrigin, 'anonymous');
  assert.equal(h.requests.some(r => r.url === DATA + 'models.json?v=' + version.models_sha256), true);
  assert.equal(h.requests.some(r => r.url === DATA + 'shared_detector.bin?v=' + version.detector_sha256), true);
  assert.equal(h.requests.some(r => /LICENSE/.test(r.url)), false);
  assert.equal(h.modelRequests.length, 3);
});

test('legacy manifest keeps data integrity and pins core to upstream ref, ignoring an unrelated global', async () => {
  const existingCore = { generateChallenges() { throw new Error('unmatched global used'); } };
  const h = browser(fixture({ legacy: true }), { existingCore });
  h.activate(); await h.ready();
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, CORE + '?v=' + h.snapshot.manifest.upstream_ref);
  assert.equal(h.scripts[0].integrity, undefined);
  assert.notEqual(h.context.LMFPD, existingCore);
  assert.equal(h.cards().length, 3);
});

test('legacy fallback still rejects detector hash mismatch', async () => {
  const h = browser(fixture({ legacy: true }));
  h.snapshot.resources.set(DATA + 'shared_detector.bin', Buffer.from('stale detector'));
  h.activate(); await h.error(); assert.match(h.message(), /SHA-256/);
  assert.equal(h.modelRequests.length, 0);
});

test('a valid IDB hit is verified and avoids the detector network request', async () => {
  const f = fixture(), key = f.manifest.built_at + ':' + f.manifest.detector_sha256;
  const idb = fakeIDB(new Map([[key, Uint8Array.from(f.resources.get(DATA + 'shared_detector.bin')).buffer]]));
  const h = browser(f, { idb }); h.activate(); await h.ready();
  assert.deepEqual(idb.reads, [key]); assert.equal(h.count(DATA + 'shared_detector.bin'), 0);
});

test('corrupt IDB data is ignored, refetched exactly once, verified and replaced before use', async () => {
  const f = fixture(), key = f.manifest.built_at + ':' + f.manifest.detector_sha256;
  const idb = fakeIDB(new Map([[key, new Uint8Array([9, 9, 9]).buffer]]));
  const h = browser(f, { idb }); h.activate(); await h.ready();
  assert.equal(h.count(DATA + 'shared_detector.bin'), 1);
  assert.deepEqual(idb.writes, [key]);
  assert.equal(sha(new Uint8Array(idb.values.get(key))), f.manifest.detector_sha256);
});

test('corrupt IDB plus wrong fresh bytes fails once without stale fallback, then explicit retry can recover', async () => {
  const f = fixture(), key = f.manifest.built_at + ':' + f.manifest.detector_sha256;
  const goodBytes = f.resources.get(DATA + 'shared_detector.bin');
  const idb = fakeIDB(new Map([[key, Uint8Array.from([8, 7]).buffer]]));
  f.resources.set(DATA + 'shared_detector.bin', Buffer.from('wrong fresh bytes'));
  const h = browser(f, { idb }); h.activate(); await h.error();
  assert.equal(h.count(DATA + 'shared_detector.bin'), 1);
  assert.deepEqual(idb.reads, [key]); assert.equal(idb.writes.length, 0);
  f.resources.set(DATA + 'shared_detector.bin', goodBytes);
  await h.retry(); await h.ready();
  assert.deepEqual(idb.reads, [key], 'corrupt key remains ignored for this page');
  assert.equal(h.count(DATA + 'shared_detector.bin'), 2);
  assert.equal(h.count(DATA + 'VERSION.json'), 1);
});

test('unreadable IDB value type is ignored and refetched rather than blocking recovery', async () => {
  const f = fixture(), key = f.manifest.built_at + ':' + f.manifest.detector_sha256;
  const idb = fakeIDB(new Map([[key, { length: -Infinity }]]));
  const h = browser(f, { idb }); h.activate(); await h.ready();
  assert.equal(h.count(DATA + 'shared_detector.bin'), 1);
});

test('IDB write failure preserves a verified memory fallback and every memory hit is rehashed', async () => {
  const hashes = [];
  const crypto = { subtle: { async digest(algorithm, bytes) {
    hashes.push(sha(bytes)); return webcrypto.subtle.digest(algorithm, bytes);
  } } };
  const idb = fakeIDB(new Map(), { failWrites: true });
  const h = browser(fixture(), { crypto, idb }); h.activate(); await h.ready();
  for (let i = 0; i < 3; i++) { await h.retry(); await h.ready(); }
  assert.equal(h.count(DATA + 'VERSION.json'), 1); assert.equal(h.scripts.length, 1);
  assert.equal(h.count(DATA + 'shared_detector.bin'), 1);
  assert.equal(idb.writes.length, 1);
  assert.equal(hashes.filter(hash => hash === h.snapshot.manifest.detector_sha256).length, 4);
  assert.match(h.elements.fingerprintDataStatus.textContent, /本次会话缓存/);
});

for (const file of ['models.json', 'shared_detector.bin']) {
  test(`${file}: fresh hash mismatch fails visibly and does not sample or save invalid bytes`, async () => {
    const idb = fakeIDB();
    const h = browser(fixture(), { idb });
    h.snapshot.resources.set(DATA + file, Buffer.from('wrong deployment bytes'));
    h.activate(); const run = h.controller.run(h.ctx); await h.error(); await run;
    assert.match(h.message(), /SHA-256|摘要|校验/);
    assert.equal(h.modelRequests.length, 0); assert.equal(idb.writes.length, 0);
    assert.equal(h.elements.fingerprintDataRetryBtn.hidden, false);
  });
}

test('retry reuses the same pinned manifest/core and verified memory cache despite a newer deployment', async () => {
  const h = browser(); h.activate(); await h.ready();
  const oldCore = h.context.LMFPD, oldManifest = clone(h.snapshot.manifest);
  Object.assign(h.snapshot.manifest, fixture({ revision: 'b' }).manifest);
  await h.retry(); await h.ready();
  assert.equal(h.count(DATA + 'VERSION.json'), 1);
  assert.equal(h.scripts.length, 1); assert.equal(h.context.LMFPD, oldCore);
  assert.equal(h.count(DATA + 'shared_detector.bin'), 1);
  assert.match(h.elements.fingerprintDataMeta.textContent, new RegExp(oldManifest.built_at.replace('+', '\\+')));
});

test('manifest network failure is retryable without freezing a rejected snapshot promise', async () => {
  let failures = 1;
  const h = browser(fixture(), { fetch(url) {
    if (url.endsWith('VERSION.json') && failures-- > 0) return new Response('offline', { status: 503, statusText: 'Unavailable' });
  } });
  h.activate(); await h.error();
  assert.equal(h.scripts.length, 0); assert.match(h.message(), /503/);
  await h.retry(); await h.ready();
  assert.equal(h.count(DATA + 'VERSION.json'), 2); assert.equal(h.scripts.length, 1);
});

test('malformed manifest acquisition can retry corrected bytes', async () => {
  let malformed = true;
  const h = browser(fixture(), { fetch(url) {
    if (url.endsWith('VERSION.json') && malformed) { malformed = false; return new Response('{'); }
  } });
  h.activate(); await h.error(); await h.retry(); await h.ready();
  assert.equal(h.count(DATA + 'VERSION.json'), 2); assert.equal(h.scripts.length, 1);
});

test('failed script load retries the same pinned manifest and removes the failed script', async () => {
  const h = browser(fixture(), { failScript: attempt => attempt === 1 });
  h.activate(); await h.error(); await h.retry(); await h.ready();
  assert.equal(h.count(DATA + 'VERSION.json'), 1); assert.equal(h.scripts.length, 2);
  assert.equal(h.scripts[0].parentNode, null); assert.equal(h.scripts[0].src, h.scripts[1].src);
});

test('script without complete API cannot inherit an unmatched preloaded global', async () => {
  const h = browser(fixture(), { noCoreExport: true, existingCore: {
    parseNumbers() {}, generateChallenges() {}, decodeDetector() {}, analyzeSharedOutputs() {}
  } });
  h.activate(); await h.error(); assert.match(h.message(), /LMFPD/);
  assert.equal(h.count(DATA + 'models.json'), 0); assert.equal(h.head.children.length, 0);
});

test('declared bundle digest mismatch fails script integrity instead of accepting existing core', async () => {
  const h = browser(fixture(), { existingCore: { parseNumbers() { return []; } } });
  h.snapshot.resources.set(CORE, Buffer.from('globalThis.LMFPD = {};'));
  h.activate(); const run = h.controller.run(h.ctx); await h.error(); await run;
  assert.equal(h.modelRequests.length, 0); assert.equal(h.count(DATA + 'models.json'), 0);
});

test('without crypto.subtle, loading reports unsupported verification instead of skipping hashes', async () => {
  const h = browser(fixture({ legacy: true }), { noCrypto: true });
  h.activate(); await h.error();
  assert.match(h.message(), /SHA-256|crypto|HTTPS|完整性/); assert.equal(h.modelRequests.length, 0);
});

for (const [name, mutate] of [
  ['ref', m => { m.upstream_ref = 'main'; }], ['detector hash', m => { m.detector_sha256 = 'bad'; }],
  ['models hash', m => { delete m.models_sha256; }], ['bundle hash', m => { m.bundle_sha256 = 'bad'; }],
  ['new pair', m => { delete m.license_sha256; }], ['license alone', m => { delete m.bundle_sha256; }],
  ['license hash', m => { m.license_sha256 = null; }], ['count', m => { m.model_count = 1.5; }],
  ['nonfinite count', m => { m.model_count = Infinity; }], ['date', m => { m.built_at = 'invalid'; }],
  ['legacy without data hash', m => { delete m.bundle_sha256; delete m.license_sha256; delete m.detector_sha256; }]
]) {
  test(`invalid manifest ${name} is rejected before core/data`, async () => {
    const f = fixture(); mutate(f.manifest); const h = browser(f); h.activate(); await h.error();
    assert.equal(h.scripts.length, 0); assert.equal(h.count(DATA + 'models.json'), 0);
    assert.equal(h.modelRequests.length, 0);
  });
}

for (const [name, changes] of [
  ['mixed built_at', { mutateDetector: d => { d.bank_built_at = '2026-11-25T00:00:00Z'; } }],
  ['mixed IDs', { mutateDetector: d => { d.model_ids[0] = 'other-version'; } }],
  ['response count', { mutateDetector: d => { d.response_counts[0] = 2; } }],
  ['model count', { mutateModels: m => { m.model_count = 2; } }],
  ['sampling shape', { mutateModels: m => { m.minimum_valid_numbers = 79; } }]
]) {
  test(`valid byte hashes cannot hide ${name}`, async () => {
    const h = browser(fixture(changes)); h.activate(); const run = h.controller.run(h.ctx);
    await h.error(); await run; assert.equal(h.modelRequests.length, 0);
  });
}

test('nonfinite numeric values in decoded detector are rejected before sampling', async () => {
  const f = fixture();
  const core = Buffer.from(f.resources.get(CORE).toString().replace('return JSON.parse(new TextDecoder().decode(bytes));',
    'var data = JSON.parse(new TextDecoder().decode(bytes)); data.ranker.values[1] = Infinity; return data;'));
  f.resources.set(CORE, core); f.manifest.bundle_sha256 = sha(core);
  const h = browser(f); h.activate(); const run = h.controller.run(h.ctx);
  await h.error(); await run; assert.match(h.message(), /有限|数值|nonfinite/); assert.equal(h.modelRequests.length, 0);
});

test('nonfinite JSON metadata and manifest model-count mismatch are rejected with valid byte hashes', async () => {
  const f = fixture();
  const models = Buffer.from(f.resources.get(DATA + 'models.json').toString().replace('"response_count":1', '"response_count":1e999'));
  f.resources.set(DATA + 'models.json', models); f.manifest.models_sha256 = sha(models);
  const h = browser(f); h.activate(); await h.error(); assert.match(h.message(), /非有限数值/);
  const count = fixture(); count.manifest.model_count = 2;
  const mismatch = browser(count); mismatch.activate(); await mismatch.error(); assert.match(mismatch.message(), /模型数量/);
});

test('bad JSON and unsupported data schemas remain readable load errors even with matching hashes', async () => {
  const f = fixture(), badModels = Buffer.from('{"broken":');
  f.resources.set(DATA + 'models.json', badModels); f.manifest.models_sha256 = sha(badModels);
  const h = browser(f); h.activate(); await h.error(); assert.ok(h.message());
  assert.equal(h.count(DATA + 'shared_detector.bin'), 0);
  const invalidDetector = browser(fixture({ mutateDetector: d => { d.schema = 'future-v99'; } }));
  invalidDetector.activate(); await invalidDetector.error(); assert.ok(invalidDetector.message());
});

test('each new page acquires its own version and uses distinct core/data cache keys', async () => {
  const a = browser(), b = browser(fixture({ revision: 'b' }));
  a.activate(); b.activate(); await Promise.all([a.ready(), b.ready()]);
  assert.notEqual(a.scripts[0].src, b.scripts[0].src);
  assert.notEqual(a.requests.find(r => r.url.includes('models.json')).url, b.requests.find(r => r.url.includes('models.json')).url);
  assert.equal(a.count(DATA + 'VERSION.json'), 1); assert.equal(b.count(DATA + 'VERSION.json'), 1);
});

for (const phase of [DATA + 'VERSION.json', CORE, DATA + 'shared_detector.bin']) {
  for (const action of ['stop', 'deactivate', 'clear', 'manual', 'regenerate']) {
    test(`${action} during ${phase} keeps canceled sampling from starting late`, async () => {
      const gate = deferred(), h = browser(fixture(), { gates: { [phase]: gate } });
      h.activate(); const run = h.controller.run(h.ctx);
      await until(() => phase === CORE ? h.scripts.length === 1 : h.count(phase) === 1);
      if (action === 'manual') h.mode('manual');
      else if (action === 'regenerate') h.elements.fingerprintRegenerateBtn.emit('click');
      else h.controller[action]();
      gate.resolve(); await run; await h.ready(); await tick();
      assert.equal(h.modelRequests.length, 0); assert.equal(h.states.at(-1).running, false);
    });
  }
}

test('manual scoring and regeneration share manifest/core without credentials or model requests', async () => {
  const h = browser(); h.ctx.apiKey = ''; h.activate(); h.mode('manual');
  const run = h.controller.run(); h.elements.fingerprintRegenerateBtn.emit('click'); await run; await h.ready();
  await h.controller.run();
  assert.equal(h.count(DATA + 'VERSION.json'), 1); assert.equal(h.scripts.length, 1);
  assert.equal(h.modelRequests.length, 0); assert.equal(h.states.at(-1).label, '评分');
});

test('deactivation while manual scoring awaits paint cannot publish late scores', async () => {
  const h = browser(fixture(), { pausePaint: true }); h.activate(); await h.ready(); h.mode('manual');
  const run = h.controller.run(); await until(() => h.pendingPaints.length === 1);
  h.controller.deactivate(); await run;
  h.pendingPaints.shift()(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.notEqual(h.elements.fingerprintStatus.textContent, '评分完成');
  assert.equal(h.states.at(-1).running, false); assert.equal(h.modelRequests.length, 0);
});

test('committed real reference assets load and score through the unchanged core', async () => {
  const paths = [CORE, DATA + 'VERSION.json', DATA + 'models.json', DATA + 'shared_detector.bin'];
  const bytes = await Promise.all(paths.map(path => readFile(new URL(path, ROOT))));
  const f = { manifest: JSON.parse(bytes[1]), resources: new Map([[paths[0], bytes[0]], [paths[2], bytes[2]], [paths[3], bytes[3]]]) };
  const h = browser(f); h.activate(); await h.ready(); h.mode('manual'); await h.controller.run();
  assert.match(h.elements.fingerprintStatus.textContent, /评分完成/);
  assert.equal(h.cards().length, 3); assert.equal(h.modelRequests.length, 0);
});
