#!/usr/bin/env node
// Runs only on the trusted publication runner. Candidate JavaScript is never loaded.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ARTIFACTS = Object.freeze({
  detector: 'assets/data/lmfpd/shared_detector.bin',
  models: 'assets/data/lmfpd/models.json',
  version: 'assets/data/lmfpd/VERSION.json',
  bundle: 'assets/vendor/lmfpd/lmfpd-core.js',
  license: 'assets/vendor/lmfpd/LICENSE',
})

const UPSTREAM = 'Ikaleio/lm-detector'
const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/
const ALLOWED_FILES = new Set(Object.values(ARTIFACTS))
const ALLOWED_DIRS = new Set([...ALLOWED_FILES].flatMap((rel) => {
  const parts = rel.split('/')
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}))
// Generous resource limits, independent of any particular upstream snapshot size.
const MAX_BYTES = {
  [ARTIFACTS.detector]: 256 * 1024 * 1024,
  [ARTIFACTS.models]: 32 * 1024 * 1024,
  [ARTIFACTS.bundle]: 32 * 1024 * 1024,
  [ARTIFACTS.version]: 64 * 1024,
  [ARTIFACTS.license]: 64 * 1024,
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function validateBindings({ baseSha, upstreamRef, versionSha256 }) {
  requireValue(SHA.test(baseSha ?? ''), 'base SHA must be a full lowercase 40-hex commit SHA.')
  requireValue(SHA.test(upstreamRef ?? ''), 'upstream ref must be a full lowercase 40-hex commit SHA.')
  requireValue(DIGEST.test(versionSha256 ?? ''), 'VERSION digest must be a lowercase SHA-256 digest.')
}

function json(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`)
    return value
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`)
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readCandidateTree(root) {
  const files = new Map()
  requireValue((await lstat(root)).isDirectory(), 'Candidate artifact root must be a real directory, not a symlink.')
  async function visit(rel = '') {
    for (const entry of await readdir(path.join(root, rel))) {
      const child = rel ? `${rel}/${entry}` : entry
      const target = path.join(root, child)
      const stat = await lstat(target)
      if (stat.isDirectory()) {
        requireValue(ALLOWED_DIRS.has(child), `Unexpected candidate artifact directory: ${child}`)
        await visit(child)
      } else {
        requireValue(ALLOWED_FILES.has(child) && stat.isFile() && !stat.isSymbolicLink(),
          `Unexpected or non-regular candidate artifact: ${child}`)
        requireValue(stat.size > 0 && stat.size <= MAX_BYTES[child], `Candidate artifact size out of bounds: ${child}`)
        const content = await readFile(target)
        requireValue(content.length === stat.size, `Candidate artifact changed while reading: ${child}`)
        files.set(child, content)
      }
    }
  }
  await visit()
  requireValue(files.size === ALLOWED_FILES.size, 'Candidate artifact must contain exactly the five allowed files.')
  return files
}

export async function validateCandidate(options) {
  const { artifactRoot, upstreamRef, versionSha256 } = options
  requireValue(SHA.test(upstreamRef ?? ''), 'Invalid expected upstream ref.')
  requireValue(DIGEST.test(versionSha256 ?? ''), 'Invalid expected VERSION digest.')
  const files = await readCandidateTree(path.resolve(artifactRoot))
  const versionBytes = files.get(ARTIFACTS.version)
  requireValue(digest(versionBytes) === versionSha256, 'Candidate VERSION digest differs from the read-only job output.')
  const version = json(versionBytes, 'candidate VERSION manifest')
  requireValue(version.upstream === UPSTREAM, 'Candidate manifest upstream repository is not approved.')
  requireValue(version.upstream_ref === upstreamRef, 'Candidate manifest upstream ref does not match the validated job.')
  requireValue(version.license === 'MIT', 'Candidate manifest license must be MIT.')
  requireValue(typeof version.built_at === 'string' && version.built_at.length <= 128 &&
    Number.isFinite(Date.parse(version.built_at)), 'Candidate manifest built_at is invalid.')
  requireValue(Number.isSafeInteger(version.model_count) && version.model_count > 0,
    'Candidate manifest model_count is invalid.')
  for (const key of ['detector', 'models', 'bundle', 'license']) {
    requireValue(DIGEST.test(version[`${key}_sha256`] ?? '') &&
      version[`${key}_sha256`] === digest(files.get(ARTIFACTS[key])), `Candidate ${key} hash does not match manifest.`)
  }
  const models = json(files.get(ARTIFACTS.models), 'candidate models manifest')
  requireValue(models.schema === 'robust-number-fingerprint-bank', 'Candidate models schema is unsupported.')
  requireValue(models.built_at === version.built_at, 'Candidate models built_at does not match VERSION.')
  requireValue(models.model_count === version.model_count && Array.isArray(models.models) &&
    models.models.length === version.model_count, 'Candidate model count does not match VERSION.')
  requireValue(models.minimum_valid_numbers === 80 && models.recommended_queries === 3,
    'Candidate models sampling protocol is incompatible.')
  const ids = new Set()
  for (const model of models.models) {
    requireValue(model && ['id', 'display_name', 'family', 'family_name'].every((key) =>
      typeof model[key] === 'string' && model[key].length > 0) &&
      Number.isSafeInteger(model.response_count) && model.response_count > 0 && !ids.has(model.id),
    'Candidate models contain invalid or duplicate metadata.')
    ids.add(model.id)
  }
  // Decode only the JSON header with trusted built-ins, never the upstream decoder.
  const detector = files.get(ARTIFACTS.detector)
  requireValue(detector.length >= 8, 'Candidate detector is too short.')
  const headerSize = detector.readUInt32LE(0)
  const payloadOffset = Math.ceil((4 + headerSize) / 4) * 4
  requireValue(headerSize > 0 && headerSize <= 16 * 1024 * 1024 && payloadOffset < detector.length &&
    (detector.length - payloadOffset) % 4 === 0, 'Candidate detector header or payload bounds are invalid.')
  const header = json(detector.subarray(4, 4 + headerSize), 'candidate detector header')
  requireValue(header.schema === 'shared-detector-v2' && header.bank_built_at === version.built_at,
    'Candidate detector schema or built_at does not match manifest.')
  requireValue(Array.isArray(header.model_ids) && header.model_ids.length === models.models.length &&
    header.model_ids.every((id, index) => id === models.models[index].id),
  'Candidate detector model IDs do not match models manifest.')
  const license = files.get(ARTIFACTS.license).toString('utf8').replace(/\s+/g, ' ')
  requireValue(license.includes('MIT License') && license.includes('Copyright (c) 2026 xqy2006') &&
    license.includes('Permission is hereby granted, free of charge, to any person obtaining a copy') &&
    license.includes('The above copyright notice and this permission notice shall be included') &&
    license.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND') &&
    license.includes('IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE'),
  'Candidate LICENSE does not contain the required MIT grant and disclaimer.')
  return { files, version }
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  }).trim()
}

function remoteMain(repo) {
  const result = git(repo, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main')
  requireValue(/^[0-9a-f]{40}\trefs\/heads\/main$/.test(result), 'Could not resolve a unique origin/main SHA.')
  return result.slice(0, 40)
}

const stale = () => ({ status: 'stale', changed: false, deploySha: '' })

export async function publishCandidate(options) {
  validateBindings(options)
  const { baseSha } = options
  const repo = path.resolve(options.repo ?? process.cwd())
  requireValue(git(repo, 'rev-parse', '--show-toplevel') === repo, 'Publication must run at the trusted repository root.')
  const branch = git(repo, 'branch', '--show-current')
  requireValue(branch === '' || branch === 'main', 'Publication requires main or a detached exact-base checkout branch.')
  requireValue(git(repo, 'status', '--porcelain', '--untracked-files=all') === '',
    'Trusted checkout must be clean before publication.')
  if (git(repo, 'rev-parse', 'HEAD') !== baseSha || remoteMain(repo) !== baseSha) return stale()
  const currentVersion = json(Buffer.from(git(repo, 'show', `${baseSha}:${ARTIFACTS.version}`)), 'trusted VERSION manifest')
  requireValue(currentVersion.upstream === UPSTREAM, 'Trusted manifest upstream repository is not approved.')
  const { files } = await validateCandidate(options)
  // Validate every destination before the first write, including every parent component.
  for (const rel of ALLOWED_DIRS) {
    requireValue((await lstat(path.join(repo, rel))).isDirectory(), `Trusted artifact parent is not a real directory: ${rel}`)
  }
  let changed = false
  for (const [rel, bytes] of files) {
    const target = path.join(repo, rel)
    const stat = await lstat(target)
    requireValue(stat.isFile() && !stat.isSymbolicLink(), `Trusted artifact is not a regular file: ${rel}`)
    if (!(await readFile(target)).equals(bytes)) changed = true
  }
  // A main advance during byte validation must also leave the checkout untouched.
  if (remoteMain(repo) !== baseSha) return stale()
  if (!changed) return { status: 'unchanged', changed: false, deploySha: baseSha }
  for (const [rel, bytes] of files) await writeFile(path.join(repo, rel), bytes)
  git(repo, 'add', '--', ...ALLOWED_FILES)
  const staged = git(repo, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean)
  requireValue(staged.length > 0 && staged.every((rel) => ALLOWED_FILES.has(rel)),
    'Publication index contains unexpected paths.')
  requireValue(git(repo, 'diff', '--cached', '--diff-filter=D', '--name-only') === '',
    'Publication must not delete artifacts.')
  git(repo,
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `chore: sync lmfpd ${options.upstreamRef}`)
  const commitSha = git(repo, 'rev-parse', 'HEAD')
  requireValue(SHA.test(commitSha), 'Git returned an invalid publication SHA.')
  if (remoteMain(repo) !== baseSha) return stale()
  try {
    git(repo, 'push', 'origin', 'HEAD:refs/heads/main')
  } catch (error) {
    if (remoteMain(repo) !== baseSha) return stale()
    throw new Error('LMFPD normal push failed; no deployment SHA was emitted. Check branch rules and Actions write permission.',
      { cause: error })
  }
  if (remoteMain(repo) !== commitSha) return stale()
  return { status: 'published', changed: true, deploySha: commitSha }
}

function parseArgs(argv) {
  const options = {}
  const names = new Map([
    ['--artifact-root', 'artifactRoot'], ['--base-sha', 'baseSha'], ['--upstream-ref', 'upstreamRef'],
    ['--version-sha256', 'versionSha256'], ['--output', 'output'],
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index])
    requireValue(key && !Object.hasOwn(options, key), `Unknown or repeated argument: ${argv[index]}`)
    const value = argv[index + 1]
    requireValue(value && !value.startsWith('--'), `Missing value for ${argv[index]}`)
    options[key] = value
  }
  requireValue(options.artifactRoot, '--artifact-root is required.')
  validateBindings(options)
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const result = await publishCandidate(options)
  requireValue(result.deploySha === '' || SHA.test(result.deploySha), 'Unsafe deployment output.')
  const output = options.output ?? process.env.GITHUB_OUTPUT
  if (output) await appendFile(output, `deploy_sha=${result.deploySha}\n`)
  console.log(`LMFPD publication: ${JSON.stringify(result)}`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`LMFPD publication failed: ${error.message}`)
    process.exitCode = 1
  })
}
