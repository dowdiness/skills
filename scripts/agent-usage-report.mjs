#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { EXPECTED_AGENT_NAMES } from './agent-prompt-contracts.mjs'
import { collectConfiguredAgentModelIds, normalizeModelId } from './validate-agent-models.mjs'
import {
  aggregateSessionRecords as aggregateCore,
  mergeUsageReports as mergeCore,
} from '../extensions/agent-observation/core.ts'

export const SCHEMA_VERSION = 1
export const MAX_INPUT_FILES = 4096
export const MAX_RECURSION_DEPTH = 16
export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_INPUT_LIMITS = Object.freeze({
  maxFiles: MAX_INPUT_FILES,
  maxBytesPerFile: MAX_FILE_BYTES,
  maxDepth: MAX_RECURSION_DEPTH,
})

const INPUT_ERROR_MESSAGES = Object.freeze({
  fileCountLimit: 'input file count limit exceeded',
  fileSizeLimit: 'input file size limit exceeded',
  depthLimit: 'input directory depth limit exceeded',
  unsupportedInput: 'unsupported input',
  nonJsonl: 'non-JSONL explicit input rejected; expected a .jsonl file',
  noFiles: 'no input files',
})

class InputError extends Error {
  constructor(code) {
    super(INPUT_ERROR_MESSAGES[code])
    this.name = 'InputError'
    this.code = code
  }
}

function inputError(code) {
  return new InputError(code)
}

export function formatInputError(error) {
  if (error?.name === 'InputError' && Object.hasOwn(INPUT_ERROR_MESSAGES, error.code)) return INPUT_ERROR_MESSAGES[error.code]
  return 'could not read explicit JSONL input'
}

function validateInputLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new TypeError('invalid input limits')
  const keys = Object.keys(limits)
  if (keys.some((key) => !Object.hasOwn(DEFAULT_INPUT_LIMITS, key))) throw new TypeError('invalid input limits')
  const normalized = { ...DEFAULT_INPUT_LIMITS, ...limits }
  if (!Number.isSafeInteger(normalized.maxFiles) || normalized.maxFiles < 1
    || !Number.isSafeInteger(normalized.maxBytesPerFile) || normalized.maxBytesPerFile < 0
    || !Number.isSafeInteger(normalized.maxDepth) || normalized.maxDepth < 0) throw new TypeError('invalid input limits')
  return Object.freeze(normalized)
}

const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+@:-]{0,199}$/

function normalizeAgentNames(values) {
  if (!values || (typeof values !== 'object' && !Array.isArray(values))) throw new TypeError('invalid agent names')
  const names = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || !AGENT_PATTERN.test(value) || names.has(value)) throw new TypeError('invalid agent names')
    names.add(value)
  }
  return names
}

function normalizeTrustedModelIds(values, strict = true) {
  if (!values || (typeof values !== 'object' && !Array.isArray(values))) throw new TypeError('invalid trusted model IDs')
  const ids = new Set()
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('invalid trusted model IDs')
    const modelId = normalizeModelId(value)
    if (!MODEL_ID_PATTERN.test(modelId)) {
      if (strict) throw new TypeError('invalid trusted model IDs')
      continue
    }
    ids.add(modelId)
  }
  return ids
}

const DEFAULT_TRUSTED_MODEL_IDS = normalizeTrustedModelIds(
  collectConfiguredAgentModelIds().map(normalizeModelId),
  false,
)
const DEFAULT_AGENT_NAMES = new Set(EXPECTED_AGENT_NAMES)

function reportOptions(options) {
  if (options === undefined) return { agentNames: DEFAULT_AGENT_NAMES, trustedModelIds: DEFAULT_TRUSTED_MODEL_IDS }
  // Preserve the original Set/array shorthand: it means trusted model IDs.
  if (options instanceof Set || Array.isArray(options)) return { agentNames: DEFAULT_AGENT_NAMES, trustedModelIds: normalizeTrustedModelIds(options) }
  if (!options || typeof options !== 'object') throw new TypeError('invalid usage report options')
  const keys = Object.keys(options)
  if (keys.some((key) => key !== 'trustedModelIds' && key !== 'agentNames')) throw new TypeError('invalid usage report options')
  return {
    agentNames: Object.hasOwn(options, 'agentNames') ? normalizeAgentNames(options.agentNames) : DEFAULT_AGENT_NAMES,
    trustedModelIds: Object.hasOwn(options, 'trustedModelIds') ? normalizeTrustedModelIds(options.trustedModelIds) : DEFAULT_TRUSTED_MODEL_IDS,
  }
}

export function aggregateSessionRecords(records, options) {
  return aggregateCore(records, reportOptions(options))
}

export function aggregateSessionLines(lines, options) {
  const records = []
  let malformedRecords = 0
  for (const line of lines) {
    if (!String(line).trim()) continue
    try { records.push(JSON.parse(line)) } catch { malformedRecords += 1 }
  }
  const report = aggregateSessionRecords(records, options)
  report.malformedRecords += malformedRecords
  return report
}

export function mergeUsageReports(reports, options) {
  return mergeCore(reports, reportOptions(options))
}

export function formatReport(report, format = 'table') {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`
  const lines = [
    'Agent usage report (runtime evidence only; no task, cwd, content, messages, response, or path data)',
    'agent                 invocations success failure aborted unresolved turns input output cacheRead cacheWrite contextTokens durationMs models',
  ]
  for (const aggregate of report.agents) {
    lines.push([
      aggregate.agent.padEnd(21), String(aggregate.invocations).padStart(11), String(aggregate.runtime.success).padStart(7),
      String(aggregate.runtime.failure).padStart(7), String(aggregate.runtime.aborted).padStart(7), String(aggregate.runtime.unresolved).padStart(9),
      String(aggregate.usage.turns).padStart(6), String(aggregate.usage.input).padStart(5), String(aggregate.usage.output).padStart(6),
      String(aggregate.usage.cacheRead).padStart(9), String(aggregate.usage.cacheWrite).padStart(10), String(aggregate.usage.contextTokens).padStart(13),
      String(aggregate.durationMs).padStart(10), aggregate.models.join(',') || '-',
    ].join(' '))
  }
  lines.push(`totals: invocations=${report.totals.invocations} success=${report.totals.runtime.success} failure=${report.totals.runtime.failure} aborted=${report.totals.runtime.aborted} unresolved=${report.totals.runtime.unresolved} turns=${report.totals.usage.turns} input=${report.totals.usage.input} output=${report.totals.usage.output} durationMs=${report.totals.durationMs} callDurationMs=${report.totals.callDurationMs}`)
  lines.push(`unknownRecords=${report.unknownRecords} malformedRecords=${report.malformedRecords} missingLeaves=${report.missingLeaves} (missing leaves are unresolved evidence, not invocations or failures)`)
  return `${lines.join('\n')}\n`
}

export function helpText() {
  return [
    'Usage: npm run agent-usage-report -- [--format table|json] <explicit-jsonl-file-or-directory> [...]', '',
    'Reads only the explicitly supplied JSONL files or directories and emits aggregate runtime evidence.',
    'Default with no paths: print this help and exit 0; no home-directory scan is performed.',
    `Input limits: at most ${MAX_INPUT_FILES} JSONL files, directory depth ${MAX_RECURSION_DEPTH}, and ${MAX_FILE_BYTES} bytes (64 MiB) per file; symlinks are rejected.`,
    'Privacy boundary: task, cwd, content, messages, response text, credentials, paths, and filenames are omitted.',
    'Missing requested leaves remain unresolved evidence; they are not counted as invocations or runtime failures.',
    'Per-agent duration uses only explicit leaf durationMs; matched tool-call wall time is counted once as totals.callDurationMs.',
    'Models are emitted only for currently configured agent primary/fallback IDs; unknown or historical values are redacted and counted.',
    'Configured model IDs come from repository agent frontmatter; no live model inventory or model call occurs.',
    'Static prompt checks are shape checks, not behavioral model evaluations; this report makes no model calls.',
  ].join('\n') + '\n'
}

export function parseArgs(argv) {
  let format = 'table'
  const paths = []
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--format') format = argv[++index] ?? ''
    else if (argument.startsWith('--format=')) format = argument.slice('--format='.length)
    else if (argument.startsWith('-')) throw new Error('unknown option')
    else paths.push(argument)
  }
  if (!['table', 'json'].includes(format)) throw new Error('format must be table or json')
  return { format, paths, help }
}

export function collectJsonlFiles(paths, limits = DEFAULT_INPUT_LIMITS) {
  const validatedLimits = validateInputLimits(limits)
  const files = []
  const visit = (path, directoryEntry, depth) => {
    let info
    try { info = lstatSync(path) } catch { throw new Error('could not read explicit JSONL input') }
    if (info.isSymbolicLink()) throw inputError('unsupportedInput')
    if (info.isFile()) {
      if (!path.endsWith('.jsonl')) { if (!directoryEntry) throw inputError('nonJsonl'); return }
      if (info.size > validatedLimits.maxBytesPerFile) throw inputError('fileSizeLimit')
      if (files.length >= validatedLimits.maxFiles) throw inputError('fileCountLimit')
      files.push(path)
    } else if (info.isDirectory()) {
      if (depth > validatedLimits.maxDepth) throw inputError('depthLimit')
      let entries
      try { entries = readdirSync(path).sort() } catch { throw new Error('could not read explicit JSONL input') }
      for (const entry of entries) visit(join(path, entry), true, depth + 1)
    } else throw inputError('unsupportedInput')
  }
  for (const path of paths) visit(path, false, 0)
  if (files.length === 0) throw inputError('noFiles')
  return files
}

export function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseArgs(argv) } catch (error) { console.error(`ERROR: ${error.message}`); return 1 }
  if (options.help || options.paths.length === 0) { console.log(helpText().trimEnd()); return 0 }
  let report
  try {
    const files = collectJsonlFiles(options.paths, DEFAULT_INPUT_LIMITS)
    const reports = []
    for (const path of files) {
      const bytes = readFileSync(path)
      if (bytes.byteLength > DEFAULT_INPUT_LIMITS.maxBytesPerFile) throw inputError('fileSizeLimit')
      reports.push(aggregateSessionLines(bytes.toString('utf8').split(/\r?\n/), { agentNames: DEFAULT_AGENT_NAMES, trustedModelIds: DEFAULT_TRUSTED_MODEL_IDS }))
    }
    report = mergeUsageReports(reports, { agentNames: DEFAULT_AGENT_NAMES, trustedModelIds: DEFAULT_TRUSTED_MODEL_IDS })
  } catch (error) {
    console.error(`ERROR: ${formatInputError(error)}`)
    return 1
  }
  process.stdout.write(formatReport(report, options.format))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = main()
