/* Controllers for three peer diagnostic scenarios:
 *   - structured output (schema-constrained JSON)
 *   - needle in a haystack (long-context retrieval)
 *   - context capacity (binary search for locally estimated accepted/rejected sizes)
 *
 * Transport is reused from the main page through window.APITestBridge; all
 * request shaping lives in window.TestingCore so it stays testable.
 */
(function () {
  'use strict';

  var panel = document.getElementById('capabilityPanel');
  if (!panel) return;

  var core = window.TestingCore;
  if (!core) return;

  var statusEl = document.getElementById('capabilityStatus');
  var progressEl = document.getElementById('capabilityProgress');
  var progressFill = document.getElementById('capabilityProgressFill');
  var progressText = document.getElementById('capabilityProgressText');
  var errorEl = document.getElementById('capabilityError');
  var resultsEl = document.getElementById('capabilityResults');
  var capacitySection = document.getElementById('capacitySection');
  var capacityAttemptsEl = document.getElementById('capacityAttempts');
  var needleTokensEl = document.getElementById('needleTokens');
  var needleDepthEl = document.getElementById('needleDepth');
  var capacityStartEl = document.getElementById('capacityStart');
  var capacityResolutionEl = document.getElementById('capacityResolution');

  var PROTOCOL_VENDOR = {
    chat_completions: 'openai',
    responses: 'openai',
    anthropic: 'anthropic',
    google: 'google'
  };

  var PROTOCOL_LABEL = {
    chat_completions: 'Chat Completions',
    responses: 'Responses',
    anthropic: 'Anthropic',
    google: 'Gemini'
  };

  var state = {
    scenario: null,
    running: false,
    epoch: 0,
    controller: null,
    runProtocol: ''
  };

  /* ------------------------------------------------------------------ *
   * Small UI helpers
   * ------------------------------------------------------------------ */

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.classList.remove('is-busy', 'is-done', 'is-error');
    if (kind === 'busy') statusEl.classList.add('is-busy');
    else if (kind === 'done') statusEl.classList.add('is-done');
    else if (kind === 'error') statusEl.classList.add('is-error');
  }

  function setProgress(current, total, label) {
    if (!total) {
      progressEl.hidden = true;
      return;
    }
    progressEl.hidden = false;
    var pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
    progressFill.style.width = pct + '%';
    progressText.textContent = (label ? label + ' · ' : '') + current + '/' + total;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function showError(text) {
    errorEl.hidden = false;
    errorEl.textContent = text;
  }

  function sanitize(err) {
    var message = err && err.message ? String(err.message) : String(err || '未知错误');
    var bridge = window.APITestBridge;
    if (bridge && typeof bridge.sanitizeSensitiveText === 'function') {
      try { message = bridge.sanitizeSensitiveText(message); } catch (e) { /* ignore */ }
    }
    var ctx = null;
    if (bridge && typeof bridge.getRequestContext === 'function') {
      try { ctx = bridge.getRequestContext(); } catch (e) { ctx = null; }
    }
    if (ctx && ctx.apiKey) message = message.split(ctx.apiKey).join('[REDACTED]');
    return message || '未知错误';
  }


  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ------------------------------------------------------------------ *
   * Request construction
   * ------------------------------------------------------------------ */

  function targetFor(ctx) {
    var bridge = window.APITestBridge;
    var protocol = ctx.protocol;
    var vendor = PROTOCOL_VENDOR[protocol];
    var headers = { 'Content-Type': 'application/json' };
    var url;

    if (protocol === 'anthropic') {
      url = bridge.buildAnthropicEndpoint(ctx.apiUrl);
      headers['x-api-key'] = ctx.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      // Without this header api.anthropic.com refuses browser-originated
      // requests at preflight, so the probe never reaches the endpoint.
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (protocol === 'google') {
      // Every capability probe is non-streaming, so use generateContent. The
      // streaming endpoint returns SSE, which leaves result.json null and
      // silently discards the usageMetadata the capacity search depends on.
      url = bridge.buildGeminiEndpoint(ctx.apiUrl, ctx.model, ctx.apiKey);
      headers = { 'Content-Type': 'application/json' };
    } else if (protocol === 'responses') {
      url = bridge.buildResponsesEndpoint(ctx.apiUrl);
      headers['Authorization'] = 'Bearer ' + ctx.apiKey;
    } else {
      url = bridge.buildEndpoint(ctx.apiUrl);
      headers['Authorization'] = 'Bearer ' + ctx.apiKey;
    }
    return { vendor: vendor, protocol: protocol, url: url, headers: headers, modelId: ctx.model };
  }

  function buildTextBody(vendor, model, text, stream, protocol) {
    if (vendor === 'anthropic') {
      return {
        model: model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: text }],
        stream: !!stream
      };
    }
    if (vendor === 'google') {
      return {
        contents: [{ role: 'user', parts: [{ text: text }] }]
      };
    }
    if (protocol === 'responses') {
      return {
        model: model,
        input: [{ role: 'user', content: text }],
        stream: !!stream
      };
    }
    return {
      model: model,
      messages: [{ role: 'user', content: text }],
      stream: !!stream
    };
  }

  /**
   * Main transport owns profile application; observe its one prepared request.
   */
  async function send(target, body, signal, run, onChunk, onPhase) {
    run.lastRequest = null;
    return window.APITestBridge.fetchAndStream(
      target.url,
      {
        method: 'POST',
        headers: target.headers,
        body: JSON.stringify(body),
        signal: signal
      },
      onChunk || null,
      onPhase || null,
      null,
      { runContext: run.ctx, onPrepared: function (prepared) { run.lastRequest = prepared; } }
    );
  }

  /** Names from the actual one-time profile application, never a new generator. */
  function profileHeaderNames(run) {
    var applied = run.lastRequest && run.lastRequest.applied;
    return applied && applied.applied ? Object.keys(applied.profileHeaders || {}) : [];
  }

  /** Report requested transport behavior without claiming upstream verification. */
  function profileNote(run) {
    if (run.profile === 'default') return '';
    var request = run.lastRequest;
    var label = core.REQUEST_PROFILE_META[run.profile].label;
    if (request && request.transport.overrideRequested) {
      return '（' + label + '：已请求代理转发画像头；未验证上游实际收到的 UA）';
    }
    var hasUa = profileHeaderNames(run).some(function (name) { return name.toLowerCase() === 'user-agent'; });
    return '（' + label + '：使用浏览器请求' +
      (hasUa ? '，浏览器可能忽略自定义 User-Agent；未验证上游收到的值' : '，未验证上游收到的画像头') + '）';
  }

  /* ------------------------------------------------------------------ *
   * Result rendering
   * ------------------------------------------------------------------ */

  function resetResults() {
    resultsEl.innerHTML = '';
    capacitySection.hidden = true;
    capacityAttemptsEl.innerHTML = '';
  }

  function createResultCard(name) {
    var card = el('div', 'capability-result is-running');
    var head = el('div', 'capability-result-head');
    head.appendChild(el('span', 'capability-result-name', name));
    var badge = el('span', 'capability-badge is-running', '运行中');
    head.appendChild(badge);
    card.appendChild(head);
    var metrics = el('div', 'capability-result-metrics');
    card.appendChild(metrics);
    var note = el('div', 'capability-result-note');
    card.appendChild(note);
    resultsEl.appendChild(card);
    return { card: card, badge: badge, metrics: metrics, note: note };
  }

  function finishCard(handle, verdict, badgeText, metrics, noteText, detail) {
    handle.card.className = 'capability-result is-' + verdict;
    handle.badge.className = 'capability-badge is-' + verdict;
    handle.badge.textContent = badgeText;
    handle.metrics.innerHTML = '';
    (metrics || []).forEach(function (pair) {
      handle.metrics.appendChild(el('span', 'capability-metric',
        pair[0] + '：' + sanitize(String(pair[1]))));
    });
    handle.note.className = 'capability-result-note' +
      (verdict === 'fail' ? ' is-error' : '');
    handle.note.textContent = noteText ? sanitize(noteText) : '';
    if (detail) {
      var details = el('details', 'capability-result-detail');
      details.appendChild(el('summary', null, '查看详情（敏感值已隐藏）'));
      details.appendChild(el('pre', null, sanitize(detail)));
      handle.card.appendChild(details);
    }
  }

  function mapVerdictToBadge(verdict) {
    if (verdict === 'pass') return '通过';
    if (verdict === 'unsupported') return '不支持';
    if (verdict === 'warn') return '部分通过';
    return '失败';
  }

  /** Turn a thrown error into the standard failed-card presentation. */
  function renderFailure(handle, err, extraMetrics) {
    var info = core.classifyError({
      name: err && err.name,
      message: err && err.message,
      status: err && err.status,
      rawText: err && err.rawText
    });
    if (info.category === 'network') {
      info = Object.assign({}, info, {
        advice: '浏览器未返回可用响应，暂时无法判断原因。请检查 API 地址、网络、CORS 和代理设置。'
      });
    }
    var verdict = info.category === 'unsupported' ? 'unsupported' : 'fail';
    var metrics = (extraMetrics || []).concat([['错误类别', info.label]]);
    if (err && err.status) metrics.push(['HTTP', err.status]);
    finishCard(handle, verdict, mapVerdictToBadge(verdict), metrics,
      info.advice, err && err.rawText ? sanitize(err.rawText).slice(0, 4000) : (err && err.message ? sanitize(err) : ''));
    return info;
  }

  /* ------------------------------------------------------------------ *
   * Test: structured output
   * ------------------------------------------------------------------ */

  async function runStructuredOutput(signal, run) {
    var handle = createResultCard('结构化输出');
    var ctx = run.ctx;
    var target = run.target;
    var built = core.buildStructuredOutputBody({
      vendor: target.vendor,
      model: ctx.model,
      prompt: core.STRUCTURED_PROMPT,
      responses: target.protocol === 'responses',
      stream: false
    });

    try {
      var startedAt = Date.now();
      var result = await send(target, built.body, signal, run);
      if (signal.aborted) return;
      var latency = Date.now() - startedAt;
      var candidate = core.extractStructuredCandidate({
        vendor: target.vendor,
        json: result.json,
        text: result.text,
        toolCalls: result.toolCalls,
        // Without this flag a Responses payload is parsed as a Chat Completions
        // payload and every field is reported missing.
        responses: target.protocol === 'responses'
      });
      var check = core.validateStructured(candidate);

      if (check.ok) {
        finishCard(handle, 'pass', '通过', [
          ['约束方式', built.mode],
          ['耗时', latency + 'ms'],
          ['city', check.value.city],
          ['population', String(check.value.population)]
        ], '返回严格符合 schema 的 JSON。' + profileNote(run));
      } else {
        finishCard(handle, 'warn', '未通过校验', [
          ['约束方式', built.mode],
          ['耗时', latency + 'ms']
        ], check.reason + '。部分网关会忽略 response_format 而仅返回普通文本。' + profileNote(run),
          result.text ? sanitize(result.text).slice(0, 2000) : '');
      }
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) throw err;
      renderFailure(handle, err, [['约束方式', built.mode]]);
    }
  }

  /* ------------------------------------------------------------------ *
   * Test: needle in a haystack
   * ------------------------------------------------------------------ */

  async function runNeedle(signal, run) {
    var handle = createResultCard('大海捞针');
    var ctx = run.ctx;
    var target = run.target;
    var targetTokens = run.params.needleTokens;
    var depth = run.params.needleDepth;
    if (isNaN(depth)) depth = 50;

    var built = core.buildNeedlePrompt({
      targetTokens: targetTokens,
      depth: depth
    });
    var body = buildTextBody(target.vendor, ctx.model, built.prompt, false, target.protocol);

    try {
      var startedAt = Date.now();
      var result = await send(target, body, signal, run);
      if (signal.aborted) return;
      var latency = Date.now() - startedAt;
      var answer = extractAnswerText(target.vendor, result, target.protocol);
      var score = core.scoreNeedleAnswer(answer, built.expected);

      var metrics = [
        ['预计输入', core.formatTokens(built.estimatedInputTokens) + ' tokens'],
        ['深度', built.depth + '%'],
        ['耗时', latency + 'ms']
      ];
      if (score.verdict === 'hit') {
        finishCard(handle, 'pass', '命中', metrics,
          '正确找回目标记录。' + profileNote(run));
      } else {
        finishCard(handle, 'fail', '未命中', metrics,
          score.reason + '。若为编码错误，说明模型读到了内容但复述不准；若完全找不到，可能是长上下文能力或截断问题。' + profileNote(run),
          '目标编码：' + built.expected + '\n模型回答：' + sanitize(answer).slice(0, 800));
      }
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) throw err;
      renderFailure(handle, err, [['预计输入', core.formatTokens(built.estimatedInputTokens) + ' tokens']]);
    }
  }

  /** Pull the assistant's visible text out of a non-streamed response. */
  function extractAnswerText(vendor, result, protocol) {
    var json = result && result.json;
    if (!json) return result && typeof result.text === 'string' ? result.text : '';
    if (vendor === 'anthropic' && Array.isArray(json.content)) {
      return json.content.filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
    }
    if (vendor === 'google') {
      var cand = json.candidates && json.candidates[0];
      if (cand && cand.content && Array.isArray(cand.content.parts)) {
        return cand.content.parts.map(function (p) { return p && p.text || ''; }).join('');
      }
      return '';
    }
    if (protocol === 'responses') {
      var out = json.output || [];
      return out.filter(function (i) { return i && i.type === 'message'; })
        .map(function (i) {
          return (i.content || []).filter(function (c) { return c && typeof c.text === 'string'; })
            .map(function (c) { return c.text; }).join('');
        }).join('');
    }
    var choice = json.choices && json.choices[0];
    return choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : '';
  }

  /* ------------------------------------------------------------------ *
   * Test: context capacity
   * ------------------------------------------------------------------ */

  function renderCapacityAttempts(result) {
    capacitySection.hidden = false;
    capacityAttemptsEl.innerHTML = '';
    result.attempts.forEach(function (attempt, index) {
      var row = document.createElement('tr');
      row.appendChild(el('td', null, String(index + 1)));
      row.appendChild(el('td', null, core.formatTokens(attempt.targetTokens)));
      var label = attempt.outcome === core.CAPACITY_OUTCOMES.Accepted
        ? '接受'
        : (attempt.outcome === core.CAPACITY_OUTCOMES.ContextLimit ? '超限' : '不确定');
      var outcomeCell = el('td', null, label);
      if (attempt.outcome === core.CAPACITY_OUTCOMES.Accepted) outcomeCell.style.color = '#166534';
      else if (attempt.outcome === core.CAPACITY_OUTCOMES.ContextLimit) outcomeCell.style.color = '#b91c1c';
      row.appendChild(outcomeCell);
      row.appendChild(el('td', null, attempt.message ? sanitize(attempt.message) : ''));
      capacityAttemptsEl.appendChild(row);
    });
  }

  async function runCapacity(signal, run) {
    var handle = createResultCard('上下文容量');
    var ctx = run.ctx;
    var target = run.target;
    var startTokens = run.params.capacityStart;
    var resolution = run.params.capacityResolution;

    resetCapacityTable();

    try {
      var result = await core.searchContextCapacity({
        startTokens: startTokens,
        // The start point is only a probe, not a cap: the search must be free
        // to double upward until something rejects, otherwise a gateway with a
        // larger window would be reported as "unknown" after one request.
        maxTokens: Math.max(startTokens * 8, core.CAPACITY_DEFAULTS.maxTokens),
        resolutionTokens: resolution,
        signal: signal,
        onProgress: function (partial) {
          if (signal.aborted) return;
          renderCapacityAttempts(partial);
          setProgress(partial.attempts.length, core.CAPACITY_DEFAULTS.maxRequests,
            '容量搜索 ' + partial.attempts.length);
        },
        attempt: async function (tokens) {
          var built = core.buildFillerPrompt(tokens);
          var body = buildTextBody(target.vendor, ctx.model,
            built.prompt, false, target.protocol);
          try {
            var response = await send(target, body, signal, run);
            var usage = core.extractUsage(response.json);
            return {
              outcome: core.CAPACITY_OUTCOMES.Accepted,
              inputTokens: usage && usage.inputTokens,
              message: usage && usage.inputTokens
                ? '服务端报告输入：' + core.formatTokens(usage.inputTokens) + ' tokens'
                : '接受'
            };
          } catch (err) {
            if (signal.aborted || (err && err.name === 'AbortError')) throw err;
            var info = core.classifyError({
              name: err && err.name,
              message: err && err.message,
              status: err && err.status,
              rawText: err && err.rawText
            });
            if (core.isContextLimitError({
              status: err && err.status,
              message: err && err.message,
              rawText: err && err.rawText
            })) {
              return {
                outcome: core.CAPACITY_OUTCOMES.ContextLimit,
                message: '超限' + (err && err.status ? '（HTTP ' + err.status + '）' : '')
              };
            }
            return {
              outcome: core.CAPACITY_OUTCOMES.Inconclusive,
              message: info.label + (err && err.status ? ' HTTP ' + err.status : '')
            };
          }
        }
      });

      if (signal.aborted) return;
      renderCapacityAttempts(result);

      var lower = result.lowerBoundTokens
        ? core.formatTokens(result.lowerBoundTokens) + ' tokens'
        : '未观察到';
      var upper = result.upperBoundTokens
        ? core.formatTokens(result.upperBoundTokens) + ' tokens'
        : '未观察到';
      var metrics = [
        ['本地估算接受下界', lower],
        ['本地估算拒绝上界', upper],
        ['请求次数', String(result.attempts.length)]
      ];

      var verdict;
      if (result.reason === core.CAPACITY_REASONS.Bracketed) verdict = 'pass';
      else if (result.reason === core.CAPACITY_REASONS.Ceiling) verdict = 'warn';
      else if (result.reason === core.CAPACITY_REASONS.Inconclusive) verdict = 'warn';
      else if (result.reason === core.CAPACITY_REASONS.Stopped) verdict = 'warn';
      else verdict = 'fail';

      var note = result.lowerBoundTokens
        ? '已接受的最大本地估算输入为 ' + lower + '。'
        : '本轮尚未观察到可接受输入。';
      note += result.upperBoundTokens
        ? '观察到的最小容量拒绝输入为本地估算 ' + upper + '。'
        : '本轮尚未观察到容量拒绝，无法给出拒绝上界。';
      finishCard(handle, verdict, core.describeCapacityReason(result.reason), metrics,
        note + '该区间仅描述本次填充文本的探测结果，不代表模型容量。服务端报告用量单独列于搜索过程。' + profileNote(run));
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) throw err;
      renderFailure(handle, err);
    }
  }

  function resetCapacityTable() {
    capacitySection.hidden = false;
    capacityAttemptsEl.innerHTML = '';
  }

  /* ------------------------------------------------------------------ *
   * Run orchestration
   * ------------------------------------------------------------------ */

  function setRunning(running) {
    state.running = running;
    window.APITestBridge.setScenarioRunState(state.scenario, { running: running,
      label: running ? '运行中…' : '运行测试' });
    [needleTokensEl, needleDepthEl, capacityStartEl, capacityResolutionEl].forEach(function (input) {
      input.disabled = running;
    });
  }

  async function runSelected(ctx) {
    if (state.running) return;
    if (!ctx || !ctx.apiUrl || !ctx.apiKey) {
      showError('请先在上方填写 API URL 和 API Key');
      return;
    }
    if (!ctx.model) {
      showError('请先填写模型名称');
      return;
    }

    // All probes use this run's protocol, model, profile, options and target.
    // Edits in the main configuration take effect on the next run.
    var run = {
      ctx: Object.assign({}, ctx),
      target: targetFor(ctx),
      profile: ctx.profile.id,
      params: {
        needleTokens: parseInt(needleTokensEl.value, 10) || 8192,
        needleDepth: parseInt(needleDepthEl.value, 10),
        capacityStart: parseInt(capacityStartEl.value, 10) || core.CAPACITY_DEFAULTS.startTokens,
        capacityResolution: parseInt(capacityResolutionEl.value, 10) || core.CAPACITY_DEFAULTS.resolutionTokens
      },
      lastRequest: null
    };

    clearError();
    resetResults();
    state.epoch += 1;
    var epoch = state.epoch;
    state.controller = new AbortController();
    state.runProtocol = ctx.protocol;
    var signal = window.APITestBridge.bindRunContext(state.controller.signal, ctx);

    setRunning(true);
    setProgress(0, 0);
    setStatus('运行中', 'busy');
    updateProtocolHint(ctx);

    var runners = {
      structured: runStructuredOutput,
      needle: runNeedle,
      capacity: runCapacity
    };

    try {
      await runners[state.scenario](signal, run);
    } catch (err) {
      if (!signal.aborted && err.name !== 'AbortError') showError(sanitize(err));
    } finally {
      if (epoch !== state.epoch) return;
      setRunning(false);
      state.controller = null;
      if (signal.aborted) {
        setStatus('已停止', '');
        setProgress(0, 0);
      } else {
        var failed = !!resultsEl.querySelector('.is-fail, .is-unsupported');
        setStatus(failed ? '完成（有失败项）' : '完成', failed ? 'error' : 'done');
      }
    }
  }

  function stopRun() {
    if (!state.running) return;
    state.epoch += 1;
    if (state.controller) {
      try { state.controller.abort(); } catch (e) { /* ignore */ }
      state.controller = null;
    }
    setRunning(false);
    setProgress(0, 0);
    setStatus('已停止', '');
  }

  var protocolHintEl = document.getElementById('capabilityProtocolHint');

  function updateProtocolHint(ctx) {
    if (!protocolHintEl) return;
    var label = PROTOCOL_LABEL[ctx.protocol] || ctx.protocol;
    protocolHintEl.textContent = (state.running ? '本轮协议：' : '当前协议：') + label +
      '。画像和配置在运行开始时固定；切换测试、协议或代理会停止当前运行。';
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  function activateScenario(id, ctx) {
    state.scenario = id;
    panel.hidden = false;
    var labels = { structured: '结构化输出', needle: '大海捞针', capacity: '上下文容量' };
    var intros = {
      structured: '使用固定 schema 检查字段类型与额外字段，保留协议原生的结构化约束。',
      needle: '在本地生成的长文本中定位目标记录，校验模型是否正确找回编码。',
      capacity: '通过多次请求探测本地估算输入的接受/拒绝区间。请留意请求预算。'
    };
    document.getElementById('capabilityTitle').textContent = labels[id];
    document.getElementById('capabilityIntro').textContent = intros[id];
    ['structured', 'needle', 'capacity'].forEach(function (name) {
      document.getElementById(name + 'Params').hidden = name !== id;
    });
    document.getElementById('capacityBudgetHint').textContent = '本轮最多 ' + core.CAPACITY_DEFAULTS.maxRequests +
      ' 次请求，总输入预算 ' + core.formatTokens(core.CAPACITY_DEFAULTS.maxTotalTokens) +
      ' tokens（本地估算与服务端报告取较大值）。达到预算即停止。';
    resetResults();
    clearError();
    setProgress(0, 0);
    setStatus('尚未开始', '');
    updateProtocolHint(ctx);
    setRunning(false);
  }

  function deactivate() {
    stopRun();
    panel.hidden = true;
  }

  ['structured', 'needle', 'capacity'].forEach(function (id) {
    window.APITestBridge.registerScenarioController(id, {
      activate: function (ctx) { activateScenario(id, ctx); },
      deactivate: deactivate,
      run: runSelected,
      stop: stopRun,
      clear: function () { resetResults(); clearError(); setProgress(0, 0); setStatus('尚未开始', ''); }
    });
  });
})();
