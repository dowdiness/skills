import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { aggregateSessionLines, formatReport } from './agent-usage-report.mjs'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const fixtureDirectory = resolve(repositoryRoot, 'scripts/fixtures/agent-sessions')
const script = resolve(repositoryRoot, 'scripts/agent-usage-report.mjs')
const fixtureText = readFileSync(resolve(fixtureDirectory, 'successful-single.jsonl'), 'utf8')

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
    invocations: 5,
    runtime: { success: 2, failure: 2, aborted: 1 },
    usage: { input: 41, output: 18, turns: 7 },
    durationMs: 6500,
  })
  expect(report.missingLeaves).toBe(1)
  expect(report.malformedRecords).toBe(1)
  expect(report.unknownRecords).toBe(1)
  expect(report.agents.find((item) => item.agent === 'scout')).toMatchObject({
    invocations: 1,
    runtime: { success: 0, failure: 1, aborted: 0 },
  })
})

test('table output contains aggregates but omits sensitive fixture data and paths', () => {
  const result = run('--format', 'table', fixtureDirectory)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('worker')
  expect(result.stdout).toContain('missingLeaves=1')
  expect(result.stdout).not.toContain('FAKE_')
  expect(result.stdout).not.toContain(fixtureDirectory)
  expect(result.stdout).not.toContain('successful-single.jsonl')
  expect(result.stderr).toBe('')
})

test('JSON output is versioned, aggregate-only, and omits sensitive fixture data and paths', () => {
  const result = run('--format=json', fixtureDirectory)
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
  expect(formatReport(report, 'json')).toContain('schemaVersion')
})
