import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const { deploy } = pages.jobs
  assert.deepEqual(deploy.concurrency, { group: 'pages', 'cancel-in-progress': 'false' })
  const steps = deploy.steps
  const index = (name) => steps.findIndex((step) => step.id === name)
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ steps.ref.outputs.sha }}')
  assert.equal(checkout.with['persist-credentials'], 'false')
  assert.ok(index('target') > steps.indexOf(checkout))
  const configure = steps.find((step) => step.uses === 'actions/configure-pages@v5')
  const upload = steps.find((step) => step.uses === 'actions/upload-pages-artifact@v3')
  assert.equal(configure.if, "steps.target.outputs.current == 'true'")
  assert.equal(upload.if, "steps.target.outputs.current == 'true'")
  assert.equal(upload.with.path, '.')
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
