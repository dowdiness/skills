#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  fstatSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readAgentPromptFiles } from './agent-prompt-contracts.mjs'
import { validateIncident as validateIncidentShared } from './agent-observation-validation.mjs'
import {
  aggregateSessionLines,
  formatReport,
  mergeUsageReports,
  MAX_FILE_BYTES,
  MAX_INPUT_FILES,
  MAX_RECURSION_DEPTH,
} from './agent-usage-report.mjs'
import { MAX_PRIVATE_STATE_BYTES, readPrivateState, validatePersistedAggregate } from '../extensions/agent-observation/core.ts'
import { collectConfiguredAgentModelIds, normalizeModelId } from './validate-agent-models.mjs'

export const SCHEMA_VERSION = 1
export const INCIDENT_CATEGORIES = Object.freeze([
  'false_clarification',
  'false_stop',
  'unsafe_proceed',
  'wrong_route',
  'false_complete',
  'rework',
  'good_assumption',
])
export const INCIDENT_SEVERITIES = Object.freeze(['low', 'medium', 'high'])
export const MAX_NOTE_LENGTH = 240
export const BASELINE_FILE = 'baseline.json'
export const METADATA_FILE = 'metadata.json'
export const REPORT_FILE = 'latest-report.json'
export const AUTOMATION_STATE_FILE = 'automation-state.json'
export const AUTOMATION_KEY_FILE = 'automation-key'
export const INCIDENT_FILE = 'incidents.tsv'
export const ACTIVE_POINTER_FILE = 'active-cohort.json'
export const PENDING_FINISH_FILE = '.pending-finish.json'

const CATEGORY_SET = new Set(INCIDENT_CATEGORIES)
const SEVERITY_SET = new Set(INCIDENT_SEVERITIES)
const SAFE_CASE_ID_PATTERN = /^case-[a-f0-9]{18}$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+@:-]{0,199}$/
const STATE_LOCK_FILE = '.operation.lock'
const STATE_LOCK_ERROR = 'observation operation already in progress'
const MISSING_PRIVATE_JSON = Symbol('missing private JSON')

function defaultStateRoot() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'skills-agent-observation')
}

function defaultSessionsDir() {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

export function normalizeAbsolutePath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('invalid path')
  return normalize(resolve(path))
}

export function hashPathIdentity(path) {
  return createHash('sha256').update(normalizeAbsolutePath(path), 'utf8').digest('hex')
}

function withStateLock(stateRoot, operation) {
  const root = normalizeAbsolutePath(stateRoot)
  privateDirectory(root)
  const lockPath = join(root, STATE_LOCK_FILE)
  let fd
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') throw new Error(STATE_LOCK_ERROR)
    throw new Error('could not lock observation state')
  }
  try {
    return operation()
  } finally {
    try {
      const lockInfo = lstatSync(lockPath)
      const ownerInfo = fstatSync(fd)
      if (lockInfo.isFile() && lockInfo.dev === ownerInfo.dev && lockInfo.ino === ownerInfo.ino) unlinkSync(lockPath)
    } catch {}
    closeSync(fd)
  }
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

function privateFile(path, content, { exclusive = false } = {}) {
  const flags = exclusive ? 'wx' : 'w'
  const fd = openSync(path, flags, 0o600)
  try {
    writeFileSync(fd, content)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, 0o600)
}

function privateAppend(path, content) {
  appendFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function safeLstat(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error('could not inspect sessions')
  }
}

/** Enumerate regular JSONL files without following symlinks or reading content. */
export function enumerateSessionFiles(sessionsDir, limits = {}) {
  const root = normalizeAbsolutePath(sessionsDir)
  const maxFiles = limits.maxFiles ?? MAX_INPUT_FILES
  const maxDepth = limits.maxDepth ?? MAX_RECURSION_DEPTH
  const maxBytesPerFile = limits.maxBytesPerFile ?? MAX_FILE_BYTES
  const rootInfo = safeLstat(root)
  if (!rootInfo) return []
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('invalid sessions directory')

  const files = []
  const visit = (path, depth) => {
    const info = safeLstat(path)
    if (!info || info.isSymbolicLink()) return
    if (info.isFile()) {
      if (!path.endsWith('.jsonl')) return
      if (info.size > maxBytesPerFile) throw new Error('session file size limit exceeded')
      if (files.length >= maxFiles) throw new Error('session file count limit exceeded')
      files.push(path)
      return
    }
    if (!info.isDirectory()) return
    if (depth > maxDepth) throw new Error('session directory depth limit exceeded')
    let entries
    try {
      entries = readdirSync(path).sort()
    } catch {
      throw new Error('could not inspect sessions')
    }
    for (const entry of entries) visit(join(path, entry), depth + 1)
  }
  visit(root, 0)
  return files
}

export function readSessionFile(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(fd)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('session file changed during read')
    if (before.size > MAX_FILE_BYTES) throw new Error('session file size limit exceeded')

    const buffer = Buffer.alloc(before.size)
    let total = 0
    while (total < before.size) {
      const count = readSync(fd, buffer, total, before.size - total, null)
      if (count === 0) break
      total += count
    }
    const extra = Buffer.alloc(1)
    const extraCount = readSync(fd, extra, 0, 1, null)
    const after = fstatSync(fd)
    if (!after.isFile() || after.isSymbolicLink()) throw new Error('session file changed during read')
    if (after.size > MAX_FILE_BYTES || total + extraCount > MAX_FILE_BYTES) throw new Error('session file size limit exceeded')
    if (after.size !== before.size || total !== after.size || extraCount !== 0) throw new Error('session file changed during read')
    return buffer.subarray(0, total).toString('utf8')
  } catch (error) {
    if (error?.message === 'session file size limit exceeded' || error?.message === 'session file changed during read') throw error
    if (error?.code === 'ELOOP') throw new Error('session file changed during read')
    throw new Error('could not read session file')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function selectNewSessionFiles(files, baselineHashes) {
  const baseline = baselineHashes instanceof Set ? baselineHashes : new Set(baselineHashes)
  return files.filter((file) => !baseline.has(hashPathIdentity(file)))
}

function gitOutput(repoDir, args) {
  try {
    return execFileSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error('could not inspect repository')
  }
}

export function repositoryState(repoDir) {
  const root = normalizeAbsolutePath(repoDir)
  const commit = gitOutput(root, ['rev-parse', '--verify', 'HEAD'])
  const dirty = gitOutput(root, ['status', '--porcelain', '--untracked-files=all'])
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('could not inspect repository')
  if (dirty !== '') throw new Error('repository worktree must be clean')
  return { repoDir: root, commit, shortHead: commit.slice(0, 12) }
}

function cohortDirectory(stateRoot, shortHead) {
  if (!/^[0-9a-f]{12}$/u.test(shortHead)) throw new Error('invalid cohort')
  return join(normalizeAbsolutePath(stateRoot), shortHead)
}

function activePointerPath(stateRoot) {
  return join(normalizeAbsolutePath(stateRoot), ACTIVE_POINTER_FILE)
}

function pendingFinishPath(stateRoot) {
  return join(normalizeAbsolutePath(stateRoot), PENDING_FINISH_FILE)
}

export function readPrivateText(path, maxBytes = MAX_PRIVATE_STATE_BYTES) {
  try {
    return readPrivateState(path, maxBytes).toString('utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw error
    throw new Error('invalid private state')
  }
}

function readJson(path, errorMessage, { missing = 'error' } = {}) {
  let text
  try {
    text = readPrivateText(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (missing === 'null') return MISSING_PRIVATE_JSON
      if (missing !== 'error') throw new Error(missing)
    }
    throw new Error(errorMessage)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(errorMessage)
  }
}

function validatePointer(pointer) {
  const keys = Object.keys(pointer ?? {}).sort()
  if (keys.length !== 3 || keys.join(',') !== 'commit,schemaVersion,shortHead'
    || pointer.schemaVersion !== SCHEMA_VERSION
    || typeof pointer.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(pointer.commit)
    || typeof pointer.shortHead !== 'string' || !/^[0-9a-f]{12}$/u.test(pointer.shortHead)
    || pointer.shortHead !== pointer.commit.slice(0, 12)) {
    throw new Error('invalid cohort')
  }
  return pointer
}

function readActivePointer(stateRoot) {
  const path = activePointerPath(stateRoot)
  return validatePointer(readJson(path, 'invalid cohort', { missing: 'cohort not found' }))
}

function pendingFinishExists(stateRoot) {
  try {
    lstatSync(pendingFinishPath(stateRoot))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    // An inaccessible marker must fail closed just like a readable marker.
    return true
  }
}

function assertCohortNotFinishing(stateRoot) {
  if (pendingFinishExists(stateRoot)) throw new Error('cohort finishing')
}

function readPendingFinish(stateRoot) {
  const path = pendingFinishPath(stateRoot)
  const pending = readJson(path, 'invalid cohort', { missing: 'null' })
  if (pending === MISSING_PRIVATE_JSON) return null
  const keys = Object.keys(pending ?? {}).sort()
  if (keys.length !== 4 || keys.join(',') !== 'commit,finishedAt,schemaVersion,shortHead'
    || pending.schemaVersion !== SCHEMA_VERSION
    || typeof pending.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(pending.commit)
    || typeof pending.shortHead !== 'string' || !/^[0-9a-f]{12}$/u.test(pending.shortHead)
    || pending.shortHead !== pending.commit.slice(0, 12)
    || typeof pending.finishedAt !== 'string' || !ISO_UTC_PATTERN.test(pending.finishedAt)) {
    throw new Error('invalid cohort')
  }
  return pending
}

function validateSnapshotArray(values, pattern, normalizeValue = (value) => value, allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) return false
  let previous = ''
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || !pattern.test(value) || normalizeValue(value) !== value
      || seen.has(value) || (previous !== '' && previous >= value)) return false
    seen.add(value)
    previous = value
  }
  return true
}

function removeMatchingActivePointer(stateRoot, expected) {
  let current
  try {
    current = readActivePointer(stateRoot)
  } catch (error) {
    if (error?.message === 'cohort not found') return
    throw error
  }
  if (current.commit !== expected.commit || current.shortHead !== expected.shortHead) throw new Error('invalid cohort')
  try {
    unlinkSync(activePointerPath(stateRoot))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function readCohortFromPointer(stateRoot, repoDir, pointer) {
  const repository = {
    repoDir: normalizeAbsolutePath(repoDir),
    commit: pointer.commit,
    shortHead: pointer.shortHead,
  }
  const directory = cohortDirectory(stateRoot, pointer.shortHead)
  const metadata = readJson(join(directory, METADATA_FILE), 'cohort not found')
  const baseline = readJson(join(directory, BASELINE_FILE), 'cohort not found')
  if (metadata?.schemaVersion !== SCHEMA_VERSION || metadata?.commit !== pointer.commit
    || metadata?.shortHead !== pointer.shortHead
    || typeof metadata.startedAt !== 'string' || !ISO_UTC_PATTERN.test(metadata.startedAt)
    || (metadata.finishedAt !== undefined
      && (typeof metadata.finishedAt !== 'string' || !ISO_UTC_PATTERN.test(metadata.finishedAt)))
    || !validateSnapshotArray(metadata.agentNames, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
    || !validateSnapshotArray(metadata.modelIds, MODEL_ID_PATTERN, normalizeModelId, true)
    || !Array.isArray(baseline?.identities)
    || baseline.identities.some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error('invalid cohort')
  }
  return {
    repository,
    pointer,
    directory,
    metadata,
    baselineHashes: new Set(baseline.identities),
    agentNames: new Set(metadata.agentNames),
    trustedModelIds: new Set(metadata.modelIds),
  }
}

function readCohort(stateRoot, repoDir) {
  return readCohortFromPointer(stateRoot, repoDir, readActivePointer(stateRoot))
}

function ensureActivePointerAbsent(stateRoot) {
  try {
    lstatSync(activePointerPath(stateRoot))
    throw new Error('active cohort exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function ensureCohortAbsent(directory) {
  try {
    lstatSync(directory)
    throw new Error('cohort already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function atomicPrivateFile(path, content) {
  const temporary = `${path}.tmp-${randomBytes(9).toString('hex')}`
  let temporaryCreated = false
  try {
    privateFile(temporary, content, { exclusive: true })
    temporaryCreated = true
    renameSync(temporary, path)
    temporaryCreated = false
    chmodSync(path, 0o600)
  } finally {
    if (temporaryCreated) {
      try { unlinkSync(temporary) } catch {}
    }
  }
}

function createActivePointer(stateRoot, pointer) {
  const path = activePointerPath(stateRoot)
  const temporary = `${path}.tmp-${randomBytes(9).toString('hex')}`
  let temporaryCreated = false
  try {
    privateFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { exclusive: true })
    temporaryCreated = true
    // A hard link makes activation exclusive without replacing another cohort's pointer.
    linkSync(temporary, path)
    temporaryCreated = false
    try { unlinkSync(temporary) } catch {}
  } catch (error) {
    if (temporaryCreated) {
      try { unlinkSync(temporary) } catch {}
    }
    if (error?.code === 'EEXIST') throw new Error('active cohort exists')
    throw error
  }
}

function cohortSnapshots() {
  let agentNames
  let modelIds
  try {
    agentNames = [...packagedAgentNames()].sort()
    modelIds = [...new Set(collectConfiguredAgentModelIds()
      .map(normalizeModelId)
      .filter((modelId) => MODEL_ID_PATTERN.test(modelId)))].sort()
  } catch {
    throw new Error('could not validate agent')
  }
  return { agentNames, modelIds }
}

function createCohortUnlocked({ stateRoot, sessionsDir, repoDir, now = new Date() }) {
  assertCohortNotFinishing(stateRoot)
  ensureActivePointerAbsent(stateRoot)
  const repository = repositoryState(repoDir)
  const directory = cohortDirectory(stateRoot, repository.shortHead)
  ensureCohortAbsent(directory)
  const files = enumerateSessionFiles(sessionsDir)
  const snapshots = cohortSnapshots()
  const identities = [...new Set(files.map(hashPathIdentity))].sort()
  let cohortCreated = false
  try {
    privateDirectory(dirname(directory))
    mkdirSync(directory, { mode: 0o700 })
    cohortCreated = true
    chmodSync(directory, 0o700)
    privateFile(join(directory, METADATA_FILE), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      commit: repository.commit,
      shortHead: repository.shortHead,
      startedAt: now.toISOString(),
      agentNames: snapshots.agentNames,
      modelIds: snapshots.modelIds,
    }, null, 2)}\n`, { exclusive: true })
    privateFile(join(directory, BASELINE_FILE), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      identities,
    }, null, 2)}\n`, { exclusive: true })
    privateFile(join(directory, INCIDENT_FILE), '', { exclusive: true })
    // Activation is deliberately last: a visible pointer always names a complete cohort.
    createActivePointer(stateRoot, {
      schemaVersion: SCHEMA_VERSION,
      commit: repository.commit,
      shortHead: repository.shortHead,
    })
  } catch (error) {
    // Only remove the directory created by this invocation; never remove an existing cohort.
    if (cohortCreated) {
      try { rmSync(directory, { recursive: true, force: true }) } catch {}
    }
    throw error instanceof Error && ['cohort already exists', 'active cohort exists'].includes(error.message)
      ? error
      : new Error('could not create cohort')
  }
  return { ...repository, directory, baselineCount: identities.length, startedAt: now.toISOString() }
}

function packagedAgentNames() {
  try {
    return new Set(readAgentPromptFiles().keys())
  } catch {
    throw new Error('could not validate agent')
  }
}

export function createCohort(options) {
  return withStateLock(options.stateRoot, () => createCohortUnlocked(options))
}

export function validateIncident(input, agentNames = packagedAgentNames()) {
  return Object.freeze(validateIncidentShared(input, agentNames, MAX_NOTE_LENGTH))
}

function caseId() {
  return `case-${randomBytes(9).toString('hex')}`
}

function appendIncidentUnlocked({ stateRoot, repoDir, incident, now = new Date() }) {
  assertCohortNotFinishing(stateRoot)
  const cohort = readCohort(stateRoot, repoDir)
  const validated = validateIncident(incident, cohort.agentNames)
  const id = caseId()
  const timestamp = now.toISOString()
  const line = [id, timestamp, validated.agent, validated.category, validated.severity, validated.note].join('\t') + '\n'
  privateAppend(join(cohort.directory, INCIDENT_FILE), line)
  return { id, timestamp, ...validated }
}

function finalizePendingFinishUnlocked({ stateRoot, repoDir, pending }) {
  const cohort = readCohortFromPointer(stateRoot, repoDir, {
    schemaVersion: SCHEMA_VERSION,
    commit: pending.commit,
    shortHead: pending.shortHead,
  })
  if (cohort.metadata.finishedAt !== undefined && cohort.metadata.finishedAt !== pending.finishedAt) {
    throw new Error('invalid cohort')
  }
  atomicPrivateFile(join(cohort.directory, METADATA_FILE), `${JSON.stringify({
    ...cohort.metadata,
    finishedAt: pending.finishedAt,
  }, null, 2)}\n`)
  removeMatchingActivePointer(stateRoot, pending)
  try {
    unlinkSync(pendingFinishPath(stateRoot))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    commit: cohort.metadata.commit,
    shortHead: cohort.metadata.shortHead,
    startedAt: cohort.metadata.startedAt,
    finishedAt: pending.finishedAt,
  }
}

function finishCohortUnlocked({ stateRoot, repoDir, now = new Date() }) {
  const pending = readPendingFinish(stateRoot)
  if (pending) return finalizePendingFinishUnlocked({ stateRoot, repoDir, pending })

  const cohort = readCohort(stateRoot, repoDir)
  if (cohort.metadata.finishedAt !== undefined) throw new Error('invalid cohort')
  const pendingFinish = {
    schemaVersion: SCHEMA_VERSION,
    commit: cohort.metadata.commit,
    shortHead: cohort.metadata.shortHead,
    finishedAt: now.toISOString(),
  }
  atomicPrivateFile(pendingFinishPath(stateRoot), `${JSON.stringify(pendingFinish, null, 2)}\n`)
  return finalizePendingFinishUnlocked({ stateRoot, repoDir, pending: pendingFinish })
}

export function appendIncident(options) {
  return withStateLock(options.stateRoot, () => appendIncidentUnlocked(options))
}

export function finishCohort(options) {
  return withStateLock(options.stateRoot, () => finishCohortUnlocked(options))
}

function aggregateSummary(report, fileCount) {
  const runtime = report.totals.runtime
  return `aggregate summary: sessions=${fileCount} invocations=${report.totals.invocations} success=${runtime.success} failure=${runtime.failure} aborted=${runtime.aborted} unresolved=${runtime.unresolved}`
}

function ownedReadableRegularFile(path) {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error('invalid aggregate report')
  }
  const owned = typeof process.getuid !== 'function' || info.uid === process.getuid()
  if (!info.isFile() || info.isSymbolicLink() || !owned || (info.mode & 0o400) === 0) throw new Error('invalid aggregate report')
  return info
}

function clearStaleAggregate(directory) {
  const path = join(directory, REPORT_FILE)
  if (!ownedReadableRegularFile(path)) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('invalid aggregate report')
  }
}

function readLegacyAggregate(cohort) {
  const path = join(cohort.directory, REPORT_FILE)
  const persisted = readJson(path, 'invalid aggregate report', { missing: 'null' })
  if (persisted === MISSING_PRIVATE_JSON) return null
  if (persisted?.schemaVersion !== SCHEMA_VERSION || typeof persisted.generatedAt !== 'string'
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(persisted.generatedAt) === false
    || !Number.isSafeInteger(persisted.fileCount) || persisted.fileCount < 0 || !persisted.aggregate) {
    throw new Error('invalid aggregate report')
  }
  const aggregate = validatePersistedAggregate(persisted.aggregate, cohort)
  if (!aggregate) throw new Error('invalid aggregate report')
  return aggregate
}

function readAutomationSnapshot(cohort) {
  const path = join(cohort.directory, AUTOMATION_STATE_FILE)
  const value = readJson(path, 'invalid automation state', { missing: 'null' })
  if (value === MISSING_PRIVATE_JSON) return null
  const keys = Object.keys(value ?? {}).sort()
  if (keys.length !== 5 || keys.join(',') !== 'aggregate,commit,schemaVersion,sessions,updatedAt'
    || value.schemaVersion !== SCHEMA_VERSION || value.commit !== cohort.metadata.commit
    || typeof value.updatedAt !== 'string' || !ISO_UTC_PATTERN.test(value.updatedAt)
    || !value.aggregate || !Array.isArray(value.aggregate.agents)
    || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) {
    throw new Error('invalid automation state')
  }
  for (const [session, fingerprints] of Object.entries(value.sessions)) {
    if (!/^[a-f0-9]{64}$/u.test(session) || !Array.isArray(fingerprints)
      || fingerprints.some((fingerprint) => typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint))) {
      throw new Error('invalid automation state')
    }
  }
  const aggregate = validatePersistedAggregate(value.aggregate, { agentNames: cohort.agentNames, trustedModelIds: cohort.trustedModelIds })
  if (!aggregate) throw new Error('invalid automation state')
  return {
    aggregate,
    observedSessions: Object.keys(value.sessions).length,
    observedEntries: Object.values(value.sessions).reduce((total, fingerprints) => total + fingerprints.length, 0),
  }
}

function runReportUnlocked({ stateRoot, sessionsDir, repoDir, now = new Date() }) {
  assertCohortNotFinishing(stateRoot)
  const cohort = readCohort(stateRoot, repoDir)
  const automation = readAutomationSnapshot(cohort)
  if (automation) return { ...cohort, files: [], newFiles: [], report: automation.aggregate, automation }
  return runReportUnlockedLegacy({ stateRoot, sessionsDir, repoDir, now })
}

function runReportUnlockedLegacy({ stateRoot, sessionsDir, repoDir, now = new Date() }) {
  const cohort = readCohort(stateRoot, repoDir)
  const files = enumerateSessionFiles(sessionsDir)
  const newFiles = selectNewSessionFiles(files, cohort.baselineHashes)
  if (newFiles.length === 0) {
    clearStaleAggregate(cohort.directory)
    return { ...cohort, files, newFiles, report: null }
  }

  // The baseline is immutable. Re-read every current cohort-created file so reports
  // remain cumulative and a file observed while it was still being written is never lost.
  const reports = newFiles.map((file) => aggregateSessionLines(
    readSessionFile(file).split(/\r?\n/),
    { agentNames: cohort.agentNames, trustedModelIds: cohort.trustedModelIds },
  ))
  const report = mergeUsageReports(reports, { agentNames: cohort.agentNames, trustedModelIds: cohort.trustedModelIds })
  atomicPrivateFile(join(cohort.directory, REPORT_FILE), `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    fileCount: newFiles.length,
    aggregate: report,
  }, null, 2)}\n`)
  return { ...cohort, files, newFiles, report }
}

export function runReport(options) {
  return withStateLock(options.stateRoot, () => runReportUnlocked(options))
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function incidentCounts(path) {
  const counts = Object.fromEntries(INCIDENT_CATEGORIES.map((category) => [category, 0]))
  let text
  try {
    text = readPrivateText(path)
  } catch {
    throw new Error('could not read incident storage')
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    if (fields.length !== 6 || !SAFE_CASE_ID_PATTERN.test(fields[0])) continue
    if (CATEGORY_SET.has(fields[3])) counts[fields[3]] += 1
  }
  return counts
}

function statusSnapshotUnlocked({ stateRoot, sessionsDir, repoDir }) {
  assertCohortNotFinishing(stateRoot)
  const cohort = readCohort(stateRoot, repoDir)
  const automation = readAutomationSnapshot(cohort)
  if (automation) {
    return {
      commit: cohort.metadata.commit,
      startedAt: cohort.metadata.startedAt,
      newFileCount: 0,
      observedSessions: automation.observedSessions,
      observedEntries: automation.observedEntries,
      automation: true,
      latest: {
        invocations: safeCounter(automation.aggregate.totals?.invocations),
        success: safeCounter(automation.aggregate.totals?.runtime?.success),
        failure: safeCounter(automation.aggregate.totals?.runtime?.failure),
        aborted: safeCounter(automation.aggregate.totals?.runtime?.aborted),
        unresolved: safeCounter(automation.aggregate.totals?.runtime?.unresolved),
      },
      incidents: incidentCounts(join(cohort.directory, INCIDENT_FILE)),
    }
  }
  const files = enumerateSessionFiles(sessionsDir)
  const newFiles = selectNewSessionFiles(files, cohort.baselineHashes)
  let latest = null
  if (newFiles.length === 0) {
    clearStaleAggregate(cohort.directory)
  } else {
    latest = readLegacyAggregate(cohort)
  }
  return {
    commit: cohort.metadata.commit,
    startedAt: cohort.metadata.startedAt,
    newFileCount: newFiles.length,
    latest: latest ? {
      invocations: safeCounter(latest.totals?.invocations),
      success: safeCounter(latest.totals?.runtime?.success),
      failure: safeCounter(latest.totals?.runtime?.failure),
      aborted: safeCounter(latest.totals?.runtime?.aborted),
      unresolved: safeCounter(latest.totals?.runtime?.unresolved),
    } : null,
    incidents: incidentCounts(join(cohort.directory, INCIDENT_FILE)),
  }
}

export function statusSnapshot(options) {
  return withStateLock(options.stateRoot, () => statusSnapshotUnlocked(options))
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('command required')
  const command = argv[0]
  if (!['start', 'report', 'incident', 'status', 'finish'].includes(command)) throw new Error('unknown command')
  const options = {
    stateRoot: defaultStateRoot(),
    sessionsDir: defaultSessionsDir(),
    repoDir: process.cwd(),
  }
  const incident = {}
  const allowed = new Set(['--state-root', '--sessions-dir', '--repo-dir', '--agent', '--category', '--severity', '--note'])
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    const equals = argument.indexOf('=')
    const key = equals === -1 ? argument : argument.slice(0, equals)
    if (!allowed.has(key)) throw new Error('invalid options')
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1)
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('invalid options')
    if (key === '--state-root') options.stateRoot = value
    else if (key === '--sessions-dir') options.sessionsDir = value
    else if (key === '--repo-dir') options.repoDir = value
    else incident[key.slice(2)] = value
  }
  if (command !== 'incident' && Object.keys(incident).length > 0) throw new Error('invalid options')
  if (command === 'incident' && Object.keys(incident).some((key) => !['agent', 'category', 'severity', 'note'].includes(key))) throw new Error('invalid options')
  return { command, options, incident }
}

export function helpText() {
  return [
    'Usage: npm run agent-observation -- <start|report|incident|status|finish> [options]',
    '',
    'start records a private, immutable hashed baseline and activates one cohort; run it after setup and before /new.',
    'report prefers the automatic aggregate after a pi lifecycle checkpoint; before that it is the legacy aggregate-only reporter for current JSONL files created after start.',
    'incident requires --agent NAME --category CATEGORY --severity low|medium|high --note TEXT.',
    'status prints cohort metadata, aggregate runtime counts, and incident category counts without paths or notes.',
    'finish records a UTC finish time and deactivates the cohort; an interrupted finish resumes safely on retry.',
    'While finish recovery is pending, start/report/incident/status fail closed with cohort finishing; finish remains available.',
    'Operations use an exclusive state-root-local lock; a live or stale lock fails closed without removing it.',
    'start snapshots the sorted packaged agent names and normalized configured model IDs; later validation and aggregation use that snapshot even after HEAD drift.',
    'Options: --state-root DIR --sessions-dir DIR --repo-dir DIR.',
    'No model calls, live model inventory, network access, or writes to the sessions directory are performed.',
  ].join('\n') + '\n'
}

function runCli(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
    const { command, options, incident } = parsed
    if (command === 'start') {
      const result = createCohort(options)
      console.log(`started cohort commit=${result.commit} started=${result.startedAt} baselineFiles=${result.baselineCount}`)
    } else if (command === 'finish') {
      const result = finishCohort(options)
      console.log(`finished cohort commit=${result.commit} shortHead=${result.shortHead} started=${result.startedAt} finished=${result.finishedAt}`)
    } else if (command === 'report') {
      const result = runReport(options)
      if (!result.report) {
        console.log('No new session files observed; no aggregate report was written.')
      } else {
        process.stdout.write(formatReport(result.report, 'table'))
        console.log(aggregateSummary(result.report, result.automation?.observedSessions ?? result.newFiles.length))
      }
    } else if (command === 'incident') {
      const result = appendIncident({ ...options, incident })
      console.log(`recorded incident ${result.id}`)
    } else {
      const result = statusSnapshot(options)
      console.log(`cohort commit=${result.commit} started=${result.startedAt}`)
      if (result.automation) console.log(`automation observed sessions=${result.observedSessions} entries=${result.observedEntries}`)
      else console.log(`new session files=${result.newFileCount}`)
      if (result.latest) console.log(`latest aggregate: invocations=${result.latest.invocations} success=${result.latest.success} failure=${result.latest.failure} aborted=${result.latest.aborted} unresolved=${result.latest.unresolved}`)
      else console.log('latest aggregate: none')
      console.log(`incidents: ${INCIDENT_CATEGORIES.map((category) => `${category}=${result.incidents[category]}`).join(' ')}`)
    }
    return 0
  } catch (error) {
    const message = error?.message
    const allowed = new Set([
      'command required', 'unknown command', 'invalid options', 'repository worktree must be clean',
      'could not inspect repository', 'cohort already exists', 'active cohort exists', 'could not create cohort', 'cohort not found',
      'observation operation already in progress', 'could not lock observation state', 'invalid cohort', 'invalid sessions directory',
      'could not inspect sessions', 'session file size limit exceeded', 'session file changed during read', 'could not read session file',
      'cohort finishing', 'session file count limit exceeded', 'session directory depth limit exceeded', 'invalid incident agent',
      'invalid incident category', 'invalid incident severity', 'invalid incident note', 'invalid incident',
      'could not validate agent', 'could not read incident storage', 'invalid aggregate report', 'invalid automation state',
    ])
    console.error(`ERROR: ${allowed.has(message) ? message : 'operation failed'}`)
    return 1
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(helpText().trimEnd())
    return 0
  }
  return runCli(argv)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
