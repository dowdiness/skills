#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readAgentPromptFiles } from './agent-prompt-contracts.mjs'
import {
  aggregateSessionLines,
  formatReport,
  mergeUsageReports,
  MAX_FILE_BYTES,
  MAX_INPUT_FILES,
  MAX_RECURSION_DEPTH,
} from './agent-usage-report.mjs'

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
export const INCIDENT_FILE = 'incidents.tsv'

const CATEGORY_SET = new Set(INCIDENT_CATEGORIES)
const SEVERITY_SET = new Set(INCIDENT_SEVERITIES)
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u
const SENSITIVE_NOTE_PATTERN = /(?:\/|\\|:\/\/|\b(?:api[_ -]?key|bearer|credential|cwd|password|prompt|secret|session|task|token)\b|\b(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]+\b|\b[A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password)\s*=)/iu
const SAFE_CASE_ID_PATTERN = /^case-[a-f0-9]{18}$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

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

function currentCommit(repoDir) {
  const root = normalizeAbsolutePath(repoDir)
  const commit = gitOutput(root, ['rev-parse', '--verify', 'HEAD'])
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('could not inspect repository')
  return { repoDir: root, commit, shortHead: commit.slice(0, 12) }
}

function cohortDirectory(stateRoot, shortHead) {
  if (!/^[0-9a-f]{12}$/u.test(shortHead)) throw new Error('invalid cohort')
  return join(normalizeAbsolutePath(stateRoot), shortHead)
}

function readJson(path, errorMessage) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(errorMessage)
  }
}

function readCohort(stateRoot, repoDir) {
  const repository = currentCommit(repoDir)
  const directory = cohortDirectory(stateRoot, repository.shortHead)
  const metadata = readJson(join(directory, METADATA_FILE), 'cohort not found')
  const baseline = readJson(join(directory, BASELINE_FILE), 'cohort not found')
  if (metadata?.schemaVersion !== SCHEMA_VERSION || metadata?.commit !== repository.commit
    || typeof metadata.startedAt !== 'string' || !ISO_UTC_PATTERN.test(metadata.startedAt)
    || !Array.isArray(baseline?.identities)
    || baseline.identities.some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error('invalid cohort')
  }
  return { repository, directory, metadata, baselineHashes: new Set(baseline.identities) }
}

function ensureCohortAbsent(directory) {
  try {
    lstatSync(directory)
    throw new Error('cohort already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function createCohort({ stateRoot, sessionsDir, repoDir, now = new Date() }) {
  const repository = repositoryState(repoDir)
  const directory = cohortDirectory(stateRoot, repository.shortHead)
  ensureCohortAbsent(directory)
  const files = enumerateSessionFiles(sessionsDir)
  const identities = [...new Set(files.map(hashPathIdentity))].sort()
  try {
    privateDirectory(dirname(directory))
    mkdirSync(directory, { mode: 0o700 })
    chmodSync(directory, 0o700)
    privateFile(join(directory, METADATA_FILE), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      commit: repository.commit,
      shortHead: repository.shortHead,
      startedAt: now.toISOString(),
    }, null, 2)}\n`, { exclusive: true })
    privateFile(join(directory, BASELINE_FILE), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      identities,
    }, null, 2)}\n`, { exclusive: true })
    privateFile(join(directory, INCIDENT_FILE), '', { exclusive: true })
  } catch (error) {
    // Avoid leaving a partially-created cohort that could be mistaken for a valid baseline.
    try { rmSync(directory, { recursive: true, force: true }) } catch {}
    throw error instanceof Error && error.message === 'cohort already exists'
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

export function validateIncident(input, agentNames = packagedAgentNames()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid incident')
  const { agent, category, severity, note } = input
  if (!(agentNames instanceof Set) || typeof agent !== 'string' || !agentNames.has(agent)) throw new Error('invalid incident agent')
  if (typeof category !== 'string' || !CATEGORY_SET.has(category)) throw new Error('invalid incident category')
  if (typeof severity !== 'string' || !SEVERITY_SET.has(severity)) throw new Error('invalid incident severity')
  if (typeof note !== 'string' || note.length === 0 || note.length > MAX_NOTE_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(note) || SENSITIVE_NOTE_PATTERN.test(note)) {
    throw new Error('invalid incident note')
  }
  return Object.freeze({ agent, category, severity, note })
}

function caseId() {
  return `case-${randomBytes(9).toString('hex')}`
}

export function appendIncident({ stateRoot, repoDir, incident, now = new Date() }) {
  const cohort = readCohort(stateRoot, repoDir)
  const validated = validateIncident(incident)
  const id = caseId()
  const timestamp = now.toISOString()
  const line = [id, timestamp, validated.agent, validated.category, validated.severity, validated.note].join('\t') + '\n'
  privateAppend(join(cohort.directory, INCIDENT_FILE), line)
  return { id, timestamp, ...validated }
}

function aggregateSummary(report, fileCount) {
  const runtime = report.totals.runtime
  return `aggregate summary: files=${fileCount} invocations=${report.totals.invocations} success=${runtime.success} failure=${runtime.failure} aborted=${runtime.aborted} unresolved=${runtime.unresolved}`
}

export function runReport({ stateRoot, sessionsDir, repoDir, now = new Date() }) {
  const cohort = readCohort(stateRoot, repoDir)
  const files = enumerateSessionFiles(sessionsDir)
  const newFiles = selectNewSessionFiles(files, cohort.baselineHashes)
  if (newFiles.length === 0) return { ...cohort, files, newFiles, report: null }

  const reports = newFiles.map((file) => aggregateSessionLines(readFileSync(file, 'utf8').split(/\r?\n/)))
  const report = mergeUsageReports(reports)
  privateFile(join(cohort.directory, BASELINE_FILE), `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    identities: [...new Set([...cohort.baselineHashes, ...newFiles.map(hashPathIdentity)])].sort(),
  }, null, 2)}\n`)
  privateFile(join(cohort.directory, REPORT_FILE), `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    fileCount: newFiles.length,
    aggregate: report,
  }, null, 2)}\n`)
  return { ...cohort, files, newFiles, report }
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function incidentCounts(path) {
  const counts = Object.fromEntries(INCIDENT_CATEGORIES.map((category) => [category, 0]))
  let text
  try {
    text = readFileSync(path, 'utf8')
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

export function statusSnapshot({ stateRoot, sessionsDir, repoDir }) {
  const cohort = readCohort(stateRoot, repoDir)
  const files = enumerateSessionFiles(sessionsDir)
  const newFiles = selectNewSessionFiles(files, cohort.baselineHashes)
  let latest = null
  const reportPath = join(cohort.directory, REPORT_FILE)
  if (existsSync(reportPath)) {
    const persisted = readJson(reportPath, 'invalid aggregate report')
    if (persisted?.schemaVersion !== SCHEMA_VERSION || !persisted.aggregate) throw new Error('invalid aggregate report')
    latest = persisted.aggregate
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

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('command required')
  const command = argv[0]
  if (!['start', 'report', 'incident', 'status'].includes(command)) throw new Error('unknown command')
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
    'Usage: npm run agent-observation -- <start|report|incident|status> [options]',
    '',
    'start records a private, hashed baseline of existing JSONL identities; run it after setup and before /clear/new session.',
    'report is aggregate-only and should be run after pi exits; it includes only JSONL files created after start.',
    'incident requires --agent NAME --category CATEGORY --severity low|medium|high --note TEXT.',
    'status prints cohort metadata, aggregate runtime counts, and incident category counts without paths or notes.',
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
    } else if (command === 'report') {
      const result = runReport(options)
      if (!result.report) {
        console.log('No new session files observed; no aggregate report was written.')
      } else {
        process.stdout.write(formatReport(result.report, 'table'))
        console.log(aggregateSummary(result.report, result.newFiles.length))
      }
    } else if (command === 'incident') {
      const result = appendIncident({ ...options, incident })
      console.log(`recorded incident ${result.id}`)
    } else {
      const result = statusSnapshot(options)
      console.log(`cohort commit=${result.commit} started=${result.startedAt}`)
      console.log(`new session files=${result.newFileCount}`)
      if (result.latest) console.log(`latest aggregate: invocations=${result.latest.invocations} success=${result.latest.success} failure=${result.latest.failure} aborted=${result.latest.aborted} unresolved=${result.latest.unresolved}`)
      else console.log('latest aggregate: none')
      console.log(`incidents: ${INCIDENT_CATEGORIES.map((category) => `${category}=${result.incidents[category]}`).join(' ')}`)
    }
    return 0
  } catch (error) {
    const message = error?.message
    const allowed = new Set([
      'command required', 'unknown command', 'invalid options', 'repository worktree must be clean',
      'could not inspect repository', 'cohort already exists', 'could not create cohort', 'cohort not found',
      'invalid cohort', 'invalid sessions directory', 'could not inspect sessions', 'session file size limit exceeded',
      'session file count limit exceeded', 'session directory depth limit exceeded', 'invalid incident agent',
      'invalid incident category', 'invalid incident severity', 'invalid incident note', 'invalid incident',
      'could not validate agent', 'could not read incident storage', 'invalid aggregate report',
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
