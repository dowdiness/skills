#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { EXPECTED_AGENT_NAMES } from './agent-prompt-contracts.mjs'
import { collectConfiguredAgentModelIds, normalizeModelId } from './validate-agent-models.mjs'

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
  if (error?.name === 'InputError' && Object.hasOwn(INPUT_ERROR_MESSAGES, error.code)) {
    return INPUT_ERROR_MESSAGES[error.code]
  }
  return 'could not read explicit JSONL input'
}

function validateInputLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('invalid input limits')
  }
  const keys = Object.keys(limits)
  if (keys.some((key) => !Object.hasOwn(DEFAULT_INPUT_LIMITS, key))) {
    throw new TypeError('invalid input limits')
  }
  const normalized = { ...DEFAULT_INPUT_LIMITS, ...limits }
  if (!Number.isSafeInteger(normalized.maxFiles) || normalized.maxFiles < 1
    || !Number.isSafeInteger(normalized.maxBytesPerFile) || normalized.maxBytesPerFile < 0
    || !Number.isSafeInteger(normalized.maxDepth) || normalized.maxDepth < 0) {
    throw new TypeError('invalid input limits')
  }
  return Object.freeze(normalized)
}

const AGENT_NAMES = new Set(EXPECTED_AGENT_NAMES)
const USAGE_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'contextTokens', 'turns'])
const RUNTIME_FIELDS = Object.freeze(['success', 'failure', 'aborted', 'unresolved'])
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+@:-]{0,199}$/

function normalizeTrustedModelIds(values, strict = true) {
  if (!values || (typeof values !== 'object' && !Array.isArray(values))) {
    throw new TypeError('invalid trusted model IDs')
  }
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

function trustedModelIdsFromOptions(options) {
  if (options === undefined) return DEFAULT_TRUSTED_MODEL_IDS
  if (options instanceof Set || Array.isArray(options)) return normalizeTrustedModelIds(options)
  if (!options || typeof options !== 'object') throw new TypeError('invalid usage report options')
  const keys = Object.keys(options)
  if (keys.some((key) => key !== 'trustedModelIds')) throw new TypeError('invalid usage report options')
  if (!Object.hasOwn(options, 'trustedModelIds')) return DEFAULT_TRUSTED_MODEL_IDS
  return normalizeTrustedModelIds(options.trustedModelIds)
}

function emptyUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]))
}

function emptyRuntime() {
  return Object.fromEntries(RUNTIME_FIELDS.map((field) => [field, 0]))
}

function emptyAgent(agent) {
  return {
    agent,
    invocations: 0,
    runtime: emptyRuntime(),
    models: new Set(),
    usage: emptyUsage(),
    durationMs: 0,
  }
}

function emptyState(trustedModelIds) {
  return {
    agents: new Map(EXPECTED_AGENT_NAMES.map((agent) => [agent, emptyAgent(agent)])),
    trustedModelIds,
    unknownRecords: 0,
    malformedRecords: 0,
    missingLeaves: 0,
    callDurationMs: 0,
  }
}

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function addSafe(target, field, value) {
  if (!isCounter(value) || target[field] > Number.MAX_SAFE_INTEGER - value) return false
  target[field] += value
  return true
}

function addUsage(state, target, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false
  for (const field of USAGE_FIELDS) {
    if (!(field in usage)) continue
    if (!addSafe(target, field, usage[field])) state.malformedRecords += 1
  }
  return true
}

function resultMessage(record) {
  if (!record || typeof record !== 'object') return null
  if (record.message && typeof record.message === 'object') return record.message
  return record
}

function recordContent(record) {
  if (!record || typeof record !== 'object') return null
  if (Array.isArray(record.content)) return record.content
  if (record.message && Array.isArray(record.message.content)) return record.message.content
  return null
}

function timestampMs(record) {
  const value = record?.timestamp ?? record?.message?.timestamp ?? record?.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value
    return Number.isSafeInteger(milliseconds) ? milliseconds : null
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return null
}

function requestedAgents(argumentsValue) {
  const requested = []
  let unknown = 0
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) {
      unknown += 1
      return
    }
    const agent = value.trim()
    if (AGENT_NAMES.has(agent)) requested.push(agent)
    else unknown += 1
  }
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return { requested, unknown: 1 }
  if (argumentsValue.agent !== undefined) add(argumentsValue.agent)
  for (const field of ['tasks', 'chain']) {
    if (argumentsValue[field] === undefined) continue
    if (!Array.isArray(argumentsValue[field])) {
      unknown += 1
      continue
    }
    for (const task of argumentsValue[field]) {
      if (typeof task === 'string') add(task)
      else if (task && typeof task === 'object') add(task.agent)
      else unknown += 1
    }
  }
  return { requested, unknown }
}

function extractRecords(records) {
  const calls = new Map()
  const results = []
  let malformedRecords = 0
  let unknownRecords = 0

  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      malformedRecords += 1
      continue
    }

    const content = recordContent(record)
    if (content) {
      for (const item of content) {
        if (!item || typeof item !== 'object' || item.name !== 'subagent') continue
        if (item.type !== 'toolCall' || typeof item.id !== 'string' || !item.id) {
          malformedRecords += 1
          continue
        }
        const request = requestedAgents(item.arguments)
        unknownRecords += request.unknown
        calls.set(item.id, {
          requested: request.requested,
          timestamp: timestampMs(record),
        })
        if (request.requested.length === 0) unknownRecords += 1
      }
    }

    const message = resultMessage(record)
    if (message?.toolName !== 'subagent') {
      if (record.type === 'unknown' || record.kind === 'unknown') unknownRecords += 1
      continue
    }
    const details = message.details ?? record.details
    if (!details || typeof details !== 'object' || !Array.isArray(details.results)) {
      malformedRecords += 1
      results.push({ toolCallId: message.toolCallId ?? record.toolCallId, leaves: [], timestamp: timestampMs(record) })
      continue
    }
    results.push({
      toolCallId: message.toolCallId ?? record.toolCallId,
      leaves: details.results,
      timestamp: timestampMs(record),
    })
  }

  return { calls, results, malformedRecords, unknownRecords }
}

function addLeaf(state, leaf) {
  if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) {
    state.malformedRecords += 1
    return null
  }
  if (typeof leaf.agent !== 'string' || !AGENT_NAMES.has(leaf.agent)) {
    state.unknownRecords += 1
    return null
  }
  const aggregate = state.agents.get(leaf.agent)
  aggregate.invocations += 1
  if (leaf.exitCode === 0) aggregate.runtime.success += 1
  else if (leaf.stopReason === 'aborted' || leaf.exitCode === 130) aggregate.runtime.aborted += 1
  else aggregate.runtime.failure += 1

  if ('model' in leaf) {
    if (typeof leaf.model !== 'string') {
      state.malformedRecords += 1
    } else {
      const modelId = normalizeModelId(leaf.model)
      if (!MODEL_ID_PATTERN.test(modelId)) state.malformedRecords += 1
      else if (!state.trustedModelIds.has(modelId)) state.unknownRecords += 1
      else aggregate.models.add(modelId)
    }
  }
  if ('usage' in leaf && !addUsage(state, aggregate.usage, leaf.usage)) state.malformedRecords += 1
  if ('durationMs' in leaf) {
    if (!addSafe(aggregate, 'durationMs', leaf.durationMs)) state.malformedRecords += 1
  }
  return leaf.agent
}

function addMissingLeaf(state, agent) {
  const aggregate = state.agents.get(agent)
  aggregate.runtime.unresolved += 1
  state.missingLeaves += 1
}

function addCallDuration(state, call, result) {
  if (call.timestamp === null || result.timestamp === null) return
  const duration = result.timestamp - call.timestamp
  if (!addSafe(state, 'callDurationMs', duration)) state.malformedRecords += 1
}

function emptyTotals() {
  return {
    invocations: 0,
    runtime: emptyRuntime(),
    models: new Set(),
    usage: emptyUsage(),
    durationMs: 0,
  }
}

function finalizeAggregate(state) {
  const totals = emptyTotals()
  const agents = [...state.agents.values()].sort((a, b) => a.agent.localeCompare(b))
  for (const aggregate of agents) {
    if (!addSafe(totals, 'invocations', aggregate.invocations)) state.malformedRecords += 1
    for (const key of RUNTIME_FIELDS) {
      if (!addSafe(totals.runtime, key, aggregate.runtime[key])) state.malformedRecords += 1
    }
    for (const model of aggregate.models) totals.models.add(model)
    for (const field of USAGE_FIELDS) {
      if (!addSafe(totals.usage, field, aggregate.usage[field])) state.malformedRecords += 1
    }
    if (!addSafe(totals, 'durationMs', aggregate.durationMs)) state.malformedRecords += 1
  }
  const serialize = (aggregate) => ({
    agent: aggregate.agent,
    invocations: aggregate.invocations,
    runtime: { ...aggregate.runtime },
    models: [...aggregate.models].sort(),
    usage: { ...aggregate.usage },
    durationMs: aggregate.durationMs,
  })
  return {
    schemaVersion: SCHEMA_VERSION,
    agents: agents.map(serialize),
    totals: {
      invocations: totals.invocations,
      runtime: { ...totals.runtime },
      models: [...totals.models].sort(),
      usage: { ...totals.usage },
      durationMs: totals.durationMs,
      callDurationMs: state.callDurationMs,
    },
    unknownRecords: state.unknownRecords,
    malformedRecords: state.malformedRecords,
    missingLeaves: state.missingLeaves,
  }
}

export function aggregateSessionRecords(records, options) {
  const trustedModelIds = trustedModelIdsFromOptions(options)
  const extracted = extractRecords(records)
  const state = emptyState(trustedModelIds)
  state.unknownRecords = extracted.unknownRecords
  state.malformedRecords = extracted.malformedRecords
  const matchedCallIds = new Set()
  const returnedAgents = new Map()

  for (const result of extracted.results) {
    const call = extracted.calls.get(result.toolCallId)
    if (call) {
      if (!matchedCallIds.has(result.toolCallId)) addCallDuration(state, call, result)
      matchedCallIds.add(result.toolCallId)
    }
    for (const leaf of result.leaves) {
      const agent = addLeaf(state, leaf)
      if (call && agent) {
        const byAgent = returnedAgents.get(result.toolCallId) ?? new Map()
        byAgent.set(agent, (byAgent.get(agent) ?? 0) + 1)
        returnedAgents.set(result.toolCallId, byAgent)
      }
    }
  }

  for (const [toolCallId, call] of extracted.calls) {
    const seenAgents = returnedAgents.get(toolCallId) ?? new Map()
    for (const agent of call.requested) {
      const count = seenAgents.get(agent) ?? 0
      if (count > 0) seenAgents.set(agent, count - 1)
      else addMissingLeaf(state, agent)
    }
  }

  return finalizeAggregate(state)
}

export function aggregateSessionLines(lines, options) {
  const trustedModelIds = trustedModelIdsFromOptions(options)
  const records = []
  let malformedRecords = 0
  for (const line of lines) {
    if (!String(line).trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      malformedRecords += 1
    }
  }
  const report = aggregateSessionRecords(records, { trustedModelIds })
  report.malformedRecords += malformedRecords
  return report
}

function mergeCounter(state, target, field, value) {
  if (value === undefined) return
  if (!addSafe(target, field, value)) state.malformedRecords += 1
}

function mergeAgent(state, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    state.malformedRecords += 1
    return
  }
  if (typeof source.agent !== 'string' || !AGENT_NAMES.has(source.agent)) {
    state.unknownRecords += 1
    return
  }
  const target = state.agents.get(source.agent)
  mergeCounter(state, target, 'invocations', source.invocations)
  for (const field of RUNTIME_FIELDS) mergeCounter(state, target.runtime, field, source.runtime?.[field])
  for (const field of USAGE_FIELDS) mergeCounter(state, target.usage, field, source.usage?.[field])
  mergeCounter(state, target, 'durationMs', source.durationMs)
  if (Array.isArray(source.models)) {
    for (const model of source.models) {
      if (typeof model !== 'string') {
        state.malformedRecords += 1
        continue
      }
      const modelId = normalizeModelId(model)
      if (!MODEL_ID_PATTERN.test(modelId)) state.malformedRecords += 1
      else if (!state.trustedModelIds.has(modelId)) state.unknownRecords += 1
      else target.models.add(modelId)
    }
  } else if (source.models !== undefined) state.malformedRecords += 1
}

/** Merge aggregate-only reports without exposing or re-correlating session records. */
export function mergeUsageReports(reports, options) {
  const trustedModelIds = trustedModelIdsFromOptions(options)
  const state = emptyState(trustedModelIds)
  if (!Array.isArray(reports)) {
    state.malformedRecords += 1
    return finalizeAggregate(state)
  }
  for (const report of reports) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      state.malformedRecords += 1
      continue
    }
    if (report.schemaVersion !== undefined && report.schemaVersion !== SCHEMA_VERSION) state.malformedRecords += 1
    if (Array.isArray(report.agents)) {
      for (const source of report.agents) mergeAgent(state, source)
    } else {
      state.malformedRecords += 1
    }
    mergeCounter(state, state, 'unknownRecords', report.unknownRecords)
    mergeCounter(state, state, 'malformedRecords', report.malformedRecords)
    mergeCounter(state, state, 'missingLeaves', report.missingLeaves)
    mergeCounter(state, state, 'callDurationMs', report.totals?.callDurationMs)
  }
  return finalizeAggregate(state)
}

export function formatReport(report, format = 'table') {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`
  const lines = [
    'Agent usage report (runtime evidence only; no task, cwd, content, messages, response, or path data)',
    'agent                 invocations success failure aborted unresolved turns input output cacheRead cacheWrite contextTokens durationMs models',
  ]
  for (const aggregate of report.agents) {
    lines.push([
      aggregate.agent.padEnd(21),
      String(aggregate.invocations).padStart(11),
      String(aggregate.runtime.success).padStart(7),
      String(aggregate.runtime.failure).padStart(7),
      String(aggregate.runtime.aborted).padStart(7),
      String(aggregate.runtime.unresolved).padStart(9),
      String(aggregate.usage.turns).padStart(6),
      String(aggregate.usage.input).padStart(5),
      String(aggregate.usage.output).padStart(6),
      String(aggregate.usage.cacheRead).padStart(9),
      String(aggregate.usage.cacheWrite).padStart(10),
      String(aggregate.usage.contextTokens).padStart(13),
      String(aggregate.durationMs).padStart(10),
      aggregate.models.join(',') || '-',
    ].join(' '))
  }
  lines.push(`totals: invocations=${report.totals.invocations} success=${report.totals.runtime.success} failure=${report.totals.runtime.failure} aborted=${report.totals.runtime.aborted} unresolved=${report.totals.runtime.unresolved} turns=${report.totals.usage.turns} input=${report.totals.usage.input} output=${report.totals.usage.output} durationMs=${report.totals.durationMs} callDurationMs=${report.totals.callDurationMs}`)
  lines.push(`unknownRecords=${report.unknownRecords} malformedRecords=${report.malformedRecords} missingLeaves=${report.missingLeaves} (missing leaves are unresolved evidence, not invocations or failures)`)
  return `${lines.join('\n')}\n`
}

export function helpText() {
  return [
    'Usage: npm run agent-usage-report -- [--format table|json] <explicit-jsonl-file-or-directory> [...]',
    '',
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
    if (argument === '--help' || argument === '-h') {
      help = true
    } else if (argument === '--format') {
      format = argv[++index] ?? ''
    } else if (argument.startsWith('--format=')) {
      format = argument.slice('--format='.length)
    } else if (argument.startsWith('-')) {
      throw new Error('unknown option')
    } else {
      paths.push(argument)
    }
  }
  if (!['table', 'json'].includes(format)) throw new Error('format must be table or json')
  return { format, paths, help }
}

export function collectJsonlFiles(paths, limits = DEFAULT_INPUT_LIMITS) {
  const validatedLimits = validateInputLimits(limits)
  const files = []
  const visit = (path, directoryEntry, depth) => {
    let info
    try {
      info = lstatSync(path)
    } catch {
      throw new Error('could not read explicit JSONL input')
    }
    if (info.isSymbolicLink()) throw inputError('unsupportedInput')
    if (info.isFile()) {
      if (!path.endsWith('.jsonl')) {
        if (!directoryEntry) throw inputError('nonJsonl')
        return
      }
      if (info.size > validatedLimits.maxBytesPerFile) throw inputError('fileSizeLimit')
      if (files.length >= validatedLimits.maxFiles) throw inputError('fileCountLimit')
      files.push(path)
    } else if (info.isDirectory()) {
      if (depth > validatedLimits.maxDepth) throw inputError('depthLimit')
      let entries
      try {
        entries = readdirSync(path).sort()
      } catch {
        throw new Error('could not read explicit JSONL input')
      }
      for (const entry of entries) visit(join(path, entry), true, depth + 1)
    } else throw inputError('unsupportedInput')
  }
  for (const path of paths) visit(path, false, 0)
  if (files.length === 0) throw inputError('noFiles')
  return files
}

export function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    return 1
  }
  if (options.help || options.paths.length === 0) {
    console.log(helpText().trimEnd())
    return 0
  }
  let report
  try {
    const files = collectJsonlFiles(options.paths, DEFAULT_INPUT_LIMITS)
    const reports = []
    for (const path of files) {
      const bytes = readFileSync(path)
      if (bytes.byteLength > DEFAULT_INPUT_LIMITS.maxBytesPerFile) throw inputError('fileSizeLimit')
      reports.push(aggregateSessionLines(bytes.toString('utf8').split(/\r?\n/), { trustedModelIds: DEFAULT_TRUSTED_MODEL_IDS }))
    }
    report = mergeUsageReports(reports, { trustedModelIds: DEFAULT_TRUSTED_MODEL_IDS })
  } catch (error) {
    console.error(`ERROR: ${formatInputError(error)}`)
    return 1
  }
  process.stdout.write(formatReport(report, options.format))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
