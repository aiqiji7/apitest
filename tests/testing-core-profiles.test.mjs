import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/testing-core.js', import.meta.url), 'utf8');
const basicBeta = ['claude-code-20250219', 'interleaved-thinking-2025-05-14'];
const enhancedBeta = [
  'thinking-token-count-2026-05-13', 'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05', 'effort-2025-11-24'
];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function loadCore({ fallback = false } = {}) {
  let identities = 0;
  const sandbox = {
    crypto: fallback ? undefined : {
      randomUUID() {
        return `00000000-0000-4000-8000-${String(++identities).padStart(12, '0')}`;
      },
      getRandomValues(buffer) { buffer.fill(42); return buffer; }
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return { core: sandbox.TestingCore, identities: () => identities };
}

function request(overrides = {}) {
  return {
    profile: 'codex', vendor: 'openai', modelId: 'gpt-5',
    url: 'https://api.example/v1/responses?key=redacted%2Fkey',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer original' },
    body: { model: 'gpt-5', input: 'hello' },
    ...overrides
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function checkProfileMapping(result) {
  for (const [name, value] of Object.entries(result.profileHeaders)) {
    assert.equal(name, name.toLowerCase());
    assert.equal(result.headers[name], value, name);
  }
  assert.equal(new Set(Object.keys(result.headers).map(name => name.toLowerCase())).size,
    Object.keys(result.headers).length);
}

test('basic Codex keeps existing identity and Responses body behavior', () => {
  const { core, identities } = loadCore();
  const result = core.applyRequestProfile(request());
  assert.equal(result.applied, true);
  assert.equal(result.headers['user-agent'], 'codex_cli_rs/0.164.0 (Windows 10.0; x86_64)');
  assert.equal(result.headers.originator, 'codex_cli_rs');
  for (const name of ['session-id', 'thread-id', 'x-client-request-id']) {
    assert.match(result.headers[name], uuidPattern);
  }
  assert.equal(identities(), 3);
  assert.notEqual(result.headers['thread-id'], result.headers['x-client-request-id']);
  assert.equal(result.headers['x-codex-window-id'], `${result.headers['thread-id']}:0`);
  assert.equal(result.body.store, false);
  assert.equal(result.body.input[0].role, 'developer');
  assert.equal(result.body.input[1].content[0].text, 'hello');
  assert.ok(result.body.include.includes('reasoning.encrypted_content'));
  assert.equal(result.body.client_metadata.session_id, result.headers['session-id']);
  assert.equal(result.body.client_metadata.thread_id, result.headers['thread-id']);
  assert.equal(result.body.prompt_cache_key, result.headers['session-id']);
  assert.equal(result.headers['x-codex-turn-metadata'], undefined);
  assert.equal(result.headers.authorization, 'Bearer original');
  assert.ok(result.blockedHeaders.includes('user-agent'));
  checkProfileMapping(result);
});

test('enhanced Codex generates metadata once and reuses the final identities everywhere', () => {
  const { core, identities } = loadCore();
  const before = Date.now();
  const result = core.applyRequestProfile(request({ options: { enhanced: true } }));
  const after = Date.now();
  const headers = result.headers;
  const metadata = JSON.parse(headers['x-codex-turn-metadata']);
  assert.deepEqual(Object.keys(metadata).sort(), [
    'installation_id', 'session_id', 'thread_id', 'window_id', 'window_number',
    'turn_id', 'root_turn_id', 'request_kind', 'history_initialization', 'model',
    'turn_started_at_unix_ms'
  ].sort());
  assert.equal(identities(), 4);
  assert.match(metadata.installation_id, uuidPattern);
  assert.match(metadata.turn_id, uuidPattern);
  assert.equal(metadata.root_turn_id, metadata.turn_id);
  assert.equal(metadata.session_id, headers['session-id']);
  assert.equal(metadata.thread_id, headers['thread-id']);
  assert.equal(metadata.window_id, headers['x-codex-window-id']);
  assert.equal(metadata.window_number, 0);
  assert.equal(metadata.request_kind, 'turn');
  assert.equal(metadata.history_initialization, 'new');
  assert.equal(metadata.model, 'gpt-5');
  assert.ok(metadata.turn_started_at_unix_ms >= before && metadata.turn_started_at_unix_ms <= after);
  assert.equal(headers['x-client-request-id'], headers['thread-id']);
  assert.equal(result.body.client_metadata['x-codex-turn-metadata'], headers['x-codex-turn-metadata']);
  assert.equal(result.body.client_metadata['x-codex-installation-id'], metadata.installation_id);
  assert.equal(result.body.prompt_cache_key, metadata.session_id);
  checkProfileMapping(result);
});

test('custom Codex identities and authorization override all casing variants', () => {
  const { core } = loadCore();
  const result = core.applyRequestProfile(request({
    headers: { Authorization: 'Bearer original', AUTHORIZATION: 'Bearer other', 'SESSION-ID': 'base' },
    options: {
      enhanced: true,
      custom: {
        'Session-ID': 'custom-session', 'THREAD-id': 'custom-thread',
        'X-Client-Request-ID': 'custom-request', AUTHORIZATION: 'Bearer custom',
        'User-Agent': 'my-cli', Constructor: 'safe-constructor'
      }
    }
  }));
  assert.equal(result.headers.authorization, 'Bearer custom');
  assert.equal(result.headers['user-agent'], 'my-cli');
  assert.equal(result.headers['session-id'], 'custom-session');
  assert.equal(result.headers['thread-id'], 'custom-thread');
  assert.equal(result.headers['x-client-request-id'], 'custom-request');
  assert.equal(result.headers['x-codex-window-id'], 'custom-thread:0');
  const metadata = JSON.parse(result.headers['x-codex-turn-metadata']);
  assert.equal(metadata.session_id, 'custom-session');
  assert.equal(metadata.thread_id, 'custom-thread');
  assert.equal(metadata.window_id, 'custom-thread:0');
  assert.equal(result.body.client_metadata.session_id, 'custom-session');
  assert.equal(result.body.client_metadata.thread_id, 'custom-thread');
  assert.equal(result.body.prompt_cache_key, 'custom-session');
  assert.equal(result.profileHeaders.constructor, 'safe-constructor');
  assert.equal(Object.hasOwn(result.profileHeaders, 'authorization'), true);
  checkProfileMapping(result);
});

test('derived Codex request and window IDs follow custom thread unless explicitly overridden', () => {
  const { core } = loadCore();
  const headers = core.buildProfileHeaders('codex', 'm', {
    enhanced: true, custom: { 'Thread-ID': 'thread-final', 'X-Codex-Window-ID': 'window-final' }
  });
  assert.equal(headers['x-client-request-id'], 'thread-final');
  assert.equal(headers['x-codex-window-id'], 'window-final');
  assert.equal(JSON.parse(headers['x-codex-turn-metadata']).window_id, 'window-final');
});

for (const enhanced of [false, true]) {
  for (const explicitWindow of [false, true]) {
    test(`Codex trims header OWS before deriving identities and cache (enhanced=${enhanced}, window=${explicitWindow})`, () => {
      const { core } = loadCore();
      const custom = {
        'Session-ID': ' \tsession with\tspace\t ',
        'Thread-ID': '\t thread with space \t',
        ...(explicitWindow ? { 'X-Codex-Window-ID': ' \twindow with space\t ' } : {})
      };
      const input = freezeDeep(request({ options: { enhanced, custom } }));
      const result = core.applyRequestProfile(input);
      const sent = new Headers(result.headers);
      const session = 'session with\tspace';
      const thread = 'thread with space';
      const window = explicitWindow ? 'window with space' : `${thread}:0`;
      for (const [name, value] of [
        ['session-id', session], ['thread-id', thread], ['x-codex-window-id', window]
      ]) {
        assert.equal(result.profileHeaders[name], value);
        assert.equal(sent.get(name), value);
      }
      assert.equal(result.body.client_metadata.session_id, sent.get('session-id'));
      assert.equal(result.body.client_metadata.thread_id, sent.get('thread-id'));
      assert.equal(result.body.client_metadata['x-codex-window-id'], sent.get('x-codex-window-id'));
      assert.equal(result.body.prompt_cache_key, sent.get('session-id'));
      if (enhanced) {
        assert.equal(result.headers['x-client-request-id'], thread);
        assert.equal(sent.get('x-client-request-id'), thread);
        const metadata = JSON.parse(sent.get('x-codex-turn-metadata'));
        assert.equal(metadata.session_id, session);
        assert.equal(metadata.thread_id, thread);
        assert.equal(metadata.window_id, window);
        assert.equal(result.body.client_metadata['x-codex-turn-metadata'], sent.get('x-codex-turn-metadata'));
      }
      assert.equal(custom['Session-ID'], ' \tsession with\tspace\t ');
      checkProfileMapping(result);
    });
  }

  test(`Claude session metadata matches native Headers after OWS normalization (enhanced=${enhanced})`, () => {
    const { core } = loadCore();
    const result = core.applyRequestProfile(request({
      profile: 'claude', vendor: 'anthropic',
      options: { enhanced, custom: {
        'X-Claude-Code-Session-ID': '\t session with\tspace \t',
        'Anthropic-Beta': ' \tcustom-only \t'
      } }
    }));
    const sent = new Headers(result.headers);
    assert.equal(result.profileHeaders['x-claude-code-session-id'], 'session with\tspace');
    assert.equal(JSON.parse(result.body.metadata.user_id).session_id, sent.get('x-claude-code-session-id'));
    assert.equal(result.profileHeaders['anthropic-beta'], 'custom-only');
    assert.equal(sent.get('anthropic-beta'), 'custom-only');
    checkProfileMapping(result);
  });
}

test('custom turn metadata loses only outer OWS before header and body reuse', () => {
  const { core } = loadCore();
  const metadata = JSON.stringify({ installation_id: ' installation with space ', extra: 'kept' });
  const result = core.applyRequestProfile(request({
    options: { enhanced: true, custom: { 'X-Codex-Turn-Metadata': ` \t${metadata}\t ` } }
  }));
  const sent = new Headers(result.profileHeaders);
  assert.equal(result.profileHeaders['x-codex-turn-metadata'], metadata);
  assert.equal(result.body.client_metadata['x-codex-turn-metadata'], sent.get('x-codex-turn-metadata'));
  assert.equal(result.body.client_metadata['x-codex-installation-id'], ' installation with space ');
});

test('custom headers preserve internal whitespace and Latin-1 edges while OWS-only values become empty', () => {
  const { core } = loadCore();
  for (const profile of ['codex', 'claude', 'gemini']) {
    const headers = core.buildProfileHeaders(profile, 'm', { custom: {
      'X-Latin1': ' \t\u00a0caf\u00e9  with\tspace\u00a0\t ', 'X-Empty': ' \t \t'
    } });
    const sent = new Headers(headers);
    assert.equal(headers['x-latin1'], '\u00a0caf\u00e9  with\tspace\u00a0');
    assert.equal(headers['x-latin1'], sent.get('x-latin1'));
    assert.equal(headers['x-empty'], '');
    assert.equal(headers['x-empty'], sent.get('x-empty'));
  }
});

test('custom turn metadata is the complete final string in headers and body', () => {
  const { core } = loadCore();
  const metadata = JSON.stringify({ installation_id: 'custom-installation', extra: 'kept' });
  const result = core.applyRequestProfile(request({
    options: { enhanced: true, custom: { 'X-Codex-Turn-Metadata': metadata } }
  }));
  assert.equal(result.profileHeaders['x-codex-turn-metadata'], metadata);
  assert.equal(result.body.client_metadata['x-codex-turn-metadata'], metadata);
  assert.equal(result.body.client_metadata['x-codex-installation-id'], 'custom-installation');
  const opaque = core.applyRequestProfile(request({
    options: { enhanced: true, custom: { 'x-codex-turn-metadata': 'opaque-custom-value' } }
  }));
  assert.equal(opaque.body.client_metadata['x-codex-turn-metadata'], 'opaque-custom-value');
  assert.equal(opaque.body.client_metadata['x-codex-installation-id'], undefined);
});

test('basic Claude has original headers and preserves caller beta flags without duplicates', () => {
  const { core } = loadCore();
  const headers = core.buildProfileHeaders('claude', 'claude-sonnet');
  assert.equal(headers['user-agent'], 'claude-cli/2.1.306 (external, cli)');
  assert.equal(headers['x-app'], 'cli');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['anthropic-beta'], basicBeta.join(','));
  const result = core.applyRequestProfile(request({
    profile: 'claude', vendor: 'anthropic',
    headers: { 'Anthropic-Beta': 'caller-flag, claude-code-20250219' },
    body: { system: 'existing instructions', metadata: { other: true } }
  }));
  assert.deepEqual(result.headers['anthropic-beta'].split(','), ['caller-flag', ...basicBeta]);
  assert.equal(result.url, request().url);
  assert.match(result.body.system[0].text, /Claude Code/);
  assert.equal(result.body.system[1].text, 'existing instructions');
  assert.equal(result.body.metadata.other, true);
  assert.equal(JSON.parse(result.body.metadata.user_id).session_id,
    result.headers['x-claude-code-session-id']);
  assert.deepEqual(Object.keys(result.headers).filter(name => name.startsWith('x-stainless-')), []);
  checkProfileMapping(result);
});

test('enhanced Claude adds eight stainless headers and four flags', () => {
  const { core } = loadCore();
  const headers = core.buildProfileHeaders('claude', 'claude-sonnet', { enhanced: true });
  const expected = {
    'x-stainless-lang': 'js', 'x-stainless-package-version': '0.128.0',
    'x-stainless-os': 'Windows', 'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node', 'x-stainless-runtime-version': 'v26.3.0',
    'x-stainless-retry-count': '0', 'x-stainless-timeout': '600'
  };
  assert.deepEqual(Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-stainless-'))), expected);
  assert.equal(headers['anthropic-beta'], [...basicBeta, ...enhancedBeta].join(','));
});

test('custom Claude beta, direct-browser flag and session override generated values last', () => {
  const { core } = loadCore();
  const result = core.applyRequestProfile(request({
    profile: 'claude', vendor: 'anthropic', headers: { 'Anthropic-Beta': 'base-flag' },
    options: { enhanced: true, custom: {
      'ANTHROPIC-beta': 'custom-only', 'X-Stainless-Lang': 'custom-lang',
      'X-Claude-Code-Session-ID': 'custom-session',
      'Anthropic-Dangerous-Direct-Browser-Access': 'false'
    } }
  }));
  assert.equal(result.headers['anthropic-beta'], 'custom-only');
  assert.equal(result.profileHeaders['anthropic-beta'], 'custom-only');
  assert.equal(result.headers['x-stainless-lang'], 'custom-lang');
  assert.equal(result.headers['anthropic-dangerous-direct-browser-access'], 'false');
  assert.equal(JSON.parse(result.body.metadata.user_id).session_id, 'custom-session');
  checkProfileMapping(result);
  const empty = core.applyRequestProfile(request({
    profile: 'claude', vendor: 'anthropic',
    options: { custom: { 'Anthropic-Beta': '', 'X-Claude-Code-Session-ID': '' } }
  }));
  assert.equal(empty.headers['anthropic-beta'], '');
  assert.equal(JSON.parse(empty.body.metadata.user_id).session_id, '');
});

for (const [url, expected] of [
  ['https://api.example/v1/messages', 'https://api.example/v1/messages?beta=true'],
  ['https://api.example/v1/messages?key=a%2Fb&flag=a%20b', 'https://api.example/v1/messages?key=a%2Fb&flag=a%20b&beta=true'],
  ['https://api.example/v1/messages?beta=false&key=k#fragment', 'https://api.example/v1/messages?beta=true&key=k#fragment'],
  ['https://proxy.example/proxy/https://api.example/v1/messages?key=a%2Fb&beta=false', 'https://proxy.example/proxy/https://api.example/v1/messages?key=a%2Fb&beta=true'],
  ['/proxy/https://api.example/v1/messages?key=a%2Fb', '/proxy/https://api.example/v1/messages?key=a%2Fb&beta=true']
]) {
  test(`enhanced Claude preserves raw query and proxy URL: ${url}`, () => {
    const { core } = loadCore();
    const result = core.applyRequestProfile(request({
      profile: 'claude', vendor: 'anthropic', url, options: { enhanced: true }
    }));
    assert.equal(result.url, expected);
    assert.equal(result.body.system.length, 1);
    assert.equal(result.body.system[0].text, "You are Claude Code, Anthropic's official CLI tool.");
  });
}

test('Gemini keeps SDK header and identity injection in both modes', () => {
  const { core } = loadCore();
  for (const enhanced of [false, true]) {
    const input = freezeDeep(request({
      profile: 'gemini', vendor: 'google', modelId: 'gemini-3-flash',
      body: { systemInstruction: { role: 'system', parts: [{ text: 'existing' }] } },
      options: { enhanced, custom: { 'X-Goog-Api-Client': 'my-sdk', 'X-Extra': 'custom' } }
    }));
    const result = core.applyRequestProfile(input);
    assert.equal(result.headers['user-agent'], 'GeminiCLI/0.65.0/gemini-3-flash (win32; x64; cli)');
    assert.equal(result.headers['x-goog-api-client'], 'my-sdk');
    assert.equal(result.headers['x-extra'], 'custom');
    assert.equal(result.body.systemInstruction.parts[0].text, 'You are Gemini CLI, a command-line interface for Gemini.');
    assert.equal(result.body.systemInstruction.parts[1].text, 'existing');
    assert.equal(result.body.systemInstruction.role, 'system');
    assert.equal(result.url, input.url);
    checkProfileMapping(result);
  }
  assert.equal(core.buildProfileHeaders('gemini', 'm')['x-goog-api-client'], 'genai-js/0.65.0');
});

test('applying profiles leaves frozen body, headers, and options untouched', () => {
  const { core } = loadCore();
  const input = freezeDeep(request({
    body: {
      input: [{ role: 'user', content: 'hello' }],
      include: ['original', 'reasoning.encrypted_content'],
      client_metadata: { original: 'kept' }, prompt_cache_key: 'original-cache'
    },
    options: { enhanced: true, custom: { 'X-Extra': 'custom' } }
  }));
  const snapshot = JSON.stringify(input);
  const result = core.applyRequestProfile(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(result.headers, input.headers);
  assert.notEqual(result.body, input.body);
  assert.notEqual(result.body.include, input.body.include);
  assert.notEqual(result.body.client_metadata, input.body.client_metadata);
  assert.equal(result.body.client_metadata.original, 'kept');
  assert.deepEqual(Array.from(result.body.include), ['original', 'reasoning.encrypted_content']);
  assert.equal(result.body.input.length, 2);
  assert.equal(result.body.prompt_cache_key, result.headers['session-id']);
});

test('default, unknown and mismatched requests retain originals without generating identities', () => {
  const { core, identities } = loadCore();
  const variants = [
    { profile: 'default' }, { profile: undefined }, { profile: 'unknown' },
    { profile: '__proto__' }, { profile: 'constructor' }, { profile: 'toString' },
    { profile: 'claude', vendor: 'openai' },
    { body: { messages: [{ role: 'user', content: 'hello' }] } }
  ];
  for (const variant of variants) {
    const input = request({ ...variant, options: { enhanced: true, custom: { 'Bad Name': 'ignored' } } });
    const result = core.applyRequestProfile(input);
    assert.equal(result.applied, false);
    assert.equal(result.url, input.url);
    assert.equal(result.headers, input.headers);
    assert.equal(result.body, input.body);
    assert.deepEqual(Object.keys(result.profileHeaders), []);
  }
  assert.equal(identities(), 0);
  assert.deepEqual(Object.keys(core.buildProfileHeaders('default', 'm', { enhanced: true, custom: { 'User-Agent': 'ignored' } })), []);
});

for (const [label, custom, error] of [
  ['null mapping', null, /object/i],
  ['array mapping', [], /object/i],
  ['string mapping', 'private-secret', /object/i],
  ['number mapping', 42, /object/i],
  ['Date mapping', new Date(), /object/i],
  ['Map mapping', new Map([['x-key', 'secret']]), /object/i],
  ['non-string value', { Authorization: 42 }, /string/i],
  ['empty name', { '': 'private-secret' }, /name|token/i],
  ['space in name', { 'Bad Name': 'private-secret' }, /name|token/i],
  ['colon in name', { 'Bad:Name': 'private-secret' }, /name|token/i],
  ['trailing newline in name', { 'private-secret\n': 'private-secret' }, /name|token/i],
  ['CRLF value', { Authorization: 'private-secret\r\ninjected: true' }, /value|control/i],
  ['NUL value', { Authorization: 'private-secret\0' }, /value|control/i],
  ['control value', { Authorization: 'private-secret\x1f' }, /value|control/i],
  ['DEL value', { Authorization: 'private-secret\x7f' }, /value|control/i],
  ['Unicode outside ByteString', { Authorization: 'private-secret中文' }, /ByteString|U\+00FF|255|Latin-1/i],
  ['proxy control header', { 'X-APITest-Override-Headers': 'private-secret' }, /proxy|reserved|control/i],
  ['mixed case proxy control', { 'x-APITEST-override-HEADERS': 'private-secret' }, /proxy|reserved|control/i]
]) {
  test(`invalid custom headers fail with safe context: ${label}`, () => {
    const { core } = loadCore();
    for (const invoke of [
      () => core.buildProfileHeaders('codex', 'm', { custom }),
      () => core.applyRequestProfile(request({ options: { custom } }))
    ]) {
      assert.throws(invoke, err => {
        assert.match(err.message, /custom.*header/i);
        assert.match(err.message, error);
        assert.equal(err.message.includes('private-secret'), false);
        return true;
      });
    }
  });
}

test('legal token names and Latin-1 values work without Object prototype collisions', () => {
  const { core } = loadCore();
  const custom = JSON.parse('{"__proto__":"safe-proto","constructor":"safe-constructor","toString":"safe-string"}');
  custom["X!#$%&'*+-.^_`|~"] = 'legal-token';
  custom['X-Latin1'] = 'caf\u00e9\tvalue';
  const result = core.applyRequestProfile(request({ options: { custom } }));
  assert.equal(Object.hasOwn(result.headers, '__proto__'), true);
  assert.equal(Object.hasOwn(result.profileHeaders, '__proto__'), true);
  assert.equal(result.headers.__proto__, 'safe-proto');
  assert.equal(result.profileHeaders.constructor, 'safe-constructor');
  assert.equal(result.profileHeaders.tostring, 'safe-string');
  assert.equal(result.headers['x-latin1'], 'caf\u00e9\tvalue');
  assert.equal(Object.getPrototypeOf(result.headers).polluted, undefined);
  assert.doesNotThrow(() => new Headers(result.profileHeaders));
  checkProfileMapping(result);
});

test('null-prototype custom maps work and inherited entries do not become headers', () => {
  const { core } = loadCore();
  const custom = Object.create(null);
  custom['User-Agent'] = 'custom-cli';
  assert.equal(core.buildProfileHeaders('gemini', 'm', { custom })['user-agent'], 'custom-cli');
  const inherited = Object.create({ Authorization: 'Bearer inherited' });
  inherited['X-Extra'] = 'own-value';
  const result = core.applyRequestProfile(request({ options: { custom: inherited } }));
  assert.equal(result.headers.authorization, 'Bearer original');
  assert.equal(Object.hasOwn(result.profileHeaders, 'authorization'), false);
  assert.equal(result.profileHeaders['x-extra'], 'own-value');
});

test('UUID fallback still produces UUID v4 identities', () => {
  const { core } = loadCore({ fallback: true });
  const headers = core.buildProfileHeaders('codex', 'm');
  for (const name of ['session-id', 'thread-id', 'x-client-request-id']) {
    assert.match(headers[name], uuidPattern);
  }
});
