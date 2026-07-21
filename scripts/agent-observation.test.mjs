import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { hashPathIdentity, enumerateSessionFiles } from './agent-observation.mjs'

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

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true })
}

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
  expect(statSync(cohort).mode & 0o777).toBe(0o700)
  for (const name of ['metadata.json', 'baseline.json', 'incidents.tsv']) {
    expect(statSync(join(cohort, name)).mode & 0o777).toBe(0o600)
  }
  const metadata = JSON.parse(readFileSync(join(cohort, 'metadata.json'), 'utf8'))
  const baseline = JSON.parse(readFileSync(join(cohort, 'baseline.json'), 'utf8'))
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
  expect(overwrite.stderr).toContain('cohort already exists')
  expect(overwrite.stderr).not.toContain(fixture.root)

  writeFileSync(join(fixture.root, 'tracked.txt'), 'dirty\n')
  const dirty = run(...args({ ...fixture, state: join(fixture.root, 'other-state') }, 'start'))
  expect(dirty.status).toBe(1)
  expect(dirty.stderr).toContain('repository worktree must be clean')
  expect(dirty.stderr).not.toContain('tracked.txt')
  cleanup(fixture)
})

test('baseline excludes an active file even when it changes, while new files are aggregate-only', () => {
  const fixture = fixtureRepo()
  const active = join(fixture.sessions, 'active.jsonl')
  session(active)
  expect(run(...args(fixture, 'start')).status).toBe(0)
  writeFileSync(active, 'PRIVATE_ACTIVE_CONTENT\n')
  const fresh = join(fixture.sessions, 'fresh.jsonl')
  session(fresh)
  writeFileSync(join(fixture.sessions, 'notes.txt'), 'PRIVATE_NON_JSONL\n')
  const report = run(...args(fixture, 'report'))
  expect(report.status).toBe(0)
  expect(report.stdout).toContain('Agent usage report')
  expect(report.stdout).toContain('aggregate summary: files=1 invocations=1')
  for (const secret of ['PRIVATE_ACTIVE_CONTENT', 'PRIVATE_NON_JSONL', 'active.jsonl', 'fresh.jsonl', fixture.root]) {
    expect(report.stdout).not.toContain(secret)
  }
  const persistedPath = join(fixture.state, fixture.shortHead, 'latest-report.json')
  const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'))
  expect(persisted.aggregate.totals.invocations).toBe(1)
  const persistedText = readFileSync(persistedPath, 'utf8')
  expect(persistedText).not.toContain('PRIVATE_ACTIVE_CONTENT')
  expect(persistedText).not.toContain(fixture.root)
  expect(statSync(persistedPath).mode & 0o777).toBe(0o600)

  const noNew = run(...args(fixture, 'report'))
  expect(noNew.status).toBe(0)
  expect(noNew.stdout).toContain('No new session files observed')
  expect(noNew.stdout).not.toContain(fixture.root)
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
  for (const note of ['line\nbreak', 'A'.repeat(241), 'API_KEY=do-not-store']) {
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
