#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { EXPECTED_AGENT_NAMES } from './agent-prompt-contracts.mjs'

export const SCHEMA_VERSION = 1
const AGENT_NAMES = new Set(EXPECTED_AGENT_NAMES)
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'contextTokens', 'cost', 'turns']

function emptyUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]))
}

function emptyAgent(agent) {
  return {
    agent,
    invocations: 0,
    runtime: { success: 0, failure: 0, aborted: 0 },
    models: new Set(),
    usage: emptyUsage(),
    durationMs: 0,
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false
  for (const field of USAGE_FIELDS) target[field] += numberOrZero(usage[field])
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
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
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

function addLeaf(state, leaf, durationMs = null) {
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
  if (typeof leaf.model === 'string' && leaf.model.trim()) aggregate.models.add(leaf.model.trim())
  if (!addUsage(aggregate.usage, leaf.usage)) state.malformedRecords += 1
  if (durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0) aggregate.durationMs += durationMs
  return leaf.agent
}

function addMissingLeaf(state, agent) {
  const aggregate = state.agents.get(agent)
  aggregate.invocations += 1
  aggregate.runtime.failure += 1
  state.missingLeaves += 1
}

function emptyTotals() {
  return {
    invocations: 0,
    runtime: { success: 0, failure: 0, aborted: 0 },
    models: new Set(),
    usage: emptyUsage(),
    durationMs: 0,
  }
}

function finalizeAggregate(state) {
  const totals = emptyTotals()
  const agents = [...state.agents.values()].sort((a, b) => a.agent.localeCompare(b))
  for (const aggregate of agents) {
    totals.invocations += aggregate.invocations
    for (const key of ['success', 'failure', 'aborted']) totals.runtime[key] += aggregate.runtime[key]
    for (const model of aggregate.models) totals.models.add(model)
    for (const field of USAGE_FIELDS) totals.usage[field] += aggregate.usage[field]
    totals.durationMs += aggregate.durationMs
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
    },
    unknownRecords: state.unknownRecords,
    malformedRecords: state.malformedRecords,
    missingLeaves: state.missingLeaves,
  }
}

export function aggregateSessionRecords(records) {
  const extracted = extractRecords(records)
  const state = {
    agents: new Map(EXPECTED_AGENT_NAMES.map((agent) => [agent, emptyAgent(agent)])),
    unknownRecords: extracted.unknownRecords,
    malformedRecords: extracted.malformedRecords,
    missingLeaves: 0,
  }
  const matchedCallIds = new Set()

  for (const result of extracted.results) {
    const call = extracted.calls.get(result.toolCallId)
    if (call) matchedCallIds.add(result.toolCallId)
    const seenAgents = new Map()
    for (const leaf of result.leaves) {
      const duration = call ? (result.timestamp !== null && call.timestamp !== null ? result.timestamp - call.timestamp : null) : null
      const agent = addLeaf(state, leaf, duration)
      if (agent) seenAgents.set(agent, (seenAgents.get(agent) ?? 0) + 1)
    }
    if (call) {
      for (const agent of call.requested) {
        const count = seenAgents.get(agent) ?? 0
        if (count > 0) seenAgents.set(agent, count - 1)
        else addMissingLeaf(state, agent)
      }
    }
  }

  for (const [toolCallId, call] of extracted.calls) {
    if (matchedCallIds.has(toolCallId)) continue
    for (const agent of call.requested) addMissingLeaf(state, agent)
  }

  return finalizeAggregate(state)
}

export function aggregateSessionLines(lines) {
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
  const report = aggregateSessionRecords(records)
  report.malformedRecords += malformedRecords
  return report
}

export function formatReport(report, format = 'table') {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`
  const lines = [
    'Agent usage report (runtime evidence only; no task, cwd, content, messages, response, or path data)',
    'agent                 invocations success failure aborted turns input output cacheRead cacheWrite contextTokens cost durationMs models',
  ]
  for (const aggregate of report.agents) {
    lines.push([
      aggregate.agent.padEnd(21),
      String(aggregate.invocations).padStart(11),
      String(aggregate.runtime.success).padStart(7),
      String(aggregate.runtime.failure).padStart(7),
      String(aggregate.runtime.aborted).padStart(7),
      String(aggregate.usage.turns).padStart(6),
      String(aggregate.usage.input).padStart(5),
      String(aggregate.usage.output).padStart(6),
      String(aggregate.usage.cacheRead).padStart(9),
      String(aggregate.usage.cacheWrite).padStart(10),
      String(aggregate.usage.contextTokens).padStart(13),
      String(aggregate.usage.cost).padStart(6),
      String(aggregate.durationMs).padStart(10),
      aggregate.models.join(',') || '-',
    ].join(' '))
  }
  lines.push(`totals: invocations=${report.totals.invocations} success=${report.totals.runtime.success} failure=${report.totals.runtime.failure} aborted=${report.totals.runtime.aborted} turns=${report.totals.usage.turns} input=${report.totals.usage.input} output=${report.totals.usage.output} durationMs=${report.totals.durationMs}`)
  lines.push(`unknownRecords=${report.unknownRecords} malformedRecords=${report.malformedRecords} missingLeaves=${report.missingLeaves}`)
  return `${lines.join('\n')}\n`
}

export function helpText() {
  return [
    'Usage: npm run agent-usage-report -- [--format table|json] <explicit-jsonl-file-or-directory> [...]',
    '',
    'Reads only the explicitly supplied JSONL files or directories and emits aggregate runtime evidence.',
    'Default with no paths: print this help and exit 0; no home-directory scan is performed.',
    'Privacy boundary: task, cwd, content, messages, response text, credentials, paths, and filenames are omitted.',
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

function collectJsonlFiles(paths) {
  const files = []
  const visit = (path, directoryEntry) => {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      if (directoryEntry) return
      throw new Error('unsupported input')
    }
    if (info.isFile()) {
      if (!directoryEntry || path.endsWith('.jsonl')) files.push(path)
    } else if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), true)
    } else throw new Error('unsupported input')
  }
  for (const path of paths) visit(path, false)
  if (files.length === 0) throw new Error('no input files')
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
    const files = collectJsonlFiles(options.paths)
    const lines = files.flatMap((path) => readFileSync(path, 'utf8').split(/\r?\n/))
    report = aggregateSessionLines(lines)
  } catch {
    console.error('ERROR: could not read explicit JSONL input')
    return 1
  }
  process.stdout.write(formatReport(report, options.format))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
