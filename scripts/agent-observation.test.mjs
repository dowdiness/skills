import { expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ACTIVE_POINTER_FILE, PENDING_FINISH_FILE, hashPathIdentity, enumerateSessionFiles, helpText, readPrivateText, readSessionFile } from './agent-observation.mjs'
import { MAX_FILE_BYTES } from './agent-usage-report.mjs'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const script = resolve(repositoryRoot, 'scripts/agent-observation.mjs')

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'agent-observation-repo-'))
  const sessions = join(root, 'sessions')
  const state = join(root, 'private-state')
  mkdirSync(sessions)
  mkdirSync(state)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Observation Test')
  writeFileSync(join(root, '.gitignore'), 'sessions/\nprivate-state/\n')
  writeFileSync(join(root, 'tracked.txt'), 'clean\n')
  git(root, 'add', '.gitignore', 'tracked.txt')
  git(root, 'commit', '-qm', 'fixture')
  return { root, sessions, state, shortHead: git(root, 'rev-parse', '--short=12', 'HEAD') }
}

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repositoryRoot, encoding: 'utf8' })
}

function args(fixture, command, extra = []) {
  return [command, '--repo-dir', fixture.root, '--sessions-dir', fixture.sessions, '--state-root', fixture.state, ...extra]
}

function session(path, agent = 'worker') {
  writeFileSync(path, JSON.stringify({ message: { toolName: 'subagent', details: { results: [{ agent, exitCode: 0 }] } } }) + '\n')
}

function pendingFinish(fixture, finishedAt) {
  const pointer = JSON.parse(readFileSync(join(fixture.state, ACTIVE_POINTER_FILE), 'utf8'))
  writeFileSync(join(fixture.state, PENDING_FINISH_FILE), `${JSON.stringify({ ...pointer, finishedAt }, null, 2)}\n`, { mode: 0o600 })
}

function sessionWithModel(path, model, agent = 'worker') {
  writeFileSync(path, [
    { content: [{ type: 'toolCall', name: 'subagent', id: 'call-1', arguments: { agent } }] },
    { message: { toolName: 'subagent', toolCallId: 'call-1', details: { results: [{ agent, model, exitCode: 0 }] } } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n')
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true })
}

test('help documents the active cohort finish lifecycle', () => {
  expect(helpText()).toContain('<start|report|incident|status|finish>')
  expect(helpText()).toContain('finish records a UTC finish time')
  expect(helpText()).toContain('interrupted finish resumes safely on retry')
  expect(helpText()).toContain('cohort finishing')
  expect(helpText()).toContain('exclusive state-root-local lock')
  expect(helpText()).toContain('snapshots the sorted packaged agent names')
})

test('start is private, content-free, mode-safe, and refuses overwrite or dirty repositories', () => {
  const fixture = fixtureRepo()
  const active = join(fixture.sessions, 'active.jsonl')
  const nonJsonl = join(fixture.sessions, 'private.txt')
  const linkTarget = join(fixture.sessions, 'target.jsonl')
  const link = join(fixture.sessions, 'link.jsonl')
  session(active)
  writeFileSync(nonJsonl, 'DO_NOT_COPY_THIS_SECRET')
  session(linkTarget)
  try { symlinkSync(linkTarget, link) } catch (error) { if (error?.code !== 'EPERM') throw error }
  chmodSync(active, 0o000)
  const started = run(...args(fixture, 'start'))
  chmodSync(active, 0o600)
  expect(started.status).toBe(0)
  expect(started.stdout).not.toContain(fixture.root)
  expect(started.stdout).not.toContain('active.jsonl')
  const cohort = join(fixture.state, fixture.shortHead)
  expect(statSync(fixture.state).mode & 0o777).toBe(0o700)
  expect(statSync(cohort).mode & 0o777).toBe(0o700)
  expect(statSync(join(fixture.state, ACTIVE_POINTER_FILE)).mode & 0o777).toBe(0o600)
  for (const name of ['metadata.json', 'baseline.json', 'incidents.tsv']) {
    expect(statSync(join(cohort, name)).mode & 0o777).toBe(0o600)
  }
  const metadata = JSON.parse(readFileSync(join(cohort, 'metadata.json'), 'utf8'))
  const baseline = JSON.parse(readFileSync(join(cohort, 'baseline.json'), 'utf8'))
  const pointer = JSON.parse(readFileSync(join(fixture.state, ACTIVE_POINTER_FILE), 'utf8'))
  expect(pointer).toEqual({ schemaVersion: 1, commit: metadata.commit, shortHead: fixture.shortHead })
  expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(metadata.startedAt).toMatch(/Z$/)
  expect(baseline.identities).toEqual([
    hashPathIdentity(active),
    hashPathIdentity(linkTarget),
  ].sort())
  const baselineText = readFileSync(join(cohort, 'baseline.json'), 'utf8')
  expect(baselineText).not.toContain('active.jsonl')
  expect(baselineText).not.toContain('DO_NOT_COPY_THIS_SECRET')

  const overwrite = run(...args(fixture, 'start'))
  expect(overwrite.status).toBe(1)
  expect(overwrite.stderr).toContain('active cohort exists')
  expect(overwrite.stderr).not.toContain(fixture.root)

  writeFileSync(join(fixture.root, 'tracked.txt'), 'dirty\n')
  const dirty = run(...args({ ...fixture, state: join(fixture.root, 'other-state') }, 'start'))
  expect(dirty.status).toBe(1)
  expect(dirty.stderr).toContain('repository worktree must be clean')
  expect(dirty.stderr).not.toContain('tracked.txt')
  cleanup(fixture)
})

test('baseline stays immutable and reports are cumulative for current cohort-created files', () => {
  const fixture = fixtureRepo()
  const active = join(fixture.sessions, 'active.jsonl')
  session(active)
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const cohort = join(fixture.state, fixture.shortHead)
  const originalBaseline = readFileSync(join(cohort, 'baseline.json'), 'utf8')

  const noNew = run(...args(fixture, 'report'))
  expect(noNew.status).toBe(0)
  expect(noNew.stdout).toContain('No new session files observed')
  expect(run(...args(fixture, 'status')).stdout).toContain('new session files=0')

  writeFileSync(active, 'PRIVATE_ACTIVE_CONTENT\n')
  const first = join(fixture.sessions, 'fresh.jsonl')
  session(first)
  writeFileSync(join(fixture.sessions, 'notes.txt'), 'PRIVATE_NON_JSONL\n')
  const firstReport = run(...args(fixture, 'report'))
  expect(firstReport.status).toBe(0)
  expect(firstReport.stdout).toContain('aggregate summary: sessions=1 invocations=1')
  expect(firstReport.stdout).not.toContain(fixture.root)
  expect(run(...args(fixture, 'status')).stdout).toContain('new session files=1')

  const rerun = run(...args(fixture, 'report'))
  expect(rerun.status).toBe(0)
  expect(rerun.stdout).not.toContain('No new session files observed')
  expect(rerun.stdout).toContain('aggregate summary: sessions=1 invocations=1')

  const second = join(fixture.sessions, 'second.jsonl')
  session(second)
  const secondReport = run(...args(fixture, 'report'))
  expect(secondReport.status).toBe(0)
  expect(secondReport.stdout).toContain('aggregate summary: sessions=2 invocations=2')
  expect(run(...args(fixture, 'status')).stdout).toContain('new session files=2')

  expect(readFileSync(join(cohort, 'baseline.json'), 'utf8')).toBe(originalBaseline)
  const persistedPath = join(cohort, 'latest-report.json')
  const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'))
  expect(persisted.fileCount).toBe(2)
  expect(persisted.aggregate.totals.invocations).toBe(2)
  expect(readFileSync(persistedPath, 'utf8')).not.toContain('PRIVATE_ACTIVE_CONTENT')
  expect(statSync(persistedPath).mode & 0o777).toBe(0o600)
  cleanup(fixture)
})

test('CLI report and status prefer the automation aggregate while legacy remains available before activation', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const created = join(fixture.sessions, 'created.jsonl')
  session(created)
  expect(run(...args(fixture, 'report')).status).toBe(0)
  const cohort = join(fixture.state, fixture.shortHead)
  const legacy = JSON.parse(readFileSync(join(cohort, 'latest-report.json'), 'utf8'))
  writeFileSync(join(cohort, 'automation-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    commit: JSON.parse(readFileSync(join(fixture.state, ACTIVE_POINTER_FILE), 'utf8')).commit,
    updatedAt: '2026-01-01T00:00:00.000Z',
    aggregate: legacy.aggregate,
    sessions: { ['a'.repeat(64)]: ['b'.repeat(64)] },
  }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(join(cohort, 'automation-state.json'), 0o600)
  const report = run(...args(fixture, 'report'))
  expect(report.status).toBe(0)
  expect(report.stdout).toContain('aggregate summary: sessions=1 invocations=1')
  expect(report.stdout).not.toContain(fixture.root)
  const status = run(...args(fixture, 'status'))
  expect(status.status).toBe(0)
  expect(status.stdout).toContain('automation observed sessions=1 entries=1')
  expect(status.stdout).toContain('latest aggregate: invocations=1')
  expect(status.stdout).not.toContain('new session files=')
  expect(run(...args(fixture, 'finish')).status).toBe(0)
  cleanup(fixture)
})

test('an existing operation lock blocks mutation and leaves the active pointer and cohort intact', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const pointerPath = join(fixture.state, ACTIVE_POINTER_FILE)
  const cohort = join(fixture.state, fixture.shortHead)
  const pointerBefore = readFileSync(pointerPath, 'utf8')
  const metadataBefore = readFileSync(join(cohort, 'metadata.json'), 'utf8')
  writeFileSync(join(fixture.state, '.operation.lock'), 'another live operation')
  const blocked = run(...args(fixture, 'finish'))
  expect(blocked.status).toBe(1)
  expect(blocked.stderr).toContain('observation operation already in progress')
  expect(readFileSync(pointerPath, 'utf8')).toBe(pointerBefore)
  expect(readFileSync(join(cohort, 'metadata.json'), 'utf8')).toBe(metadataBefore)
  rmSync(join(fixture.state, '.operation.lock'))
  expect(run(...args(fixture, 'finish')).status).toBe(0)
  cleanup(fixture)
})

test('stale aggregate state is cleared when cohort-created files are removed', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const created = join(fixture.sessions, 'created.jsonl')
  session(created)
  expect(run(...args(fixture, 'report')).status).toBe(0)
  const reportPath = join(fixture.state, fixture.shortHead, 'latest-report.json')
  expect(statSync(reportPath).isFile()).toBe(true)
  rmSync(created)
  const status = run(...args(fixture, 'status'))
  expect(status.status).toBe(0)
  expect(status.stdout).toContain('new session files=0')
  expect(status.stdout).toContain('latest aggregate: none')
  expect(() => statSync(reportPath)).toThrow()
  cleanup(fixture)
})

test('legacy report symlinks are rejected for clear/read and atomically replaced for updates', () => {
  for (const broken of [false, true]) {
    const clearFixture = fixtureRepo()
    expect(run(...args(clearFixture, 'start')).status).toBe(0)
    const created = join(clearFixture.sessions, 'created.jsonl')
    session(created)
    expect(run(...args(clearFixture, 'report')).status).toBe(0)
    rmSync(created)
    const clearReport = join(clearFixture.state, clearFixture.shortHead, 'latest-report.json')
    rmSync(clearReport)
    const clearTarget = join(clearFixture.root, broken ? 'missing-clear-target' : 'clear-target')
    if (!broken) writeFileSync(clearTarget, 'clear target content\n')
    try { symlinkSync(clearTarget, clearReport) } catch (error) {
      if (error?.code === 'EPERM') { cleanup(clearFixture); continue }
      throw error
    }
    const clearResult = run(...args(clearFixture, 'report'))
    expect(clearResult.status).toBe(1)
    expect(clearResult.stderr).toContain('invalid aggregate report')
    expect(lstatSync(clearReport).isSymbolicLink()).toBe(true)
    expect(readlinkSync(clearReport)).toBe(clearTarget)
    if (broken) expect(() => lstatSync(clearTarget)).toThrow()
    else expect(readFileSync(clearTarget, 'utf8')).toBe('clear target content\n')
    cleanup(clearFixture)

    const writeFixture = fixtureRepo()
    expect(run(...args(writeFixture, 'start')).status).toBe(0)
    session(join(writeFixture.sessions, 'created.jsonl'))
    const writeReport = join(writeFixture.state, writeFixture.shortHead, 'latest-report.json')
    const writeTarget = join(writeFixture.root, broken ? 'missing-write-target' : 'write-target')
    if (!broken) writeFileSync(writeTarget, 'write target content\n')
    try { symlinkSync(writeTarget, writeReport) } catch (error) {
      if (error?.code === 'EPERM') { cleanup(writeFixture); continue }
      throw error
    }
    const writeResult = run(...args(writeFixture, 'report'))
    expect(writeResult.status).toBe(0)
    expect(lstatSync(writeReport).isFile()).toBe(true)
    expect(lstatSync(writeReport).isSymbolicLink()).toBe(false)
    if (broken) expect(() => lstatSync(writeTarget)).toThrow()
    else expect(readFileSync(writeTarget, 'utf8')).toBe('write target content\n')
    cleanup(writeFixture)

    const readFixture = fixtureRepo()
    expect(run(...args(readFixture, 'start')).status).toBe(0)
    session(join(readFixture.sessions, 'created.jsonl'))
    expect(run(...args(readFixture, 'report')).status).toBe(0)
    const readReport = join(readFixture.state, readFixture.shortHead, 'latest-report.json')
    const readTarget = join(readFixture.root, broken ? 'missing-read-target' : 'read-target')
    if (!broken) writeFileSync(readTarget, 'read target content\n')
    rmSync(readReport)
    try { symlinkSync(readTarget, readReport) } catch (error) {
      if (error?.code === 'EPERM') { cleanup(readFixture); continue }
      throw error
    }
    const readResult = run(...args(readFixture, 'status'))
    expect(readResult.status).toBe(1)
    expect(readResult.stderr).toContain('invalid aggregate report')
    expect(lstatSync(readReport).isSymbolicLink()).toBe(true)
    expect(readlinkSync(readReport)).toBe(readTarget)
    if (broken) expect(() => lstatSync(readTarget)).toThrow()
    else expect(readFileSync(readTarget, 'utf8')).toBe('read target content\n')
    cleanup(readFixture)
  }
})

test('start snapshots agent names and model IDs for later validation and aggregation', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const cohort = join(fixture.state, fixture.shortHead)
  const metadata = JSON.parse(readFileSync(join(cohort, 'metadata.json'), 'utf8'))
  expect(metadata.agentNames).toEqual([...metadata.agentNames].sort())
  expect(metadata.modelIds).toEqual([...metadata.modelIds].sort())
  expect(metadata.agentNames).toContain('worker')
  const snapshotModel = metadata.modelIds[0]
  const accepted = run(...args(fixture, 'incident', ['--agent', 'worker', '--category', 'good_assumption', '--severity', 'low', '--note', '日本語の短いメモ']))
  expect(accepted.status).toBe(0)
  const rejected = run(...args(fixture, 'incident', ['--agent', 'new-agent-from-current-checkout', '--category', 'rework', '--severity', 'low', '--note', 'short note']))
  expect(rejected.status).toBe(1)
  expect(rejected.stderr).toContain('invalid incident agent')
  sessionWithModel(join(fixture.sessions, 'snapshot.jsonl'), snapshotModel)
  sessionWithModel(join(fixture.sessions, 'drift.jsonl'), 'model-that-was-not-snapshotted')
  const report = run(...args(fixture, 'report'))
  expect(report.status).toBe(0)
  expect(report.stdout).toContain('aggregate summary: sessions=2 invocations=2')
  const persisted = JSON.parse(readFileSync(join(cohort, 'latest-report.json'), 'utf8')).aggregate
  const worker = persisted.agents.find((agent) => agent.agent === 'worker')
  expect(worker.models).toEqual([snapshotModel])
  expect(persisted.unknownRecords).toBeGreaterThan(0)
  cleanup(fixture)
})

test('finish records metadata, removes activation, and prevents same-commit overwrite', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const finish = run(...args(fixture, 'finish'))
  expect(finish.status).toBe(0)
  expect(finish.stdout).toMatch(/^finished cohort commit=[0-9a-f]{40} shortHead=[0-9a-f]{12} started=.* finished=.*\n$/)
  expect(finish.stdout).not.toContain(fixture.root)
  expect(() => statSync(join(fixture.state, ACTIVE_POINTER_FILE))).toThrow()
  const metadata = JSON.parse(readFileSync(join(fixture.state, fixture.shortHead, 'metadata.json'), 'utf8'))
  expect(metadata.finishedAt).toMatch(/Z$/)

  for (const command of ['status', 'report', 'incident']) {
    const result = run(...args(fixture, command, command === 'incident'
      ? ['--agent', 'worker', '--category', 'rework', '--severity', 'low', '--note', 'not recorded']
      : []))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cohort not found')
    expect(result.stderr).not.toContain(fixture.root)
  }
  const sameCommit = run(...args(fixture, 'start'))
  expect(sameCommit.status).toBe(1)
  expect(sameCommit.stderr).toContain('cohort already exists')
  cleanup(fixture)
})

test('finish retries recover with the old active pointer and blocks other operations', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const finishedAt = '2099-01-02T03:04:05.678Z'
  pendingFinish(fixture, finishedAt)
  expect(statSync(join(fixture.state, PENDING_FINISH_FILE)).mode & 0o777).toBe(0o600)

  for (const command of ['start', 'report', 'status', 'incident']) {
    const result = run(...args(fixture, command, command === 'incident'
      ? ['--agent', 'worker', '--category', 'rework', '--severity', 'low', '--note', 'blocked while finishing']
      : []))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cohort finishing')
    expect(result.stderr).not.toContain(fixture.root)
  }

  expect(run(...args(fixture, 'finish')).status).toBe(0)
  const metadata = JSON.parse(readFileSync(join(fixture.state, fixture.shortHead, 'metadata.json'), 'utf8'))
  expect(metadata.finishedAt).toBe(finishedAt)
  expect(() => statSync(join(fixture.state, ACTIVE_POINTER_FILE))).toThrow()
  expect(() => statSync(join(fixture.state, PENDING_FINISH_FILE))).toThrow()
  cleanup(fixture)
})

test('finish retries recover after the matching active pointer was already removed', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const finishedAt = '2099-02-03T04:05:06.789Z'
  pendingFinish(fixture, finishedAt)
  unlinkSync(join(fixture.state, ACTIVE_POINTER_FILE))

  for (const command of ['start', 'report', 'status', 'incident']) {
    const result = run(...args(fixture, command, command === 'incident'
      ? ['--agent', 'worker', '--category', 'rework', '--severity', 'low', '--note', 'blocked while finishing']
      : []))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cohort finishing')
  }

  expect(run(...args(fixture, 'finish')).status).toBe(0)
  const metadata = JSON.parse(readFileSync(join(fixture.state, fixture.shortHead, 'metadata.json'), 'utf8'))
  expect(metadata.finishedAt).toBe(finishedAt)
  expect(() => statSync(join(fixture.state, ACTIVE_POINTER_FILE))).toThrow()
  expect(() => statSync(join(fixture.state, PENDING_FINISH_FILE))).toThrow()
  cleanup(fixture)
})

test('active cohort follows its pointer across a clean commit drift', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const originalCommit = git(fixture.root, 'rev-parse', 'HEAD')
  writeFileSync(join(fixture.root, 'tracked.txt'), 'second clean commit\n')
  git(fixture.root, 'add', 'tracked.txt')
  git(fixture.root, 'commit', '-qm', 'fixture drift')
  expect(git(fixture.root, 'rev-parse', 'HEAD')).not.toBe(originalCommit)

  const incident = run(...args(fixture, 'incident', ['--agent', 'worker', '--category', 'good_assumption', '--severity', 'low', '--note', 'clean drift retained cohort']))
  expect(incident.status).toBe(0)
  session(join(fixture.sessions, 'after-drift.jsonl'))
  const report = run(...args(fixture, 'report'))
  expect(report.status).toBe(0)
  expect(report.stdout).toContain('aggregate summary: sessions=1 invocations=1')
  const status = run(...args(fixture, 'status'))
  expect(status.status).toBe(0)
  expect(status.stdout).toContain(`cohort commit=${originalCommit}`)
  expect(status.stdout).not.toContain(git(fixture.root, 'rev-parse', 'HEAD'))
  expect(status.stdout).toContain('good_assumption=1')
  expect(run(...args(fixture, 'finish')).status).toBe(0)
  cleanup(fixture)
})

test('shared private JSON reader rejects static symlinks and does not expose target content', () => {
  const fixture = fixtureRepo()
  const target = join(fixture.root, 'private-target.json')
  const link = join(fixture.state, 'private-link.json')
  writeFileSync(target, 'TARGET_SECRET_CONTENT', { mode: 0o600 })
  symlinkSync(target, link)
  expect(() => readPrivateText(link)).toThrow('invalid private state')
  expect(readFileSync(target, 'utf8')).toBe('TARGET_SECRET_CONTENT')
  expect(readlinkSync(link)).toBe(target)
  cleanup(fixture)
})

test('state readers have no pathname read after an lstat precheck', () => {
  const coreSource = readFileSync(join(repositoryRoot, 'extensions/agent-observation/core.ts'), 'utf8')
  const scriptSource = readFileSync(script, 'utf8')
  expect(coreSource).not.toContain('readFileSync(')
  expect(scriptSource).not.toContain('readFileSync(')
})

test('session reads tiny and zero-length files without changing their contents', () => {
  const fixture = fixtureRepo()
  const tiny = join(fixture.sessions, 'tiny.jsonl')
  const empty = join(fixture.sessions, 'empty.jsonl')
  writeFileSync(tiny, '{"tiny":true}\n')
  writeFileSync(empty, '')
  expect(readSessionFile(tiny)).toBe('{"tiny":true}\n')
  expect(readSessionFile(empty)).toBe('')
  cleanup(fixture)
})

test('session reads reject symlinks and enforce the bounded descriptor read', () => {
  const fixture = fixtureRepo()
  const target = join(fixture.sessions, 'target.jsonl')
  const link = join(fixture.sessions, 'linked.jsonl')
  writeFileSync(target, 'private target content\n')
  try {
    symlinkSync(target, link)
    expect(() => readSessionFile(link)).toThrow('session file changed during read')
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }
  const oversized = join(fixture.sessions, 'oversized.jsonl')
  writeFileSync(oversized, '')
  truncateSync(oversized, MAX_FILE_BYTES + 1)
  expect(() => readSessionFile(oversized)).toThrow('session file size limit exceeded')
  cleanup(fixture)
})

test('symlinks and non-JSONL files are ignored during session enumeration', () => {
  const fixture = fixtureRepo()
  const regular = join(fixture.sessions, 'regular.jsonl')
  const target = join(fixture.sessions, 'target.jsonl')
  session(regular)
  session(target)
  writeFileSync(join(fixture.sessions, 'config.toml'), 'SECRET_CONFIG=1')
  try { symlinkSync(target, join(fixture.sessions, 'linked.jsonl')) } catch (error) { if (error?.code !== 'EPERM') throw error }
  const files = enumerateSessionFiles(fixture.sessions)
  expect(files).toEqual([regular, target].sort())
  cleanup(fixture)
})

test('incident validation and status expose only bounded aggregates', () => {
  const fixture = fixtureRepo()
  expect(run(...args(fixture, 'start')).status).toBe(0)
  const valid = run(...args(fixture, 'incident', ['--agent', 'worker', '--category', 'wrong_route', '--severity', 'low', '--note', 'selected the wrong route']))
  expect(valid.status).toBe(0)
  expect(valid.stdout).toMatch(/^recorded incident case-[a-f0-9]{18}\n$/)
  const invalidIncidents = [
    ['--agent', 'worker', '--category', 'not-a-category', '--severity', 'medium', '--note', 'short note'],
    ['--agent', 'worker', '--category', 'rework', '--severity', 'critical', '--note', 'short note'],
    ['--agent', 'not-packaged', '--category', 'rework', '--severity', 'medium', '--note', 'short note'],
  ]
  for (const incidentArgs of invalidIncidents) {
    const invalid = run(...args(fixture, 'incident', incidentArgs))
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('invalid incident')
    expect(invalid.stderr).not.toContain('not-packaged')
    expect(invalid.stderr).not.toContain('not-a-category')
    expect(invalid.stderr).not.toContain('critical')
  }
  for (const note of [
    'line\nbreak',
    'A'.repeat(241),
    'API_KEY=do-not-store',
    'contact test@example.com',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue123',
    'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AWS AKIAIOSFODNN7EXAMPLE',
    'Google AIzaSyA123456789012345678901234567890',
  ]) {
    const invalid = run(...args(fixture, 'incident', ['--agent', 'worker', '--category', 'rework', '--severity', 'medium', '--note', note]))
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('invalid incident note')
    expect(invalid.stderr).not.toContain('API_KEY')
  }
  const status = run(...args(fixture, 'status'))
  expect(status.status).toBe(0)
  expect(status.stdout).toContain(`cohort commit=${git(fixture.root, 'rev-parse', 'HEAD')}`)
  expect(status.stdout).toContain('new session files=0')
  expect(status.stdout).toContain('latest aggregate: none')
  expect(status.stdout).toContain('wrong_route=1')
  expect(status.stdout).not.toContain('selected the wrong route')
  expect(status.stdout).not.toContain(fixture.root)
  const incidentText = readFileSync(join(fixture.state, fixture.shortHead, 'incidents.tsv'), 'utf8')
  expect(incidentText).toContain('\tworker\twrong_route\tlow\tselected the wrong route\n')
  expect(incidentText).not.toContain('task')
  expect(statSync(join(fixture.state, fixture.shortHead, 'incidents.tsv')).mode & 0o777).toBe(0o600)
  cleanup(fixture)
})
