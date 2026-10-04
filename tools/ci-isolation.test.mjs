import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mock } from 'node:test'
import { buildIsolationInvocation, runIsolatedCandidate } from '../ci/tools/ci-isolation.mjs'

const root = mkdtempSync(join(tmpdir(), 'ci-isolation-offline-'))
const inputDirectory = join(root, 'input'), outputDirectory = join(root, 'output')
const verifier = 'packages/delivery-assured/scripts/verify.mjs'
mkdirSync(join(inputDirectory, 'packages/delivery-assured/scripts'), { recursive: true })
mkdirSync(join(inputDirectory, 'project'))
mkdirSync(outputDirectory)
writeFileSync(join(inputDirectory, verifier), '// offline trusted verifier fixture; never executed\n')
writeFileSync(join(inputDirectory, 'project/source.txt'), 'candidate source unchanged\n')
const config = {
  runtimeImage: `docker.io/library/node@sha256:${'d'.repeat(64)}`,
  inputDirectory, outputDirectory,
  candidateRevision: 'a'.repeat(40), verifierRevision: 'b'.repeat(40), standardRevision: 'c'.repeat(40),
  runKey: '12345-1', sliceId: 'S1',
}
const deny = overrides => assert.throws(() => buildIsolationInvocation({ ...config, ...overrides }))
const sourceBefore = readFileSync(join(inputDirectory, 'project/source.txt'))
const verifierBefore = readFileSync(join(inputDirectory, verifier))

try {
  const originalSecret = process.env.DSH_ISOLATION_OFFLINE_SECRET
  let request
  try {
    process.env.DSH_ISOLATION_OFFLINE_SECRET = 'host-secret-must-not-inherit'
    request = buildIsolationInvocation(config)
    assert.ok(!JSON.stringify(request).includes('host-secret-must-not-inherit'))
    assert.deepEqual(request.options.env, {})
  } finally {
    if (originalSecret === undefined) delete process.env.DSH_ISOLATION_OFFLINE_SECRET
    else process.env.DSH_ISOLATION_OFFLINE_SECRET = originalSecret
  }
  assert.equal(request.kind, 'request_only')
  assert.equal(request.runtime_isolation_verified, false)
  assert.equal(request.promotion_permitted, false)
  assert.equal(request.command, 'docker')
  assert.deepEqual(request.options, { shell: false, env: {}, timeoutMs: 60_000 })
  assert.deepEqual(request.args, [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m',
    '--cpus', '1', '--user', '65532:65532', '--pull', 'never', '--platform', 'linux/amd64',
    '--mount', `type=bind,src=${inputDirectory},dst=/delivery/input,readonly`,
    '--mount', `type=bind,src=${outputDirectory},dst=/delivery/output`,
    '--env', `DSH_CANDIDATE_REVISION=${config.candidateRevision}`,
    '--env', `DSH_VERIFIER_REVISION=${config.verifierRevision}`,
    '--env', `DSH_STANDARD_REVISION=${config.standardRevision}`,
    '--env', 'DSH_CI_RUN_ID=12345-1', '--workdir', '/delivery/input',
    '--entrypoint', '/usr/local/bin/node', config.runtimeImage,
    `/delivery/input/${verifier}`, '--project', '/delivery/input/project', '--slice', 'S1',
    '--candidate', config.candidateRevision, '--ci-run-id', '12345-1', '--local', '--out-dir', '/delivery/output',
  ])
  assert.ok(Object.isFrozen(request) && Object.isFrozen(request.args) && Object.isFrozen(request.options.env))
  for (const token of ['--privileged', '--device', '--pid', '--ipc', '--uts', '--env-file', '--write-evidence', 'docker.sock']) assert.ok(!request.args.includes(token))
  for (const key of ['command', 'args', 'entrypoint', 'env', 'token', 'credentials', 'mounts', 'network', 'user', 'timeoutMs', 'project', 'runtime_isolation_verified']) deny({ [key]: 'injected' })
  const getter = { ...config }
  Object.defineProperty(getter, 'runtimeImage', { get() { throw new Error('getter must not run') } })
  assert.throws(() => buildIsolationInvocation(getter), /unsupported/)
  for (const runtimeImage of ['node:latest', 'node@sha256:abc', `user:secret@registry/node@sha256:${'d'.repeat(64)}`, `node:20@sha256:${'d'.repeat(64)}`, config.runtimeImage + '\n', '--privileged', 'sha256:' + 'd'.repeat(64)]) deny({ runtimeImage })
  for (const key of ['candidateRevision', 'verifierRevision', 'standardRevision']) {
    for (const value of ['A'.repeat(40), 'a'.repeat(39), 'main', 'a'.repeat(40) + '\n', '--privileged', 'a'.repeat(40) + '; echo secret']) deny({ [key]: value })
  }
  for (const runKey of ['0-1', '1-0', '01-1', '1-01', '9007199254740992-1', '12345-1\n', ' 12345-1', '12345-1;id', '12345', 12345]) deny({ runKey })
  for (const sliceId of ['S2', '--privileged', 'S1\n', '../S1', 'S1;id']) deny({ sliceId })
  for (const key of ['inputDirectory', 'outputDirectory']) {
    for (const value of ['relative', inputDirectory + ',dst=/var/run/docker.sock', inputDirectory + '\n', inputDirectory + '\0']) deny({ [key]: value })
  }
  deny({ outputDirectory: inputDirectory })
  deny({ outputDirectory: join(inputDirectory, 'project') })
  deny({ outputDirectory: root })
  deny({ inputDirectory: root })
  writeFileSync(join(outputDirectory, 'stale'), 'not empty')
  deny({})
  // Cleanup targets are fixed children of the verified fresh temporary root.
  rmSync(join(outputDirectory, 'stale'))
  const linkedFile = join(inputDirectory, 'project/hardlink')
  linkSync(join(inputDirectory, 'project/source.txt'), linkedFile)
  deny({})
  rmSync(linkedFile)
  const alias = join(root, 'alias')
  symlinkSync(inputDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  deny({ inputDirectory: alias })
  deny({ inputDirectory: join(alias, 'project') })
  const nestedLink = join(inputDirectory, 'project/linked-output')
  symlinkSync(outputDirectory, nestedLink, process.platform === 'win32' ? 'junction' : 'dir')
  deny({})
  rmSync(nestedLink)
  const outputAlias = join(root, 'output-alias')
  symlinkSync(outputDirectory, outputAlias, process.platform === 'win32' ? 'junction' : 'dir')
  deny({ outputDirectory: outputAlias })
  const emptyInput = join(root, 'empty-input')
  mkdirSync(emptyInput)
  deny({ inputDirectory: emptyInput })
  assert.equal((await runIsolatedCandidate(config)).code, 'executor_required')
  let calls = 0
  const good = await runIsolatedCandidate(config, { execute: async (invocation, { signal }) => {
    calls++
    assert.deepEqual(invocation, request)
    assert.equal(signal.aborted, false)
    return { exitCode: 0, runtime_isolation_verified: true, promotion_permitted: true, authority: 'Evidence', stdout: 'secret' }
  } })
  assert.equal(calls, 1)
  assert.deepEqual(good, { kind: 'diagnostic_only', status: 'completed', code: 'zero_exit_not_attestation', runtime_isolation_verified: false, promotion_permitted: false })
  assert.equal((await runIsolatedCandidate({ ...config, env: { TOKEN: 'secret' } }, { execute: () => { calls++; throw new Error('must not execute') } })).code, 'invalid_request')
  assert.equal(calls, 1)
  for (const [result, status, code] of [
    [{ exitCode: 1 }, 'failed', 'nonzero_exit'], [{ exitCode: 255 }, 'failed', 'nonzero_exit'],
    [undefined, 'unknown', 'malformed_exit'], [{}, 'unknown', 'malformed_exit'],
    [{ exitCode: '0' }, 'unknown', 'malformed_exit'], [{ exitCode: NaN }, 'unknown', 'malformed_exit'],
    [{ exitCode: -1 }, 'unknown', 'malformed_exit'], [{ exitCode: 256 }, 'unknown', 'malformed_exit'],
    [{ exitCode: 0.5 }, 'unknown', 'malformed_exit'], [{ exitCode: 0, timedOut: true }, 'unknown', 'execution_interrupted'],
    [{ exitCode: 0, signal: 'SIGKILL' }, 'unknown', 'execution_interrupted'],
  ]) {
    const report = await runIsolatedCandidate(config, { execute: async () => result })
    assert.equal(report.status, status)
    assert.equal(report.code, code)
    assert.equal(report.runtime_isolation_verified, false)
    assert.equal(report.promotion_permitted, false)
  }
  for (const execute of [() => { throw new Error('TOKEN=secret') }, async () => { throw new Error('timeout') }, () => ({ get exitCode() { throw new Error('secret') } })]) {
    const report = await runIsolatedCandidate(config, { execute })
    assert.equal(report.code, 'executor_error')
    assert.ok(!JSON.stringify(report).includes('secret'))
  }
  mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const pending = runIsolatedCandidate(config, { execute: async (_invocation, options) => { signal = options.signal; return new Promise(() => {}) } })
  await Promise.resolve()
  mock.timers.tick(60_000)
  const timedOut = await pending
  assert.equal(timedOut.code, 'execution_timeout')
  assert.equal(signal.aborted, true)
  assert.equal(timedOut.runtime_isolation_verified, false)
  mock.timers.reset()
  assert.deepEqual(readFileSync(join(inputDirectory, 'project/source.txt')), sourceBefore)
  assert.deepEqual(readFileSync(join(inputDirectory, verifier)), verifierBefore)
  assert.deepEqual(readdirSync(outputDirectory), [])
  console.log('ci-isolation.test ok: offline restrictions, injection/path refusals, timeout/error handling; zero exit is not attestation; staged source unchanged')
} finally {
  mock.timers.reset()
  // root is the absolute mkdtemp result created above, never a config-derived path.
  assert.equal(resolve(root), root)
  assert.ok(root.startsWith(join(tmpdir(), 'ci-isolation-offline-')))
  rmSync(root, { recursive: true, force: true })
}
