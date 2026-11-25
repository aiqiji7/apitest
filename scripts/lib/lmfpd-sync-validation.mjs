/** Independent format checks run before executing a candidate decoder or analyzer. */
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function validateDetectorBinary(bytes) {
  assert(bytes.length >= 4, 'Detector is shorter than its u32 header length.')
  const length = bytes.readUInt32LE(0)
  const start = Math.ceil((4 + length) / 4) * 4
  assert(length > 0 && start <= bytes.length, 'Detector JSON header exceeds file bounds.')
  assert((bytes.length - start) % 4 === 0, 'Detector float32 payload is not aligned.')
  for (let i = 4 + length; i < start; i++) assert(bytes[i] === 0, 'Detector header padding must be zero.')
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length)))
  assert(object(header), 'Detector header must be an object.')
  const count = (bytes.length - start) / 4
  assert(count > 0, 'Detector float32 payload is empty.')
  const floats = new Float32Array(count)
  const scratch = Buffer.alloc(4)
  for (let i = 0; i < count; i++) {
    for (let b = 0; b < 4; b++) scratch[b] = bytes[start + b * count + i]
    floats[i] = scratch.readFloatLE(0)
    assert(Number.isFinite(floats[i]), `Detector float32 #${i} is nonfinite.`)
  }
  const ranges = []
  function decode(value, key = 'detector') {
    if (typeof value === 'number') assert(Number.isFinite(value), `${key} is nonfinite.`)
    if (!value || typeof value !== 'object') return value
    if (!Array.isArray(value) && ('$f32' in value || 'n' in value && Object.keys(value).length === 1)) {
      assert(Object.keys(value).sort().join(',') === '$f32,n', `${key} has an invalid float reference shape.`)
      const { $f32: offset, n } = value
      assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(n) && n > 0 && offset + n <= count, `${key} has an invalid float reference bounds/dimension.`)
      ranges.push([offset, offset + n])
      return Array.from(floats.subarray(offset, offset + n))
    }
    return Array.isArray(value) ? value.map((v, i) => decode(v, `${key}[${i}]`)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, `${key}.${k}`)]))
  }
  const decoded = decode(header)
  ranges.sort((a, b) => a[0] - b[0])
  let end = 0
  for (const [from, to] of ranges) {
    assert(from === end, 'Detector references overlap or leave unreferenced payload values.')
    end = to
  }
  assert(end === count, 'Detector payload contains unreferenced values.')
  return decoded
}

export function validateBank(bank) {
  assert(object(bank) && bank.schema === 'robust-number-fingerprint-bank', 'Invalid bank schema.')
  assert(typeof bank.built_at === 'string' && Number.isFinite(Date.parse(bank.built_at)), 'Invalid bank built_at.')
  assert(bank.minimum_valid_numbers === 80 && bank.recommended_queries === 3, 'Bank sampling contract must remain minimum80/recommended3.')
  assert(Array.isArray(bank.models) && bank.models.length > 0, 'Bank has no models.')
  assert(bank.model_count === undefined || bank.model_count === bank.models.length, 'Bank model_count mismatch.')
  const seen = new Set()
  for (const model of bank.models) {
    for (const key of ['id', 'display_name', 'family', 'family_name']) assert(typeof model?.[key] === 'string' && model[key].length > 0, `Invalid model ${key}.`)
    assert(!seen.has(model.id), `Duplicate model id ${model.id}.`)
    seen.add(model.id)
    assert(Number.isSafeInteger(model.response_count) && model.response_count > 0, `Invalid response_count for ${model.id}.`)
  }
}

export function validateDetector(detector, bank) {
  validateBank(bank)
  assert(object(detector) && detector.schema === 'shared-detector-v2', 'Invalid detector schema.')
  const ids = bank.models.map(m => m.id), count = ids.length
  const sameIds = value => Array.isArray(value) && value.length === count && value.every((v, i) => v === ids[i])
  assert(detector.bank_built_at === bank.built_at, 'Bank/detector built_at mismatch.')
  assert(sameIds(detector.model_ids), 'Bank/detector model order/IDs mismatch.')
  assert(Array.isArray(detector.response_counts) && detector.response_counts.length === count && detector.response_counts.every((v, i) => v === bank.models[i].response_count), 'Bank/detector response counts mismatch.')
  for (const key of ['base_sha256', 'source_reference_sha256']) assert(hash(detector[key]), `Invalid detector ${key}.`)
  for (const key of ['bank_robust_sha256', 'calibration_sha256']) if (detector[key] != null) assert(hash(detector[key]), `Invalid detector ${key}.`)
  assert(typeof detector.source_run === 'string' && detector.source_run.length > 0, 'Invalid detector source_run.')
  const vector = (v, n, key, positive = false) => {
    assert(Array.isArray(v) && v.length === n && n > 0 && v.every(x => Number.isFinite(x) && (!positive || x > 0)), `Invalid detector vector dimension/values: ${key}.`)
  }
  const matrix = (v, rows, cols, key) => {
    assert(Array.isArray(v) && v.length === rows, `Invalid detector matrix rows: ${key}.`)
    v.forEach(row => vector(row, cols, key))
  }
  const params = (p, key) => {
    assert(Array.isArray(p) && p.length > 0, `Missing preprocessing ${key}.`)
    return p.reduce((sum, item) => {
      vector(item.mean, item.mean?.length, `${key}.mean`)
      vector(item.scale, item.mean.length, `${key}.scale`, true)
      return sum + item.mean.length
    }, 0)
  }
  const a = detector.ranker
  assert(object(a) && a.head_params?.length === 2 && a.full_params?.length === 2, 'Invalid ranker preprocessing blocks.')
  const head = params(a.head_params, 'head_params'), full = params(a.full_params, 'full_params')
  matrix(a.lda_weights, count, head, 'lda_weights')
  vector(a.lda_bias, count, 'lda_bias')
  assert(Array.isArray(a.references) && a.references.length === count, 'Invalid ranker references model dimension.')
  a.references.forEach((rows, i) => {
    assert(Array.isArray(rows) && rows.length === bank.models[i].response_count, `Invalid references response_count for ${ids[i]}.`)
    matrix(rows, rows.length, full, `references[${i}]`)
  })
  assert(object(a.bank) && sameIds(a.bank.model_order), 'Invalid ranker bank model_order.')
  for (const [i, name] of ['hellinger', 'ordered_blocks'].entries()) {
    const feature = a.bank[name], width = a.full_params[i].mean.length
    assert(object(feature), `Missing feature bank ${name}.`)
    vector(feature.feature_mean, width, `${name}.feature_mean`)
    vector(feature.feature_scale, width, `${name}.feature_scale`, true)
    assert(Array.isArray(feature.nuisance_basis) && Number.isSafeInteger(feature.nuisance_rank) && feature.nuisance_rank === feature.nuisance_basis.length, `Invalid ${name} nuisance dimension.`)
    matrix(feature.nuisance_basis, feature.nuisance_rank, width, `${name}.nuisance_basis`)
    matrix(feature.centroids, count, width, `${name}.centroids`)
    if (name === 'ordered_blocks') {
      assert(Array.isArray(feature.environment_centroids) && feature.environment_centroids.length > 0, 'Missing environment_centroids.')
      feature.environment_centroids.forEach(rows => matrix(rows, count, width, 'environment_centroids'))
    }
  }
  assert(object(a.blend) && Number.isFinite(a.blend.frequency) && Number.isFinite(a.blend.positional) && a.blend.frequency >= 0 && a.blend.positional >= 0 && Math.abs(a.blend.frequency + a.blend.positional - 1) < 1e-9, 'Invalid ranker blend.')
  assert(object(a.positional), 'Missing positional head.')
  const width = params(a.positional.params, 'positional.params')
  matrix(a.positional.weights, count, width, 'positional.weights')
  vector(a.positional.bias, count, 'positional.bias')
  if (detector.calibration != null) {
    const c = detector.calibration, b = c.binding
    assert(c.schema === 'shared-confidence-v2' && c.method === 'ranking-temperature' && Number.isFinite(c.tau) && c.tau >= .001 && c.tau <= 1000, 'Invalid calibration contract.')
    assert(b?.base_sha256 === detector.base_sha256 && b.reference_sha256 === detector.source_reference_sha256 && sameIds(b.model_ids), 'Calibration binding mismatch.')
    assert(typeof c.calibration_run === 'string' && c.calibration_run.length > 0 && hash(detector.calibration_sha256), 'Invalid calibration provenance.')
  }
}

/** SDK input normalization; never consumes the fixture's expected result. */
export function prepareOutputs(outputs, strict, api) {
  assert(Array.isArray(outputs) && outputs.length >= 1 && outputs.length <= 3 && outputs.every(o => o && typeof o.text === 'string' && Number.isSafeInteger(o.expected_count) && o.expected_count > 0), 'Each input round must contain one to three outputs with text and a positive safe integer expected_count.')
  return outputs.map(({ text, expected_count }) => {
    const numbers = api.parseNumbers(text)
    assert(Array.isArray(numbers) && numbers.every(Number.isFinite), 'parseNumbers returned invalid numbers.')
    if (!strict && numbers.length > expected_count) text = numbers.slice(0, expected_count).join(', ')
    if (numbers.length < Math.max(80, Math.ceil(expected_count * .55))) text = ''
    return { text, expected_count }
  })
}

/** Small equivalent of the official SDK canonical/English presentation adapter. */
export function canonicalAnalysis(a) {
  const decision = a.decision ?? 'scored'
  let label, reason
  if (decision === 'unscorable') {
    label = 'Not enough valid samples'
    reason = `Received ${a.used_outputs}/3 valid samples. Three valid samples are required.`
  } else if (decision === 'not_model') {
    label = 'Not like a language model reply'
    reason = 'Consecutive numbers change differently from the language-model replies in the reference bank. Program-generated, sorted or shuffled numbers often do this. No ranking was produced.'
  } else if (decision === 'partial') {
    label = 'Partial sample ranking'
    reason = `Ranked ${a.used_outputs} valid sample${a.used_outputs === 1 ? '' : 's'}. Confidence requires three valid samples.`
  } else if (a.probability_status === 'reference_calibrated') {
    label = 'Calibrated ranking'
    reason = 'Confidence is a closed-set probability within the reference bank.'
  } else {
    label = 'Uncalibrated ranking'
    reason = 'The confidence calibration does not match this detector. Confidence is unavailable.'
  }
  return { ...a, decision, family_prediction: a.family_prediction ?? '', ranking_score: a.ranking_score ?? null, probability_scope: a.probability_scope ?? null, calibration: a.calibration ?? null, sequence: a.sequence ?? null,
    prediction_name: decision === 'unscorable' ? 'Not scored' : decision === 'not_model' ? 'Not a model reply' : a.prediction_name,
    evidence: { ...a.evidence, label, reason } }
}

export function compareSemantic(actual, expected, key = 'analysis') {
  if (typeof actual === 'number' || typeof expected === 'number') {
    assert(typeof actual === 'number' && typeof expected === 'number' && Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected)), `${key}: numeric mismatch (${actual} vs ${expected}).`)
  } else if (Array.isArray(actual) || Array.isArray(expected)) {
    assert(Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length, `${key}: array dimension mismatch.`)
    actual.forEach((v, i) => compareSemantic(v, expected[i], `${key}[${i}]`))
  } else if (object(actual) || object(expected)) {
    assert(object(actual) && object(expected), `${key}: object mismatch.`)
    const a = Object.keys(actual).sort(), b = Object.keys(expected).sort()
    assert(JSON.stringify(a) === JSON.stringify(b), `${key}: keys mismatch (${a} vs ${b}).`)
    a.forEach(k => compareSemantic(actual[k], expected[k], `${key}.${k}`))
  } else assert(actual === expected && actual !== undefined, `${key}: value mismatch (${actual} vs ${expected}).`)
}

export function validateConformance(suite, bank, detector) {
  assert(object(suite) && suite.data?.built_at === bank.built_at, `Conformance built_at binding mismatch: ${suite?.data?.built_at} vs ${bank.built_at}.`)
  assert(Array.isArray(suite.cases) && suite.cases.length > 0, 'Conformance cases must be nonempty.')
  const seen = new Set()
  const required = ['decision', 'prediction', 'prediction_name', 'family_prediction', 'family_prediction_name', 'results', 'ranking_score', 'probability', 'probability_status', 'probability_scope', 'calibration', 'used_outputs', 'diagnostics', 'sequence', 'method', 'model_version', 'evidence']
  for (const item of suite.cases) {
    assert(typeof item?.name === 'string' && item.name.length > 0 && !seen.has(item.name), 'Invalid/duplicate conformance case name.')
    seen.add(item.name)
    assert(typeof item.strict === 'boolean' && object(item.expected), `Invalid conformance case ${item.name}.`)
    for (const key of required) assert(Object.hasOwn(item.expected, key), `${item.name}: missing expected ${key}.`)
    assert(item.expected.model_version?.base_sha256 === detector.base_sha256, `${item.name}: conformance model_version base_sha256 binding mismatch.`)
    assert(Array.isArray(item.expected.results), `${item.name}: invalid results.`)
    if (item.expected.results.length) {
      assert(item.expected.results.length === bank.models.length, `${item.name}: conformance model count mismatch.`)
      const ids = new Set(item.expected.results.map(row => row.model))
      assert(ids.size === bank.models.length && bank.models.every(m => ids.has(m.id)), `${item.name}: conformance model IDs mismatch.`)
    }
    // Validates numeric finiteness even before the candidate analyzer executes.
    compareSemantic(item.expected, item.expected, `${item.name}.expected`)
  }
}
