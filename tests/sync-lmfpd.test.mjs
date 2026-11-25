import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACTS, artifactPaths, parseArgs, resolveLatest, readSource, fetchRaw,
  prepareOutputs, canonicalAnalysis, compareSemantic, validateDetectorBinary,
  verifyArtifacts, publishCandidate, publishResult, changedArtifacts, sync,
} from '../scripts/sync-lmfpd.mjs'
import { validateBank, validateDetector } from '../scripts/lib/lmfpd-sync-validation.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = fileURLToPath(new URL('./fixtures/lmfpd-sync/', import.meta.url))
const GOLDEN_ROOT = path.join(FIXTURES, 'supported')
const GOLDEN = artifactPaths(GOLDEN_ROOT)
const FIXTURE = path.join(FIXTURES, 'analyze-supported.json')
const REF = '1e58ed83c1cde17f88cba89560ad4d083042ae92'
// Immutable Ikaleio/lm-detector @ REF, 63 models, matched to the original
// upstream 12-case analyze-supported.json. Four shipped artifact bytes match
// repository c4e5e07ef7c0a652b54e94fb2fa67348ea91ae08; VERSION also includes
// the verified bundle/license hashes.
// Keep this independent of the rolling production snapshot and Git history.
const GOLDEN_HASHES = Object.freeze({
  detector: '6a102f86c3f8a9aeeb052edfbdf5edf6f9e891ac6693129a4e007139c74861f6',
  models: '50a5eb5cda7e0a5eb75ecd5513a865b54a8b9498433f3e039ecc70ff7d85ba4d',
  version: 'e63701f78d5ef0274df455f4930ccc49155bda4705a07915ce4423f6b657c9c0',
  bundle: '091e84c2842283a967334cd18519e03c3b5185ae3bdbb27fc75b4eecfffd9496',
  license: '238afb57e498990742f84b9ce6167b4e256ac06104a9938ce953bc41c14bea51',
})
const CONFORMANCE_HASH = '7bdd3ab697de6b1a2600d7dc19103380c10139abfd6f0db8e92a03141ad0ce73'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const owned = []
const scratch = async () => { const dir = await mkdtemp('/tmp/opencode/lmfpd-sync-test-'); owned.push(dir); return dir }
test.after(async () => { for (const dir of owned) await rm(dir, { recursive: true, force: true }) })
const fixture = async () => ({ bytes: await readFile(FIXTURE), origin: FIXTURE })

test.before(async () => {
  for (const [key, hash] of Object.entries(GOLDEN_HASHES)) assert.equal(sha(await readFile(GOLDEN[key])), hash, `immutable ${key}`)
  assert.equal(sha((await fixture()).bytes), CONFORMANCE_HASH, 'unchanged upstream expected results')
  const version = JSON.parse(await readFile(GOLDEN.version))
  assert.equal(version.upstream_ref, REF)
  for (const key of ['detector', 'models', 'bundle', 'license']) assert.equal(version[`${key}_sha256`], GOLDEN_HASHES[key])
})

test('CLI validates mutually exclusive selectors, values, SHA and result boundaries', () => {
  for (const args of [
    ['--latest', '--ref', REF], ['--latest', '--upstream', '/tmp/x'],
    ['--ref', 'main'], ['--ref', ''], ['--artifact-root'], ['--result-file', ''],
    ['--verify-only', '--latest'], ['--verify-only', '--result-file', '/tmp/report'],
    ['--artifact-root', '/tmp/out', '--result-file', '/tmp/out/result.json'],
    ['--ref', REF, '--ref', REF], ['--unknown'],
  ]) assert.throws(() => parseArgs(args), undefined, args.join(' '))
  assert.equal(parseArgs(['--latest', '--artifact-root=/tmp/out', '--result-file=/tmp/report']).latest, true)
  assert.equal(parseArgs([]).ref, null)
})

test('latest resolves the default branch once and fails closed on API problems', async () => {
  const urls = []
  const fetcher = async url => {
    urls.push(url)
    return { ok: true, json: async () => urls.length === 1 ? { default_branch: 'release/v2' } : { sha: REF } }
  }
  assert.equal(await resolveLatest(fetcher), REF)
  assert.deepEqual(urls, [
    'https://api.github.com/repos/Ikaleio/lm-detector',
    'https://api.github.com/repos/Ikaleio/lm-detector/commits/release%2Fv2',
  ])
  for (const fetcher of [
    async () => ({ ok: false, status: 503, statusText: 'Unavailable' }),
    async () => ({ ok: true, json: async () => ({}) }),
    async url => ({ ok: true, json: async () => url.endsWith('lm-detector') ? { default_branch: 'main' } : { sha: 'main' } }),
    async () => { throw new Error('offline') },
  ]) await assert.rejects(resolveLatest(fetcher))
})

test('source transport fallback remains at the exact same SHA and fails on both errors', async () => {
  const urls = []
  const bytes = Buffer.from('immutable source')
  const fetched = await fetchRaw(REF, 'shared/types.ts', async url => {
    urls.push(url)
    if (urls.length === 1) throw new Error('raw network unavailable')
    return { ok: true, arrayBuffer: async () => bytes }
  })
  assert.equal(fetched.toString(), bytes.toString())
  assert.equal(urls[0], `https://raw.githubusercontent.com/Ikaleio/lm-detector/${REF}/shared/types.ts`)
  assert.equal(urls[1], `https://api.github.com/repos/Ikaleio/lm-detector/contents/shared/types.ts?ref=${REF}`)
  await assert.rejects(fetchRaw(REF, 'LICENSE', async () => ({ ok: false, status: 404, statusText: 'Not Found' })), /404 Not Found/)
})

test('local source uses immutable commit objects, including when HEAD or files differ', async () => {
  const dir = await scratch()
  const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q'])
  await writeFile(path.join(dir, 'sample.txt'), 'committed')
  git(['add', 'sample.txt'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  const ref = git(['rev-parse', 'HEAD'])
  await writeFile(path.join(dir, 'sample.txt'), 'dirty')
  assert.equal((await readSource('sample.txt', { upstream: dir, ref })).toString(), 'committed')
  await assert.rejects(readSource('sample.txt', { upstream: dir, ref: 'f'.repeat(40) }), /commit|ref|object/i)
  await assert.rejects(readSource('sample.txt', { upstream: await scratch(), ref }), /git|commit|ref/i)
})

test('SDK preprocessing validates, truncates relaxed outputs and clears short replies', () => {
  const api = { parseNumbers: text => text.split(',').filter(Boolean).map(Number) }
  const text = Array.from({ length: 101 }, (_, i) => i + 1).join(',')
  assert.equal(prepareOutputs([{ text, expected_count: 100 }], false, api)[0].text.split(', ').length, 100)
  assert.equal(prepareOutputs([{ text, expected_count: 100 }], true, api)[0].text, text)
  assert.equal(prepareOutputs([{ text: '1,2', expected_count: 100 }], false, api)[0].text, '')
  for (const outputs of [[], Array(4).fill({ text, expected_count: 100 }), [{ text: 1, expected_count: 100 }], [{ text, expected_count: 0 }], [{ text, expected_count: 1.5 }], [{ text, expected_count: Number.MAX_SAFE_INTEGER + 1 }]]) {
    assert.throws(() => prepareOutputs(outputs, false, api))
  }
})

test('semantic comparison covers all ranked entries, order, probabilities and unknown keys', () => {
  const expected = { results: [{ model: 'a', score: 2, probability: .8 }, { model: 'b', score: 1, probability: .2 }], calibration: { tau: 4 }, diagnostics: [{ accepted: true }], model_version: { base_sha256: 'abc' } }
  assert.doesNotThrow(() => compareSemantic(expected, structuredClone(expected)))
  for (const mutate of [
    a => { a.results[1].score += .001 }, a => { a.results[1].probability = .3 },
    a => { a.results.reverse() }, a => { a.calibration.tau = 5 },
    a => { a.diagnostics[0].accepted = false }, a => { a.model_version.base_sha256 = 'def' },
    a => { a.extra = true }, a => { a.results[1].extra = true },
    a => { a.results[0].score = NaN }, a => { a.results[0].score = Infinity },
  ]) {
    const actual = structuredClone(expected)
    mutate(actual)
    assert.throws(() => compareSemantic(actual, expected))
  }
  assert.throws(() => compareSemantic({ x: NaN }, { x: NaN }))
  assert.doesNotThrow(() => compareSemantic({ x: 100 + 5e-8 }, { x: 100 }))
  assert.throws(() => compareSemantic({ x: 100 + 2e-7 }, { x: 100 }))
})

test('canonical SDK fields use defaults and exact English presentation without expected data', () => {
  const a = canonicalAnalysis({ decision: 'unscorable', used_outputs: 0, evidence: { method: 'complete-three-answers', threshold: null, insufficient: true }, extra: 1 })
  assert.equal(a.prediction_name, 'Not scored')
  assert.equal(a.evidence.reason, 'Received 0/3 valid samples. Three valid samples are required.')
  assert.equal(a.family_prediction, '')
  assert.equal(a.ranking_score, null)
  assert.equal(a.extra, 1)
})

function encodeHeader(header, floats = [1]) {
  const json = Buffer.from(JSON.stringify(header))
  const start = Math.ceil((4 + json.length) / 4) * 4
  const bytes = Buffer.alloc(start + floats.length * 4)
  bytes.writeUInt32LE(json.length)
  json.copy(bytes, 4)
  const float = Buffer.alloc(4)
  floats.forEach((value, i) => {
    float.writeFloatLE(value)
    for (let b = 0; b < 4; b++) bytes[start + b * floats.length + i] = float[b]
  })
  return bytes
}

test('binary format rejects invalid lengths, references and nonfinite byte-plane floats', async () => {
  const original = await readFile(GOLDEN.detector)
  assert.doesNotThrow(() => validateDetectorBinary(original))
  for (const bytes of [
    Buffer.alloc(3), Buffer.from([255, 255, 255, 255]), original.subarray(0, original.length - 1),
    encodeHeader({ values: { $f32: -1, n: 1 } }), encodeHeader({ values: { $f32: .5, n: 1 } }),
    encodeHeader({ values: { $f32: 0, n: 2 } }), encodeHeader({ values: { $f32: 0, n: 1, extra: true } }),
    encodeHeader({ values: { $f32: 0, n: 1 } }, [Infinity]), encodeHeader({ values: { $f32: 0, n: 1 } }, [NaN]),
  ]) assert.throws(() => validateDetectorBinary(bytes))
})

test('bank/detector schemas reject sampling, IDs, dimensions and calibration drift', async () => {
  const bank = JSON.parse(await readFile(GOLDEN.models))
  const detector = validateDetectorBinary(await readFile(GOLDEN.detector))
  for (const mutate of [
    b => { b.minimum_valid_numbers = 79 }, b => { b.recommended_queries = 4 },
    b => { b.models[1].id = b.models[0].id }, b => { b.models[0].response_count = 1.5 },
    b => { b.models[0].display_name = '' }, b => { b.model_count-- },
  ]) { const b = structuredClone(bank); mutate(b); assert.throws(() => validateBank(b)) }
  for (const mutate of [
    d => { d.model_ids.reverse() }, d => { d.ranker.lda_weights[0].pop() },
    d => { d.ranker.references[0].pop() }, d => { d.ranker.bank.ordered_blocks.environment_centroids[0].pop() },
    d => { d.ranker.positional.weights.pop() }, d => { d.ranker.full_params[0].scale[0] = 0 },
    d => { d.calibration.binding.model_ids.reverse() }, d => { d.calibration.binding.base_sha256 = 'f'.repeat(64) },
    d => { d.base_sha256 = 'invalid' },
  ]) { const d = structuredClone(detector); mutate(d); assert.throws(() => validateDetector(d, bank)) }
  // Count and binary size can evolve when all dimensions/bindings evolve together.
  const smallerBank = structuredClone(bank), smaller = structuredClone(detector)
  smallerBank.models = smallerBank.models.slice(0, 2)
  smallerBank.model_count = 2
  smaller.model_ids = smaller.model_ids.slice(0, 2)
  smaller.response_counts = smaller.response_counts.slice(0, 2)
  const a = smaller.ranker
  for (const key of ['lda_weights', 'lda_bias', 'references']) a[key] = a[key].slice(0, 2)
  a.bank.model_order = a.bank.model_order.slice(0, 2)
  a.bank.hellinger.centroids = a.bank.hellinger.centroids.slice(0, 2)
  a.bank.ordered_blocks.centroids = a.bank.ordered_blocks.centroids.slice(0, 2)
  a.bank.ordered_blocks.environment_centroids = a.bank.ordered_blocks.environment_centroids.map(rows => rows.slice(0, 2))
  a.positional.weights = a.positional.weights.slice(0, 2)
  a.positional.bias = a.positional.bias.slice(0, 2)
  smaller.calibration.binding.model_ids = smaller.model_ids.slice()
  assert.doesNotThrow(() => validateDetector(smaller, smallerBank))
})

test('real supported 63-model snapshot passes every full conformance case (complete and legacy manifests)', async () => {
  const version = JSON.parse(await readFile(GOLDEN.version))
  const legacy = { ...version }
  delete legacy.bundle_sha256
  delete legacy.license_sha256
  for (const expectedVersion of [version, legacy]) {
    const result = await verifyArtifacts(GOLDEN, { conformance: await fixture(), expectedVersion, allowLegacy: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.rows.length, 12)
    assert.equal(result.info.modelCount, 63)
  }
})

test('stale fixture binding fails before analysis, including model_version base SHA', async () => {
  for (const mutate of [
    suite => { suite.data.built_at = '2026-11-17T19:37:59.839365+00:00' },
    suite => { suite.cases[0].expected.model_version.base_sha256 = 'f'.repeat(64) },
    suite => { suite.cases = [] },
  ]) {
    const suite = JSON.parse((await fixture()).bytes)
    mutate(suite)
    const result = await verifyArtifacts(GOLDEN, { conformance: { bytes: Buffer.from(JSON.stringify(suite)), origin: 'mutated' }, expectedVersion: JSON.parse(await readFile(GOLDEN.version)), allowLegacy: true })
    assert.equal(result.ok, false)
    assert.equal(result.rows.length, 0, 'binding gate must run before analyze')
  }
})

test('full real conformance rejects changed non-top scores, probability, order and extra keys', async () => {
  for (const mutate of [
    a => { a.results[1].score += .01 }, a => { a.results[1].probability += .01 },
    a => { [a.results[1], a.results[2]] = [a.results[2], a.results[1]] }, a => { a.unknown = true },
  ]) {
    const suite = JSON.parse((await fixture()).bytes)
    mutate(suite.cases[0].expected)
    const result = await verifyArtifacts(GOLDEN, { conformance: { bytes: Buffer.from(JSON.stringify(suite)), origin: 'mutated' }, expectedVersion: JSON.parse(await readFile(GOLDEN.version)), allowLegacy: true })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].ok, false)
  }
})

test('isolated publication has exactly five files, deterministic change detection, no success on copy failure', async () => {
  const base = await scratch()
  const output = path.join(base, 'candidate')
  const staged = GOLDEN
  assert.equal(await changedArtifacts(staged, staged), false)
  await publishCandidate(staged, output)
  const files = await readdir(output, { recursive: true })
  const leaves = files.filter(name => Object.values(ARTIFACTS).includes(name))
  assert.equal(leaves.length, 5)
  assert.equal(await changedArtifacts(artifactPaths(output), staged), false)
  await writeFile(artifactPaths(output).license, 'different')
  assert.equal(await changedArtifacts(artifactPaths(output), staged), true)
  const broken = { ...staged, bundle: path.join(base, 'missing') }
  const failed = path.join(base, 'failed')
  await assert.rejects(publishCandidate(broken, failed))
  await assert.rejects(readFile(path.join(failed, ARTIFACTS.version)), /ENOENT/)
  const report = path.join(base, 'no-success.json')
  await assert.rejects(publishResult(report, { upstream_ref: REF, changed: false }, { writeFile: async () => { throw new Error('disk full') } }))
  await assert.rejects(readFile(report), /ENOENT/)
  const failedCopyReport = path.join(base, 'failed-copy-result.json')
  await assert.rejects((async () => {
    await publishCandidate(broken, path.join(base, 'failed-copy'))
    await publishResult(failedCopyReport, { upstream_ref: REF, changed: true })
  })())
  await assert.rejects(readFile(failedCopyReport), /ENOENT/)
})

async function localSnapshot() {
  const base = await scratch()
  const upstream = path.join(base, 'upstream')
  await mkdir(upstream)
  const git = args => execFileSync('git', ['-C', upstream, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-26T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-26T00:00:00Z' },
  }).trim()
  git(['init', '-q'])
  const files = {
    'data/unified_bank.json': await readFile(GOLDEN.models),
    'data/shared_detector.bin': await readFile(GOLDEN.detector),
    'LICENSE': await readFile(GOLDEN.license),
    'sdk/conformance/analyze.json': (await fixture()).bytes,
  }
  for (const name of ['shared-detector.ts', 'positional.ts', 'fingerprint-core.js', 'challenge-browser.js', 'detector-codec.ts', 'types.ts']) files[`shared/${name}`] = `// immutable source ${name}\n`
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(upstream, name)), { recursive: true })
    await writeFile(path.join(upstream, name), bytes)
  }
  git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'snapshot'])
  const ref = git(['rev-parse', 'HEAD'])
  const sourceByRef = new Map([[ref, files['shared/shared-detector.ts']]])
  // A controlled builder exercises real shipped analysis independently of fixture expected.
  // The real esbuild/source closure is also checked by the supported-SHA integration command.
  const build = async (sourceDir, outfile, sourceRef) => {
    assert.ok(sourceByRef.has(sourceRef), 'builder must receive a committed fixture SHA')
    assert.equal(await readFile(path.join(sourceDir, 'shared-detector.ts'), 'utf8'), sourceByRef.get(sourceRef))
    await writeFile(outfile, (await readFile(GOLDEN.bundle, 'utf8')).replaceAll(REF, sourceRef))
  }
  const root = path.join(base, 'repo')
  await publishCandidate(GOLDEN, root)
  const version = JSON.parse(await readFile(artifactPaths(root).version))
  version.upstream_ref = ref
  await writeFile(artifactPaths(root).version, JSON.stringify(version))
  const advance = async builtAt => {
    const bank = JSON.parse(files['data/unified_bank.json'])
    assert.ok(Date.parse(builtAt) > Date.parse(bank.built_at))
    bank.built_at = builtAt
    files['data/unified_bank.json'] = Buffer.from(JSON.stringify(bank))
    const original = files['data/shared_detector.bin']
    const headerLength = original.readUInt32LE(0)
    const payloadStart = Math.ceil((4 + headerLength) / 4) * 4
    const header = JSON.parse(original.subarray(4, 4 + headerLength))
    header.bank_built_at = builtAt
    const headerBytes = Buffer.from(JSON.stringify(header))
    const updatedPayloadStart = Math.ceil((4 + headerBytes.length) / 4) * 4
    const updated = Buffer.alloc(updatedPayloadStart + original.length - payloadStart)
    updated.writeUInt32LE(headerBytes.length)
    headerBytes.copy(updated, 4)
    original.copy(updated, updatedPayloadStart, payloadStart)
    assert.deepEqual(updated.subarray(updatedPayloadStart), original.subarray(payloadStart), 'calibration/weights remain unchanged')
    files['data/shared_detector.bin'] = updated
    const suite = JSON.parse(files['sdk/conformance/analyze.json'])
    suite.data.built_at = builtAt
    // Only fixture input metadata advances. Never compute or rewrite expected
    // predictions, ranks, scores, probabilities, calibration or model_version.
    assert.deepEqual(suite.cases, JSON.parse((await fixture()).bytes).cases)
    files['sdk/conformance/analyze.json'] = Buffer.from(JSON.stringify(suite))
    files['shared/shared-detector.ts'] = `// immutable source shared-detector.ts at ${builtAt}\n`
    for (const name of ['data/unified_bank.json', 'data/shared_detector.bin', 'sdk/conformance/analyze.json', 'shared/shared-detector.ts']) {
      await writeFile(path.join(upstream, name), files[name])
    }
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', `snapshot ${builtAt}`])
    const nextRef = git(['rev-parse', 'HEAD'])
    sourceByRef.set(nextRef, files['shared/shared-detector.ts'])
    return nextRef
  }
  return { base, upstream, ref, build, root, git, advance }
}

test('full isolated sync defaults to manifest ref, reads immutable source, and reports no-change on repeat', async () => {
  const { base, upstream, ref, build, root } = await localSnapshot()
  await writeFile(path.join(upstream, 'shared/shared-detector.ts'), 'dirty source that must not be built')
  const first = path.join(base, 'first')
  const firstResult = path.join(base, 'first-result.json')
  const report = await sync(parseArgs(['--upstream', upstream, '--artifact-root', first, '--result-file', firstResult]), { root, build })
  assert.deepEqual(report, { upstream_ref: ref, changed: true })
  assert.deepEqual(JSON.parse(await readFile(firstResult)), report)
  const v = JSON.parse(await readFile(artifactPaths(first).version))
  assert.match(v.bundle_sha256, /^[0-9a-f]{64}$/)
  assert.match(v.license_sha256, /^[0-9a-f]{64}$/)
  const second = path.join(base, 'second')
  const secondResult = path.join(base, 'second-result.json')
  assert.deepEqual(await sync(parseArgs(['--upstream', upstream, '--artifact-root', second, '--result-file', secondResult]), { root: first, build }), { upstream_ref: ref, changed: false })
  assert.equal(await changedArtifacts(artifactPaths(second), artifactPaths(first)), false)
  // Manual no-artifact-root publication still works only after complete validation.
  assert.deepEqual(await sync(parseArgs(['--upstream', upstream]), { root: first, build }), { upstream_ref: ref, changed: false })
})

test('two later snapshots keep the next daily preflight and update working', async t => {
  const f = await localSnapshot()
  const checkout = path.join(f.base, 'checkout')
  await mkdir(path.join(checkout, 'tests'), { recursive: true })
  await cp(path.join(ROOT, 'scripts'), path.join(checkout, 'scripts'), { recursive: true })
  await copyFile(fileURLToPath(import.meta.url), path.join(checkout, 'tests/sync-lmfpd.test.mjs'))
  await cp(path.dirname(FIXTURE), path.join(checkout, 'tests/fixtures/lmfpd-sync'), { recursive: true })
  for (const [key, rel] of Object.entries(ARTIFACTS)) {
    await mkdir(path.dirname(path.join(checkout, rel)), { recursive: true })
    await copyFile(artifactPaths(f.root)[key], path.join(checkout, rel))
  }
  const initialVersion = JSON.parse(await readFile(artifactPaths(checkout).version))
  let previousRef = f.ref
  for (const [index, builtAt] of ['2026-11-24T10:04:10.682171+00:00', '2026-11-25T10:04:10.682171+00:00'].entries()) {
    const ref = await f.advance(builtAt)
    assert.notEqual(ref, previousRef)
    const candidate = path.join(f.base, `update-${index + 1}`)
    const report = await sync(parseArgs(['--ref', ref, '--upstream', f.upstream, '--artifact-root', candidate]), { root: checkout, build: f.build })
    assert.deepEqual(report, { upstream_ref: ref, changed: true })
    const paths = artifactPaths(candidate)
    const version = JSON.parse(await readFile(paths.version))
    assert.equal(version.built_at, builtAt)
    assert.equal(version.upstream_ref, ref)
    assert.notEqual(version.detector_sha256, initialVersion.detector_sha256)
    assert.notEqual(version.models_sha256, initialVersion.models_sha256)
    const conformance = { bytes: await readSource('sdk/conformance/analyze.json', { upstream: f.upstream, ref }), origin: ref }
    assert.deepEqual(JSON.parse(conformance.bytes).cases, JSON.parse((await fixture()).bytes).cases)
    const valid = await verifyArtifacts(paths, { conformance })
    assert.equal(valid.ok, true, JSON.stringify(valid))
    assert.equal(valid.rows.length, 12)
    const stale = await verifyArtifacts(paths, { conformance: await fixture() })
    assert.equal(stale.ok, false)
    assert.equal(stale.rows.length, 0)
    assert.ok(stale.checks.some(check => !check.ok && /conformance snapshot binding/.test(check.name)))
    // Reproduce the next day's checkout after all five production files roll.
    for (const key of Object.keys(ARTIFACTS)) await copyFile(paths[key], artifactPaths(checkout)[key])
    // A nested node:test process otherwise inherits the parent's IPC reporter.
    const { NODE_TEST_CONTEXT, ...preflightEnv } = process.env
    // Exercise the real golden suite, local source/builder and mutation paths.
    // Selecting these excludes this parent regression and avoids recursive runs.
    const preflight = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      '--test-name-pattern=^(real supported 63-model snapshot|full isolated sync defaults|updater rejects unsafe output paths)',
      path.join(checkout, 'tests/sync-lmfpd.test.mjs')], {
      cwd: f.base, env: preflightEnv, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    })
    assert.equal(preflight.error, undefined, preflight.error?.message)
    assert.equal(preflight.status, 0, `preflight after update ${index + 1}:\n${preflight.stdout}\n${preflight.stderr}`)
    assert.match(preflight.stdout, /# fail 0\b/)
    assert.match(preflight.stdout, /# tests 3\b/)
    assert.match(preflight.stdout, /# pass 3\b/)
    assert.match(preflight.stdout, /# skipped 0\b/)
    assert.match(preflight.stdout, /ok \d+ - real supported 63-model snapshot/)
    assert.match(preflight.stdout, /ok \d+ - full isolated sync/)
    assert.match(preflight.stdout, /ok \d+ - updater rejects unsafe output paths/)
    t.diagnostic(`update ${index + 1}: ${builtAt} @ ${ref}; 12 unchanged conformance cases and 3 child preflight tests passed`)
    previousRef = ref
  }
})

test('CLI invalid candidate preserves production bytes, output and success result', async () => {
  const { base, upstream, ref, git } = await localSnapshot()
  // Commit the invalid fixture, so the CLI must reject the actual immutable candidate.
  const suitePath = path.join(upstream, 'sdk/conformance/analyze.json')
  const bad = JSON.parse(await readFile(suitePath))
  bad.data.built_at = '2026-11-17T19:37:59.839365+00:00'
  await writeFile(suitePath, JSON.stringify(bad))
  git(['add', 'sdk/conformance/analyze.json'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'stale fixture'])
  const badRef = git(['rev-parse', 'HEAD'])
  assert.notEqual(badRef, ref)
  const before = await Promise.all(Object.values(artifactPaths(ROOT)).map(async file => sha(await readFile(file))))
  const output = path.join(base, 'candidate')
  const report = path.join(base, 'result.json')
  const run = spawnSync(process.execPath, ['scripts/sync-lmfpd.mjs', '--ref', badRef, '--upstream', upstream, '--artifact-root', output, '--result-file', report], { cwd: ROOT, encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /conformance.*built_at|binding/i)
  assert.deepEqual(await Promise.all(Object.values(artifactPaths(ROOT)).map(async file => sha(await readFile(file)))), before)
  await assert.rejects(readFile(path.join(output, ARTIFACTS.version)), /ENOENT/)
  await assert.rejects(readFile(report), /ENOENT/)
})

test('updater rejects unsafe output paths, partial hashes, API and license incompatibility', async () => {
  const { base, root, upstream, build } = await localSnapshot()
  const candidate = path.join(base, 'candidate')
  await mkdir(candidate)
  const alias = path.join(base, 'alias')
  await symlink(candidate, alias)
  await assert.rejects(sync(parseArgs(['--upstream', upstream, '--artifact-root', candidate, '--result-file', path.join(alias, 'result.json')]), { root, build }), /outside.*symlink/i)
  await assert.rejects(sync(parseArgs(['--artifact-root', root]), { root, build }), /separate/)
  for (const [failedCheck, mutate] of [
    ['LICENSE MIT and copyright', async p => { await writeFile(p.license, 'MIT License\nwrong copyright') }],
    ['VERSION bundle/license hashes', async p => { const v = JSON.parse(await readFile(p.version)); v.bundle_sha256 = 'f'.repeat(64); await writeFile(p.version, JSON.stringify(v)) }],
    ['bundle exports', async p => {
      const code = await readFile(p.bundle, 'utf8')
      const broken = code.replace(/parseNumbers: \(\) => parseNumbers/, 'parseNumbers: () => undefined')
      assert.notEqual(broken, code, 'fixed golden bundle must contain the mutated API export')
      await writeFile(p.bundle, broken)
      const version = JSON.parse(await readFile(p.version))
      version.bundle_sha256 = sha(broken)
      await writeFile(p.version, JSON.stringify(version))
    }],
  ]) {
    const dir = path.join(await scratch(), 'artifacts')
    await publishCandidate(GOLDEN, dir)
    const paths = artifactPaths(dir)
    await mutate(paths)
    const result = await verifyArtifacts(paths, { conformance: await fixture(), expectedVersion: JSON.parse(await readFile(paths.version)), allowLegacy: true })
    assert.equal(result.ok, false)
    assert.equal(result.rows.length, 0)
    assert.ok(result.checks.some(check => check.name === failedCheck && !check.ok), JSON.stringify(result))
  }
})
