import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  aggregateSessionLines,
  collectJsonlFiles,
  formatReport,
  MAX_FILE_BYTES,
  MAX_INPUT_FILES,
  MAX_RECURSION_DEPTH,
  mergeUsageReports,
} from './agent-usage-report.mjs'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const fixtureDirectory = resolve(repositoryRoot, 'scripts/fixtures/agent-sessions')
const script = resolve(repositoryRoot, 'scripts/agent-usage-report.mjs')
const fixtureText = readFileSync(resolve(fixtureDirectory, 'successful-single.jsonl'), 'utf8')
const baseFixturePaths = ['successful-single.jsonl', 'failed-result.jsonl', 'parallel-missing-leaf.jsonl', 'malformed-line.jsonl', 'result-only.jsonl'].map((name) => resolve(fixtureDirectory, name))

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

test('aggregates successful, failed, aborted, missing, malformed, and unknown evidence', () => {
  const lines = []
  for (const name of ['successful-single.jsonl', 'failed-result.jsonl', 'parallel-missing-leaf.jsonl', 'malformed-line.jsonl', 'result-only.jsonl']) {
    lines.push(...readFileSync(resolve(fixtureDirectory, name), 'utf8').split(/\r?\n/))
  }
  const report = aggregateSessionLines(lines)
  expect(report.schemaVersion).toBe(1)
  expect(report.totals).toMatchObject({
    invocations: 4,
    runtime: { success: 2, failure: 1, aborted: 1, unresolved: 1 },
    usage: { input: 41, output: 18, turns: 7 },
    durationMs: 0,
    callDurationMs: 6500,
  })
  expect(report.missingLeaves).toBe(1)
  expect(report.malformedRecords).toBe(1)
  expect(report.unknownRecords).toBe(1)
  expect(report.agents.find((item) => item.agent === 'scout')).toMatchObject({
    invocations: 0,
    runtime: { success: 0, failure: 0, aborted: 0, unresolved: 1 },
  })
})

test('table output contains aggregates but omits sensitive fixture data and paths', () => {
  const result = run('--format', 'table', ...baseFixturePaths)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('worker')
  expect(result.stdout).toContain('missingLeaves=1')
  expect(result.stdout).toContain('unresolved=1')
  expect(result.stdout).toContain('callDurationMs=6500')
  expect(result.stdout).not.toContain('FAKE_')
  expect(result.stdout).not.toContain(fixtureDirectory)
  expect(result.stdout).not.toContain('successful-single.jsonl')
  expect(result.stderr).toBe('')
})

test('JSON output is versioned, aggregate-only, and omits sensitive fixture data and paths', () => {
  const result = run('--format=json', resolve(fixtureDirectory, 'successful-single.jsonl'))
  expect(result.status).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.schemaVersion).toBe(1)
  expect(report.agents.find((item) => item.agent === 'worker').models).toEqual(['test/provider-model'])
  expect(result.stdout).not.toContain('FAKE_')
  expect(result.stdout).not.toContain(fixtureDirectory)
  expect(result.stdout).not.toContain('successful-single.jsonl')
  expect(result.stdout).not.toContain('task')
  expect(result.stdout).not.toContain('cwd')
  expect(result.stdout).not.toContain('messages')
  expect(result.stdout).not.toContain('response')
})

test('default invocation prints help without scanning home or writing files', () => {
  const result = run()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Usage:')
  expect(result.stdout).toContain('no home-directory scan')
  expect(result.stdout).toContain('no model calls')
  expect(result.stderr).toBe('')
})

test('help and invalid format/path behavior are deterministic and path-free', () => {
  const help = run('--help')
  expect(help.status).toBe(0)
  expect(help.stdout).toContain('Privacy boundary')

  const invalidFormat = run('--format', 'xml', fixtureDirectory)
  expect(invalidFormat.status).toBe(1)
  expect(invalidFormat.stderr).toContain('format must be table or json')
  expect(invalidFormat.stderr).not.toContain(fixtureDirectory)

  const invalidPath = run(resolve(fixtureDirectory, 'does-not-exist.jsonl'))
  expect(invalidPath.status).toBe(1)
  expect(invalidPath.stderr).toContain('could not read explicit JSONL input')
  expect(invalidPath.stderr).not.toContain('does-not-exist.jsonl')
})

test('result-only records do not require a tool-call lookup', () => {
  const report = aggregateSessionLines([
    '{"message":{"toolName":"subagent","details":{"results":[{"agent":"worker","exitCode":0,"model":"test/model","stopReason":"completed","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"contextTokens":1,"cost":0,"turns":1}}]}}}',
  ])
  expect(report.totals.invocations).toBe(1)
  expect(report.totals.runtime.unresolved).toBe(0)
  expect(formatReport(report, 'json')).toContain('schemaVersion')
})

test('invalid model IDs and numeric usage are omitted, counted malformed, and never overflow', () => {
  const secret = 'SECRET_API_KEY=top-secret'
  const control = '\u001b[31mSECRET\u001b[0m\\n'
  const overlong = 'A'.repeat(201)
  const report = aggregateSessionLines([JSON.stringify({
    message: {
      toolName: 'subagent',
      details: {
        results: [
          { agent: 'scout', exitCode: 0, model: secret, usage: { input: -1, output: Number.MAX_SAFE_INTEGER + 1, cacheRead: 1.5, cacheWrite: '8', contextTokens: Number.MAX_SAFE_INTEGER, turns: 1, cost: secret } },
          { agent: 'worker', exitCode: 0, model: control, usage: { contextTokens: 1 } },
          { agent: 'planner', exitCode: 0, model: overlong },
        ],
      },
    },
  })])
  const json = formatReport(report, 'json')
  expect(report.totals.invocations).toBe(3)
  expect(report.totals.usage.contextTokens).toBe(Number.MAX_SAFE_INTEGER)
  expect(report.totals.usage.output).toBe(0)
  expect(report.malformedRecords).toBe(8)
  expect(report.agents.every((agent) => agent.models.length === 0)).toBe(true)
  expect(json).not.toContain(secret)
  expect(json).not.toContain('SECRET')
  expect(json).not.toContain('\\u001b')
  expect(json).not.toContain('A'.repeat(201))
  expect(json).not.toContain('cost')
  expect(formatReport(report, 'table')).not.toContain('cost')
})

test('correlation is isolated per file and merge is deterministic', () => {
  const aPath = resolve(fixtureDirectory, 'shared-call-a.jsonl')
  const bPath = resolve(fixtureDirectory, 'shared-call-b.jsonl')
  const a = aggregateSessionLines(readFileSync(aPath, 'utf8').split(/\r?\n/))
  const b = aggregateSessionLines(readFileSync(bPath, 'utf8').split(/\r?\n/))
  const merged = mergeUsageReports([a, b])
  expect(merged.totals).toMatchObject({ invocations: 2, callDurationMs: 7000, durationMs: 18 })
  expect(merged.agents.find((item) => item.agent === 'scout')).toMatchObject({ durationMs: 7, runtime: { success: 1 } })
  expect(merged.agents.find((item) => item.agent === 'worker')).toMatchObject({ durationMs: 11, runtime: { success: 1 } })
  expect(mergeUsageReports([b, a])).toEqual(merged)
  const cli = run('--format=json', aPath, bPath)
  expect(cli.status).toBe(0)
  expect(JSON.parse(cli.stdout)).toEqual(merged)
})

test('call wall time is counted once while leaf durations remain per-agent', () => {
  const report = aggregateSessionLines([
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T03:00:00.000Z', message: { content: [{ type: 'toolCall', id: 'multi', name: 'subagent', arguments: { tasks: [{ agent: 'scout' }, { agent: 'worker' }] } }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T03:00:02.000Z', message: { toolName: 'subagent', toolCallId: 'multi', details: { results: [
      { agent: 'scout', exitCode: 0, durationMs: 13 },
      { agent: 'worker', exitCode: 0, durationMs: 17 },
    ] } } }),
  ])
  expect(report.totals.callDurationMs).toBe(2000)
  expect(report.totals.durationMs).toBe(30)
  expect(report.agents.find((item) => item.agent === 'scout').durationMs).toBe(13)
  expect(report.agents.find((item) => item.agent === 'worker').durationMs).toBe(17)
})

test('explicit input processing is bounded and rejects symlinks without pathful errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-usage-report-'))
  try {
    const countDir = join(root, 'count')
    mkdirSync(countDir)
    for (let index = 0; index <= MAX_INPUT_FILES; index += 1) writeFileSync(join(countDir, `${index}.jsonl`), '')
    expect(() => collectJsonlFiles([countDir])).toThrow('input file count limit exceeded')

    const depthDir = join(root, 'depth')
    let current = depthDir
    mkdirSync(current)
    for (let index = 0; index <= MAX_RECURSION_DEPTH; index += 1) {
      current = join(current, 'nested')
      mkdirSync(current)
    }
    expect(() => collectJsonlFiles([depthDir])).toThrow('input directory depth limit exceeded')

    const large = join(root, 'large.jsonl')
    writeFileSync(large, '')
    truncateSync(large, MAX_FILE_BYTES + 1)
    expect(() => collectJsonlFiles([large])).toThrow('input file size limit exceeded')

    const target = join(root, 'target.jsonl')
    writeFileSync(target, '')
    const link = join(root, 'link.jsonl')
    try {
      symlinkSync(target, link)
      expect(() => collectJsonlFiles([link])).toThrow('unsupported input')
    } catch (error) {
      if (error?.code !== 'EPERM') throw error
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
