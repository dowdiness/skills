import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import {
  checkAgentLinks,
  checkExtensions,
  checkModels,
  extensionFilterExcludes,
  collectEnvironment,
  diagnoseAgentEnvironment,
  isDevelopmentSkillsExtensionOverride,
} from './check-agent-env.mjs'

const script = resolve(new URL('./check-agent-env.mjs', import.meta.url).pathname)
const PIN = 'a'.repeat(40)

function makeFixture({
  pin = PIN,
  head = pin,
  filters,
  overrides,
  inventory = 'test-provider test-model 128K\n',
  inventoryStatus = 0,
  includeLinks = true,
  deprecated = [],
  missingIndexes = [],
  autoload,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'check-agent-env-test-'))
  const packageRoot = join(home, '.pi', 'agent', 'git', 'github.com', 'dowdiness', 'skills')
  const packageAgents = join(packageRoot, 'agents')
  const packageExtensions = join(packageRoot, 'extensions')
  const globalAgents = join(home, '.pi', 'agent', 'agents')
  mkdirSync(packageAgents, { recursive: true })
  mkdirSync(join(packageExtensions, 'scheduler'), { recursive: true })
  mkdirSync(join(packageExtensions, 'subagent'), { recursive: true })
  for (const name of ['scheduler', 'subagent']) {
    if (!missingIndexes.includes(name)) writeFileSync(join(packageExtensions, name, 'index.ts'), '// fixture entrypoint\n')
  }
  mkdirSync(globalAgents, { recursive: true })

  for (const name of ['reviewer.md', 'worker.md']) {
    writeFileSync(join(packageAgents, name), `---\nname: ${name.slice(0, -3)}\ndescription: fixture\nmodel: test-provider/test-model\n---\n`)
    if (includeLinks) symlinkSync(join(packageAgents, name), join(globalAgents, name))
  }
  for (const name of deprecated) writeFileSync(join(globalAgents, name), 'deprecated')
  writeFileSync(join(globalAgents, 'my-custom-agent.md'), 'unrelated user agent')

  const packageEntry = { source: `git:github.com/dowdiness/skills@${pin}` }
  if (filters !== undefined) packageEntry.extensions = filters
  if (autoload !== undefined) packageEntry.autoload = autoload
  const settings = {
    packages: [packageEntry],
    ...(overrides === undefined ? {} : { extensions: overrides }),
  }
  const settingsPath = join(home, '.pi', 'agent', 'settings.json')
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`)

  const commands = []
  const runCommand = (command, args) => {
    commands.push([command, ...args])
    if (command === 'git') return { status: 0, stdout: `${head}\n`, stderr: '' }
    if (command === 'pi' && args[0] === '--offline' && args[1] === '--list-models') {
      return { status: inventoryStatus, stdout: inventory, stderr: inventoryStatus === 0 ? '' : 'inventory unavailable' }
    }
    if (command === 'pi' && args[0] === '--offline' && args[1] === '--no-session' && args[2] === '--no-tools' && args[3] === '--help') {
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' }
  }

  return { home, packageRoot, globalAgents, commands, runCommand, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function withFixture(options, callback) {
  const fixture = makeFixture(options)
  try {
    return callback(fixture)
  } finally {
    fixture.cleanup()
  }
}

test('healthy temporary package environment passes without making a model request', () => {
  withFixture({}, (fixture) => {
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))

    expect(report.summary).toEqual({ status: 'PASS', pass: 7, warn: 0, fail: 0 })
    expect(fixture.commands).toEqual([
      ['git', '-C', fixture.packageRoot, 'rev-parse', 'HEAD'],
      ['pi', '--offline', '--list-models'],
      ['pi', '--offline', '--no-session', '--no-tools', '--help'],
    ])
    expect(fixture.commands.flat()).not.toContain('-p')
  })
})

test('reports invalid pins, mismatched checkouts, and broken managed links', () => {
  withFixture({ pin: 'main', head: PIN, includeLinks: false }, (fixture) => {
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))

    expect(report.checks.find((item) => item.name === 'package-pin')).toMatchObject({ status: 'FAIL' })
    expect(report.checks.find((item) => item.name === 'checkout')).toMatchObject({ status: 'FAIL' })
    expect(report.checks.find((item) => item.name === 'agent-links')).toMatchObject({ status: 'FAIL' })
    expect(report.exitCode).toBe(1)
  })
})

test('rejects deprecated lens links and package extension filters while ignoring custom agents', () => {
  withFixture({ filters: ['!extensions/scheduler/**'], deprecated: ['reviewer-flash.md'] }, (fixture) => {
    const snapshot = collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand })
    const report = diagnoseAgentEnvironment(snapshot)

    expect(report.checks.find((item) => item.name === 'agent-links')).toMatchObject({ status: 'FAIL' })
    expect(report.checks.find((item) => item.name === 'agent-links').detail).toContain('reviewer-flash.md')
    expect(report.checks.find((item) => item.name === 'extensions')).toMatchObject({ status: 'FAIL' })
    expect(snapshot.agentLinks.links['my-custom-agent.md']).toBeUndefined()
    expect(checkAgentLinks(snapshot.package, snapshot.agentLinks).detail).not.toContain('my-custom-agent')
  })
})

test('matches package filters against the exact extension entrypoints', () => {
  expect(extensionFilterExcludes(undefined, 'scheduler')).toBe(false)
  expect(extensionFilterExcludes([], 'scheduler')).toBe(true)
  expect(extensionFilterExcludes(['extensions/*/index.ts'], 'scheduler')).toBe(false)
  expect(extensionFilterExcludes(['./extensions/*/index.ts'], 'subagent')).toBe(false)
  expect(extensionFilterExcludes([' extensions/*/index.ts '], 'scheduler')).toBe(true)
  expect(extensionFilterExcludes(['extensions/scheduler'], 'scheduler')).toBe(true)
  expect(extensionFilterExcludes(['extensions/scheduler/**'], 'scheduler')).toBe(false)
  expect(extensionFilterExcludes(['extensions/scheduler/index.ts'], 'scheduler')).toBe(false)
  expect(extensionFilterExcludes(['extensions/**'], 'scheduler')).toBe(false)
  expect(extensionFilterExcludes(['extensions/**'], 'subagent')).toBe(false)
})

test('requires discoverable extension entrypoint files, not just directories', () => {
  withFixture({ missingIndexes: ['scheduler'] }, (fixture) => {
    const snapshot = collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand })
    const report = diagnoseAgentEnvironment(snapshot)

    expect(snapshot.package.requiredExtensions.scheduler).toBe(false)
    expect(report.checks.find((item) => item.name === 'extensions')).toMatchObject({ status: 'FAIL' })
  })
})

test('force-exclude wins over a force-include for the same entrypoint', () => {
  expect(
    extensionFilterExcludes(
      ['+./extensions/scheduler/index.ts', '-extensions/scheduler/index.ts'],
      'scheduler'
    )
  ).toBe(true)
})

test('autoload false applies later matching patterns last', () => {
  expect(
    extensionFilterExcludes(
      ['extensions/*/index.ts', '!extensions/scheduler/**'],
      'scheduler',
      undefined,
      false
    )
  ).toBe(true)
  expect(
    extensionFilterExcludes(
      ['!extensions/scheduler/**', 'extensions/*/index.ts'],
      'scheduler',
      undefined,
      false
    )
  ).toBe(false)
})

test('autoload false can enable both required entrypoints with explicit patterns', () => {
  withFixture({ autoload: false, filters: ['extensions/*/index.ts'] }, (fixture) => {
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))

    expect(report.checks.find((item) => item.name === 'extensions')).toMatchObject({ status: 'PASS' })
  })
})

test('distinguishes model inventory command failures from unavailable configured IDs', () => {
  withFixture({ inventoryStatus: 1 }, (fixture) => {
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))
    const modelCheck = report.checks.find((item) => item.name === 'models')
    expect(modelCheck.status).toBe('FAIL')
    expect(modelCheck.detail).toContain('command/inventory failure')
  })

  withFixture({ inventory: 'other-provider other-model 128K\n' }, (fixture) => {
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))
    const modelCheck = report.checks.find((item) => item.name === 'models')
    expect(modelCheck.status).toBe('WARN')
    expect(modelCheck.detail).toContain('configured model IDs unavailable: test-provider/test-model')
  })
})

test('rejects only absolute overrides that point into the skills checkout', () => {
  withFixture({ overrides: ['/opt/unrelated-extension/index.ts'] }, (fixture) => {
    expect(isDevelopmentSkillsExtensionOverride('/home/src/dowdiness/skills/extensions/scheduler', fixture.packageRoot)).toBe(true)
    expect(isDevelopmentSkillsExtensionOverride('/opt/unrelated-extension/index.ts', fixture.packageRoot)).toBe(false)
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))
    expect(report.checks.find((item) => item.name === 'extension-overrides')).toMatchObject({ status: 'PASS' })
  })

  withFixture({ overrides: ['/home/src/dowdiness/skills/extensions/scheduler/index.ts'] }, (fixture) => {
    const report = diagnoseAgentEnvironment(collectEnvironment({ home: fixture.home, runCommand: fixture.runCommand }))
    expect(report.checks.find((item) => item.name === 'extension-overrides')).toMatchObject({ status: 'FAIL' })
  })
})

test('json CLI output is machine-readable with fake pi and git commands', () => {
  const fixture = makeFixture()
  const bin = join(fixture.home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' '${PIN}'\n`)
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\nif [ "$1" = "--offline" ] && [ "$2" = "--list-models" ]; then printf \'test-provider test-model 128K\\n\'; fi\nexit 0\n')
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'pi'), 0o755)
  try {
    const result = spawnSync(process.execPath, [script, '--json'], {
      env: { ...process.env, HOME: fixture.home, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.summary).toEqual({ status: 'PASS', pass: 7, warn: 0, fail: 0 })
    expect(result.stdout.trim().startsWith('{')).toBe(true)
  } finally {
    fixture.cleanup()
  }
})