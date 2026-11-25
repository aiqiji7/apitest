/* Model fingerprint panel controller (classic script, no build step). */
(function () {
  'use strict';

  var CORE_SRC = 'assets/vendor/lmfpd/lmfpd-core.js';
  var DATA_BASE = 'assets/data/lmfpd/';
  var DB_NAME = 'apitest-lmfpd';
  var DB_VERSION = 1;
  var DB_STORE = 'detector';
  var SAMPLE_COUNT = 3;
  var MIN_ABSOLUTE_NUMBERS = 80;

  var panel = document.getElementById('fingerprintPanel');
  if (!panel) return;

  var modeWrap = document.getElementById('fingerprintMode');
  var protocolHintEl = document.getElementById('fingerprintProtocolHint');
  var regenerateBtn = document.getElementById('fingerprintRegenerateBtn');
  var parallelToggle = document.getElementById('fingerprintParallelToggle');
  var streamToggle = document.getElementById('fingerprintStreamToggle');
  var statusEl = document.getElementById('fingerprintStatus');

  var dataRowEl = document.getElementById('fingerprintDataRow');
  var dataStatusEl = document.getElementById('fingerprintDataStatus');
  var dataMetaEl = document.getElementById('fingerprintDataMeta');
  var dataRetryBtn = document.getElementById('fingerprintDataRetryBtn');
  var dataProgressEl = document.getElementById('fingerprintDataProgress');

  var errorEl = document.getElementById('fingerprintError');
  var samplesEl = document.getElementById('fingerprintSamples');
  var manualHintEl = document.getElementById('fingerprintManualHint');
  var resultEl = document.getElementById('fingerprintResult');

  var dataState = {
    ready: false,
    models: null,
    detector: null,
    version: null,
    cacheMode: 'idb'
  };
  var dataPromise = null;
  var snapshotPromise = null;
  var corePromise = null;
  var loadedCore = null;
  var memoryDetectorCache = Object.create(null);
  var ignoredDetectorCache = Object.create(null);
  var lastProgress = -1;

  var samples = [];
  var sampleEls = [];
  var mode = 'api';
  var runEpoch = 0;
  var lastAnalysis = null;
  var activated = false;
  var activationEpoch = 0;
  var selectedProtocol = '';
  var roundContext = null;
  var operations = [];
  var scoreRevision = 0;

  // ---------------------------------------------------------------------
  // Small DOM / state helpers
  // ---------------------------------------------------------------------

  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function nextPaint() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { setTimeout(resolve, 0); });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function setStatus(text, state) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('is-busy', 'is-done', 'is-error');
    if (state) statusEl.classList.add('is-' + state);
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function sanitizeError(err, runContext) {
    var message = err && err.message ? String(err.message) : String(err || '未知错误');
    var bridge = window.APITestBridge;
    if (bridge && typeof bridge.sanitizeSensitiveText === 'function') {
      try { message = bridge.sanitizeSensitiveText(message); } catch (e) { /* ignore */ }
    }
    var ctx = null;
    if (bridge && typeof bridge.getRequestContext === 'function') {
      try { ctx = bridge.getRequestContext(); } catch (e) { ctx = null; }
    }
    if (ctx && ctx.apiKey) {
      message = message.split(ctx.apiKey).join('[REDACTED]');
    }
    if (runContext && runContext.apiKey) {
      message = message.split(runContext.apiKey).join('[REDACTED]');
      message = message.split(encodeURIComponent(runContext.apiKey)).join('[REDACTED]');
    }
    return message || '未知错误';
  }

  function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
  }

  function minimumFor(expectedCount) {
    return Math.max(MIN_ABSOLUTE_NUMBERS, Math.ceil((Number(expectedCount) || 0) * 0.55));
  }

  function countParsed(text) {
    if (window.LMFPD && typeof window.LMFPD.parseNumbers === 'function') {
      return window.LMFPD.parseNumbers(String(text || '')).length;
    }
    return 0;
  }

  function isRunning(sample) {
    return !!sample && (sample.status === 'requesting' || sample.status === 'streaming');
  }

  // ---------------------------------------------------------------------
  // Data row states
  // ---------------------------------------------------------------------

  function setDataLoading(text) {
    dataRowEl.classList.remove('is-ready', 'is-error');
    dataRowEl.classList.add('is-loading');
    dataStatusEl.textContent = text;
    dataMetaEl.textContent = '';
    dataProgressEl.hidden = false;
    dataProgressEl.value = 0;
    dataRetryBtn.hidden = true;
  }

  function setDetectorProgress(percent) {
    var rounded = Math.max(0, Math.min(100, Math.floor(percent)));
    if (rounded === lastProgress) return;
    lastProgress = rounded;
    dataProgressEl.hidden = false;
    dataProgressEl.value = rounded;
    dataStatusEl.textContent = '正在下载检测器数据… ' + rounded + '%';
  }

  function setDataReady() {
    dataRowEl.classList.remove('is-loading', 'is-error');
    dataRowEl.classList.add('is-ready');
    dataStatusEl.textContent = dataState.cacheMode === 'memory'
      ? '参考数据已就绪（本次会话缓存）'
      : '参考数据已就绪';
    var count = 0;
    if (dataState.models && typeof dataState.models.model_count === 'number') {
      count = dataState.models.model_count;
    } else if (dataState.models && Array.isArray(dataState.models.models)) {
      count = dataState.models.models.length;
    }
    var builtAt = (dataState.models && dataState.models.built_at)
      || (dataState.version && dataState.version.built_at)
      || '—';
    dataMetaEl.textContent = builtAt + ' · ' + count + ' 个模型';
    dataProgressEl.hidden = true;
    dataRetryBtn.hidden = true;
    clearError();
  }

  function setDataError(message) {
    dataRowEl.classList.remove('is-loading', 'is-ready');
    dataRowEl.classList.add('is-error');
    dataStatusEl.textContent = '参考数据加载失败';
    dataMetaEl.textContent = '';
    dataProgressEl.hidden = true;
    dataRetryBtn.hidden = false;
    showError(message);
  }

  // ---------------------------------------------------------------------
  // Core + data loading
  // ---------------------------------------------------------------------

  function validHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  }

  function validateVersion(version) {
    if (!version || typeof version !== 'object' || Array.isArray(version)
      || version.upstream !== 'Ikaleio/lm-detector' || version.license !== 'MIT'
      || typeof version.upstream_ref !== 'string' || !/^[0-9a-f]{40}$/.test(version.upstream_ref)
      || typeof version.built_at !== 'string' || version.built_at.length > 128
      || !Number.isFinite(Date.parse(version.built_at))
      || !Number.isSafeInteger(version.model_count) || version.model_count < 1
      || !validHash(version.models_sha256) || !validHash(version.detector_sha256)) {
      throw new Error('VERSION.json 格式不正确：版本、构建时间、模型数量或 SHA-256 摘要无效');
    }
    var hasBundle = Object.prototype.hasOwnProperty.call(version, 'bundle_sha256');
    var hasLicense = Object.prototype.hasOwnProperty.call(version, 'license_sha256');
    if (hasBundle !== hasLicense || (hasBundle && (!validHash(version.bundle_sha256) || !validHash(version.license_sha256)))) {
      throw new Error('VERSION.json 格式不正确：核心与许可 SHA-256 摘要必须同时有效');
    }
  }

  function requireIntegritySupport() {
    if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') {
      throw new Error('当前环境不支持 SHA-256 完整性校验，请使用支持 Web Crypto 的浏览器通过 HTTPS 或 localhost 访问');
    }
  }

  function ensureSnapshot() {
    if (snapshotPromise) return snapshotPromise;
    snapshotPromise = (async function () {
      setDataLoading('正在下载参考数据版本信息…');
      var res = await fetch(DATA_BASE + 'VERSION.json', { cache: 'no-store' });
      checkDataResponse(res, 'VERSION.json');
      var version = await res.json();
      validateVersion(version);
      requireIntegritySupport();
      // Only a failed acquisition may retry VERSION. All later callers, including
      // forced data retries, keep this page's algorithm and data snapshot fixed.
      return Object.freeze(version);
    })();
    var current = snapshotPromise;
    current.catch(function () {
      if (snapshotPromise === current) snapshotPromise = null;
    });
    return current;
  }

  function versionedUrl(path, hash) {
    return path + '?v=' + encodeURIComponent(hash);
  }

  function checkDataResponse(res, name) {
    if (!res.ok) throw new Error(name + ' HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
  }

  async function verifyBytes(bytes, expectedHash, name) {
    requireIntegritySupport();
    var digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes));
    var actual = Array.from(digest, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    if (actual !== expectedHash) {
      var err = new Error(name + ' SHA-256 校验失败：文件与本页版本不匹配，请重试或刷新页面');
      err.lmfpdIntegrityError = true;
      throw err;
    }
  }

  function bundleIntegrity(hash) {
    var bytes = '';
    for (var i = 0; i < hash.length; i += 2) bytes += String.fromCharCode(parseInt(hash.slice(i, i + 2), 16));
    return 'sha256-' + btoa(bytes);
  }

  function ensureCore() {
    if (loadedCore) {
      window.LMFPD = loadedCore;
      return Promise.resolve(loadedCore);
    }
    if (corePromise) return corePromise;

    corePromise = ensureSnapshot().then(function (version) {
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = versionedUrl(CORE_SRC, version.bundle_sha256 || version.upstream_ref);
        script.async = true;
        if (version.bundle_sha256) {
          script.integrity = bundleIntegrity(version.bundle_sha256);
          script.crossOrigin = 'anonymous';
        }
        // An arbitrary preloaded global has no binding to the pinned manifest.
        window.LMFPD = undefined;
        function fail(message) {
          script.onload = script.onerror = null;
          if (script.parentNode) script.parentNode.removeChild(script);
          window.LMFPD = undefined;
          reject(new Error(message));
        }
        script.onload = function () {
          var core = window.LMFPD;
          if (!core || !['parseNumbers', 'generateChallenges', 'decodeDetector', 'analyzeSharedOutputs'].every(function (name) {
            return typeof core[name] === 'function';
          })) {
            fail('检测核心脚本未暴露完整的 LMFPD 接口');
            return;
          }
          loadedCore = core;
          script.onload = script.onerror = null;
          resolve(core);
        };
        script.onerror = function () { fail('无法加载检测核心脚本或核心 SHA-256 完整性校验失败，请重试或刷新页面'); };
        document.head.appendChild(script);
      });
    });

    var current = corePromise;
    current.catch(function () {
      if (corePromise === current) corePromise = null;
    });
    return current;
  }

  function ensureDataLoaded(force) {
    if (!force && dataState.ready) return Promise.resolve(dataState);
    if (dataPromise) return dataPromise;

    dataPromise = loadData();
    var current = dataPromise;
    function reset() {
      if (dataPromise === current) dataPromise = null;
    }
    dataPromise.then(reset, reset);
    return dataPromise;
  }

  async function loadData() {
    dataState.ready = false;
    lastProgress = -1;
    setDataLoading('正在加载参考数据…');
    clearError();

    try {
      var version = await ensureSnapshot();
      await ensureCore();

      setDataLoading('正在下载模型元数据…');
      var modelsRes = await fetch(versionedUrl(DATA_BASE + 'models.json', version.models_sha256), { cache: 'no-store' });
      checkDataResponse(modelsRes, 'models.json');
      var modelsBytes = new Uint8Array(await modelsRes.arrayBuffer());
      await verifyBytes(modelsBytes, version.models_sha256, 'models.json');
      var models = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(modelsBytes));

      setDataLoading('正在加载检测器数据…');
      var bytes = await loadDetectorBytes(version);

      setDataLoading('正在解析参考数据…');
      var detector = window.LMFPD.decodeDetector(bytes);
      validateData(models, detector, version);

      dataState.models = models;
      dataState.detector = detector;
      dataState.version = version;
      dataState.ready = true;
      setDataReady();
      return dataState;
    } catch (err) {
      var wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.lmfpdDataError = true;
      dataState.ready = false;
      setDataError(dataErrorMessage(err));
      throw wrapped;
    }
  }

  function dataErrorMessage(err) {
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      return '请通过 http(s) 访问页面以加载参考数据';
    }
    var message = err && err.message ? String(err.message) : String(err || '');
    message = sanitizeError({ message: message });
    return '参考数据加载失败：' + (message || '未知错误');
  }

  async function loadDetectorBytes(version) {
    var key = version.built_at + ':' + version.detector_sha256;

    if (memoryDetectorCache[key]) {
      try {
        var memoryBytes = memoryDetectorCache[key].slice();
        await verifyBytes(memoryBytes, version.detector_sha256, '检测器内存缓存');
        dataState.cacheMode = 'memory';
        return memoryBytes;
      } catch (err) {
        if (!err.lmfpdIntegrityError) throw err;
        delete memoryDetectorCache[key];
        ignoredDetectorCache[key] = true;
      }
    }

    var cached = null;
    if (!ignoredDetectorCache[key]) {
      try { cached = await idbGet(key); } catch (e) { cached = null; }
    }
    if (cached) {
      var cachedBytes = null;
      try { cachedBytes = cached instanceof Uint8Array ? cached.slice() : new Uint8Array(cached); } catch (e) {
        ignoredDetectorCache[key] = true;
      }
      if (cachedBytes) {
        try {
          await verifyBytes(cachedBytes, version.detector_sha256, '检测器 IndexedDB 缓存');
          memoryDetectorCache[key] = cachedBytes.slice();
          dataState.cacheMode = 'idb';
          return cachedBytes;
        } catch (err) {
          if (!err.lmfpdIntegrityError) throw err;
          // Ignore only this exact corrupt key for the page. Never fall back to it
          // if the single fresh download below also fails integrity verification.
          ignoredDetectorCache[key] = true;
        }
      }
    }

    var downloaded = await downloadDetector(version);
    await verifyBytes(downloaded, version.detector_sha256, 'shared_detector.bin');
    memoryDetectorCache[key] = downloaded.slice();

    var stored = false;
    try {
      await idbSet(key, downloaded.slice().buffer);
      stored = true;
    } catch (e) {
      stored = false;
    }
    dataState.cacheMode = stored ? 'idb' : 'memory';
    return downloaded;
  }

  async function downloadDetector(version) {
    var res = await fetch(versionedUrl(DATA_BASE + 'shared_detector.bin', version.detector_sha256), { cache: 'no-store' });
    checkDataResponse(res, 'shared_detector.bin');

    var total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || typeof res.body.getReader !== 'function') {
      var buffer = await res.arrayBuffer();
      setDetectorProgress(100);
      return new Uint8Array(buffer);
    }

    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    while (true) {
      var part = await reader.read();
      if (part.done) break;
      if (part.value) {
        chunks.push(part.value);
        received += part.value.length;
        if (total) setDetectorProgress((received / total) * 100);
      }
    }

    var bytes = new Uint8Array(received);
    var offset = 0;
    for (var i = 0; i < chunks.length; i += 1) {
      bytes.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    setDetectorProgress(100);
    return bytes;
  }

  function validateData(models, detector, version) {
    if (!models || models.schema !== 'robust-number-fingerprint-bank' || !Array.isArray(models.models)
      || !Number.isSafeInteger(models.model_count) || models.model_count < 1
      || models.minimum_valid_numbers !== MIN_ABSOLUTE_NUMBERS || models.recommended_queries !== SAMPLE_COUNT) {
      throw new Error('参考数据格式不正确：缺少模型列表');
    }
    if (!detector || detector.schema !== 'shared-detector-v2' || !Array.isArray(detector.model_ids)
      || !Array.isArray(detector.response_counts) || !validHash(detector.base_sha256)
      || !detector.ranker || typeof detector.ranker !== 'object' || Array.isArray(detector.ranker)) {
      throw new Error('参考数据格式不正确：检测器缺少模型索引');
    }
    validateFiniteData(models);
    validateFiniteData(detector);
    if (version && version.built_at && version.built_at !== models.built_at) {
      throw new Error('参考数据版本不匹配：VERSION.json 与 models.json 的构建时间不一致');
    }
    if (models.built_at !== detector.bank_built_at) {
      throw new Error('参考数据与检测器版本不匹配：built_at 不一致');
    }
    if (typeof models.model_count === 'number' && models.model_count !== detector.model_ids.length) {
      throw new Error('参考数据与检测器版本不匹配：模型数量不一致');
    }
    if (version && typeof version.model_count === 'number' && version.model_count !== detector.model_ids.length) {
      throw new Error('参考数据与检测器版本不匹配：VERSION.json 模型数量不一致');
    }
    if (models.models.length !== detector.model_ids.length || detector.response_counts.length !== detector.model_ids.length) {
      throw new Error('参考数据与检测器版本不匹配：模型列表长度不一致');
    }
    var seen = Object.create(null);
    for (var i = 0; i < models.models.length; i += 1) {
      var model = models.models[i];
      if (!model || !['id', 'display_name', 'family', 'family_name'].every(function (name) {
        return typeof model[name] === 'string' && model[name].length > 0;
      }) || seen[model.id] || model.id !== detector.model_ids[i]) {
        throw new Error('参考数据与检测器版本不匹配：模型顺序不一致（第 ' + (i + 1) + ' 项）');
      }
      seen[model.id] = true;
      if (!Number.isSafeInteger(model.response_count) || model.response_count < 1 || model.response_count !== detector.response_counts[i]) {
        throw new Error('参考数据与检测器版本不匹配：响应数量不一致（第 ' + (i + 1) + ' 项）');
      }
    }
  }

  function validateFiniteData(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('参考数据格式不正确：包含非有限数值');
    }
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) { validateFiniteData(value[key]); });
    }
  }

  // ---------------------------------------------------------------------
  // IndexedDB cache (best effort; memory is the fallback)
  // ---------------------------------------------------------------------

  function openCacheDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      var request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 打开失败')); };
      request.onblocked = function () { reject(new Error('IndexedDB 被其他标签页阻塞')); };
    });
  }

  function idbGet(key) {
    return openCacheDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var request = tx.objectStore(DB_STORE).get(key);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || new Error('读取缓存失败')); };
        tx.oncomplete = function () { try { db.close(); } catch (e) { /* ignore */ } };
        tx.onabort = function () { try { db.close(); } catch (e) { /* ignore */ } };
      });
    });
  }

  function idbSet(key, value) {
    return openCacheDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () {
          try { db.close(); } catch (e) { /* ignore */ }
          resolve();
        };
        tx.onerror = function () {
          try { db.close(); } catch (e) { /* ignore */ }
          reject(tx.error || new Error('写入缓存失败'));
        };
        tx.onabort = function () {
          try { db.close(); } catch (e) { /* ignore */ }
          reject(tx.error || new Error('写入缓存被中止'));
        };
      });
    });
  }

  // ---------------------------------------------------------------------
  // Sample cards
  // ---------------------------------------------------------------------

  function createSample(challenge) {
    return {
      challenge: challenge,
      text: '',
      status: 'idle',
      elapsedMs: null,
      parsedNumbers: 0,
      error: '',
      controller: null,
      runId: 0,
      runContext: null,
      retrying: false
    };
  }

  function ensureChallenges() {
    var ready = samples.length === SAMPLE_COUNT && samples.every(function (sample) {
      return sample && sample.challenge;
    });
    if (ready) return;
    regenerateChallenges();
  }

  function regenerateChallenges() {
    var challenges = window.LMFPD.generateChallenges(SAMPLE_COUNT);
    samples = challenges.map(function (challenge) { return createSample(challenge); });
    sampleEls = [];
    clearNode(samplesEl);
    for (var i = 0; i < samples.length; i += 1) {
      samplesEl.appendChild(buildSampleCard(i));
    }
    renderSamples();
  }

  function buildSampleCard(index) {
    var root = createEl('article', 'fingerprint-sample');
    root.setAttribute('data-index', String(index));

    var header = createEl('div', 'fingerprint-sample-header');
    header.appendChild(createEl('span', 'fingerprint-sample-index', String(index + 1)));
    header.appendChild(createEl('span', 'fingerprint-sample-title', '样本 ' + (index + 1)));
    var badge = createEl('span', 'fingerprint-badge');
    header.appendChild(badge);
    var meta = createEl('span', 'fingerprint-sample-meta');
    header.appendChild(meta);

    var details = createEl('details', 'fingerprint-sample-prompt');
    details.appendChild(createEl('summary', '', '查看题目'));
    var promptPre = createEl('pre');
    details.appendChild(promptPre);

    var output = createEl('pre', 'fingerprint-sample-output');

    var textarea = createEl('textarea', 'fingerprint-sample-textarea');
    textarea.placeholder = '粘贴该题的完整回答';
    textarea.spellcheck = false;

    var footer = createEl('div', 'fingerprint-sample-footer');
    var stats = createEl('div', 'fingerprint-sample-stats');
    var actions = createEl('div', 'fingerprint-sample-actions');
    var retryBtn = createEl('button', 'fingerprint-mini-btn', '重试');
    retryBtn.type = 'button';
    retryBtn.setAttribute('data-action', 'retry');
    var stopBtn = createEl('button', 'fingerprint-mini-btn is-danger', '停止');
    stopBtn.type = 'button';
    stopBtn.setAttribute('data-action', 'stop');
    actions.appendChild(retryBtn);
    actions.appendChild(stopBtn);
    footer.appendChild(stats);
    footer.appendChild(actions);

    root.appendChild(header);
    root.appendChild(details);
    root.appendChild(output);
    root.appendChild(textarea);
    root.appendChild(footer);

    textarea.addEventListener('input', function () {
      var sample = samples[index];
      if (!sample || mode !== 'manual') return;
      cancelWork(true);
      sample.text = textarea.value;
      sample.parsedNumbers = countParsed(sample.text);
      sample.error = '';
      sample.status = 'idle';
      lastAnalysis = null;
      resetResult();
      updateSampleCard(index);
      updateRunningControls();
    });

    sampleEls[index] = {
      root: root,
      badge: badge,
      meta: meta,
      promptPre: promptPre,
      output: output,
      textarea: textarea,
      stats: stats,
      retryBtn: retryBtn,
      stopBtn: stopBtn
    };
    return root;
  }

  function badgeState(sample) {
    if (mode === 'manual') {
      if (sample.text && sample.text.trim()) return { text: '已填写', cls: 'is-active' };
      return { text: '待粘贴', cls: '' };
    }
    switch (sample.status) {
      case 'requesting': return { text: '请求中', cls: 'is-active' };
      case 'streaming': return { text: '接收中', cls: 'is-active' };
      case 'done': return { text: '完成', cls: 'is-done' };
      case 'rejected': return { text: '未采用', cls: 'is-warn' };
      case 'aborted': return { text: '已停止', cls: 'is-error' };
      case 'error': return { text: '失败', cls: 'is-error' };
      default: return { text: '待请求', cls: '' };
    }
  }

  function sampleStateClass(sample) {
    switch (sample.status) {
      case 'requesting': return 'is-requesting';
      case 'streaming': return 'is-streaming';
      case 'done': return 'is-done';
      case 'rejected': return 'is-rejected';
      case 'aborted': return 'is-aborted';
      case 'error': return 'is-error';
      default: return '';
    }
  }

  function statPart(label, value) {
    var span = document.createElement('span');
    span.appendChild(document.createTextNode(label + ' '));
    var strong = document.createElement('strong');
    strong.textContent = value;
    span.appendChild(strong);
    return span;
  }

  function setSampleStats(index) {
    var sample = samples[index];
    var els = sampleEls[index];
    if (!sample || !els) return;
    clearNode(els.stats);
    var parsed = sample.parsedNumbers || countParsed(sample.text);
    var minimum = minimumFor(sample.challenge.expected_count);
    els.stats.appendChild(statPart('有效', parsed + '/' + minimum));
    if (sample.elapsedMs !== null && sample.elapsedMs !== undefined) {
      els.stats.appendChild(statPart('耗时', Math.round(sample.elapsedMs) + ' ms'));
    }
    if (sample.error) {
      var errSpan = createEl('span', '', sample.error);
      errSpan.title = sample.error;
      els.stats.appendChild(errSpan);
    }
  }

  function updateSampleCard(index) {
    var sample = samples[index];
    var els = sampleEls[index];
    if (!sample || !els) return;

    var manual = mode === 'manual';
    els.root.classList.remove('is-requesting', 'is-streaming', 'is-done', 'is-rejected', 'is-aborted', 'is-error');
    if (!manual) {
      var stateClass = sampleStateClass(sample);
      if (stateClass) els.root.classList.add(stateClass);
    }

    var badge = badgeState(sample);
    els.badge.className = 'fingerprint-badge' + (badge.cls ? ' ' + badge.cls : '');
    els.badge.textContent = badge.text;

    els.meta.textContent = '期望 ' + sample.challenge.expected_count + ' 个数字';
    els.promptPre.textContent = sample.challenge.prompt;

    if (manual) {
      els.output.hidden = true;
      els.output.textContent = '';
      els.textarea.hidden = false;
      if (document.activeElement !== els.textarea && els.textarea.value !== (sample.text || '')) {
        els.textarea.value = sample.text || '';
      }
      els.retryBtn.hidden = true;
      els.stopBtn.hidden = true;
    } else {
      els.textarea.hidden = true;
      els.output.hidden = false;
      els.output.textContent = sample.text || '';
      if (els.output.scrollHeight) els.output.scrollTop = els.output.scrollHeight;
      els.retryBtn.hidden = false;
      els.retryBtn.disabled = !!sample.retrying;
      els.stopBtn.hidden = false;
      els.stopBtn.disabled = !isRunning(sample);
    }

    setSampleStats(index);
  }

  function updateSampleLive(index) {
    var sample = samples[index];
    var els = sampleEls[index];
    if (!sample || !els) return;
    var badge = badgeState(sample);
    els.badge.className = 'fingerprint-badge' + (badge.cls ? ' ' + badge.cls : '');
    els.badge.textContent = badge.text;
    if (mode !== 'manual') {
      els.output.textContent = sample.text || '';
      if (els.output.scrollHeight) els.output.scrollTop = els.output.scrollHeight;
    }
    setSampleStats(index);
  }

  function renderSamples() {
    for (var i = 0; i < samples.length; i += 1) updateSampleCard(i);
    updateRunningControls();
  }

  function updateRunningControls() {
    var bridge = window.APITestBridge;
    if (bridge && typeof bridge.setScenarioRunState === 'function') {
      var running = activated && (operations.length > 0 || samples.some(isRunning));
      bridge.setScenarioRunState('fingerprint', {
        running: running,
        label: mode === 'manual' ? (running ? '评分中…' : '评分') : (running ? '检测中…' : '开始检测'),
        stopEnabled: running
      });
    }
  }

  function applyModeUI() {
    var manual = mode === 'manual';
    if (regenerateBtn) regenerateBtn.hidden = false;
    if (manualHintEl) manualHintEl.hidden = !manual;
    updateRunningControls();
    renderSamples();
  }

  function updateModeButtons() {
    if (!modeWrap) return;
    var buttons = modeWrap.querySelectorAll('.seg-btn');
    for (var i = 0; i < buttons.length; i += 1) {
      var active = buttons[i].getAttribute('data-mode') === mode;
      buttons[i].classList.toggle('active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  // ---------------------------------------------------------------------
  // Request construction + text extraction
  // ---------------------------------------------------------------------

  function captureContext(context) {
    var bridge = window.APITestBridge;
    if (!context && bridge && typeof bridge.captureRunContext === 'function') {
      context = bridge.captureRunContext();
    }
    if (!context) {
      throw new Error('页面桥接尚未就绪，请刷新页面后重试');
    }
    var ctx = JSON.parse(JSON.stringify(context));
    if (['chat_completions', 'responses', 'anthropic', 'google'].indexOf(ctx.protocol) === -1) {
      throw new Error('当前协议不支持模型指纹检测');
    }
    ctx.stream = typeof ctx.stream === 'boolean' ? ctx.stream : (streamToggle ? !!streamToggle.checked : true);
    return ctx;
  }

  function validateRequestContext(ctx) {
    if (!ctx.apiUrl) throw new Error('请先填写 API URL');
    if (!ctx.apiKey) throw new Error('请先填写 API Key');
    if (!ctx.model) throw new Error('请先填写模型');
  }

  function buildRequest(ctx, prompt) {
    var bridge = window.APITestBridge;
    var stream = ctx.stream;
    var accept = stream ? 'text/event-stream' : 'application/json';

    if (ctx.protocol === 'responses') {
      return {
        url: bridge.buildResponsesEndpoint(ctx.apiUrl),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + ctx.apiKey,
          'Accept': accept
        },
        body: {
          model: ctx.model,
          input: [{ role: 'user', content: prompt }],
          stream: stream,
          store: false
        }
      };
    }

    if (ctx.protocol === 'anthropic') {
      return {
        url: bridge.buildAnthropicEndpoint(ctx.apiUrl),
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ctx.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Accept': accept
        },
        body: {
          model: ctx.model,
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
          stream: stream
        }
      };
    }

    if (ctx.protocol === 'google') {
      return {
        url: stream
          ? bridge.buildGeminiStreamEndpoint(ctx.apiUrl, ctx.model, ctx.apiKey)
          : bridge.buildGeminiEndpoint(ctx.apiUrl, ctx.model, ctx.apiKey),
        headers: { 'Content-Type': 'application/json', 'Accept': accept },
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 8192 }
        }
      };
    }

    return {
      url: bridge.buildEndpoint(ctx.apiUrl),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ctx.apiKey,
        'Accept': accept
      },
      body: {
        model: ctx.model,
        messages: [{ role: 'user', content: prompt }],
        stream: stream
      }
    };
  }

  function extractNonStreamText(json, requestFormat) {
    if (!json) return '';

    if (requestFormat === 'chat_completions') {
      var message = json.choices && json.choices[0] && json.choices[0].message;
      var content = message && message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(function (part) {
          if (typeof part === 'string') return part;
          return part && typeof part.text === 'string' ? part.text : '';
        }).join('');
      }
      return '';
    }

    if (requestFormat === 'responses') {
      var out = '';
      var output = Array.isArray(json.output) ? json.output : [];
      for (var i = 0; i < output.length; i += 1) {
        var item = output[i];
        if (!item || !Array.isArray(item.content)) continue;
        for (var j = 0; j < item.content.length; j += 1) {
          var part = item.content[j];
          if (part && part.type === 'output_text' && typeof part.text === 'string') {
            out += part.text;
          }
        }
      }
      if (!out && typeof json.output_text === 'string') out = json.output_text;
      return out;
    }

    if (requestFormat === 'anthropic') {
      var blocks = Array.isArray(json.content) ? json.content : [];
      return blocks.filter(function (block) {
        return block && block.type === 'text' && typeof block.text === 'string';
      }).map(function (block) { return block.text; }).join('');
    }

    if (requestFormat === 'google') {
      var candidate = json.candidates && json.candidates[0];
      var parts = candidate && candidate.content && candidate.content.parts;
      return (Array.isArray(parts) ? parts : []).filter(function (part) {
        return part && !part.thought && typeof part.text === 'string';
      }).map(function (part) { return part.text; }).join('');
    }

    return '';
  }

  // ---------------------------------------------------------------------
  // Sampling
  // ---------------------------------------------------------------------

  function isCurrent(epoch, expectedMode) {
    return activated && epoch === runEpoch && (!expectedMode || mode === expectedMode);
  }

  function hasOperation(kind) {
    return operations.some(function (operation) { return operation.kind === kind; });
  }

  function runOperation(kind, context, work) {
    var operation = { kind: kind, epoch: runEpoch, context: context, promise: null, cancel: null };
    var cancelled = new Promise(function (resolve) { operation.cancel = resolve; });
    // Register before yielding, so repeated shared runs cannot enter during loading.
    operations.push(operation);
    var task = Promise.resolve().then(function () {
      if (!isCurrent(operation.epoch)) return;
      return work(operation);
    });
    operation.promise = Promise.race([task, cancelled]).finally(function () {
      var index = operations.indexOf(operation);
      if (index === -1) return;
      operations.splice(index, 1);
      updateRunningControls();
    });
    updateRunningControls();
    return operation.promise;
  }

  async function runScenario(context) {
    var activation = activationEpoch;
    await (mode === 'manual' ? scoreManual() : startAll(context));
    // Internal stop/scoring or regeneration may replace the awaited operation.
    // Keep the shared run pending until those controls have also finished.
    while (activated && activation === activationEpoch && operations.length) {
      await Promise.all(operations.map(function (operation) { return operation.promise; }));
    }
  }

  function cancelWork(markStopped) {
    runEpoch += 1;
    scoreRevision += 1;
    var previous = operations;
    operations = [];
    previous.forEach(function (operation) { operation.cancel(); });
    abortSamples(markStopped);
    updateRunningControls();
    return runEpoch;
  }

  function resetSampleState(sample) {
    sample.runId += 1;
    if (sample.controller) {
      try { sample.controller.abort(); } catch (e) { /* ignore */ }
      sample.controller = null;
    }
    sample.text = '';
    sample.status = 'idle';
    sample.elapsedMs = null;
    sample.parsedNumbers = 0;
    sample.error = '';
    sample.runContext = null;
    sample.retrying = false;
  }

  function abortSamples(markStopped) {
    samples.forEach(function (sample, index) {
      sample.runId += 1;
      if (sample.controller) {
        try { sample.controller.abort(); } catch (e) { /* ignore */ }
        sample.controller = null;
      }
      sample.retrying = false;
      if (markStopped && isRunning(sample)) {
        sample.status = 'aborted';
        sample.error = '已停止';
        updateSampleCard(index);
      }
    });
  }

  async function ensureReadyForScoring() {
    await ensureCore();
    if (!dataState.ready) await ensureDataLoaded();
    if (!dataState.ready) throw new Error('参考数据尚未就绪');
  }

  async function runSample(index, ctx, epoch) {
    var sample = samples[index];
    if (!sample || !isCurrent(epoch, 'api')) return false;

    var myRun = sample.runId + 1;
    sample.runId = myRun;
    if (sample.controller) {
      try { sample.controller.abort(); } catch (e) { /* ignore */ }
    }
    sample.controller = new AbortController();
    sample.runContext = ctx;
    var controller = sample.controller;
    function current() {
      return isCurrent(epoch, 'api') && samples[index] === sample && sample.runId === myRun;
    }
    sample.status = 'requesting';
    sample.text = '';
    sample.parsedNumbers = 0;
    sample.error = '';
    sample.elapsedMs = null;
    updateSampleCard(index);
    updateRunningControls();

    var started = nowMs();
    try {
      validateRequestContext(ctx);
      var request = buildRequest(ctx, sample.challenge.prompt);
      var bridge = window.APITestBridge;
      var signal = controller.signal;
      if (typeof bridge.bindRunContext === 'function') {
        signal = bridge.bindRunContext(signal, ctx) || signal;
      }
      if (!current()) return false;
      var result = await window.APITestBridge.fetchAndStream(
        request.url,
        {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: signal
        },
        function (chunk, full) {
          if (!current()) return;
          sample.text = typeof full === 'string' ? full : (sample.text + (chunk || ''));
          sample.status = 'streaming';
          updateSampleLive(index);
        },
        function (phase) {
          if (!current()) return;
          if (phase === 'receiving_data') {
            sample.status = 'streaming';
            updateSampleCard(index);
          }
        },
        null,
        { runContext: ctx }
      );

      if (!current()) return false;

      var text = result && result.isStreamed
        ? result.text
        : extractNonStreamText(result && result.json, ctx.protocol);
      sample.text = text || '';
      sample.elapsedMs = nowMs() - started;
      sample.parsedNumbers = countParsed(sample.text);

      var minimum = minimumFor(sample.challenge.expected_count);
      if (sample.parsedNumbers < minimum) {
        sample.status = 'rejected';
        sample.error = '有效数字不足：' + sample.parsedNumbers + '/' + minimum
          + '（至少需要 ' + minimum + ' 个 1–355 的整数）';
      } else {
        sample.status = 'done';
        sample.error = '';
      }
      updateSampleCard(index);
      updateRunningControls();
      return sample.status === 'done';
    } catch (err) {
      if (!current()) return false;
      sample.elapsedMs = nowMs() - started;
      if (isAbortError(err)) {
        sample.status = 'aborted';
        sample.error = '已停止';
      } else {
        sample.status = 'error';
        sample.error = sanitizeError(err, ctx);
      }
      updateSampleCard(index);
      updateRunningControls();
      return false;
    } finally {
      if (sample.runId === myRun) sample.controller = null;
    }
  }

  function startAll(context) {
    if (!activated || mode !== 'api') return Promise.resolve();
    if (operations.length) return Promise.all(operations.map(function (operation) { return operation.promise; }));
    clearError();
    var ctx;
    try {
      ctx = captureContext(context);
      validateRequestContext(ctx);
    } catch (err) {
      setStatus('请求失败', 'error');
      showError(sanitizeError(err, ctx));
      updateRunningControls();
      return Promise.resolve();
    }
    if (selectedProtocol && ctx.protocol !== selectedProtocol) {
      invalidateRound();
    }
    selectedProtocol = ctx.protocol;
    var epoch = cancelWork(true);
    var runMode = mode;
    var parallel = parallelToggle ? !!parallelToggle.checked : true;
    roundContext = ctx;
    samples.forEach(resetSampleState);
    renderSamples();
    resetResult();
    setStatus('正在准备检测…', 'busy');
    return runOperation('all', ctx, async function () {
      try {
        await ensureReadyForScoring();
        if (!isCurrent(epoch, runMode)) return;
        ensureChallenges();
        samples.forEach(function (sample) { sample.runContext = ctx; });
        var plannedRuns = samples.map(function (sample) { return sample.runId; });
        setStatus('正在请求 3 条样本…', 'busy');
        if (parallel) {
          await Promise.allSettled(samples.map(function (_, index) {
            if (samples[index].retrying || samples[index].status === 'aborted') return false;
            return runSample(index, ctx, epoch);
          }));
        } else {
          for (var i = 0; i < samples.length; i += 1) {
            if (!isCurrent(epoch, runMode)) return;
            // A retry/stop can take ownership of a sample before its serial turn.
            if (!samples[i].retrying && samples[i].status !== 'aborted' && samples[i].runId === plannedRuns[i]) {
              await runSample(i, ctx, epoch);
            }
          }
        }
        while (samples.some(function (sample) { return isRunning(sample) || sample.retrying; })) {
          if (!isCurrent(epoch, runMode)) return;
          await new Promise(function (resolve) { setTimeout(resolve, 50); });
        }
        if (isCurrent(epoch, runMode)) await scoreCurrentSamples(epoch);
      } catch (err) {
        if (!isCurrent(epoch, runMode)) return;
        if (!err || !err.lmfpdDataError) showError(sanitizeError(err, ctx));
        setStatus('请求失败', 'error');
      }
    });
  }

  function stopAll() {
    var epoch = cancelWork(true);
    setStatus('已停止', '');
    var hasAnyNumbers = samples.some(function (sample) {
      return countParsed(sample.text) > 0;
    });
    if (activated && dataState.ready && hasAnyNumbers) {
      return runOperation('score', roundContext, function () { return scoreCurrentSamples(epoch); });
    }
    return Promise.resolve();
  }

  function retrySample(index) {
    if (!activated || mode !== 'api' || hasOperation('regenerate')) return Promise.resolve();
    var sample = samples[index];
    if (!sample || sample.retrying) return Promise.resolve();
    var ctx;
    try {
      // Keep the original round's credentials/profile even after form edits.
      ctx = sample.runContext || roundContext || captureContext();
      validateRequestContext(ctx);
    } catch (err) {
      showError(sanitizeError(err, ctx));
      return Promise.resolve();
    }
    clearError();
    var epoch = runEpoch;
    scoreRevision += 1;
    var retryToken = {};
    sample.retrying = retryToken;
    sample.runId += 1;
    if (sample.controller) {
      try { sample.controller.abort(); } catch (e) { /* ignore */ }
      sample.controller = null;
    }
    var retryId = sample.runId;
    sample.status = 'requesting';
    sample.runContext = ctx;
    if (!roundContext) roundContext = ctx;
    resetResult();
    updateSampleCard(index);
    setStatus('正在重试样本 ' + (index + 1) + '…', 'busy');
    return runOperation('retry', ctx, async function () {
      try {
        await ensureReadyForScoring();
        if (!isCurrent(epoch, 'api') || samples[index] !== sample || sample.runId !== retryId) return;
        var usedLengths = samples.filter(function (_, i) { return i !== index; }).map(function (item) {
          return item.challenge.expected_count;
        });
        sample.challenge = window.LMFPD.generateChallenges(1, usedLengths)[0];
        await runSample(index, ctx, epoch);
        if (sample.retrying !== retryToken) return;
      } catch (err) {
        if (!isCurrent(epoch, 'api') || sample.runId !== retryId) return;
        sample.status = 'error';
        sample.error = sanitizeError(err, ctx);
      } finally {
        if (isCurrent(epoch, 'api') && samples[index] === sample && sample.retrying === retryToken) {
          sample.retrying = false;
          updateSampleCard(index);
        }
      }
      if (isCurrent(epoch, 'api') && !samples.some(isRunning)) {
        // The round may already be painting a score invalidated by this retry.
        // Let it finish, then score here only if it did not publish fresh results.
        var rounds = operations.filter(function (operation) { return operation.kind === 'all'; });
        if (rounds.length) await Promise.all(rounds.map(function (operation) { return operation.promise; }));
        if (!isCurrent(epoch, 'api') || lastAnalysis || samples.some(function (item) {
          return isRunning(item) || item.retrying;
        })) return;
        await scoreCurrentSamples(epoch);
      }
    });
  }

  function stopSample(index) {
    var sample = samples[index];
    if (!sample) return;

    scoreRevision += 1;
    sample.retrying = false;
    sample.runId += 1;
    if (sample.controller) {
      try { sample.controller.abort(); } catch (e) { /* ignore */ }
      sample.controller = null;
    }
    if (isRunning(sample)) {
      sample.status = 'aborted';
      sample.error = '已停止';
      updateSampleCard(index);
    }

    setStatus('样本 ' + (index + 1) + ' 已停止', '');
    updateRunningControls();
    if (!operations.length && !samples.some(isRunning) && dataState.ready && activated) {
      var epoch = runEpoch;
      handleAsync(runOperation('score', roundContext, function () { return scoreCurrentSamples(epoch); }));
    }
  }

  // ---------------------------------------------------------------------
  // Scoring + result rendering
  // ---------------------------------------------------------------------

  async function scoreCurrentSamples(epoch) {
    if (typeof epoch !== 'number') epoch = runEpoch;
    if (!isCurrent(epoch)) return;
    var revision = ++scoreRevision;
    function current() { return isCurrent(epoch) && revision === scoreRevision; }

    clearError();
    try {
      await ensureReadyForScoring();
    } catch (err) {
      if (!current()) return;
      if (!err || !err.lmfpdDataError) {
        setStatus('评分失败', 'error');
        showError(sanitizeError(err));
      }
      return;
    }
    if (!current()) return;

    setStatus('计算中…', 'busy');
    await nextPaint();
    if (!current()) return;

    try {
      var outputs = samples.map(function (sample) {
        return {
          text: sample.text || '',
          expected_count: sample.challenge.expected_count
        };
      });
      var analysis = window.LMFPD.analyzeSharedOutputs(
        outputs,
        dataState.models,
        dataState.detector,
        { allowPartial: true }
      );
      if (!current()) return;
      lastAnalysis = analysis;
      renderAnalysis(analysis);
      setStatus(scoringStatusText(analysis), 'done');
    } catch (err) {
      if (!current()) return;
      setStatus('评分失败', 'error');
      showError(sanitizeError(err));
    }
    updateRunningControls();
  }

  function decisionOf(analysis) {
    if (!analysis) return 'unscorable';
    if (analysis.decision) return analysis.decision;
    // The upstream scored branch omits `decision`; results imply a scored run.
    return Array.isArray(analysis.results) && analysis.results.length > 0 ? 'scored' : 'unscorable';
  }

  function scoringStatusText(analysis) {
    switch (decisionOf(analysis)) {
      case 'scored': return '评分完成';
      case 'partial': return '评分完成（部分样本）';
      case 'not_model': return '评分完成（不像语言模型回答）';
      case 'unscorable': return '评分完成（暂不可评分）';
      default: return '评分完成';
    }
  }

  function scoreManual() {
    if (!activated || mode !== 'manual') return Promise.resolve();
    if (operations.length) return Promise.all(operations.map(function (operation) { return operation.promise; }));
    var epoch = cancelWork(true);
    clearError();
    setStatus('正在准备评分…', 'busy');
    return runOperation('manual', null, async function () {
      try {
        await ensureReadyForScoring();
        if (!isCurrent(epoch, 'manual')) return;
        ensureChallenges();
        samples.forEach(function (sample, index) {
          var els = sampleEls[index];
          if (els) sample.text = els.textarea.value;
          sample.parsedNumbers = countParsed(sample.text);
          updateSampleCard(index);
        });
        await scoreCurrentSamples(epoch);
      } catch (err) {
        if (!isCurrent(epoch, 'manual')) return;
        if (!err || !err.lmfpdDataError) showError(sanitizeError(err));
        setStatus('评分失败', 'error');
      }
    });
  }

  function resetResult() {
    clearNode(resultEl);
    var empty = createEl('p', 'fingerprint-empty', '完成三次有效采样后显示排名。');
    resultEl.appendChild(empty);
    lastAnalysis = null;
  }

  function renderAnalysis(analysis) {
    clearNode(resultEl);
    if (!analysis) {
      resetResult();
      return;
    }

    var decision = decisionOf(analysis);
    var hasRanking = (decision === 'scored' || decision === 'partial')
      && Array.isArray(analysis.results)
      && analysis.results.length > 0;

    if (!hasRanking) {
      var note = createEl('div', 'fingerprint-result-note'
        + (decision === 'unscorable' ? ' is-error' : ''));
      var title = document.createElement('strong');
      title.textContent = decision === 'not_model'
        ? '不像语言模型回答'
        : (decision === 'unscorable' ? '暂不可评分' : '暂无排名');
      note.appendChild(title);
      var reason = analysis.evidence && analysis.evidence.reason;
      if (reason) {
        note.appendChild(document.createElement('br'));
        note.appendChild(document.createTextNode(reason));
      }
      resultEl.appendChild(note);
    } else {
      var info = analysis.evidence && analysis.evidence.reason;
      if (decision === 'partial') {
        var partialNote = createEl('div', 'fingerprint-result-note is-info');
        partialNote.textContent = info
          || ('仅使用 ' + (analysis.used_outputs || 0) + '/3 条有效回答生成排名，置信度不可用。');
        resultEl.appendChild(partialNote);
      } else if (info) {
        var scoredNote = createEl('div', 'fingerprint-result-note is-info');
        scoredNote.textContent = info;
        resultEl.appendChild(scoredNote);
      }
      resultEl.appendChild(renderPrediction(analysis, decision));
      resultEl.appendChild(renderCandidates(analysis, decision));
    }

    resultEl.appendChild(renderStats(analysis));
    resultEl.appendChild(renderDiagnostics(analysis));
  }

  function renderPrediction(analysis, decision) {
    var wrap = createEl('div', 'fingerprint-prediction');
    var main = createEl('div', 'fingerprint-prediction-main');
    main.appendChild(createEl('div', 'fingerprint-prediction-label', '最相似的模型'));
    main.appendChild(createEl('div', 'fingerprint-prediction-name',
      analysis.prediction_name || analysis.prediction || '未知'));
    var family = analysis.family_prediction_name || analysis.family_prediction || '';
    if (family) main.appendChild(createEl('span', 'fingerprint-prediction-family', family));
    wrap.appendChild(main);

    var probability = createEl('div', 'fingerprint-probability');
    var value = createEl('span', 'fingerprint-probability-value');
    var label = createEl('span', 'fingerprint-probability-label');
    var calibrated = decision === 'scored'
      && typeof analysis.probability === 'number'
      && isFinite(analysis.probability)
      && analysis.probability_status === 'reference_calibrated';
    if (calibrated) {
      value.textContent = formatProbability(analysis.probability);
      label.textContent = '库内置信度';
    } else {
      value.textContent = '—';
      label.textContent = '置信度不可用';
    }
    probability.appendChild(value);
    probability.appendChild(label);
    wrap.appendChild(probability);
    return wrap;
  }

  function renderCandidates(analysis, decision) {
    var fragment = document.createDocumentFragment();
    var results = Array.isArray(analysis.results) ? analysis.results : [];
    var top = results.slice(0, 5);
    var rest = results.slice(5);

    fragment.appendChild(buildCandidateList(top, 1, decision, results));
    if (rest.length) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = '其余 ' + rest.length + ' 个候选';
      details.appendChild(summary);
      details.appendChild(buildCandidateList(rest, 6, decision, results));
      fragment.appendChild(details);
    }
    return fragment;
  }

  function buildCandidateList(items, startRank, decision, allResults) {
    var list = createEl('ol', 'fingerprint-candidates');
    items.forEach(function (item, index) {
      list.appendChild(buildCandidate(item, startRank + index, decision, allResults));
    });
    return list;
  }

  function buildCandidate(item, rank, decision, allResults) {
    var li = createEl('li', 'fingerprint-candidate');
    li.appendChild(createEl('span', 'fingerprint-candidate-rank', String(rank)));

    var body = createEl('div', 'fingerprint-candidate-body');
    body.appendChild(createEl('span', 'fingerprint-candidate-name',
      item.display_name || item.model || '未知模型'));

    var bar = createEl('div', 'fingerprint-candidate-bar');
    var fill = createEl('div', 'fingerprint-candidate-bar-fill');
    fill.style.width = barWidth(item, decision, allResults).toFixed(2) + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
    li.appendChild(body);

    var probText;
    if (decision === 'partial') {
      probText = '分数 ' + formatScore(item.score);
    } else {
      probText = typeof item.probability === 'number' && isFinite(item.probability)
        ? formatProbability(item.probability)
        : '—';
    }
    li.appendChild(createEl('span', 'fingerprint-candidate-prob', probText));
    return li;
  }

  function barWidth(item, decision, allResults) {
    if (decision === 'scored') {
      var top = allResults && allResults[0];
      var topProb = top ? Number(top.probability) : NaN;
      var prob = Number(item.probability);
      if (!isFinite(topProb) || topProb <= 0 || !isFinite(prob) || prob <= 0) return 2;
      return Math.max(2, Math.min(100, (prob / topProb) * 100));
    }

    var values = (allResults || []).map(function (entry) {
      return Number(entry.score);
    }).filter(function (value) {
      return isFinite(value);
    });
    if (!values.length) return 50;
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);
    var score = Number(item.score);
    if (!isFinite(score)) return 50;
    if (max === min) return 50;
    return Math.max(6, Math.min(100, ((score - min) / (max - min)) * 100));
  }

  function formatProbability(value) {
    var p = Number(value);
    if (!isFinite(p)) return '—';
    if (p <= 0) return '0%';
    var percent = p * 100;
    if (percent >= 1) return percent.toFixed(2) + '%';
    if (percent >= 0.01) return percent.toFixed(3) + '%';
    if (percent >= 0.0001) return percent.toFixed(5) + '%';
    return '<0.0001%';
  }

  function formatScore(value) {
    var n = Number(value);
    return isFinite(n) ? n.toFixed(3) : '—';
  }

  function formatMetric(value) {
    var n = Number(value);
    return isFinite(n) ? n.toFixed(4) : '—';
  }

  function renderStats(analysis) {
    var stats = createEl('div', 'fingerprint-stats');
    var builtAt = (dataState.models && dataState.models.built_at)
      || (dataState.version && dataState.version.built_at)
      || '—';
    var count = 0;
    if (dataState.models && typeof dataState.models.model_count === 'number') {
      count = dataState.models.model_count;
    } else if (dataState.models && Array.isArray(dataState.models.models)) {
      count = dataState.models.models.length;
    }
    addStat(stats, '参考库构建时间', builtAt);
    addStat(stats, '模型数量', String(count));
    addStat(stats, '有效样本', (analysis.used_outputs || 0) + ' / 3');
    addStat(stats, '评分方法', analysis.method || '—');
    var sequence = analysis.sequence;
    addStat(stats, '自相关 autocorrelation',
      sequence ? formatMetric(sequence.autocorrelation) : '—');
    addStat(stats, '小步占比 small_step_share',
      sequence ? formatMetric(sequence.small_step_share) : '—');
    return stats;
  }

  function addStat(container, label, value) {
    var item = createEl('div', 'fingerprint-stat');
    item.appendChild(createEl('span', 'fingerprint-stat-label', label));
    item.appendChild(createEl('span', 'fingerprint-stat-value', value));
    container.appendChild(item);
  }

  function renderDiagnostics(analysis) {
    var wrap = createEl('div', 'fingerprint-diagnostics');
    var table = createEl('table', 'fingerprint-diagnostics-table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['样本', '有效数字', '最低要求', '采用', '说明'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var diagnostics = Array.isArray(analysis.diagnostics) ? analysis.diagnostics : [];
    diagnostics.forEach(function (diag) {
      var row = document.createElement('tr');
      row.appendChild(createEl('td', '', String((diag.index || 0) + 1)));
      row.appendChild(createEl('td', '', String(diag.parsed_numbers)));
      row.appendChild(createEl('td', '', String(diag.minimum_numbers)));
      row.appendChild(createEl('td', '', diag.accepted ? '是' : '否'));

      var sample = samples[diag.index];
      var note;
      if (diag.accepted) note = '已采用';
      else if (sample && sample.error) note = sample.error;
      else note = '有效数字不足';
      row.appendChild(createEl('td', '', note));
      tbody.appendChild(row);
    });

    if (!diagnostics.length) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 5;
      emptyCell.textContent = '暂无诊断信息';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
    }

    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Panel activation / deactivation
  // ---------------------------------------------------------------------

  function invalidateRound() {
    cancelWork(true);
    roundContext = null;
    samples.forEach(resetSampleState);
    renderSamples();
    resetResult();
    clearError();
  }

  function clear() {
    invalidateRound();
    setStatus(mode === 'manual' ? '手动模式：粘贴三条回答后点击评分' : '尚未开始', '');
    updateRunningControls();
  }

  function activatePanel(context) {
    var ctx;
    try {
      ctx = captureContext(context);
    } catch (err) {
      setStatus('加载失败', 'error');
      showError(sanitizeError(err));
      return;
    }
    var protocolChanged = selectedProtocol && ctx.protocol !== selectedProtocol;
    if (protocolChanged) invalidateRound();
    selectedProtocol = ctx.protocol;
    if (!activated || protocolChanged) activationEpoch += 1;
    activated = true;
    panel.hidden = false;
    updateModeButtons();
    applyModeUI();
    var labels = { chat_completions: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic', google: 'Gemini' };
    var hint = '当前协议：' + labels[selectedProtocol];
    if (protocolHintEl) protocolHintEl.textContent = hint;
    else if (!operations.length && (protocolChanged || !lastAnalysis)) {
      setStatus((mode === 'manual' ? '手动模式 · ' : '尚未开始 · ') + hint, '');
    }

    var epoch = activationEpoch;
    ensureCore().then(function () {
      if (!activated || epoch !== activationEpoch) return;
      ensureChallenges();
      renderSamples();
    }).catch(function (err) {
      if (!activated || epoch !== activationEpoch) return;
      setStatus('加载失败', 'error');
      showError(sanitizeError(err));
    });

    ensureDataLoaded().catch(function () {
      // loadData has already rendered a readable error.
    });
  }

  function deactivate() {
    activated = false;
    activationEpoch += 1;
    cancelWork(true);
    if (statusEl && statusEl.classList.contains('is-busy')) setStatus('已停止', '');
    panel.hidden = true;
  }

  function setMode(next) {
    if (next !== 'api' && next !== 'manual') return;
    if (mode === next) {
      updateModeButtons();
      applyModeUI();
      return;
    }

    cancelWork(true);
    mode = next;

    updateModeButtons();
    applyModeUI();

    if (mode === 'manual') {
      setStatus('手动模式：粘贴三条回答后点击评分', '');
    } else if (!lastAnalysis) {
      setStatus('尚未开始', '');
    }
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  if (modeWrap) {
    modeWrap.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('.seg-btn') : null;
      if (!button || !button.getAttribute('data-mode')) return;
      setMode(button.getAttribute('data-mode'));
    });
  }

  samplesEl.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!button) return;
    var card = button.closest('.fingerprint-sample');
    if (!card) return;
    var index = Number(card.getAttribute('data-index'));
    if (!isFinite(index)) return;

    if (button.getAttribute('data-action') === 'retry') {
      handleAsync(retrySample(index));
    } else if (button.getAttribute('data-action') === 'stop') {
      stopSample(index);
    }
  });

  if (regenerateBtn) regenerateBtn.addEventListener('click', function () { handleAsync(regenerateAll()); });
  if (dataRetryBtn) dataRetryBtn.addEventListener('click', function () {
    if (!activated) return;
    var activation = activationEpoch;
    handleAsync(ensureDataLoaded(true).then(function () {
      if (!activated || activation !== activationEpoch) return;
      ensureChallenges();
      renderSamples();
    }).catch(function (err) {
      if (!err || !err.lmfpdDataError) throw err;
      // Data-loading errors already have a readable retry state.
    }));
  });

  function regenerateAll() {
    if (!activated) return Promise.resolve();
    var epoch = cancelWork(true);
    roundContext = null;
    samples.forEach(function (sample) { sample.runContext = null; });
    clearError();
    resetResult();
    return runOperation('regenerate', null, async function () {
      try {
        await ensureCore();
        if (!isCurrent(epoch)) return;
        regenerateChallenges();
        setStatus('已重新生成题目', '');
      } catch (err) {
        if (!isCurrent(epoch)) return;
        setStatus('加载失败', 'error');
        showError(sanitizeError(err));
      }
    });
  }

  function handleAsync(promise) {
    var epoch = runEpoch;
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (err) {
        if (!isCurrent(epoch)) return;
        setStatus('操作失败', 'error');
        showError(sanitizeError(err));
      });
    }
  }

  // ---------------------------------------------------------------------
  // Initial state (no data or core request on page load)
  // ---------------------------------------------------------------------

  updateModeButtons();
  resetResult();
  var bridge = window.APITestBridge;
  if (bridge && typeof bridge.registerScenarioController === 'function') {
    bridge.registerScenarioController('fingerprint', {
      activate: activatePanel,
      deactivate: deactivate,
      run: runScenario,
      stop: stopAll,
      clear: clear
    });
  }
})();
