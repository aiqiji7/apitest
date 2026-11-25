/* Testing core — pure logic shared by the request pipeline and the capability panel.
 *
 * No DOM access, no network, no timers. Profiles synthesize local identities;
 * the remaining helpers can be tested deterministically outside a browser.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Token estimation
   * ------------------------------------------------------------------ */

  // The page ships no tokenizer. CJK glyphs count as one token each, other
  // characters at roughly four per token. Every figure derived from this is an
  // estimate and is labelled as such wherever it is shown.
  function estimateTokens(text) {
    if (!text) return 0;
    var wide = 0;
    var narrow = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if ((code >= 0x4e00 && code <= 0x9fff) ||
          (code >= 0x3040 && code <= 0x30ff) ||
          (code >= 0xac00 && code <= 0xd7af) ||
          (code >= 0x3000 && code <= 0x303f)) {
        wide++;
      } else {
        narrow++;
      }
    }
    return Math.ceil(wide + narrow / 4);
  }

  function trimZero(value) {
    var text = value.toFixed(1);
    return text.slice(-2) === '.0' ? text.slice(0, -2) : text;
  }

  function scaleCount(count, unit) {
    var value = count / unit;
    // Keep one decimal only while it still carries information (1.5k, 2.3M).
    return value < 10 ? trimZero(value) : String(Math.round(value));
  }

  function formatTokens(count) {
    if (typeof count !== 'number' || !isFinite(count) || count < 0) return '—';
    if (count >= 1000000) return scaleCount(count, 1000000) + 'M';
    if (count >= 1000) return scaleCount(count, 1000) + 'k';
    return String(count);
  }

  /* ------------------------------------------------------------------ *
   * Deterministic PRNG (LCG) — shared by the needle and capacity prompts
   * ------------------------------------------------------------------ */

  function createRandom(seed) {
    var state = (seed >>> 0) || 1;
    return function next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
  }

  function hex8(random) {
    return random().toString(16).padStart(8, '0');
  }

  function archiveCode(random) {
    return hex8(random) + hex8(random) + hex8(random) + hex8(random);
  }

  /* ------------------------------------------------------------------ *
   * Request profile simulation
   * ------------------------------------------------------------------ *
   * Answers "can this endpoint actually serve Codex CLI / Claude Code /
   * Gemini CLI?" by reproducing the identity headers and request shape those
   * clients send. Identities are synthesised locally, never copied from a real
   * logged-in client.
   */

  var REQUEST_PROFILES = ['default', 'codex', 'claude', 'gemini'];

  var REQUEST_PROFILE_META = {
    default: {
      label: '默认',
      hint: '普通 API 调用，不模拟任何客户端',
      vendor: null
    },
    codex: {
      label: 'Codex CLI',
      hint: '模拟 codex_cli_rs 的 UA 与 /responses 请求形状',
      vendor: 'openai'
    },
    claude: {
      label: 'Claude CLI',
      hint: '模拟 claude-cli 的 UA、x-app 与 system 注入',
      vendor: 'anthropic'
    },
    gemini: {
      label: 'Gemini CLI',
      hint: '模拟 GeminiCLI 的 UA 与 systemInstruction 注入',
      vendor: 'google'
    }
  };

  var CLAUDE_CLI_VERSION = '2.1.306';
  var CODEX_CLI_UA = 'codex_cli_rs/0.164.0 (Windows 10.0; x86_64)';
  var GEMINI_CLI_VERSION = '0.65.0';

  // Fetch permits User-Agent, but some browsers silently ignore a scripted UA.
  // Keep this compatibility hint for direct-browser callers; a proxy can apply
  // the complete profileHeaders mapping on the upstream request.
  var BROWSER_BLOCKED_HEADERS = ['user-agent'];
  var CLAUDE_BASE_BETA = ['claude-code-20250219', 'interleaved-thinking-2025-05-14'];
  var CLAUDE_ENHANCED_BETA = [
    'thinking-token-count-2026-05-13', 'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05', 'effort-2025-11-24'
  ];

  var CODEX_DEVELOPER_PREFIX =
    'You are a coding agent running in the Codex CLI tool, a terminal-based ' +
    'coding assistant. Perform only the requested task.';
  var CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI tool.";
  var GEMINI_IDENTITY =
    'You are Gemini CLI, a command-line interface for Gemini.';

  function randomHex(bytes) {
    var out = '';
    var target = bytes * 2;
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      var buf = new Uint8Array(bytes);
      global.crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) {
        out += buf[i].toString(16).padStart(2, '0');
      }
      return out;
    }
    while (out.length < target) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out.slice(0, target);
  }

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    var h = randomHex(16);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-' +
      ((parseInt(h.charAt(16), 16) & 3) | 8).toString(16) + h.slice(17, 20) + '-' + h.slice(20, 32);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  // Defining own data properties also handles legal names such as __proto__.
  function setHeader(headers, name, value) {
    Object.defineProperty(headers, name.toLowerCase(), {
      value: value, enumerable: true, configurable: true, writable: true
    });
  }

  function mergeHeaders(base, overrides) {
    var headers = {};
    [base, overrides].forEach(function (source) {
      Object.keys(source || {}).forEach(function (name) {
        setHeader(headers, name, source[name]);
      });
    });
    return headers;
  }

  function validateHeaderValue(value, context) {
    if (typeof value !== 'string') {
      throw new TypeError(context + ': header value must be a string');
    }
    if (/[^\x00-\xff]/.test(value)) {
      throw new TypeError(context + ': header value must fit ByteString (U+0000–U+00FF)');
    }
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new TypeError(context + ': header value contains invalid control characters');
    }
  }

  function customProfileHeaders(custom) {
    if (custom === undefined) return {};
    if (!custom || Object.prototype.toString.call(custom) !== '[object Object]') {
      throw new TypeError('Custom headers must be an object mapping header names to string values');
    }
    var headers = {};
    Object.keys(custom).forEach(function (name, index) {
      // Never include a supplied name or value in errors: either can contain a
      // credential, and these errors may be rendered directly by the caller.
      var context = 'Custom headers entry #' + (index + 1);
      if (!name || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name)) {
        throw new TypeError(context + ': header name must be a legal HTTP token');
      }
      if (name.toLowerCase() === 'x-apitest-override-headers') {
        throw new TypeError(context + ': reserved proxy control header is not allowed');
      }
      validateHeaderValue(custom[name], context);
      // Native Headers strips HTTP OWS. Do so before deriving body identities;
      // preserve internal whitespace and non-OWS Latin-1 bytes such as NBSP.
      setHeader(headers, name, custom[name].replace(/^[ \t]+|[ \t]+$/g, ''));
    });
    return headers;
  }

  function mergeBetaFlags(existing, generated) {
    var flags = [];
    [existing, generated].forEach(function (value) {
      String(value || '').split(',').forEach(function (flag) {
        flag = flag.trim();
        if (flag && flags.indexOf(flag) === -1) flags.push(flag);
      });
    });
    return flags.join(',');
  }

  /** Identity headers, then enhanced fields, then case-insensitive custom overrides. */
  function buildProfileHeaders(profile, modelId, options) {
    if (profile !== 'codex' && profile !== 'claude' && profile !== 'gemini') return {};
    options = options || {};
    var custom = customProfileHeaders(options.custom);
    var generated;
    if (profile === 'gemini') {
      generated = {
        // Keep the CLI's SDK header alongside UA for direct-browser requests.
        'x-goog-api-client': 'genai-js/0.65.0',
        'user-agent': 'GeminiCLI/' + GEMINI_CLI_VERSION + '/' +
          (modelId || '') + ' (win32; x64; cli)'
      };
    } else if (profile === 'claude') {
      generated = {
        'user-agent': 'claude-cli/' + CLAUDE_CLI_VERSION + ' (external, cli)',
        'x-app': 'cli',
        'anthropic-version': '2023-06-01',
        'x-claude-code-session-id': uuid(),
        'anthropic-beta': CLAUDE_BASE_BETA.join(','),
        // Without this header api.anthropic.com refuses browser-originated
        // requests at the CORS preflight, so the profile would fail before the
        // identity was ever evaluated.
        'anthropic-dangerous-direct-browser-access': 'true'
      };
      if (options.enhanced) {
        generated['anthropic-beta'] = mergeBetaFlags(generated['anthropic-beta'], CLAUDE_ENHANCED_BETA.join(','));
        generated['x-stainless-lang'] = 'js';
        generated['x-stainless-package-version'] = '0.128.0';
        generated['x-stainless-os'] = 'Windows';
        generated['x-stainless-arch'] = 'x64';
        generated['x-stainless-runtime'] = 'node';
        generated['x-stainless-runtime-version'] = 'v26.3.0';
        generated['x-stainless-retry-count'] = '0';
        generated['x-stainless-timeout'] = '600';
      }
    } else {
      var sessionId = hasOwn(custom, 'session-id') ? custom['session-id'] : uuid();
      var threadId = hasOwn(custom, 'thread-id') ? custom['thread-id'] : uuid();
      var windowId = hasOwn(custom, 'x-codex-window-id') ? custom['x-codex-window-id'] : threadId + ':0';
      generated = {
        'user-agent': CODEX_CLI_UA,
        originator: 'codex_cli_rs',
        'session-id': sessionId,
        'thread-id': threadId,
        'x-client-request-id': options.enhanced ? threadId : uuid(),
        'x-codex-window-id': windowId
      };
      if (options.enhanced && !hasOwn(custom, 'x-codex-turn-metadata')) {
        var installationId = uuid();
        var turnId = uuid();
        generated['x-codex-turn-metadata'] = JSON.stringify({
          installation_id: installationId,
          session_id: sessionId,
          thread_id: threadId,
          window_id: windowId,
          window_number: 0,
          turn_id: turnId,
          root_turn_id: turnId,
          request_kind: 'turn',
          history_initialization: 'new',
          model: modelId || '',
          turn_started_at_unix_ms: Date.now()
        });
      }
    }
    var headers = mergeHeaders(generated, custom);
    Object.keys(headers).forEach(function (name) {
      validateHeaderValue(headers[name], 'Profile header ' + name);
    });
    return headers;
  }

  function isResponsesShaped(body) {
    return !!body && (body.input !== undefined || body.instructions !== undefined);
  }

  /** Codex CLI body rewrite for /responses requests. */
  function applyCodexBody(body, headers) {
    var next = Object.assign({}, body);
    next.store = false;
    var include = Array.isArray(next.include) ? next.include.slice() : [];
    if (include.indexOf('reasoning.encrypted_content') === -1) {
      include.push('reasoning.encrypted_content');
    }
    next.include = include;

    var meta = Object.assign({}, next.client_metadata || {});
    meta.session_id = headers['session-id'];
    meta.thread_id = headers['thread-id'];
    meta['x-codex-window-id'] = headers['x-codex-window-id'];
    if (hasOwn(headers, 'x-codex-turn-metadata')) {
      var turnMetadata = headers['x-codex-turn-metadata'];
      meta['x-codex-turn-metadata'] = turnMetadata;
      var parsed;
      try {
        parsed = JSON.parse(turnMetadata);
      } catch (e) { /* A custom header may intentionally be an opaque string. */ }
      if (parsed && typeof parsed.installation_id === 'string') {
        meta['x-codex-installation-id'] = parsed.installation_id;
      }
    }
    next.client_metadata = meta;

    var input = next.input;
    if (typeof input === 'string') {
      input = [{ role: 'user', content: [{ type: 'input_text', text: input }] }];
    } else if (!Array.isArray(input)) {
      input = [];
    }
    next.input = [{
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: CODEX_DEVELOPER_PREFIX }]
    }].concat(input);
    next.prompt_cache_key = headers['session-id'];
    return next;
  }

  /** Claude CLI body rewrite for /messages requests. */
  function applyClaudeBody(body, headers) {
    var next = Object.assign({}, body);
    var existing = Array.isArray(body.system)
      ? body.system.slice()
      : (body.system ? [{ type: 'text', text: String(body.system) }] : []);
    next.system = [{ type: 'text', text: CLAUDE_IDENTITY }].concat(existing);
    next.metadata = Object.assign({}, body.metadata || {}, {
      user_id: JSON.stringify({
        device_id: randomHex(16),
        account_uuid: '',
        session_id: headers['x-claude-code-session-id']
      })
    });
    return next;
  }

  /** Gemini CLI body rewrite for generateContent requests. */
  function applyGeminiBody(body) {
    var next = Object.assign({}, body);
    var current = next.systemInstruction && Array.isArray(next.systemInstruction.parts)
      ? next.systemInstruction.parts
      : [];
    next.systemInstruction = Object.assign({}, next.systemInstruction || {}, {
      parts: [{ text: GEMINI_IDENTITY }].concat(current)
    });
    return next;
  }

  // Edit only the beta query field. URLSearchParams would re-encode unrelated
  // query values, including those in the raw /proxy/<target-url> route.
  function withClaudeBeta(url) {
    if (typeof url !== 'string') return url;
    var fragmentAt = url.indexOf('#');
    var fragment = fragmentAt === -1 ? '' : url.slice(fragmentAt);
    var target = fragmentAt === -1 ? url : url.slice(0, fragmentAt);
    var queryAt = target.indexOf('?');
    var path = queryAt === -1 ? target : target.slice(0, queryAt);
    var query = queryAt === -1 ? '' : target.slice(queryAt + 1);
    var fields = [];
    var found = false;
    (query ? query.split('&') : []).forEach(function (field) {
      var name = field.split('=')[0];
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch (e) { /* Preserve malformed escapes in unrelated query keys. */ }
      if (name === 'beta') {
        if (!found) fields.push('beta=true');
        found = true;
      } else {
        fields.push(field);
      }
    });
    if (!found) fields.push('beta=true');
    return path + '?' + fields.join('&') + fragment;
  }

  /**
   * Apply a request profile to an outgoing request.
   *
   * Returns the original request untouched when the profile is 'default', and a
   * `mismatch` flag (instead of silently applying the wrong identity) when the
   * profile does not belong to the vendor currently being tested.
   * `profileHeaders` is the final generated/custom mapping from this request;
   * transports must reuse it rather than generating another set of identities.
   */
  function applyRequestProfile(input) {
    input = input || {};
    var profile = input && input.profile;
    var vendor = input && input.vendor;
    if (!profile || profile === 'default') {
      return { applied: false, url: input.url, headers: input.headers, body: input.body, profileHeaders: {} };
    }
    var meta = hasOwn(REQUEST_PROFILE_META, profile) ? REQUEST_PROFILE_META[profile] : null;
    if (!meta) {
      return { applied: false, reason: 'unknown-profile', url: input.url, headers: input.headers, body: input.body, profileHeaders: {} };
    }
    if (meta.vendor && vendor && meta.vendor !== vendor) {
      return {
        applied: false,
        mismatch: true,
        reason: profile + ' 画像要求 ' + meta.vendor + ' 协议，当前为 ' + vendor,
        url: input.url,
        headers: input.headers,
        body: input.body,
        profileHeaders: {}
      };
    }

    var body = input.body;
    if (profile === 'codex' && !isResponsesShaped(body)) {
      // Codex CLI only speaks /responses. Applying its identity headers to a
      // chat-completions body would test a request the client never sends.
      return {
        applied: false,
        mismatch: true,
        reason: 'codex 画像要求 /responses 请求体（input / instructions）',
        url: input.url,
        headers: input.headers,
        body: input.body,
        profileHeaders: {}
      };
    }

    var options = input.options || {};
    var profileHeaders = buildProfileHeaders(profile, input.modelId, options);
    var baseHeaders = mergeHeaders(input.headers);
    if (profile === 'claude') {
      var customBeta = Object.keys(options.custom || {}).some(function (name) {
        return name.toLowerCase() === 'anthropic-beta';
      });
      if (!customBeta) {
        profileHeaders['anthropic-beta'] = mergeBetaFlags(baseHeaders['anthropic-beta'], profileHeaders['anthropic-beta']);
      }
    }
    var headers = mergeHeaders(baseHeaders, profileHeaders);
    var url = input.url;
    if (profile === 'codex') {
      body = applyCodexBody(body, headers);
    } else if (profile === 'claude') {
      body = applyClaudeBody(body || {}, headers);
      if (options.enhanced) url = withClaudeBeta(url);
    } else if (profile === 'gemini') {
      body = applyGeminiBody(body || {});
    }

    var blocked = BROWSER_BLOCKED_HEADERS.filter(function (name) {
      return headers[name] !== undefined;
    });
    return {
      applied: true,
      headers: headers,
      body: body,
      url: url,
      profileHeaders: profileHeaders,
      // Headers some browsers may ignore when sent directly, without a proxy.
      blockedHeaders: blocked
    };
  }

  /* ------------------------------------------------------------------ *
   * Error taxonomy
   * ------------------------------------------------------------------ *
   * One stable classification for every failure, so that batch runs and the
   * history list can be filtered, counted and acted on instead of showing raw
   * provider prose.
   */

  var ERROR_CATEGORIES = {
    network: {
      label: '网络错误',
      advice: '请求未到达服务端。检查 API URL 是否可达、代理是否生效、目标站点是否开启 CORS。',
      retriable: true
    },
    auth: {
      label: '鉴权失败',
      advice: '密钥无效或已过期。确认 API Key 属于该站点，并检查是否缺少 Authorization / x-api-key 头。',
      retriable: false
    },
    permission: {
      label: '权限不足',
      advice: '密钥有效但无权访问该模型或该能力。换模型，或确认账号分组是否开放此端点。',
      retriable: false
    },
    validation: {
      label: '请求不合法',
      advice: '服务端拒绝了请求体。通常是参数不被支持（如该模型不接受此 stream / tools / response_format）。',
      retriable: false
    },
    unsupported: {
      label: '能力不支持',
      advice: '该站点或模型未实现此能力。属于中转站能力缺口，不是配置问题。',
      retriable: false
    },
    server: {
      label: '服务端错误',
      advice: '请求已到达服务端但处理失败。多为一层上游或中转自身异常，与你的配置无关；重试通常可恢复。',
      retriable: true
    },
    rate_limit: {
      label: '限流',
      advice: '触发频率或配额限制。降低并发、稍后重试，或确认账号额度。',
      retriable: true
    },
    timeout: {
      label: '超时',
      advice: '在超时时间内未完成。长上下文或深度思考场景可适当调大超时。',
      retriable: true
    },
    unknown: {
      label: '未知错误',
      advice: '未匹配到已知模式。查看原始响应体判断归属。',
      retriable: false
    }
  };

  function matchAny(haystack, needles) {
    for (var i = 0; i < needles.length; i++) {
      if (haystack.indexOf(needles[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Classify an error (or a raw message excerpt) into ERROR_CATEGORIES.
   * `status` may be lifted from an HTTP response; `message` from any source.
   */
  function classifyError(input) {
    var status = (input && input.status) || 0;
    var name = (input && input.name) || '';
    var message = String((input && input.message) || '');
    var raw = String((input && input.rawText) || '');
    var haystack = (message + ' ' + raw).toLowerCase();

    var category;
    if (name === 'AbortError') {
      category = 'unknown';
    } else if (name === 'TimeoutError') {
      category = 'timeout';
    } else if (name === 'FetchNetworkError' || name === 'TypeError') {
      category = 'network';
    } else if (status === 401) {
      category = 'auth';
    } else if (status === 403) {
      category = 'permission';
    } else if (status === 429) {
      category = 'rate_limit';
    } else if (status === 408 || status === 504) {
      category = 'timeout';
    } else if (status === 404) {
      category = 'unsupported';
    } else if (status === 400 || status === 422) {
      category = 'validation';
    } else if (status >= 500) {
      // Reaching a 5xx means the request did arrive; calling this a network
      // error sends the user to check their URL and CORS for nothing.
      category = 'server';
    } else if (matchAny(haystack, ['invalid api key', 'incorrect api key', 'unauthorized', 'authentication', 'api key not valid', '无效的令牌', '令牌无效'])) {
      category = 'auth';
    } else if (matchAny(haystack, ['rate limit', 'too many requests', 'quota', 'insufficient_quota', '额度', '限流', '频率'])) {
      category = 'rate_limit';
    } else if (matchAny(haystack, ['not supported', 'unsupported', 'not implemented', 'does not support', '不支持'])) {
      category = 'unsupported';
    } else if (matchAny(haystack, ['permission', 'forbidden', 'not allowed', 'no access', '无权'])) {
      category = 'permission';
    } else if (matchAny(haystack, ['timeout', 'timed out', '超时'])) {
      category = 'timeout';
    } else if (matchAny(haystack, ['failed to fetch', 'networkerror', 'network error', 'econnrefused', 'cors'])) {
      category = 'network';
    } else {
      category = 'unknown';
    }

    var meta = ERROR_CATEGORIES[category];
    return {
      category: category,
      label: meta.label,
      advice: meta.advice,
      retriable: meta.retriable,
      status: status || undefined
    };
  }

  /** Compact one-line summary suitable for a results table cell. */
  function describeError(input) {
    var info = classifyError(input);
    var status = info.status ? 'HTTP ' + info.status + ' · ' : '';
    return status + info.label;
  }

  /**
   * Is this failure specifically a context/token ceiling rejection?
   *
   * Capacity search must not confuse "too long" with any other 400, otherwise a
   * parameter error would be reported as a capacity bound.
   */
  function isContextLimitError(input) {
    var status = (input && input.status) || 0;
    if (status === 413) return true;
    var haystack = (String((input && input.message) || '') + ' ' +
      String((input && input.rawText) || '')).toLowerCase();
    return matchAny(haystack, [
      'context length', 'context_length', 'context window', 'context size',
      'maximum context', 'max context', 'too many tokens', 'token limit',
      'prompt is too long', 'input is too long', 'request is too large',
      'reduce the length', 'exceeds the maximum', '超出最大上下文',
      '上下文长度', '内容过长', '输入过长', '超出限制'
    ]);
  }

  /** Best-effort token usage extraction across the four protocols. */
  function extractUsage(json) {
    if (!json) return null;
    var usage = json.usage || json.usageMetadata;
    if (!usage || typeof usage !== 'object') return null;
    var input = usage.prompt_tokens ?? usage.input_tokens ??
      usage.promptTokenCount ?? usage.inputTokenCount;
    var output = usage.completion_tokens ?? usage.output_tokens ??
      usage.candidatesTokenCount ?? usage.outputTokenCount;
    if (typeof input !== 'number' && typeof output !== 'number') return null;
    return {
      inputTokens: typeof input === 'number' ? input : undefined,
      outputTokens: typeof output === 'number' ? output : undefined
    };
  }

  /* ------------------------------------------------------------------ *
   * Structured output
   * ------------------------------------------------------------------ *
   * A deliberately small schema: the point is to prove the endpoint honours
   * schema-constrained decoding at all, not to test JSON Schema coverage.
   */

  var STRUCTURED_SCHEMA = {
    type: 'object',
    properties: {
      city: { type: 'string' },
      population: { type: 'integer' },
      coastal: { type: 'boolean' }
    },
    required: ['city', 'population', 'coastal'],
    additionalProperties: false
  };

  var STRUCTURED_PROMPT =
    'Return JSON describing the city of Lisbon: its name, its approximate ' +
    'population as an integer, and whether it is coastal. Respond with JSON only.';

  /**
   * Build a schema-constrained request for the given vendor.
   * Returns { body, mode } where mode names the enforcement mechanism, because
   * "structured output" is spelled differently by every provider.
   */
  function buildStructuredOutputBody(input) {
    var vendor = input.vendor;
    var model = input.model;
    var prompt = input.prompt || STRUCTURED_PROMPT;
    var stream = !!input.stream;

    if (vendor === 'anthropic') {
      // Anthropic has no response_format; a forced tool call is the documented
      // equivalent, so the probe reports which mechanism was used.
      return {
        body: {
          model: model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
          tools: [{
            name: 'emit_city',
            description: 'Emit the structured city record.',
            input_schema: STRUCTURED_SCHEMA
          }],
          tool_choice: { type: 'tool', name: 'emit_city' },
          stream: stream
        },
        mode: 'forced-tool'
      };
    }

    if (vendor === 'google') {
      return {
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: STRUCTURED_SCHEMA
          }
        },
        mode: 'responseSchema'
      };
    }

    if (input.responses) {
      return {
        body: {
          model: model,
          input: [{ role: 'user', content: prompt }],
          text: {
            format: {
              type: 'json_schema',
              name: 'city',
              strict: true,
              schema: STRUCTURED_SCHEMA
            }
          },
          stream: stream
        },
        mode: 'json_schema'
      };
    }

    return {
      body: {
        model: model,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'city', strict: true, schema: STRUCTURED_SCHEMA }
        },
        stream: stream
      },
      mode: 'json_schema'
    };
  }

  /** Pull the JSON candidate out of a provider-shaped response. */
  function extractStructuredCandidate(input) {
    var vendor = input.vendor;
    var json = input.json;
    var text = input.text || '';
    var toolCalls = input.toolCalls || null;

    if (vendor === 'anthropic') {
      if (toolCalls) {
        for (var i = 0; i < toolCalls.length; i++) {
          if (toolCalls[i] && toolCalls[i].input) return toolCalls[i].input;
        }
      }
      if (json && Array.isArray(json.content)) {
        for (var j = 0; j < json.content.length; j++) {
          var block = json.content[j];
          if (block && block.type === 'tool_use' && block.input) return block.input;
        }
        var textBlock = json.content.filter(function (b) { return b && b.type === 'text'; })[0];
        if (textBlock && textBlock.text) text = textBlock.text;
      }
    } else if (vendor === 'google') {
      if (toolCalls) {
        for (var k = 0; k < toolCalls.length; k++) {
          var call = toolCalls[k];
          if (call && call.args) return call.args;
        }
      }
      var candidate = json && json.candidates && json.candidates[0];
      if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
        var parts = candidate.content.parts.filter(function (p) { return p && typeof p.text === 'string'; });
        if (parts.length) text = parts.map(function (p) { return p.text; }).join('');
      }
    } else if (input.responses) {
      var output = (json && json.output) || [];
      for (var m = 0; m < output.length; m++) {
        var item = output[m];
        if (item && item.type === 'message' && Array.isArray(item.content)) {
          var texts = item.content.filter(function (c) { return c && typeof c.text === 'string'; });
          if (texts.length) text = texts.map(function (c) { return c.text; }).join('');
        }
      }
    } else {
      var choice = json && json.choices && json.choices[0];
      if (choice && choice.message) {
        if (choice.message.refusal) return { refusal: choice.message.refusal };
        if (typeof choice.message.content === 'string') text = choice.message.content;
      }
    }

    return parseJsonLoose(text);
  }

  /** Tolerate fenced code blocks and surrounding prose around a JSON object. */
  function parseJsonLoose(text) {
    if (!text) return null;
    if (typeof text === 'object') return text;
    var body = String(text).trim();
    var fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) body = fence[1].trim();
    try {
      return JSON.parse(body);
    } catch (e) {
      var start = body.indexOf('{');
      var end = body.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(body.slice(start, end + 1));
        } catch (e2) { /* fall through */ }
      }
    }
    return null;
  }

  /** Validate the parsed value against STRUCTURED_SCHEMA's three fields. */
  function validateStructured(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: '未返回 JSON 对象' };
    }
    for (var i = 0; i < STRUCTURED_SCHEMA.required.length; i++) {
      var field = STRUCTURED_SCHEMA.required[i];
      if (!hasOwn(value, field)) {
        return { ok: false, reason: '缺少字段 ' + field };
      }
    }
    if (Object.keys(value).some(function (name) { return !hasOwn(STRUCTURED_SCHEMA.properties, name); })) {
      return { ok: false, reason: '包含额外字段（模型未遵守 schema）' };
    }
    if (typeof value.city !== 'string') {
      return { ok: false, reason: 'city 不是字符串（模型未遵守 schema）' };
    }
    if (!Number.isInteger(value.population)) {
      return { ok: false, reason: 'population 不是整数（模型未遵守 schema）' };
    }
    if (typeof value.coastal !== 'boolean') {
      return { ok: false, reason: 'coastal 不是布尔值（模型未遵守 schema）' };
    }
    return { ok: true, value: value };
  }

  /* ------------------------------------------------------------------ *
   * Needle in a haystack
   * ------------------------------------------------------------------ *
   * Fills a prompt with plausible filler records, hides one target record at a
   * configurable depth, and asks for that record back. The filler is generated
   * locally from a seeded PRNG so the same seed reproduces the same prompt.
   */

  var NEEDLE_NOTES = [
    'the field team recorded the water level before returning to the station',
    'a librarian moved the maps to a dry room beside the main reading hall',
    'the morning train carried supplies for the repair work at the bridge',
    'observers compared the soil samples collected from three nearby gardens',
    'the workshop opened after the inspection of the lamps and ventilation',
    'a delivery schedule was revised when rain closed the northern road',
    'the survey described a walking route through the valley and forest',
    'new shelves were assembled to hold the collection of historical journals',
    'the weather report predicted clear skies for the evening observation',
    'residents discussed the opening hours of the community exhibition',
    'the repair crew checked each section before restoring the power supply',
    'the archive received a collection of sketches from the coastal expedition'
  ];

  var NEEDLE_MIN_TOKENS = 1024;
  var NEEDLE_DEPTHS = [10, 50, 90];

  /**
   * Build a needle prompt.
   *
   * `targetTokens` is an estimate, not a guarantee: the loop stops once the
   * estimate reaches the target, so the real token count lands within roughly
   * one record of it.
   */
  function buildNeedlePrompt(input) {
    var targetTokens = Math.max(NEEDLE_MIN_TOKENS, Math.floor(input.targetTokens || 8192));
    var depth = Math.min(100, Math.max(0, input.depth === undefined ? 50 : input.depth));
    var seed = (input.seed === undefined ? Math.floor(Math.random() * 0xffffffff) : input.seed) >>> 0;
    var random = createRandom(seed ^ 0x9e3779b9);

    var key = 'archive-' + hex8(random);
    var expected = archiveCode(random);

    var prefix = 'Read these archive notes and look up the requested record. ' +
      'Use only the supplied notes.\n<notes>\n';
    var suffix = '\n</notes>\nQuestion: Return only the archive code for record "' +
      key + '". Do not list other codes and do not explain your answer.';

    function recordLine() {
      var record = 'archive-' + hex8(random);
      var value = archiveCode(random);
      var note = NEEDLE_NOTES[random() % NEEDLE_NOTES.length];
      return 'Record "' + record + '" has archive code "' + value + '". Note: ' + note + '.\n';
    }

    var needle = 'Record "' + key + '" has archive code "' + expected + '".\n';

    // Build filler first so the needle can be spliced in at the right depth.
    var lines = [];
    var total = estimateTokens(prefix) + estimateTokens(needle) + estimateTokens(suffix);
    var guard = 0;
    while (total < targetTokens && guard < 200000) {
      guard++;
      var line = recordLine();
      var cost = estimateTokens(line);
      if (total + cost > targetTokens) break;
      lines.push({ line: line, cost: cost });
      total += cost;
    }

    var insertedAt = 0;
    var running = 0;
    var cutoff = (total * depth) / 100;
    while (insertedAt < lines.length && running + lines[insertedAt].cost / 2 < cutoff) {
      running += lines[insertedAt].cost;
      insertedAt++;
    }

    var before = lines.slice(0, insertedAt).map(function (l) { return l.line; }).join('');
    var after = lines.slice(insertedAt).map(function (l) { return l.line; }).join('');
    var prompt = prefix + before + needle + after + suffix;

    return {
      prompt: prompt,
      expected: expected,
      key: key,
      seed: seed,
      depth: depth,
      estimatedInputTokens: estimateTokens(prompt),
      estimatedBackgroundTokens: total
    };
  }

  /** Score a needle answer: exact match, case-insensitive, ignoring punctuation. */
  function scoreNeedleAnswer(answer, expected) {
    if (!answer || !expected) {
      return { verdict: 'miss', reason: '未返回内容' };
    }
    var text = String(answer).toLowerCase();
    if (text.indexOf(String(expected).toLowerCase()) !== -1) {
      return { verdict: 'hit', reason: '命中目标记录' };
    }
    var codes = text.match(/[0-9a-f]{32}/g);
    if (codes && codes.length) {
      return { verdict: 'miss', reason: '返回了其它 archive code（编码错误）' };
    }
    if (matchAny(text, ['cannot find', 'not found', '找不到', '未找到', 'unable to'])) {
      return { verdict: 'miss', reason: '模型声称找不到记录' };
    }
    return { verdict: 'miss', reason: '未包含目标编码' };
  }

  /* ------------------------------------------------------------------ *
   * Context capacity
   * ------------------------------------------------------------------ *
   * Bracket local estimated targets between an accepted probe and a context
   * rejection. These bounds do not establish the provider's actual token limit.
   * Starts high and halves downward, then bisects once both bounds exist.
   */

  var CAPACITY_OUTCOMES = {
    Accepted: 'accepted',
    ContextLimit: 'context-limit',
    Inconclusive: 'inconclusive'
  };

  var CAPACITY_REASONS = {
    Bracketed: 'bracketed',
    Ceiling: 'ceiling',
    TestLimit: 'test-limit',
    Budget: 'budget',
    Inconclusive: 'inconclusive',
    Stopped: 'stopped',
    Error: 'error'
  };

  var CAPACITY_DEFAULTS = {
    startTokens: 131072,
    maxTokens: 1048576,
    minTokens: 1024,
    resolutionTokens: 4096,
    maxRequests: 10,
    maxTotalTokens: 4194304
  };

  /**
   * Run a capacity search.
   *
   * `attempt(tokens)` must return a Promise of
   * { outcome, inputTokens?, message? }. This function owns the search policy
   * only; transport, prompt building and UI all stay with the caller.
   * Bounds and convergence use only the local target passed to attempt().
   * Provider inputTokens remain in attempts and count toward the total budget.
   */
  async function searchContextCapacity(options) {
    var attempt = options.attempt;
    var start = Math.max(CAPACITY_DEFAULTS.minTokens, Math.floor(options.startTokens || CAPACITY_DEFAULTS.startTokens));
    var maxTokens = Math.floor(options.maxTokens || start);
    var minTokens = Math.floor(options.minTokens || CAPACITY_DEFAULTS.minTokens);
    var resolution = Math.max(1, Math.floor(options.resolutionTokens || CAPACITY_DEFAULTS.resolutionTokens));
    var maxRequests = Math.floor(options.maxRequests || CAPACITY_DEFAULTS.maxRequests);
    var maxTotalTokens = Math.floor(options.maxTotalTokens || CAPACITY_DEFAULTS.maxTotalTokens);
    var signal = options.signal;
    var onProgress = options.onProgress || null;

    var result = {
      lowerBoundTokens: 0,
      upperBoundTokens: null,
      reason: CAPACITY_REASONS.TestLimit,
      attempts: []
    };

    var accepted = null;
    var rejected = null;
    var next = Math.min(maxTokens, Math.max(minTokens, start));
    var spent = 0;

    function stopped() {
      return !!(signal && signal.aborted);
    }

    function report() {
      if (!onProgress) return;
      try {
        onProgress({
          lowerBoundTokens: result.lowerBoundTokens,
          upperBoundTokens: result.upperBoundTokens,
          reason: result.reason,
          attempts: result.attempts.slice()
        });
      } catch (e) { /* progress callbacks must never break the search */ }
    }

    while (result.attempts.length < maxRequests) {
      if (stopped()) {
        result.reason = CAPACITY_REASONS.Stopped;
        break;
      }
      if (spent + next > maxTotalTokens) {
        result.reason = CAPACITY_REASONS.Budget;
        break;
      }

      var outcome;
      try {
        outcome = await attempt(next);
      } catch (err) {
        if (stopped()) {
          result.reason = CAPACITY_REASONS.Stopped;
          break;
        }
        outcome = { outcome: CAPACITY_OUTCOMES.Inconclusive, message: String(err && err.message || err) };
      }
      if (stopped()) {
        result.reason = CAPACITY_REASONS.Stopped;
        break;
      }

      var used = Math.max(next, (outcome && outcome.inputTokens) || 0);
      spent += used;
      result.attempts.push({
        targetTokens: next,
        outcome: outcome.outcome,
        inputTokens: outcome.inputTokens,
        message: outcome.message
      });

      if (outcome.outcome === CAPACITY_OUTCOMES.Accepted) {
        accepted = next;
        result.lowerBoundTokens = accepted;
      } else if (outcome.outcome === CAPACITY_OUTCOMES.ContextLimit) {
        rejected = next;
        result.upperBoundTokens = rejected;
      } else {
        result.reason = CAPACITY_REASONS.Inconclusive;
        report();
        break;
      }

      report();

      if (rejected !== null) {
        if (accepted === null) {
          if (next <= minTokens) {
            result.reason = CAPACITY_REASONS.Inconclusive;
            break;
          }
          next = Math.max(minTokens, Math.floor(next / 2));
          continue;
        }
        if (rejected - accepted <= resolution) {
          result.reason = CAPACITY_REASONS.Bracketed;
          break;
        }
        next = Math.floor((accepted + rejected) / 2);
      } else {
        if (next >= maxTokens) {
          // Accepted at the largest size we were willing to send: no upper
          // bound exists inside the search range.
          result.reason = CAPACITY_REASONS.Ceiling;
          break;
        }
        next = Math.min(next * 2, maxTokens);
      }
    }

    if (result.attempts.length >= maxRequests && result.reason === CAPACITY_REASONS.TestLimit) {
      result.reason = CAPACITY_REASONS.Budget;
    }
    report();
    return result;
  }

  function describeCapacityReason(reason) {
    if (reason === CAPACITY_REASONS.Bracketed) return '已收敛本地估算区间';
    if (reason === CAPACITY_REASONS.Ceiling) return '本地估算搜索区间内未触顶';
    if (reason === CAPACITY_REASONS.Budget) return '达到请求/总量预算，未定位';
    if (reason === CAPACITY_REASONS.Stopped) return '已手动停止';
    if (reason === CAPACITY_REASONS.Inconclusive) return '结果不确定（出现非容量类错误）';
    if (reason === CAPACITY_REASONS.Error) return '执行出错';
    return '未开始';
  }

  /** Build a cheap filler prompt of roughly `tokens` size plus a short instruction. */
  function buildFillerPrompt(tokens, instruction) {
    var target = Math.max(CAPACITY_DEFAULTS.minTokens, Math.floor(tokens || 1024));
    var random = createRandom(0x5f3759df);
    var parts = [];
    var total = 0;
    var guard = 0;
    while (total < target && guard < 300000) {
      guard++;
      var note = NEEDLE_NOTES[random() % NEEDLE_NOTES.length];
      var line = 'Reference note ' + hex8(random) + ': ' + note + '.\n';
      var cost = estimateTokens(line);
      if (total + cost > target) break;
      parts.push(line);
      total += cost;
    }
    var tail = '\n' + (instruction || 'Reply with the single word OK and nothing else.');
    var prompt = parts.join('') + tail;
    return { prompt: prompt, estimatedInputTokens: estimateTokens(prompt) };
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  global.TestingCore = {
    // tokens
    estimateTokens: estimateTokens,
    formatTokens: formatTokens,
    // profiles
    REQUEST_PROFILES: REQUEST_PROFILES,
    REQUEST_PROFILE_META: REQUEST_PROFILE_META,
    BROWSER_BLOCKED_HEADERS: BROWSER_BLOCKED_HEADERS,
    buildProfileHeaders: buildProfileHeaders,
    applyRequestProfile: applyRequestProfile,
    // errors
    ERROR_CATEGORIES: ERROR_CATEGORIES,
    classifyError: classifyError,
    describeError: describeError,
    isContextLimitError: isContextLimitError,
    extractUsage: extractUsage,
    // structured output
    STRUCTURED_SCHEMA: STRUCTURED_SCHEMA,
    STRUCTURED_PROMPT: STRUCTURED_PROMPT,
    buildStructuredOutputBody: buildStructuredOutputBody,
    extractStructuredCandidate: extractStructuredCandidate,
    parseJsonLoose: parseJsonLoose,
    validateStructured: validateStructured,
    // needle
    NEEDLE_DEPTHS: NEEDLE_DEPTHS,
    buildNeedlePrompt: buildNeedlePrompt,
    scoreNeedleAnswer: scoreNeedleAnswer,
    // capacity
    CAPACITY_OUTCOMES: CAPACITY_OUTCOMES,
    CAPACITY_REASONS: CAPACITY_REASONS,
    CAPACITY_DEFAULTS: CAPACITY_DEFAULTS,
    searchContextCapacity: searchContextCapacity,
    describeCapacityReason: describeCapacityReason,
    buildFillerPrompt: buildFillerPrompt
  };
})(typeof window !== 'undefined' ? window : this);
