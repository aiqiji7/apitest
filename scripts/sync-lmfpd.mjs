#!/usr/bin/env node
/**
 * Maintainer-only sync tool for the LM Fingerpoint Detector snapshot.
 *
 * This script is NOT loaded by the site. It rebuilds the browser bundle and the
 * slim reference metadata from a pinned upstream commit, validates the result
 * against the upstream conformance cases, and only then publishes the files
 * under `assets/data/lmfpd/` and `assets/vendor/lmfpd/`.
 *
 * Usage:
 *   node scripts/sync-lmfpd.mjs --ref <40-hex-commit> [--upstream <checkout>]
 *   node scripts/sync-lmfpd.mjs --verify-only [--upstream <checkout>]
 *
 * Upstream: Ikaleio/lm-detector (MIT, Copyright (c) 2026 xqy2006)
 */

import { execFileSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const UPSTREAM_REPO = 'Ikaleio/lm-detector'
const DEFAULT_REF = '1e58ed83c1cde17f88cba89560ad4d083042ae92'
const ESBUILD_VERSION = '0.28.2'
const EXPECTED_DETECTOR_BYTES = 4_597_032
const EXPECTED_MINIMUM_VALID_NUMBERS = 80
const EXPECTED_RECOMMENDED_QUERIES = 3
const MIT_NOTICE = 'Copyright (c) 2026 xqy2006'
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const ARTIFACTS = {
  detector: 'assets/data/lmfpd/shared_detector.bin',
  models: 'assets/data/lmfpd/models.json',
  version: 'assets/data/lmfpd/VERSION.json',
  bundle: 'assets/vendor/lmfpd/lmfpd-core.js',
  license: 'assets/vendor/lmfpd/LICENSE',
}

/** Upstream files needed to build and validate the browser bundle. */
const SOURCE_FILES = [
  'shared/shared-detector.ts',
  'shared/positional.ts',
  'shared/fingerprint-core.js',
  'shared/challenge-browser.js',
  'shared/detector-codec.ts',
  'shared/types.ts',
]

const ENTRY_SOURCE = `export { decodeDetector } from './detector-codec'
export { analyzeSharedOutputs } from './shared-detector'
export { generateChallenges } from './challenge-browser.js'
export { parseNumbers } from './fingerprint-core.js'
`

/** Cases that must match the upstream analysis output; mirrors the acceptance criteria. */
const REQUIRED_CASES = {
  'scored-claude-opus-4.8': (actual) =>
    actual.decision === 'scored' &&
    actual.prediction === 'claude-opus-4.8' &&
    typeof actual.probability === 'number' &&
    actual.probability > 0.9,
  'partial-two': (actual) => actual.decision === 'partial' && actual.probability === null,
  'unscorable-short': (actual) => actual.decision === 'unscorable' && actual.results.length === 0,
  'not-model-sorted': (actual) => actual.decision === 'not_model' && actual.results.length === 0,
  truncated: (actual) => actual.decision === 'scored' && actual.used_outputs === 3,
  'strict-two': (actual) => actual.decision === 'unscorable',
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-lmfpd.mjs --ref <40-hex-commit> [options]
  node scripts/sync-lmfpd.mjs --verify-only [options]

Options:
  --ref <commit>        Upstream commit to pin (default: ${DEFAULT_REF})
  --upstream <path>     Read pinned files from a local checkout instead of GitHub
  --conformance <path>  Override the upstream sdk/conformance/analyze.json path
  --verify-only         Validate the committed artifacts; never writes site files
  --keep-stage          Keep the temporary staging directory when validation fails
  -h, --help            Show this help

The script builds into a temporary directory and publishes only after every
check passes. It never touches index.html, script.js or styles.css.

Environment:
  Node 24+ built-in fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1
  is set at process start. Set it when downloading through an HTTP(S) proxy.`)
}

function parseArgs(argv) {
  const options = { ref: null, upstream: null, conformance: null, verifyOnly: false, keepStage: false, help: false }
  let index = 0
  const valueOf = (name) => {
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
    return value
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--verify-only') options.verifyOnly = true
    else if (arg === '--keep-stage') options.keepStage = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--ref') options.ref = valueOf('--ref')
    else if (arg.startsWith('--ref=')) options.ref = arg.slice('--ref='.length)
    else if (arg === '--upstream') options.upstream = valueOf('--upstream')
    else if (arg.startsWith('--upstream=')) options.upstream = arg.slice('--upstream='.length)
    else if (arg === '--conformance') options.conformance = valueOf('--conformance')
    else if (arg.startsWith('--conformance=')) options.conformance = arg.slice('--conformance='.length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (options.ref !== null && !/^[0-9a-f]{40}$/i.test(options.ref)) {
    throw new Error(`--ref must be a full 40-character commit SHA, got: ${options.ref}`)
  }
  if (options.upstream) options.upstream = path.resolve(options.upstream)
  if (options.conformance) options.conformance = path.resolve(options.conformance)
  return options
}

function artifactPaths(root) {
  return Object.fromEntries(Object.entries(ARTIFACTS).map(([key, rel]) => [key, path.join(root, rel)]))
}

function stagePaths(stage) {
  return {
    detector: path.join(stage, 'shared_detector.bin'),
    models: path.join(stage, 'models.json'),
    version: path.join(stage, 'VERSION.json'),
    bundle: path.join(stage, 'lmfpd-core.js'),
    license: path.join(stage, 'LICENSE'),
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function rawUrl(ref, relPath) {
  const parts = relPath.split(path.sep).join('/')
  return `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${ref}/${parts}`
}

async function fetchRaw(ref, relPath) {
  const url = rawUrl(ref, relPath)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

async function readUpstream(upstream, relPath) {
  const file = path.join(upstream, relPath)
  if (!existsSync(file)) throw new Error(`Missing upstream file: ${file}`)
  return readFile(file)
}

async function readSource(relPath, { upstream, ref }) {
  return upstream ? readUpstream(upstream, relPath) : fetchRaw(ref, relPath)
}

async function assertUpstreamRef(upstream, ref) {
  let head = null
  try {
    head = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    console.warn(`! Could not read git HEAD from ${upstream}; skipping commit check.`)
    return
  }
  if (head !== ref) {
    throw new Error(`Upstream checkout ${upstream} is at ${head}, but --ref is ${ref}. Check out the pinned commit first.`)
  }
}

function conformanceCachePath(ref) {
  return path.join(tmpdir(), 'lmfpd-conformance', `${ref}.json`)
}

async function loadConformance({ upstream, ref, conformance }) {
  if (conformance) {
    return { bytes: await readFile(conformance), origin: conformance }
  }
  if (upstream) {
    return { bytes: await readUpstream(upstream, 'sdk/conformance/analyze.json'), origin: `${upstream}/sdk/conformance/analyze.json` }
  }
  const cached = conformanceCachePath(ref)
  if (existsSync(cached)) return { bytes: await readFile(cached), origin: cached }
  return { bytes: await fetchRaw(ref, 'sdk/conformance/analyze.json'), origin: 'raw.githubusercontent.com' }
}

async function cacheConformance(ref, bytes) {
  const target = conformanceCachePath(ref)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes)
}

function bundleBanner(ref) {
  return `/*!
 * LM Fingerpoint Detector core (window.LMFPD)
 * Bundled from ${UPSTREAM_REPO} @ ${ref}
 * ${MIT_NOTICE}
 * MIT License — see assets/vendor/lmfpd/LICENSE
 */`
}

async function stageSources(sourceDir, { upstream, ref }) {
  const files = [...SOURCE_FILES, 'LICENSE']
  for (const relPath of files) {
    const bytes = await readSource(relPath, { upstream, ref })
    await writeFile(path.join(sourceDir, path.basename(relPath)), bytes)
  }
}

async function buildBundle(sourceDir, outFile, ref) {
  const entry = path.join(sourceDir, 'lmfpd-entry.ts')
  await writeFile(entry, ENTRY_SOURCE)
  execFileSync(
    NPX,
    [
      '--yes',
      `esbuild@${ESBUILD_VERSION}`,
      entry,
      '--bundle',
      '--format=iife',
      '--global-name=LMFPD',
      '--target=es2020',
      `--banner:js=${bundleBanner(ref)}`,
      `--outfile=${outFile}`,
      '--log-level=warning',
    ],
    { cwd: sourceDir, stdio: 'inherit' },
  )
}

function buildModels(bank) {
  if (!bank || typeof bank !== 'object') throw new Error('unified_bank.json is not an object.')
  if (!Array.isArray(bank.models) || bank.models.length === 0) throw new Error('unified_bank.json has no models.')
  if (typeof bank.built_at !== 'string' || !bank.built_at) throw new Error('unified_bank.json has no built_at.')

  const seen = new Set()
  const models = bank.models.map((model, index) => {
    for (const key of ['id', 'display_name', 'family', 'family_name']) {
      if (typeof model[key] !== 'string' || !model[key]) {
        throw new Error(`Model #${index} is missing a non-empty ${key}.`)
      }
    }
    if (!Number.isSafeInteger(model.response_count) || model.response_count <= 0) {
      throw new Error(`Model ${model.id} has an invalid response_count.`)
    }
    if (seen.has(model.id)) throw new Error(`Duplicate model id in unified_bank.json: ${model.id}`)
    seen.add(model.id)
    return {
      id: model.id,
      display_name: model.display_name,
      family: model.family,
      family_name: model.family_name,
      response_count: model.response_count,
    }
  })

  return {
    schema: bank.schema,
    built_at: bank.built_at,
    model_count: models.length,
    minimum_valid_numbers: bank.minimum_valid_numbers,
    recommended_queries: bank.recommended_queries,
    models,
  }
}

function loadLmfpdBundle(bundlePath) {
  const code = readFileSync(bundlePath, 'utf8')
  const sandbox = {
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    DataView,
    Uint8Array,
    Uint32Array,
    Float32Array,
    ArrayBuffer,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  new vm.Script(code, { filename: bundlePath }).runInContext(sandbox)
  const api = sandbox.LMFPD ?? sandbox.window?.LMFPD
  if (!api) throw new Error(`Bundle did not expose window.LMFPD: ${bundlePath}`)
  return api
}

function pass(checks, name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  return Boolean(ok)
}

async function verifyArtifacts(paths, { conformance, expectedVersion = null }) {
  const checks = []
  const rows = []

  const api = loadLmfpdBundle(paths.bundle)
  const exported = ['generateChallenges', 'parseNumbers', 'decodeDetector', 'analyzeSharedOutputs']
  const missing = exported.filter((name) => typeof api[name] !== 'function')
  if (!pass(checks, 'bundle exports', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : exported.join(', '))) {
    return { ok: false, checks, rows, info: null }
  }

  try {
    const parsed = api.parseNumbers('1, 2, 3')
    pass(checks, 'parseNumbers smoke', Array.isArray(parsed) && parsed.join(',') === '1,2,3', JSON.stringify(parsed))
  } catch (error) {
    pass(checks, 'parseNumbers smoke', false, error.message)
  }

  try {
    const challenges = api.generateChallenges(3)
    const ok =
      Array.isArray(challenges) &&
      challenges.length === 3 &&
      new Set(challenges.map((item) => item.expected_count)).size === 3 &&
      challenges.every((item) => typeof item.prompt === 'string' && item.prompt.includes(String(item.expected_count)))
    pass(checks, 'generateChallenges smoke', ok, ok ? challenges.map((item) => item.expected_count).join(',') : 'invalid challenges')
  } catch (error) {
    pass(checks, 'generateChallenges smoke', false, error.message)
  }

  const detectorBytes = await readFile(paths.detector)
  pass(checks, 'detector size', detectorBytes.length === EXPECTED_DETECTOR_BYTES, `${detectorBytes.length} bytes (expected ${EXPECTED_DETECTOR_BYTES})`)

  let detector
  try {
    detector = api.decodeDetector(detectorBytes)
  } catch (error) {
    pass(checks, 'detector decode', false, error.message)
    return { ok: false, checks, rows, info: null }
  }
  pass(checks, 'detector decode', detector?.schema === 'shared-detector-v2', String(detector?.schema))

  const modelsBytes = await readFile(paths.models)
  let bank
  try {
    bank = JSON.parse(modelsBytes.toString('utf8'))
  } catch (error) {
    pass(checks, 'models.json parse', false, error.message)
    return { ok: false, checks, rows, info: null }
  }
  pass(checks, 'models.json schema', bank.schema === 'robust-number-fingerprint-bank', String(bank.schema))
  pass(checks, 'models.json model_count', bank.model_count === bank.models?.length, `${bank.model_count} vs ${bank.models?.length}`)
  pass(checks, 'models.json built_at', typeof bank.built_at === 'string' && bank.built_at.length > 0, String(bank.built_at))
  pass(
    checks,
    'models.json minimum_valid_numbers',
    bank.minimum_valid_numbers === EXPECTED_MINIMUM_VALID_NUMBERS,
    String(bank.minimum_valid_numbers),
  )
  pass(
    checks,
    'models.json recommended_queries',
    bank.recommended_queries === EXPECTED_RECOMMENDED_QUERIES,
    String(bank.recommended_queries),
  )

  const bankBuiltAt = bank.built_at === detector.bank_built_at
  const bankCount = Array.isArray(bank.models) && bank.models.length === detector.model_ids.length
  const bankOrder = bankCount && bank.models.every((model, index) => model.id === detector.model_ids[index])
  const bankCounts = bankCount && bank.models.every((model, index) => model.response_count === detector.response_counts[index])
  pass(checks, 'bank built_at matches detector', bankBuiltAt, `${bank.built_at} vs ${detector.bank_built_at}`)
  pass(checks, 'bank model count matches detector', bankCount, `${bank.models?.length} vs ${detector.model_ids.length}`)
  pass(checks, 'bank model order/ids match detector', bankOrder, bankOrder ? `${detector.model_ids.length} ids` : 'mismatch')
  pass(checks, 'bank response counts match detector', bankCounts, bankCounts ? 'ok' : 'mismatch')
  pass(
    checks,
    'supportsSharedDetector',
    detector.schema === 'shared-detector-v2' && bankBuiltAt && bankCount && bankOrder && bankCounts,
  )

  const licenseText = await readFile(paths.license, 'utf8')
  pass(checks, 'LICENSE is MIT', licenseText.includes('MIT License'), '')
  pass(checks, 'LICENSE copyright', licenseText.includes(MIT_NOTICE), MIT_NOTICE)

  const detectorSha = sha256(detectorBytes)
  const modelsSha = sha256(modelsBytes)
  if (expectedVersion) {
    pass(checks, 'VERSION upstream', expectedVersion.upstream === UPSTREAM_REPO, String(expectedVersion.upstream))
    pass(checks, 'VERSION built_at', expectedVersion.built_at === bank.built_at, `${expectedVersion.built_at} vs ${bank.built_at}`)
    pass(checks, 'VERSION model_count', expectedVersion.model_count === bank.model_count, `${expectedVersion.model_count} vs ${bank.model_count}`)
    pass(checks, 'VERSION detector sha256', expectedVersion.detector_sha256 === detectorSha, expectedVersion.detector_sha256)
    pass(checks, 'VERSION models sha256', expectedVersion.models_sha256 === modelsSha, expectedVersion.models_sha256)
    pass(checks, 'VERSION license', expectedVersion.license === 'MIT', String(expectedVersion.license))
  }

  const suite = JSON.parse(conformance.bytes.toString('utf8'))
  pass(
    checks,
    'conformance built_at',
    suite.data?.built_at === bank.built_at,
    `${suite.data?.built_at} vs ${bank.built_at}`,
  )

  const actuals = new Map()
  for (const item of suite.cases) {
    const expected = item.expected
    let actual = null
    try {
      actual = api.analyzeSharedOutputs(item.outputs, bank, detector, { allowPartial: !item.strict })
    } catch (error) {
      rows.push({ name: item.name, expected: expected.decision, actual: 'threw', detail: error.message, ok: false })
      continue
    }
    const decision = actual.decision ?? 'scored'
    actuals.set(item.name, { ...actual, decision })
    const probabilityOk = (actual.probability === null) === (expected.probability === null)
    const topOk = expected.results.length === 0 || actual.results[0]?.model === expected.results[0].model
    const ok =
      decision === expected.decision &&
      actual.prediction === expected.prediction &&
      actual.used_outputs === expected.used_outputs &&
      probabilityOk &&
      actual.results.length === expected.results.length &&
      topOk
    rows.push({
      name: item.name,
      expected: `${expected.decision}/${expected.prediction || '-'}`,
      actual: `${decision}/${actual.prediction || '-'}`,
      detail: `used=${actual.used_outputs} top=${actual.results[0]?.model ?? '-'} p=${actual.probability === null ? 'null' : actual.probability.toFixed(6)}`,
      ok,
    })
  }

  for (const [name, predicate] of Object.entries(REQUIRED_CASES)) {
    const actual = actuals.get(name)
    const ok = Boolean(actual) && predicate(actual)
    rows.push({
      name: `required:${name}`,
      expected: 'task contract',
      actual: actual ? `${actual.decision}/${actual.prediction || '-'}` : 'missing',
      detail: '',
      ok,
    })
  }

  const ok = checks.every((check) => check.ok) && rows.every((row) => row.ok)
  return {
    ok,
    checks,
    rows,
    info: {
      builtAt: bank.built_at,
      modelCount: bank.model_count,
      detectorSha,
      modelsSha,
      conformance: conformance.origin,
    },
  }
}

function printReport(result) {
  const checkWidth = Math.max(30, ...result.checks.map((check) => check.name.length))
  console.log('\nValidation checks')
  for (const check of result.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(checkWidth)}  ${check.detail}`)
  }
  if (result.rows.length) {
    const nameWidth = Math.max(24, ...result.rows.map((row) => row.name.length))
    console.log('\nConformance')
    for (const row of result.rows) {
      console.log(
        `  ${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(nameWidth)}  expected ${row.expected.padEnd(28)}  actual ${row.actual.padEnd(28)}  ${row.detail}`,
      )
    }
  }
  const total = result.checks.length + result.rows.length
  const passed = result.checks.filter((check) => check.ok).length + result.rows.filter((row) => row.ok).length
  console.log(`\nResult: ${passed}/${total} checks passed${result.ok ? '' : ' — FAILED'}`)
}

async function publish(staged, dest) {
  for (const key of Object.keys(ARTIFACTS)) {
    await mkdir(path.dirname(dest[key]), { recursive: true })
    await copyFile(staged[key], dest[key])
  }
}

async function sync(options) {
  const ref = options.ref ?? DEFAULT_REF
  console.log(`Syncing ${UPSTREAM_REPO} @ ${ref}`)
  if (options.upstream) {
    console.log(`Using local upstream snapshot: ${options.upstream}`)
    await assertUpstreamRef(options.upstream, ref)
  }

  const stage = await mkdtemp(path.join(tmpdir(), 'lmfpd-sync-'))
  const staged = stagePaths(stage)
  try {
    const sourceDir = path.join(stage, 'src')
    await mkdir(sourceDir, { recursive: true })
    await stageSources(sourceDir, { upstream: options.upstream, ref })

    console.log('Building lmfpd-core.js ...')
    await buildBundle(sourceDir, staged.bundle, ref)

    const bankBytes = await readSource('data/unified_bank.json', { upstream: options.upstream, ref })
    const bank = JSON.parse(bankBytes.toString('utf8'))
    const models = buildModels(bank)
    console.log(`Slimming bank metadata: ${models.model_count} models, built_at ${models.built_at}`)
    await writeFile(staged.models, `${JSON.stringify(models, null, 2)}\n`)

    console.log('Copying detector snapshot ...')
    await copyFile(path.join(sourceDir, 'LICENSE'), staged.license)
    const detectorBytes = await readSource('data/shared_detector.bin', { upstream: options.upstream, ref })
    await writeFile(staged.detector, detectorBytes)

    const version = {
      upstream: UPSTREAM_REPO,
      upstream_ref: ref,
      built_at: models.built_at,
      model_count: models.model_count,
      detector_sha256: sha256(detectorBytes),
      models_sha256: sha256(await readFile(staged.models)),
      license: 'MIT',
    }
    await writeFile(staged.version, `${JSON.stringify(version, null, 2)}\n`)

    const conformance = await loadConformance({ upstream: options.upstream, ref, conformance: options.conformance })
    const result = await verifyArtifacts(staged, { conformance, expectedVersion: version })
    printReport(result)
    if (!result.ok) {
      throw new Error('Verification failed; nothing was published.')
    }

    console.log(`\nPublishing ${Object.keys(ARTIFACTS).length} files ...`)
    await publish(staged, artifactPaths(ROOT))
    try {
      await cacheConformance(ref, conformance.bytes)
    } catch (error) {
      console.warn(`! Could not cache the conformance fixture: ${error.message}`)
    }
    console.log(`Published detector ${result.info.detectorSha}`)
    console.log(`Published models   ${result.info.modelsSha}`)
  } finally {
    if (options.keepStage) {
      console.error(`Staging directory kept: ${stage}`)
    } else {
      await rm(stage, { recursive: true, force: true })
    }
  }
}

async function verifyOnly(options) {
  const paths = artifactPaths(ROOT)
  let version
  try {
    version = JSON.parse(await readFile(paths.version, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${ARTIFACTS.version}: ${error.message}`)
  }

  const ref = version.upstream_ref
  if (typeof ref !== 'string' || !/^[0-9a-f]{40}$/i.test(ref)) {
    throw new Error(`VERSION.json has an invalid upstream_ref: ${ref}`)
  }
  if (options.ref && options.ref !== ref) {
    throw new Error(`--ref ${options.ref} does not match VERSION.json upstream_ref ${ref}`)
  }

  console.log(`Verifying committed snapshot: ${UPSTREAM_REPO} @ ${ref}`)
  const conformance = await loadConformance({ upstream: options.upstream, ref, conformance: options.conformance })
  const result = await verifyArtifacts(paths, { conformance, expectedVersion: version })
  printReport(result)
  if (!result.ok) throw new Error('Committed snapshot failed verification.')
  console.log(`\nSnapshot is valid: ${result.info.modelCount} models, built_at ${result.info.builtAt}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (options.verifyOnly) await verifyOnly(options)
  else await sync(options)
}

main().catch((error) => {
  console.error(`\nERROR: ${error.message}`)
  if (error.stack && process.env.LMFPD_DEBUG) console.error(error.stack)
  process.exitCode = 1
})
