import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const YAML_AVAILABLE = spawnSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' }).status === 0
const parseYaml = async (rel) => {
  const text = await readFile(path.join(ROOT, rel), 'utf8')
  // BaseLoader retains GitHub's `on` key instead of interpreting it as YAML 1.1 true.
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,yaml; print(json.dumps(yaml.load(sys.stdin.read(), Loader=yaml.BaseLoader)))',
  ], { input: text, encoding: 'utf8' }))
}
const workflow = (name, fn) => test(name, { skip: !YAML_AVAILABLE && 'Existing Python PyYAML unavailable' }, fn)

workflow('sync workflow separates read-only candidate, trusted writer, and explicit reusable Pages deployment', async () => {
  const sync = await parseYaml('.github/workflows/sync-lmfpd.yml')
  assert.equal(sync.on.schedule[0].cron, '17 3 * * *')
  assert.ok(Object.hasOwn(sync.on, 'workflow_dispatch'))
  assert.deepEqual(sync.permissions, { contents: 'read' })
  assert.deepEqual(sync.concurrency, { group: 'lmfpd-sync-main', 'cancel-in-progress': 'false' })
  assert.deepEqual(Object.keys(sync.jobs), ['candidate', 'commit', 'deploy'])
  const { candidate, commit, deploy } = sync.jobs
  assert.deepEqual(candidate.permissions, { contents: 'read' })
  const checkout = candidate.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with['persist-credentials'], 'false')
  assert.equal(checkout.with.ref, 'main')
  assert.ok(candidate.steps.some((step) => step.with?.['node-version'] === '24'))
  assert.ok(candidate.steps.some((step) => step.run?.includes('sync-lmfpd.mjs --latest --artifact-root')))
  assert.ok(candidate.steps.some((step) => step.run?.includes('node --test tests/sync-lmfpd*.test.mjs')))
  const upload = candidate.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.equal(upload.with['include-hidden-files'], 'true')
  assert.deepEqual(Object.keys(candidate.outputs).sort(),
    ['artifact_id', 'base_sha', 'changed', 'upstream_ref', 'version_sha256'])
  assert.equal(commit.needs, 'candidate')
  assert.deepEqual(commit.permissions, { contents: 'write' })
  assert.equal(commit.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref,
    '${{ needs.candidate.outputs.base_sha }}')
  const download = commit.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(download.with['artifact-ids'], '${{ needs.candidate.outputs.artifact_id }}')
  assert.equal(download.with['merge-multiple'], 'true')
  assert.ok(!Object.hasOwn(download.with, 'run-id'))
  assert.ok(!Object.hasOwn(download.with, 'name'))
  const commands = commit.steps.map((step) => step.run || '').join('\n')
  assert.match(commands, /node scripts\/publish-lmfpd\.mjs/)
  assert.doesNotMatch(commands, /sync-lmfpd\.mjs|node --test|conformance|lmfpd-core\.js/)
  assert.equal(commit.outputs.deploy_sha, '${{ steps.publish.outputs.deploy_sha }}')
  assert.equal(deploy.needs, 'commit')
  assert.equal(deploy.if, "needs.commit.outputs.deploy_sha != ''")
  assert.equal(deploy.uses, './.github/workflows/static.yml')
  assert.equal(deploy.with.ref, '${{ needs.commit.outputs.deploy_sha }}')
  assert.deepEqual(deploy.permissions, { contents: 'read', pages: 'write', 'id-token': 'write' })
  assert.ok(!deploy.concurrency)
  // Expressions from data-producing steps must enter shell commands through env.
  for (const job of [candidate, commit]) {
    for (const step of job.steps) assert.doesNotMatch(step.run || '', /\$\{\{/)
  }
})

workflow('all actual Pages deployments share the job lock and exact-SHA stale guards', async () => {
  const pages = await parseYaml('.github/workflows/static.yml')
  assert.deepEqual(pages.on.push.branches, ['main'])
  assert.ok(Object.hasOwn(pages.on, 'workflow_dispatch'))
  assert.deepEqual(pages.on.workflow_call.inputs.ref, {
    description: 'Exact validated main commit to deploy', required: 'true', type: 'string',
  })
  assert.ok(!pages.concurrency)
  assert.deepEqual(pages.permissions, { contents: 'read', pages: 'write', 'id-token': 'write' })
  const { deploy } = pages.jobs
  assert.deepEqual(deploy.concurrency, { group: 'pages', 'cancel-in-progress': 'false' })
  assert.deepEqual(deploy.environment, { name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' })
  const steps = deploy.steps
  const index = (name) => steps.findIndex((step) => step.id === name)
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ steps.ref.outputs.sha }}')
  assert.equal(checkout.with['persist-credentials'], 'false')
  assert.ok(index('target') > steps.indexOf(checkout))
  const configure = steps.find((step) => step.uses === 'actions/configure-pages@v5')
  const stage = steps.find((step) => step.name === 'Stage website runtime files')
  const upload = steps.find((step) => step.uses === 'actions/upload-pages-artifact@v3')
  assert.equal(configure.if, "steps.target.outputs.current == 'true'")
  assert.equal(stage?.if, "steps.target.outputs.current == 'true'")
  assert.equal(steps.indexOf(stage), steps.indexOf(configure) + 1)
  assert.equal(steps.indexOf(upload), steps.indexOf(stage) + 1)
  assert.equal(upload.if, "steps.target.outputs.current == 'true'")
  assert.equal(upload.with.path, '${{ runner.temp }}/apitest-site')
  assert.equal(index('ready'), steps.indexOf(upload) + 1)
  assert.equal(index('deployment'), index('ready') + 1)
  assert.equal(steps[index('deployment')].uses, 'actions/deploy-pages@v4')
  assert.equal(steps[index('deployment')].if, "steps.ready.outputs.current == 'true'")
  for (const step of steps) assert.doesNotMatch(step.run || '', /\$\{\{/)
})

workflow('Pages guards actually skip an old SHA and main advancing during upload', async (t) => {
  const pages = await parseYaml('.github/workflows/static.yml')
  const steps = pages.jobs.deploy.steps
  const scratch = await mkdtemp('/tmp/opencode/lmfpd-pages-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = path.join(scratch, 'repo')
  const remote = path.join(scratch, 'remote.git')
  const output = path.join(scratch, 'output')
  const summary = path.join(scratch, 'summary')
  await mkdir(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim()
  git('init', '--initial-branch=main')
  git('init', '--bare', remote)
  git('remote', 'add', 'origin', remote)
  await writeFile(path.join(repo, 'index.html'), 'first')
  git('add', '.')
  git('commit', '-m', 'First')
  git('push', 'origin', 'HEAD:refs/heads/main')
  const first = git('rev-parse', 'HEAD')
  const guard = async (id, extraEnv = {}) => {
    await writeFile(output, '')
    execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      steps.find((step) => step.id === id).run,
    ], { cwd: repo, stdio: 'pipe',
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...extraEnv } })
    return readFile(output, 'utf8')
  }
  assert.equal(await guard('target'), `current=true\nsha=${first}\n`)
  assert.equal(await guard('ready', { TARGET_SHA: first }), 'current=true\n')
  await writeFile(path.join(repo, 'index.html'), 'second')
  git('add', '.')
  git('commit', '-m', 'Second')
  git('push', 'origin', 'HEAD:refs/heads/main')
  assert.equal(await guard('ready', { TARGET_SHA: first }), 'current=false\n')
  git('checkout', '--detach', first)
  assert.equal(await guard('target'), 'current=false\n')
  assert.match(await readFile(summary, 'utf8'), /Skipping stale Pages target/)
})

workflow('Pages input resolution pins manual main and rejects malformed SHAs before checkout', async (t) => {
  const pages = await parseYaml('.github/workflows/static.yml')
  const run = pages.jobs.deploy.steps[0].run
  const scratch = await mkdtemp('/tmp/opencode/lmfpd-pages-input-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const output = path.join(scratch, 'output')
  const validate = (event, ref, sha = 'a'.repeat(40)) => spawnSync('bash', ['-e', '-c',
    'gh() { [[ "$*" == "api repos/test/repo/commits/main --jq .sha" ]] || return 2; printf "%s\\n" "$MANUAL_SHA"; };\n' + run,
  ], {
    env: { ...process.env, EVENT_NAME: event, REQUESTED_REF: ref, EVENT_SHA: sha,
      GITHUB_OUTPUT: output, TARGET_REPOSITORY: 'test/repo', MANUAL_SHA: 'c'.repeat(40) },
    stdio: 'pipe',
  }).status
  assert.equal(validate('schedule', 'b'.repeat(40)), 0)
  assert.equal(validate('push', ''), 0)
  assert.equal(validate('workflow_dispatch', ''), 0)
  assert.match(await readFile(output, 'utf8'), new RegExp(`sha=${'c'.repeat(40)}\\n`))
  assert.notEqual(validate('schedule', ''), 0)
  assert.notEqual(validate('workflow_dispatch', 'main'), 0)
  assert.notEqual(validate('push', '', 'main'), 0)
  assert.notEqual(validate('schedule', `${'b'.repeat(40)}\nother=value`), 0)
})

const RUNTIME = ['index.html', 'assets', 'CNAME', '.nojekyll', 'LICENSE']
const readTree = async (dir) => {
  const files = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [rel, bytes] of Object.entries(await readTree(file))) files[`${entry.name}/${rel}`] = bytes
    } else {
      assert.ok(entry.isFile(), `Expected regular file: ${file}`)
      files[entry.name] = await readFile(file)
    }
  }
  return files
}
const runtimeFiles = async (root) => ({
  ...Object.fromEntries(await Promise.all(RUNTIME.filter(name => name !== 'assets').map(async name => [name, await readFile(path.join(root, name))]))),
  ...Object.fromEntries(Object.entries(await readTree(path.join(root, 'assets'))).map(([rel, bytes]) => [`assets/${rel}`, bytes])),
})
const runStage = (run, repo, temp) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run], {
  cwd: repo, env: { ...process.env, RUNNER_TEMP: temp }, encoding: 'utf8',
})
const fixtureFiles = {
  'index.html': '<link href="assets/css/site.css"><script src="assets/js/site.js"></script>',
  'assets/css/site.css': 'body { color: green }',
  'assets/js/site.js': 'window.fixture = true',
  'assets/deep folder/reference.bin': Buffer.from([0, 255, 1, 128, 10]),
  'assets/.hidden-reference': 'retained asset',
  CNAME: 'fixture.example.invalid\n', '.nojekyll': '', LICENSE: 'fixture license\n',
  'tests/sentinel': 'test code', 'scripts/sentinel': 'build code', 'proxy/sentinel': 'server code',
  '.trellis/sentinel': 'task state', '.opencode/sentinel': 'agent config', '.github/sentinel': 'workflow',
  'README.md': 'development documentation', 'example.png': 'large example', 'other-sentinel': 'unlisted',
}
const makeFixture = async (repo, missing) => {
  await mkdir(repo)
  for (const [rel, bytes] of Object.entries(fixtureFiles)) {
    if (rel === missing || rel.startsWith(`${missing}/`)) continue
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true })
    await writeFile(path.join(repo, rel), bytes)
  }
}

workflow('Pages staging copies only runtime files byte-for-byte with quoted paths and leaves source intact', async (t) => {
  const pages = await parseYaml('.github/workflows/static.yml')
  const stage = pages.jobs.deploy.steps.find(step => step.name === 'Stage website runtime files')
  assert.ok(stage?.run)
  const scratch = await mkdtemp('/tmp/opencode/pages-package-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = path.join(scratch, 'source repo'), temp = path.join(scratch, 'runner temp with spaces')
  await makeFixture(repo)
  await mkdir(temp)
  const before = await readTree(repo)
  const result = runStage(stage.run, repo, temp)
  assert.equal(result.status, 0, result.stderr)
  const site = path.join(temp, 'apitest-site')
  assert.deepEqual(await readTree(site), await runtimeFiles(repo))
  assert.deepEqual((await readdir(site)).sort(), RUNTIME.slice().sort())
  assert.deepEqual(await readTree(repo), before, 'staging must neither edit nor delete source files')
})

workflow('Pages staging of the actual repository preserves every runtime byte, asset path and manifest hash', async (t) => {
  const pages = await parseYaml('.github/workflows/static.yml')
  const stage = pages.jobs.deploy.steps.find(step => step.name === 'Stage website runtime files')
  assert.ok(stage?.run)
  const scratch = await mkdtemp('/tmp/opencode/pages-package-real-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const temp = path.join(scratch, 'runner temp with spaces')
  await mkdir(temp)
  const before = await runtimeFiles(ROOT)
  const result = runStage(stage.run, ROOT, temp)
  assert.equal(result.status, 0, result.stderr)
  const files = await readTree(path.join(temp, 'apitest-site'))
  assert.deepEqual(files, before)
  assert.deepEqual(await runtimeFiles(ROOT), before)
  const base = new URL('https://package.example.invalid/')
  let references = 0
  for (const match of files['index.html'].toString().matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const url = new URL(match[1], base)
    if (url.origin !== base.origin || url.pathname === '/') continue
    assert.ok(files[decodeURIComponent(url.pathname.slice(1))], `Missing staged resource: ${match[1]}`)
    references++
  }
  assert.ok(references > 0)
  const version = JSON.parse(files['assets/data/lmfpd/VERSION.json'])
  for (const [field, rel] of Object.entries({
    detector_sha256: 'assets/data/lmfpd/shared_detector.bin', models_sha256: 'assets/data/lmfpd/models.json',
    bundle_sha256: 'assets/vendor/lmfpd/lmfpd-core.js', license_sha256: 'assets/vendor/lmfpd/LICENSE',
  })) assert.equal(createHash('sha256').update(files[rel]).digest('hex'), version[field], field)
  t.diagnostic(`Actual runtime package: ${Object.keys(files).length} files, ${Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0)} bytes; ${references} local index resources and four manifest hashes verified`)
})

workflow('Pages staging fails before upload when any required input is missing', async (t) => {
  const pages = await parseYaml('.github/workflows/static.yml')
  const stage = pages.jobs.deploy.steps.find(step => step.name === 'Stage website runtime files')
  assert.ok(stage?.run)
  const scratch = await mkdtemp('/tmp/opencode/pages-package-missing-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  for (const missing of RUNTIME) {
    const repo = path.join(scratch, `source-${missing}`), temp = path.join(scratch, `runner temp-${missing}`)
    await makeFixture(repo, missing)
    await mkdir(temp)
    const before = await readTree(repo)
    const result = runStage(stage.run + '\nprintf "eligible" > "$RUNNER_TEMP/upload-eligible"\n', repo, temp)
    assert.notEqual(result.status, 0, `Missing ${missing} must fail`)
    await assert.rejects(readFile(path.join(temp, 'upload-eligible')), { code: 'ENOENT' })
    assert.deepEqual(await readTree(repo), before)
  }
})

workflow('Pages staging refuses an existing destination without uploading or reusing stale files', async (t) => {
  const pages = await parseYaml('.github/workflows/static.yml')
  const stage = pages.jobs.deploy.steps.find(step => step.name === 'Stage website runtime files')
  assert.ok(stage?.run)
  const scratch = await mkdtemp('/tmp/opencode/pages-package-existing-')
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = path.join(scratch, 'source'), temp = path.join(scratch, 'runner temp')
  await makeFixture(repo)
  const site = path.join(temp, 'apitest-site')
  await mkdir(site, { recursive: true })
  await writeFile(path.join(site, 'stale-test-artifact'), 'leftover')
  const before = await readTree(repo), stale = await readTree(site)
  const result = runStage(stage.run + '\nprintf "eligible" > "$RUNNER_TEMP/upload-eligible"\n', repo, temp)
  assert.notEqual(result.status, 0)
  await assert.rejects(readFile(path.join(temp, 'upload-eligible')), { code: 'ENOENT' })
  assert.deepEqual(await readTree(site), stale)
  assert.deepEqual(await readTree(repo), before)
})
