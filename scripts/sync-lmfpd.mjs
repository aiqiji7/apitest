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
import { readFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { validateDetectorBinary, validateBank, validateDetector, prepareOutputs, canonicalAnalysis, compareSemantic, validateConformance } from './lib/lmfpd-sync-validation.mjs'
export { validateDetectorBinary, prepareOutputs, canonicalAnalysis, compareSemantic } from './lib/lmfpd-sync-validation.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const UPSTREAM_REPO = 'Ikaleio/lm-detector'
const ESBUILD_VERSION = '0.28.2'
const EXPECTED_MINIMUM_VALID_NUMBERS = 80
const EXPECTED_RECOMMENDED_QUERIES = 3
const MIT_NOTICE = 'Copyright (c) 2026 xqy2006'
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

export const ARTIFACTS = Object.freeze({
  detector: 'assets/data/lmfpd/shared_detector.bin',
  models: 'assets/data/lmfpd/models.json',
  version: 'assets/data/lmfpd/VERSION.json',
  bundle: 'assets/vendor/lmfpd/lmfpd-core.js',
  license: 'assets/vendor/lmfpd/LICENSE',
})

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

function printHelp() {
  console.log(`Usage:
  node scripts/sync-lmfpd.mjs --latest --artifact-root DIR --result-file FILE
  node scripts/sync-lmfpd.mjs --ref <40-hex-commit> [options]
  node scripts/sync-lmfpd.mjs --verify-only [options]

Options:
  --latest              Resolve GitHub's default branch once to a complete SHA
  --ref <commit>        Pin a complete SHA (default: current VERSION upstream_ref)
  --upstream <path>     Read immutable Git objects from a local repository
  --conformance <path>  Override the upstream sdk/conformance/analyze.json path
  --artifact-root DIR  Publish exactly five repo-relative files here, after validation
  --result-file FILE   Write {upstream_ref,changed} only on success, outside DIR
  --verify-only         Validate artifacts in DIR or the project; never publish
  --keep-stage          Keep the temporary staging directory when validation fails
  -h, --help            Show this help

The script builds into a temporary directory and publishes only after every
check passes. It never touches index.html, script.js or styles.css.

Environment:
  Node 24+ built-in fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1
  is set at process start. Set it when downloading through an HTTP(S) proxy.`)
}

export function parseArgs(argv) {
  const options = { ref: null, latest: false, upstream: null, conformance: null, artifactRoot: null, resultFile: null, verifyOnly: false, keepStage: false, help: false }
  const values = new Map([['--ref', 'ref'], ['--upstream', 'upstream'], ['--conformance', 'conformance'], ['--artifact-root', 'artifactRoot'], ['--result-file', 'resultFile']])
  const flags = new Map([['--latest', 'latest'], ['--verify-only', 'verifyOnly'], ['--keep-stage', 'keepStage'], ['--help', 'help'], ['-h', 'help']])
  const seen = new Set()
  let index = 0
  const valueOf = (name) => {
    const value = argv[++index]
    if (!value || value.startsWith('-')) throw new Error(`${name} requires a value.`)
    return value
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    const [name] = arg.split('=')
    if (seen.has(name)) throw new Error(`Duplicate argument: ${name}`)
    seen.add(name)
    if (flags.has(arg)) options[flags.get(arg)] = true
    else if (values.has(name)) {
      const value = arg.includes('=') ? arg.slice(name.length + 1) : valueOf(name)
      if (!value || value.startsWith('-')) throw new Error(`${name} requires a value.`)
      options[values.get(name)] = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (options.ref !== null && !/^[0-9a-f]{40}$/i.test(options.ref)) {
    throw new Error(`--ref must be a full 40-character commit SHA, got: ${options.ref}`)
  }
  if (options.upstream) options.upstream = path.resolve(options.upstream)
  if (options.conformance) options.conformance = path.resolve(options.conformance)
  if (options.ref) options.ref = options.ref.toLowerCase()
  if (options.latest && (options.ref || options.upstream || options.verifyOnly)) throw new Error('--latest is mutually exclusive with --ref, --upstream and --verify-only.')
  if (options.verifyOnly && options.resultFile) throw new Error('--verify-only does not publish a --result-file.')
  if (options.artifactRoot) options.artifactRoot = path.resolve(options.artifactRoot)
  if (options.resultFile) options.resultFile = path.resolve(options.resultFile)
  if (options.artifactRoot && options.resultFile && within(options.artifactRoot, options.resultFile)) throw new Error('--result-file must be outside --artifact-root.')
  return options
}

function within(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function artifactPaths(root) {
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

export async function fetchRaw(ref, relPath, fetcher = fetch) {
  // Both transports address the same immutable object. Some networks block raw
  // GitHub while allowing its official contents API; neither uses a moving ref.
  requireSha(ref, 'upstream ref')
  const encoded = relPath.split('/').map(encodeURIComponent).join('/')
  const urls = [rawUrl(ref, relPath), `https://api.github.com/repos/${UPSTREAM_REPO}/contents/${encoded}?ref=${ref}`]
  const errors = []
  for (const [index, url] of urls.entries()) {
    try {
      const response = await fetcher(url, { headers: { Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(index === 0 ? 15_000 : 60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      errors.push(`GET ${url}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`)
    }
  }
  throw new Error(errors.join('; '))
}

export async function readSource(relPath, { upstream, ref }) {
  requireSha(ref, 'upstream ref')
  if (!upstream) return fetchRaw(ref, relPath)
  try {
    const commit = execFileSync('git', ['-C', upstream, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (commit !== ref) throw new Error(`resolved to ${commit}`)
    return execFileSync('git', ['-C', upstream, 'show', `${ref}:${relPath}`], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(`Cannot prove/read Git commit ${ref}:${relPath} in ${upstream}: ${error.message}`)
  }
}

function requireSha(ref, label) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${label} must be a full 40-character commit SHA: ${ref}`)
  return ref
}

export async function resolveLatest(fetcher = fetch) {
  const get = async url => {
    const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText || ''}`)
    return response.json()
  }
  const endpoint = `https://api.github.com/repos/${UPSTREAM_REPO}`
  const repo = await get(endpoint)
  if (typeof repo.default_branch !== 'string' || !repo.default_branch.trim()) throw new Error('GitHub returned no default_branch.')
  const commit = await get(`${endpoint}/commits/${encodeURIComponent(repo.default_branch)}`)
  return requireSha(commit.sha, 'GitHub default branch SHA')
}

async function loadConformance({ upstream, ref, conformance }) {
  if (conformance) return { bytes: await readFile(conformance), origin: conformance }
  const rel = 'sdk/conformance/analyze.json'
  return { bytes: await readSource(rel, { upstream, ref }), origin: upstream ? `${upstream}@${ref}:${rel}` : rawUrl(ref, rel) }
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
  await Promise.all(files.map(async relPath => {
    const bytes = await readSource(relPath, { upstream, ref })
    await writeFile(path.join(sourceDir, path.basename(relPath)), bytes)
  }))
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
  validateBank(bank)
  const models = bank.models.map(({ id, display_name, family, family_name, response_count }) => ({ id, display_name, family, family_name, response_count }))

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

export async function verifyArtifacts(paths, { conformance, expectedVersion = null, allowLegacy = false }) {
  const checks = []
  const rows = []
  let info = null
  let current = 'artifact input'
  const check = (name, condition, detail = '') => {
    current = name
    if (!condition) throw new Error(detail || name)
    pass(checks, name, true, detail)
  }
  try {
    const [detectorBytes, modelsBytes, bundleBytes, licenseBytes] = await Promise.all(['detector', 'models', 'bundle', 'license'].map(k => readFile(paths[k])))
    current = 'detector binary format'
    const independentlyDecoded = validateDetectorBinary(detectorBytes)
    check(current, true, `${detectorBytes.length} bytes, bounded finite float32 references`)
    current = 'bank/detector schemas, dimensions and binding'
    const bank = JSON.parse(modelsBytes)
    validateDetector(independentlyDecoded, bank)
    check(current, bank.model_count === bank.models.length, `${bank.models.length} models, ${bank.built_at}`)
    const licenseText = licenseBytes.toString('utf8')
    check('LICENSE MIT and copyright', ['MIT License', MIT_NOTICE, 'Permission is hereby granted, free of charge', 'THE SOFTWARE IS PROVIDED "AS IS"'].every(s => licenseText.includes(s)))
    const detectorSha = sha256(detectorBytes), modelsSha = sha256(modelsBytes), bundleSha = sha256(bundleBytes), licenseSha = sha256(licenseBytes)
    current = 'VERSION manifest'
    const v = expectedVersion ?? JSON.parse(await readFile(paths.version, 'utf8'))
    requireSha(v.upstream_ref, 'VERSION upstream_ref')
    check('VERSION upstream and metadata', v.upstream === UPSTREAM_REPO && v.built_at === bank.built_at && v.model_count === bank.model_count && v.license === 'MIT')
    check('VERSION detector/models hashes', v.detector_sha256 === detectorSha && v.models_sha256 === modelsSha)
    const legacy = allowLegacy && !Object.hasOwn(v, 'bundle_sha256') && !Object.hasOwn(v, 'license_sha256')
    check('VERSION bundle/license hashes', legacy || (v.bundle_sha256 === bundleSha && v.license_sha256 === licenseSha), legacy ? 'legacy manifest: new hashes absent' : 'both hashes match')
    check('bundle upstream ref binding', bundleBytes.toString('utf8').includes(`Bundled from ${UPSTREAM_REPO} @ ${v.upstream_ref}`))
    current = 'conformance snapshot binding'
    const suite = JSON.parse(conformance.bytes.toString('utf8'))
    validateConformance(suite, bank, independentlyDecoded)
    check(current, true, `${suite.cases.length} nonempty same-snapshot cases`)
    current = 'bundle exports'
    const api = loadLmfpdBundle(paths.bundle)
    const exported = ['generateChallenges', 'parseNumbers', 'decodeDetector', 'analyzeSharedOutputs']
    check(current, exported.every(name => typeof api[name] === 'function'), exported.join(', '))
    const parsed = api.parseNumbers('1, 2, 3')
    check('parseNumbers smoke', Array.isArray(parsed) && parsed.join(',') === '1,2,3')
    const challenges = api.generateChallenges(EXPECTED_RECOMMENDED_QUERIES)
    check('generateChallenges sample80/3', Array.isArray(challenges) && challenges.length === 3 && new Set(challenges.map(c => c.expected_count)).size === 3 && challenges.every(c => Number.isSafeInteger(c.expected_count) && c.expected_count >= EXPECTED_MINIMUM_VALID_NUMBERS && typeof c.prompt === 'string' && c.prompt.includes(String(c.expected_count))))
    current = 'candidate decoder matches independent codec'
    const detector = api.decodeDetector(detectorBytes)
    compareSemantic(detector, independentlyDecoded, 'decodedDetector')
    check(current, true)
    for (const item of suite.cases) {
      let actual
      try {
        const outputs = prepareOutputs(item.outputs, item.strict, api)
        actual = canonicalAnalysis(api.analyzeSharedOutputs(outputs, bank, detector, { allowPartial: !item.strict }))
        compareSemantic(actual, item.expected)
        rows.push({ name: item.name, expected: item.expected.decision, actual: actual.decision, detail: `all fields, ${actual.results.length} ranked entries`, ok: true })
      } catch (error) {
        rows.push({ name: item.name, expected: item.expected.decision, actual: actual?.decision ?? 'threw', detail: error.message, ok: false })
      }
    }
    info = { builtAt: bank.built_at, modelCount: bank.model_count, detectorSha, modelsSha, bundleSha, licenseSha, conformance: conformance.origin }
  } catch (error) {
    pass(checks, current, false, error.message)
  }
  return { ok: checks.every(c => c.ok) && rows.length > 0 && rows.every(r => r.ok), checks, rows, info }
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

async function statIfPresent(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function canonicalDestination(file) {
  const suffix = []
  let ancestor = path.resolve(file)
  while (!(await statIfPresent(ancestor))) {
    suffix.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error(`Cannot resolve destination: ${file}`)
    ancestor = parent
  }
  return path.join(await realpath(ancestor), ...suffix)
}

async function validateDestinations(options, root) {
  if (options.artifactRoot) {
    const target = await canonicalDestination(options.artifactRoot)
    // An explicit candidate destination must never address the checked-in snapshot.
    for (const file of Object.values(artifactPaths(root))) {
      if (within(target, await canonicalDestination(file))) throw new Error('--artifact-root must be separate from the project artifacts.')
    }
    const stat = await statIfPresent(options.artifactRoot)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(options.artifactRoot)).length)) throw new Error('--artifact-root must be a new or empty regular directory.')
  }
  if (options.resultFile) {
    const target = await canonicalDestination(options.resultFile)
    if (options.artifactRoot && within(await canonicalDestination(options.artifactRoot), target)) throw new Error('--result-file must be outside --artifact-root (including symlinks).')
    if (await statIfPresent(options.resultFile)) throw new Error('--result-file already exists; use a fresh result path.')
    if (Object.values(artifactPaths(root)).some(file => path.resolve(file) === target)) throw new Error('--result-file cannot overwrite a project artifact.')
  }
}

export async function changedArtifacts(staged, baseline) {
  for (const key of Object.keys(ARTIFACTS)) {
    let bytes
    try { bytes = await readFile(baseline[key]) } catch (error) { if (error.code === 'ENOENT') return true; throw error }
    if (!(await readFile(staged[key])).equals(bytes)) return true
  }
  return false
}

/** Copy to a private sibling first; a failed copy never exposes a partial candidate. */
export async function publishCandidate(staged, root) {
  const stat = await statIfPresent(root)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(root)).length)) throw new Error('Candidate root must be new or empty.')
  await mkdir(path.dirname(root), { recursive: true })
  const pending = await mkdtemp(path.join(path.dirname(root), '.lmfpd-candidate-'))
  try {
    const dest = artifactPaths(pending)
    for (const key of Object.keys(ARTIFACTS)) {
      await mkdir(path.dirname(dest[key]), { recursive: true })
      await copyFile(staged[key], dest[key])
    }
    await rename(pending, root)
  } finally {
    await rm(pending, { recursive: true, force: true })
  }
}

export async function publishResult(file, result, io = { writeFile, rename }) {
  if (await statIfPresent(file)) throw new Error(`Result path already exists: ${file}`)
  await mkdir(path.dirname(file), { recursive: true })
  const pending = await mkdtemp(path.join(path.dirname(file), '.lmfpd-result-'))
  try {
    const temp = path.join(pending, 'result.json')
    await io.writeFile(temp, `${JSON.stringify(result)}\n`, { flag: 'wx' })
    await io.rename(temp, file)
  } finally {
    await rm(pending, { recursive: true, force: true })
  }
}

/** The legacy manual path publishes only validated bytes and rolls back copy errors. */
async function publishLocal(staged, dest, stage) {
  const backups = {}
  const pending = {}
  const replaced = []
  try {
    for (const key of Object.keys(ARTIFACTS)) {
      await mkdir(path.dirname(dest[key]), { recursive: true })
      const stat = await statIfPresent(dest[key])
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Refusing non-regular artifact: ${dest[key]}`)
      backups[key] = stat ? path.join(stage, `backup-${key}`) : null
      if (stat) await copyFile(dest[key], backups[key])
      const dir = await mkdtemp(path.join(path.dirname(dest[key]), '.lmfpd-publish-'))
      pending[key] = path.join(dir, key)
      await copyFile(staged[key], pending[key])
    }
    for (const key of Object.keys(ARTIFACTS)) {
      await rename(pending[key], dest[key])
      replaced.push(key)
    }
  } catch (error) {
    for (const key of replaced.reverse()) {
      if (backups[key]) await copyFile(backups[key], dest[key])
      else await rm(dest[key], { force: true })
    }
    throw new Error(`Local publication failed and was rolled back: ${error.message}`)
  } finally {
    for (const file of Object.values(pending)) await rm(path.dirname(file), { recursive: true, force: true })
  }
}

export async function sync(options, { root = ROOT, build = buildBundle } = {}) {
  await validateDestinations(options, root)
  const baseline = artifactPaths(root)
  const currentVersion = JSON.parse(await readFile(baseline.version, 'utf8'))
  const ref = options.latest ? await resolveLatest() : requireSha(options.ref ?? currentVersion.upstream_ref, 'upstream ref')
  console.log(`Syncing ${UPSTREAM_REPO} @ ${ref}`)
  if (options.upstream) {
    console.log(`Using immutable local upstream snapshot: ${options.upstream}@${ref}`)
  }

  const stage = await mkdtemp('/tmp/opencode/lmfpd-sync-')
  const staged = stagePaths(stage)
  try {
    const source = { upstream: options.upstream, ref }
    const [bankBytes, detectorBytes, conformance] = await Promise.all([
      readSource('data/unified_bank.json', source),
      readSource('data/shared_detector.bin', source),
      loadConformance({ ...source, conformance: options.conformance }),
    ])
    const bank = JSON.parse(bankBytes.toString('utf8'))
    const models = buildModels(bank)
    // Reject stale fixtures and malformed data before running any candidate code.
    const detector = validateDetectorBinary(detectorBytes)
    validateDetector(detector, models)
    validateConformance(JSON.parse(conformance.bytes.toString('utf8')), models, detector)
    const sourceDir = path.join(stage, 'src')
    await mkdir(sourceDir, { recursive: true })
    await stageSources(sourceDir, source)

    console.log('Building lmfpd-core.js ...')
    await build(sourceDir, staged.bundle, ref)

    console.log(`Slimming bank metadata: ${models.model_count} models, built_at ${models.built_at}`)
    await writeFile(staged.models, `${JSON.stringify(models, null, 2)}\n`)

    console.log('Copying detector snapshot ...')
    await copyFile(path.join(sourceDir, 'LICENSE'), staged.license)
    await writeFile(staged.detector, detectorBytes)

    const version = {
      upstream: UPSTREAM_REPO,
      upstream_ref: ref,
      built_at: models.built_at,
      model_count: models.model_count,
      detector_sha256: sha256(detectorBytes),
      models_sha256: sha256(await readFile(staged.models)),
      bundle_sha256: sha256(await readFile(staged.bundle)),
      license_sha256: sha256(await readFile(staged.license)),
      license: 'MIT',
    }
    await writeFile(staged.version, `${JSON.stringify(version, null, 2)}\n`)

    const result = await verifyArtifacts(staged, { conformance, expectedVersion: version })
    printReport(result)
    if (!result.ok) {
      throw new Error('Verification failed; nothing was published.')
    }

    const changed = await changedArtifacts(staged, baseline)
    console.log(`\nPublishing ${Object.keys(ARTIFACTS).length} files (changed=${changed}) ...`)
    if (options.artifactRoot) await publishCandidate(staged, options.artifactRoot)
    else await publishLocal(staged, baseline, stage)
    const report = { upstream_ref: ref, changed }
    if (options.resultFile) await publishResult(options.resultFile, report)
    console.log(`Published detector ${result.info.detectorSha}`)
    console.log(`Published models   ${result.info.modelsSha}`)
    return report
  } finally {
    if (options.keepStage) {
      console.error(`Staging directory kept: ${stage}`)
    } else {
      await rm(stage, { recursive: true, force: true })
    }
  }
}

async function verifyOnly(options) {
  const paths = artifactPaths(options.artifactRoot ?? ROOT)
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
  const result = await verifyArtifacts(paths, { conformance, expectedVersion: version, allowLegacy: true })
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`\nERROR: ${error.message}`)
  if (error.stack && process.env.LMFPD_DEBUG) console.error(error.stack)
  process.exitCode = 1
})
