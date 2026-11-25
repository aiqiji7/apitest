import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sandbox = {};
sandbox.window = sandbox;
vm.runInNewContext(readFileSync(new URL('../assets/js/testing-core.js', import.meta.url), 'utf8'), sandbox);
const core = sandbox.TestingCore;
const { Accepted, ContextLimit, Inconclusive } = core.CAPACITY_OUTCOMES;
const reasons = core.CAPACITY_REASONS;
const city = { city: 'Lisbon', population: 545000, coastal: true };

for (const [label, value] of [
  ['ordinary city', city],
  ['minimal values', { city: '', population: 0, coastal: false }],
  ['negative integer without a schema minimum', { city: ' ', population: -1, coastal: false }],
  ['large integer without a schema maximum', { city: 'x', population: 1e20, coastal: true }],
  ['null prototype object', Object.assign(Object.create(null), city)]
]) {
  test(`structured schema accepts ${label}`, () => {
    const result = core.validateStructured(value);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value, value);
  });
}

test('structured schema rejects values other than objects', () => {
  for (const value of [null, undefined, [], 'city', 1, false]) {
    assert.equal(core.validateStructured(value).ok, false);
  }
});

for (const [label, value] of [
  ['fractional population', { ...city, population: 1.5 }],
  ['negative fractional population', { ...city, population: -1.5 }],
  ['NaN population', { ...city, population: NaN }],
  ['infinite population', { ...city, population: Infinity }],
  ['string population', { ...city, population: '545000' }],
  ['non-string city', { ...city, city: 1 }],
  ['non-boolean coastal', { ...city, coastal: 1 }],
  ['extra field', { ...city, country: 'Portugal' }],
  ['own constructor field', { ...city, constructor: 'extra' }],
  ['own __proto__ field', JSON.parse('{"city":"Lisbon","population":1,"coastal":true,"__proto__":{}}')]
]) {
  test(`structured schema rejects ${label}`, () => {
    assert.equal(core.validateStructured(value).ok, false);
  });
}

for (const field of ['city', 'population', 'coastal']) {
  test(`structured schema requires own field ${field}`, () => {
    const missing = Object.fromEntries(Object.entries(city).filter(([name]) => name !== field));
    assert.equal(core.validateStructured(missing).ok, false);
    const inherited = Object.assign(Object.create({ [field]: city[field] }), missing);
    assert.equal(core.validateStructured(inherited).ok, false);
  });
}

test('inherited extra fields are not JSON object properties', () => {
  const value = Object.assign(Object.create({ extra: 'ignored' }), city);
  assert.equal(core.validateStructured(value).ok, true);
});

test('structured validation preserves loose parsing and provider extraction compatibility', () => {
  const json = JSON.stringify(city);
  for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Here is the result: ${json} done.`]) {
    assert.equal(core.validateStructured(core.parseJsonLoose(text)).ok, true);
  }
  for (const input of [
    { vendor: 'openai', json: { choices: [{ message: { content: json } }] } },
    { vendor: 'openai', responses: true, json: { output: [{ type: 'message', content: [{ text: json }] }] } },
    { vendor: 'anthropic', json: { content: [{ type: 'tool_use', input: city }] } },
    { vendor: 'anthropic', toolCalls: [{ input: city }] },
    { vendor: 'google', json: { candidates: [{ content: { parts: [{ text: json }] } }] } },
    { vendor: 'google', toolCalls: [{ args: city }] },
    { vendor: 'openai', text: json }
  ]) {
    assert.equal(core.validateStructured(core.extractStructuredCandidate(input)).ok, true);
  }
  assert.equal(core.parseJsonLoose('not JSON'), null);
});

function checkEstimatedBounds(result) {
  const accepted = result.attempts.filter(attempt => attempt.outcome === Accepted);
  const rejected = result.attempts.filter(attempt => attempt.outcome === ContextLimit);
  assert.equal(result.lowerBoundTokens, accepted.length ? Math.max(...accepted.map(attempt => attempt.targetTokens)) : 0);
  assert.equal(result.upperBoundTokens, rejected.length ? Math.min(...rejected.map(attempt => attempt.targetTokens)) : null);
  if (result.upperBoundTokens !== null) {
    assert.ok(result.lowerBoundTokens < result.upperBoundTokens, 'local estimate interval must never invert');
  }
}

for (const startTokens of [16384, 131072]) {
  for (const [label, acceptedScale, rejectedScale] of [
    ['usage above estimates', 2, 2],
    ['usage below estimates', 0.5, 0.5],
    ['accepted usage above and rejected usage below estimates', 2, 0.5]
  ]) {
    test(`capacity brackets local targets with ${label} (start=${startTokens})`, async () => {
      const snapshots = [];
      const result = await core.searchContextCapacity({
        startTokens, maxTokens: 262144, resolutionTokens: 4096,
        onProgress(progress) {
          snapshots.push(progress);
        },
        attempt: async target => {
          const accepted = target <= 64000;
          return { outcome: accepted ? Accepted : ContextLimit,
            inputTokens: target * (accepted ? acceptedScale : rejectedScale),
            message: accepted ? 'accepted' : 'context limit' };
        }
      });
      assert.equal(result.reason, reasons.Bracketed);
      checkEstimatedBounds(result);
      assert.ok(result.lowerBoundTokens <= 64000 && result.upperBoundTokens > 64000);
      assert.ok(result.upperBoundTokens - result.lowerBoundTokens <= 4096);
      assert.equal(snapshots.length, result.attempts.length + 1);
      snapshots.forEach(checkEstimatedBounds);
      for (const attempt of result.attempts) {
        assert.equal(attempt.inputTokens, attempt.targetTokens * (attempt.outcome === Accepted ? acceptedScale : rejectedScale));
        assert.equal(attempt.message, attempt.outcome === Accepted ? 'accepted' : 'context limit');
      }
    });
  }
}

test('capacity uses target estimates when usage is absent', async () => {
  const result = await core.searchContextCapacity({
    startTokens: 8192, maxTokens: 32768, resolutionTokens: 1024,
    attempt: async target => ({ outcome: target <= 10000 ? Accepted : ContextLimit })
  });
  assert.equal(result.reason, reasons.Bracketed);
  checkEstimatedBounds(result);
  assert.ok(result.upperBoundTokens - result.lowerBoundTokens <= 1024);
});

test('capacity ceiling is an accepted local target with no rejected upper bound', async () => {
  const result = await core.searchContextCapacity({
    startTokens: 8192, maxTokens: 32768,
    attempt: async target => ({ outcome: Accepted, inputTokens: target * 2 })
  });
  assert.equal(result.reason, reasons.Ceiling);
  checkEstimatedBounds(result);
  assert.equal(result.lowerBoundTokens, 32768);
  assert.equal(result.upperBoundTokens, null);
});

test('capacity rejection at the minimum stays inconclusive without an accepted lower bound', async () => {
  const result = await core.searchContextCapacity({
    startTokens: 4096, minTokens: 1024,
    attempt: async target => ({ outcome: ContextLimit, inputTokens: target / 2 })
  });
  assert.equal(result.reason, reasons.Inconclusive);
  checkEstimatedBounds(result);
  assert.equal(result.lowerBoundTokens, 0);
  assert.equal(result.upperBoundTokens, 1024);
});

test('capacity stop before a request sends nothing', async () => {
  let calls = 0;
  const result = await core.searchContextCapacity({
    signal: { aborted: true },
    attempt: async () => { calls++; return { outcome: Accepted }; }
  });
  assert.equal(result.reason, reasons.Stopped);
  assert.equal(calls, 0);
  assert.equal(result.attempts.length, 0);
  checkEstimatedBounds(result);
});

test('capacity stop during a request preserves only earlier completed bounds', async () => {
  const signal = { aborted: false };
  let calls = 0;
  const result = await core.searchContextCapacity({
    startTokens: 4096, maxTokens: 32768, signal,
    attempt: async target => {
      if (++calls === 2) {
        signal.aborted = true;
        throw Object.assign(new Error('stopped'), { name: 'AbortError' });
      }
      return { outcome: Accepted, inputTokens: target * 2 };
    }
  });
  assert.equal(result.reason, reasons.Stopped);
  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 1);
  checkEstimatedBounds(result);
});

for (const status of [401, 429]) {
  test(`capacity HTTP ${status} errors do not establish a rejected capacity`, async () => {
    const result = await core.searchContextCapacity({
      startTokens: 4096, maxTokens: 16384,
      attempt: async target => {
        if (target === 4096) return { outcome: Accepted, inputTokens: target * 2 };
        const message = status === 401 ? 'invalid api key' : 'rate limit';
        assert.equal(core.isContextLimitError({ status, message }), false);
        throw Object.assign(new Error(message), { status });
      }
    });
    assert.equal(result.reason, reasons.Inconclusive);
    assert.equal(result.attempts[1].outcome, Inconclusive);
    assert.equal(result.upperBoundTokens, null);
    checkEstimatedBounds(result);
  });
}

test('capacity request budget preserves an unconverged local interval', async () => {
  const result = await core.searchContextCapacity({
    startTokens: 8192, maxTokens: 65536, maxRequests: 3, resolutionTokens: 1,
    attempt: async target => ({ outcome: target <= 20000 ? Accepted : ContextLimit, inputTokens: target * 2 })
  });
  assert.equal(result.reason, reasons.Budget);
  assert.equal(result.attempts.length, 3);
  checkEstimatedBounds(result);
  assert.ok(result.upperBoundTokens - result.lowerBoundTokens > 1);
});

for (const [scale, expectedRequests] of [[2, 1], [0.5, 2]]) {
  test(`capacity total budget accounts for max(target, usage) with usage scale ${scale}`, async () => {
    const result = await core.searchContextCapacity({
      startTokens: 4096, maxTokens: 32768, maxTotalTokens: 14000,
      attempt: async target => ({ outcome: Accepted, inputTokens: target * scale })
    });
    assert.equal(result.reason, reasons.Budget);
    assert.equal(result.attempts.length, expectedRequests);
    checkEstimatedBounds(result);
  });
}
