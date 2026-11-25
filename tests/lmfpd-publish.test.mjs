import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ARTIFACTS, publishCandidate, validateCandidate } from '../scripts/publish-lmfpd.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const HELPER = path.join(ROOT, 'scripts/publish-lmfpd.mjs')
const UPSTREAM_REF = 'a'.repeat(40)
const BUILT_AT = '2026-11-23T06:25:02.164646+00:00'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim()
}

async function fixture(t, bundle = 'throw new Error("candidate bundle must never execute")\n') {
  const scratch = await mkdtemp('/tmp/opencode/lmfpd-publish-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = path.join(scratch, 'repo')
  const remote = path.join(scratch, 'remote.git')
  const artifactRoot = path.join(scratch, 'candidate')
  await mkdir(repo)
  await mkdir(artifactRoot)
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'init', '--bare', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  const models = {
    schema: 'robust-number-fingerprint-bank', built_at: BUILT_AT, model_count: 2,
    minimum_valid_numbers: 80, recommended_queries: 3,
    models: ['first', 'second'].map((id) => ({
      id, display_name: id, family: 'test', family_name: 'Test', response_count: 3,
    })),
  }
  const header = Buffer.from(JSON.stringify({
    schema: 'shared-detector-v2', bank_built_at: BUILT_AT, model_ids: ['first', 'second'],
  }))
  const detector = Buffer.alloc(4 + header.length + (4 - header.length % 4) % 4 + 8)
  detector.writeUInt32LE(header.length)
  header.copy(detector, 4)
  const bytes = new Map([
    [ARTIFACTS.detector, detector],
    [ARTIFACTS.models, Buffer.from(JSON.stringify(models))],
    [ARTIFACTS.bundle, Buffer.from(bundle)],
    [ARTIFACTS.license, await readFile(path.join(ROOT, ARTIFACTS.license))],
  ])
  const version = {
    upstream: 'Ikaleio/lm-detector', upstream_ref: UPSTREAM_REF, built_at: BUILT_AT,
    model_count: 2, license: 'MIT',
    ...Object.fromEntries(['detector', 'models', 'bundle', 'license'].map((key) => [
      `${key}_sha256`, hash(bytes.get(ARTIFACTS[key])),
    ])),
  }
  bytes.set(ARTIFACTS.version, Buffer.from(JSON.stringify(version)))
  for (const [rel, content] of bytes) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true })
    await mkdir(path.dirname(path.join(artifactRoot, rel)), { recursive: true })
    await writeFile(path.join(repo, rel), content)
    await writeFile(path.join(artifactRoot, rel), content)
  }
  // The base is an older snapshot, with a valid trusted upstream identity.
  await writeFile(path.join(repo, ARTIFACTS.bundle), 'old bundle\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Fixture baseline')
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main')
  const baseSha = git(repo, 'rev-parse', 'HEAD')
  const options = {
    repo, artifactRoot, baseSha, upstreamRef: UPSTREAM_REF,
    versionSha256: hash(bytes.get(ARTIFACTS.version)),
  }
  const snapshot = async () => Object.fromEntries(await Promise.all(
    Object.values(ARTIFACTS).map(async (rel) => [rel, hash(await readFile(path.join(repo, rel)))]),
  ))
  const rebindVersion = async (change = () => {}) => {
    change(version)
    const content = Buffer.from(JSON.stringify(version))
    await writeFile(path.join(artifactRoot, ARTIFACTS.version), content)
    options.versionSha256 = hash(content)
  }
  return { ...options, options, scratch, remote, bytes, version, models, baseSha, snapshot, rebindVersion }
}

test('valid candidate makes one normal commit containing only five allowed paths and pushes it', async (t) => {
  const f = await fixture(t)
  const result = await publishCandidate(f.options)
  assert.equal(result.status, 'published')
  assert.equal(result.changed, true)
  assert.match(result.deploySha, /^[a-f0-9]{40}$/)
  assert.notEqual(result.deploySha, f.baseSha)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), result.deploySha)
  assert.equal(git(f.repo, 'rev-parse', 'HEAD^'), f.baseSha)
  assert.equal(git(f.repo, 'status', '--porcelain'), '')
  assert.equal(git(f.repo, 'show', '-s', '--format=%an <%ae>'),
    'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>')
  const changed = git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n')
  assert.ok(changed.length > 0 && changed.every((rel) => Object.values(ARTIFACTS).includes(rel)))
  assert.equal(git(f.repo, 'config', '--get-regexp', '^remote\\.origin\\.'),
    `remote.origin.url ${f.remote}\nremote.origin.fetch +refs/heads/*:refs/remotes/origin/*`)
})

test('validated unchanged candidate returns current main for redeploy recovery without an empty commit', async (t) => {
  const f = await fixture(t)
  const published = await publishCandidate(f.options)
  const count = git(f.repo, 'rev-list', '--count', 'HEAD')
  const result = await publishCandidate({ ...f.options, baseSha: published.deploySha })
  assert.deepEqual(result, { status: 'unchanged', changed: false, deploySha: published.deploySha })
  assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), count)
})

test('wrong local base skips without writing any candidate bytes or pushing', async (t) => {
  const f = await fixture(t)
  const before = await f.snapshot()
  assert.deepEqual(await publishCandidate({ ...f.options, baseSha: 'b'.repeat(40) }),
    { status: 'stale', changed: false, deploySha: '' })
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseSha)
})

test('main advance before publication skips without modifying the checkout', async (t) => {
  const f = await fixture(t)
  const before = await f.snapshot()
  const other = path.join(f.scratch, 'other')
  git(f.repo, 'clone', f.remote, other)
  git(other, 'checkout', 'main')
  await writeFile(path.join(other, 'new-main.txt'), 'another author\n')
  git(other, 'add', '.')
  git(other, 'commit', '-m', 'Advance main')
  git(other, 'push', 'origin', 'main')
  const newMain = git(other, 'rev-parse', 'HEAD')
  assert.equal((await publishCandidate(f.options)).status, 'stale')
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(git(f.repo, 'status', '--porcelain'), '')
  assert.equal(git(f.remote, 'rev-parse', 'main'), newMain)
})

const tampering = {
  'extra file': async (f) => writeFile(path.join(f.artifactRoot, 'unexpected.js'), 'no'),
  'extra directory': async (f) => mkdir(path.join(f.artifactRoot, 'unused')),
  'hidden file': async (f) => writeFile(path.join(f.artifactRoot, '.env'), 'no'),
  'symlink file': async (f) => {
    const target = path.join(f.artifactRoot, ARTIFACTS.bundle)
    await rm(target)
    await symlink(path.join(f.repo, ARTIFACTS.bundle), target)
  },
  'symlink directory': async (f) => {
    const target = path.join(f.artifactRoot, 'assets/vendor/lmfpd')
    await rm(target, { recursive: true })
    await symlink(path.join(f.repo, 'assets/vendor/lmfpd'), target)
  },
  'missing artifact': async (f) => rm(path.join(f.artifactRoot, ARTIFACTS.license)),
  'bundle hash': async (f) => writeFile(path.join(f.artifactRoot, ARTIFACTS.bundle), 'tampered'),
  'version digest': async (f) => writeFile(path.join(f.artifactRoot, ARTIFACTS.version), '{}'),
  'upstream SHA binding': async (f) => f.rebindVersion((v) => { v.upstream_ref = 'c'.repeat(40) }),
  'upstream repository': async (f) => f.rebindVersion((v) => { v.upstream = 'elsewhere/repository' }),
  'license declaration': async (f) => f.rebindVersion((v) => { v.license = 'GPL' }),
  'built_at binding': async (f) => f.rebindVersion((v) => { v.built_at = '2026-01-01T00:00:00Z' }),
  'model count binding': async (f) => f.rebindVersion((v) => { v.model_count = 3 }),
  'models protocol': async (f) => {
    f.models.minimum_valid_numbers = 1
    const content = Buffer.from(JSON.stringify(f.models))
    await writeFile(path.join(f.artifactRoot, ARTIFACTS.models), content)
    await f.rebindVersion((v) => { v.models_sha256 = hash(content) })
  },
  'detector/model ID binding': async (f) => {
    f.models.models[0].id = 'mismatch'
    const content = Buffer.from(JSON.stringify(f.models))
    await writeFile(path.join(f.artifactRoot, ARTIFACTS.models), content)
    await f.rebindVersion((v) => { v.models_sha256 = hash(content) })
  },
  'invalid detector header': async (f) => {
    const content = Buffer.from('unparseable detector')
    await writeFile(path.join(f.artifactRoot, ARTIFACTS.detector), content)
    await f.rebindVersion((v) => { v.detector_sha256 = hash(content) })
  },
  'MIT content': async (f) => {
    const content = Buffer.from('MIT License\nproprietary replacement')
    await writeFile(path.join(f.artifactRoot, ARTIFACTS.license), content)
    await f.rebindVersion((v) => { v.license_sha256 = hash(content) })
  },
}

for (const [name, tamper] of Object.entries(tampering)) {
  test(`rejects ${name} before repository writes or push`, async (t) => {
    const f = await fixture(t)
    const before = await f.snapshot()
    await tamper(f)
    await assert.rejects(publishCandidate(f.options), /candidate|artifact|manifest|digest|model|detector|MIT|upstream|built_at/i)
    assert.deepEqual(await f.snapshot(), before)
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.baseSha)
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseSha)
    assert.equal(git(f.repo, 'status', '--porcelain'), '')
  })
}

test('dirty trusted checkout is refused before candidate writes', async (t) => {
  const f = await fixture(t)
  await writeFile(path.join(f.repo, 'unrelated.txt'), 'preserve this')
  const before = await f.snapshot()
  await assert.rejects(publishCandidate(f.options), /clean/i)
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(await readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'preserve this')
})

test('a different checked-out branch cannot publish main', async (t) => {
  const f = await fixture(t)
  git(f.repo, 'checkout', '-b', 'other')
  await assert.rejects(publishCandidate(f.options), /branch/i)
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseSha)
})

test('detached trusted checkout supports publication', async (t) => {
  const f = await fixture(t)
  git(f.repo, 'checkout', '--detach', f.baseSha)
  assert.equal((await publishCandidate(f.options)).status, 'published')
})

test('candidate bundle is handled as bytes even when it would execute arbitrary Node code', async (t) => {
  const f = await fixture(t, 'process.exit(71); require("node:fs").writeFileSync("EXECUTED", "bad")\n')
  assert.equal((await publishCandidate(f.options)).status, 'published')
  await assert.rejects(readFile(path.join(f.repo, 'EXECUTED')), { code: 'ENOENT' })
})

test('a push rejected by the remote does not return an unpublished deploy SHA', async (t) => {
  const f = await fixture(t)
  await writeFile(path.join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await assert.rejects(publishCandidate(f.options), /push/i)
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseSha)
  assert.notEqual(git(f.repo, 'rev-parse', 'HEAD'), f.baseSha)
})

test('main race at push is rejected by normal Git fast-forward rules, with no force or rebase', async (t) => {
  const f = await fixture(t)
  const tree = git(f.repo, 'rev-parse', 'HEAD^{tree}')
  const advanced = git(f.repo, 'commit-tree', tree, '-p', f.baseSha, '-m', 'Concurrent main')
  git(f.repo, 'push', 'origin', `${advanced}:refs/heads/race`)
  // Advance main during receive, after the publisher's final main check.
  await writeFile(path.join(f.remote, 'hooks/update'),
    `#!/bin/sh\ngit update-ref refs/heads/main ${advanced}\n`, { mode: 0o755 })
  const result = await publishCandidate(f.options)
  assert.equal(result.deploySha, '')
  assert.equal(result.status, 'stale')
  assert.equal(git(f.remote, 'rev-parse', 'main'), advanced)
  assert.equal(git(f.repo, 'rev-parse', 'HEAD^'), f.baseSha)
})

test('CLI emits only a fixed output key and a validated full deployment SHA', async (t) => {
  const f = await fixture(t)
  const output = path.join(f.scratch, 'github-output')
  execFileSync(process.execPath, [HELPER,
    '--base-sha', f.baseSha, '--artifact-root', f.artifactRoot,
    '--upstream-ref', UPSTREAM_REF, '--version-sha256', f.versionSha256, '--output', output,
  ], { cwd: f.repo, stdio: 'pipe' })
  assert.equal(await readFile(output, 'utf8'), `deploy_sha=${git(f.remote, 'rev-parse', 'main')}\n`)
})

test('CLI rejects output injection and unknown flags before publication', async (t) => {
  const f = await fixture(t)
  for (const extra of [['--base-sha', `${f.baseSha}\nevil=value`], ['--unknown', 'x']]) {
    assert.throws(() => execFileSync(process.execPath, [HELPER,
      '--base-sha', f.baseSha, '--artifact-root', f.artifactRoot,
      '--upstream-ref', UPSTREAM_REF, '--version-sha256', f.versionSha256, ...extra,
    ], { cwd: f.repo, stdio: 'pipe' }))
  }
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.baseSha)
})

test('standalone byte validator returns all five immutable buffers without executing the bundle', async (t) => {
  const f = await fixture(t)
  const result = await validateCandidate(f.options)
  assert.equal(result.files.size, 5)
  assert.equal(result.version.upstream_ref, UPSTREAM_REF)
})

test('real supported snapshot satisfies publication byte checks with a migrated integrity manifest', async (t) => {
  const artifactRoot = await mkdtemp('/tmp/opencode/lmfpd-publish-supported-')
  t.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const bytes = new Map(await Promise.all(Object.values(ARTIFACTS).map(async (rel) => [
    rel, await readFile(path.join(ROOT, rel)),
  ])))
  const version = JSON.parse(bytes.get(ARTIFACTS.version))
  for (const key of ['detector', 'models', 'bundle', 'license']) {
    version[`${key}_sha256`] = hash(bytes.get(ARTIFACTS[key]))
  }
  bytes.set(ARTIFACTS.version, Buffer.from(JSON.stringify(version)))
  for (const [rel, content] of bytes) {
    await mkdir(path.dirname(path.join(artifactRoot, rel)), { recursive: true })
    await writeFile(path.join(artifactRoot, rel), content)
  }
  const result = await validateCandidate({ artifactRoot, upstreamRef: version.upstream_ref,
    versionSha256: hash(bytes.get(ARTIFACTS.version)) })
  assert.equal(result.version.model_count, JSON.parse(bytes.get(ARTIFACTS.models)).models.length)
})
