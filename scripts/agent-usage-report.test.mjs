import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  aggregateSessionLines,
  collectJsonlFiles,
  formatInputError,
  formatReport,
  DEFAULT_INPUT_LIMITS,
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

function runWithEnv(env, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
  expect(report.unknownRecords).toBe(4)
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
  expect(report.agents.find((item) => item.agent === 'worker').models).toEqual(['openai-codex/gpt-5.6-luna'])
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

test('configured model trust is static and import/help never invoke pi', () => {
  const usageSource = readFileSync(script, 'utf8')
  const validatorPath = resolve(repositoryRoot, 'scripts/validate-agent-models.mjs')
  const validatorSource = readFileSync(validatorPath, 'utf8')
  expect(usageSource).toContain("collectConfiguredAgentModelIds")
  expect(usageSource).not.toContain("spawnSync('pi'")
  expect(validatorSource).toContain("spawnSync('pi', ['--list-models']")
  expect(validatorSource).toContain('if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))')

  const root = mkdtempSync(join(tmpdir(), 'agent-usage-report-pi-'))
  const marker = join(root, 'pi-called')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fakePi = join(bin, 'pi')
  writeFileSync(fakePi, '#!/bin/sh\ntouch "$PI_MARKER"\nexit 99\n')
  chmodSync(fakePi, 0o755)
  try {
    const env = { PATH: bin, PI_MARKER: marker }
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(script).href)})`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    expect(imported.status).toBe(0)
    expect(runWithEnv(env, '--help').status).toBe(0)
    expect(() => readFileSync(marker)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

test('untrusted, token-like, and malformed model IDs are omitted from table and JSON', () => {
  const privatePath = 'private/repo/secret'
  const tokenLike = 'sk-live-1234567890'
  const control = '\u001b[31mSECRET\u001b[0m\\n'
  const trusted = new Set(['test/provider-model:high'])
  const report = aggregateSessionLines([JSON.stringify({
    message: {
      toolName: 'subagent',
      details: {
        results: [
          { agent: 'scout', exitCode: 0, model: privatePath },
          { agent: 'worker', exitCode: 0, model: tokenLike },
          { agent: 'planner', exitCode: 0, model: control },
          { agent: 'reviewer', exitCode: 0, model: 'test/provider-model:high' },
        ],
      },
    },
  })], { trustedModelIds: trusted })
  const json = formatReport(report, 'json')
  const table = formatReport(report, 'table')
  expect(report.agents.find((agent) => agent.agent === 'reviewer').models).toEqual(['test/provider-model'])
  expect(report.totals.models).toEqual(['test/provider-model'])
  expect(report.unknownRecords).toBe(2)
  expect(report.malformedRecords).toBe(1)
  for (const value of [privatePath, tokenLike, 'SECRET', '\\u001b']) {
    expect(json).not.toContain(value)
    expect(table).not.toContain(value)
  }

  const source = {
    schemaVersion: 1,
    agents: [{ agent: 'worker', invocations: 0, runtime: {}, usage: {}, durationMs: 0, models: [privatePath, 'test/provider-model'] }],
    unknownRecords: 0,
    malformedRecords: 0,
    missingLeaves: 0,
    totals: { callDurationMs: 0 },
  }
  const merged = mergeUsageReports([source], { trustedModelIds: new Set(['test/provider-model']) })
  expect(merged.agents.find((agent) => agent.agent === 'worker').models).toEqual(['test/provider-model'])
  expect(merged.unknownRecords).toBe(1)
  const rechecked = mergeUsageReports([source], { trustedModelIds: new Set(['other/model']) })
  expect(rechecked.totals.models).toEqual([])
  expect(rechecked.unknownRecords).toBe(2)
  expect(() => aggregateSessionLines([], { trustedModelIds: new Set([control]) })).toThrow('invalid trusted model IDs')
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

test('defaults cover the observed session corpus and injected limits bound collection', () => {
  expect(MAX_INPUT_FILES).toBeGreaterThanOrEqual(668)
  expect(MAX_FILE_BYTES).toBeGreaterThan(35.6 * 1024 * 1024)
  expect(DEFAULT_INPUT_LIMITS).toEqual({ maxFiles: MAX_INPUT_FILES, maxBytesPerFile: MAX_FILE_BYTES, maxDepth: MAX_RECURSION_DEPTH })

  const root = mkdtempSync(join(tmpdir(), 'agent-usage-report-'))
  const limits = { maxFiles: 2, maxBytesPerFile: 4, maxDepth: 2 }
  try {
    const countDir = join(root, 'count')
    mkdirSync(countDir)
    for (let index = 0; index <= limits.maxFiles; index += 1) writeFileSync(join(countDir, `${index}.jsonl`), '')
    expect(() => collectJsonlFiles([countDir], limits)).toThrow('input file count limit exceeded')
    try {
      collectJsonlFiles([countDir], limits)
    } catch (error) {
      expect(formatInputError(error)).toBe('input file count limit exceeded')
      expect(formatInputError(error)).not.toContain(root)
    }

    const depthDir = join(root, 'depth')
    let current = depthDir
    mkdirSync(current)
    for (let index = 0; index <= limits.maxDepth; index += 1) {
      current = join(current, 'nested')
      mkdirSync(current)
    }
    expect(() => collectJsonlFiles([depthDir], limits)).toThrow('input directory depth limit exceeded')

    const large = join(root, 'large.jsonl')
    writeFileSync(large, '12345')
    expect(() => collectJsonlFiles([large], limits)).toThrow('input file size limit exceeded')
    expect(() => collectJsonlFiles([large], { maxFiles: 0 })).toThrow('invalid input limits')

    const target = join(root, 'target.jsonl')
    writeFileSync(target, '')
    const link = join(root, 'link.jsonl')
    try {
      symlinkSync(target, link)
      expect(() => collectJsonlFiles([link], limits)).toThrow('unsupported input')
    } catch (error) {
      if (error?.code !== 'EPERM') throw error
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('explicit non-JSONL files are rejected with a specific path-free CLI error', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-usage-report-'))
  const nonJsonl = join(root, 'private.txt')
  try {
    writeFileSync(nonJsonl, 'not a session')
    const result = run(nonJsonl)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('non-JSONL explicit input rejected')
    expect(result.stderr).not.toContain(root)
    expect(result.stderr).not.toContain('private.txt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('directory scanning skips non-JSONL files and does not expose their contents or filenames', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-usage-report-'))
  try {
    const jsonlPath = join(root, 'session.jsonl')
    writeFileSync(jsonlPath, fixtureText)
    const nonJsonlPath = join(root, 'config.yml')
    writeFileSync(nonJsonlPath, 'API_KEY=sk-fake-secret-12345')

    const files = collectJsonlFiles([root])
    expect(files).toEqual([jsonlPath])

    const cliResult = run(root)
    expect(cliResult.status).toBe(0)
    expect(cliResult.stdout).toContain('worker')
    expect(cliResult.stdout).not.toContain('config.yml')
    expect(cliResult.stdout).not.toContain('API_KEY')
    expect(cliResult.stdout).not.toContain('sk-fake-secret-12345')
    expect(cliResult.stderr).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
