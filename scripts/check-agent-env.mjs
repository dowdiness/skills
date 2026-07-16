#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path'
import { normalizeModelId, validateAgentModels } from './validate-agent-models.mjs'

const DEPRECATED_AGENT_NAMES = ['reviewer-flash.md', 'reviewer-mimo.md', 'reviewer-qwen.md']
const REQUIRED_EXTENSIONS = ['scheduler', 'subagent']
const REQUIRED_EXTENSION_ENTRYPOINTS = Object.fromEntries(
  REQUIRED_EXTENSIONS.map((name) => [name, `extensions/${name}/index.ts`])
)
const SKILLS_SOURCE = 'git:github.com/dowdiness/skills'
const PINNED_SOURCE = /^git:github\.com\/dowdiness\/skills@([0-9a-f]{40})$/
const SOURCE_CHECKOUT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const check = (name, status, detail) => ({
  name,
  status,
  detail: String(detail).replace(/[\r\n]+/g, ' ')
})
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sourceOf = (entry) => {
  if (typeof entry === 'string') return entry
  return isObject(entry) ? entry.source : null
}
const isSkillsSource = (source) => {
  if (typeof source !== 'string') return false
  const value = source.trim()
  return (
    value === SKILLS_SOURCE ||
    (value.startsWith(`${SKILLS_SOURCE}@`) && !value.slice(SKILLS_SOURCE.length + 1).includes('/'))
  )
}
const isDirectory = (path) => {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
const exists = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function parseSkillsPackageSource(source) {
  const value = typeof source === 'string' ? source.trim() : ''
  const match = value.match(PINNED_SOURCE)

  return match
    ? {
        source: value,
        ref: match[1],
        pin: match[1].toLowerCase()
      }
    : null
}

export function findSkillsPackageEntries(settings) {
  if (!isObject(settings) || !Array.isArray(settings.packages)) return []
  return settings.packages
    .map((entry, index) => ({ entry, index, source: sourceOf(entry) }))
    .filter(({ source }) => isSkillsSource(source))
    .map((item) => ({ ...item, sourceInfo: parseSkillsPackageSource(item.source) }))
}

export function resolveSkillsPackageRoot(source, home) {
  if (!home || !isSkillsSource(source)) return null

  return join(resolve(home), '.pi/agent/git/github.com/dowdiness/skills')
}

function readSettings(home) {
  if (!home) {
    return {
      path: null,
      exists: false,
      value: null,
      error: 'HOME is not set'
    }
  }

  const path = join(home, '.pi/agent/settings.json')
  try {
    return {
      path,
      exists: true,
      value: JSON.parse(readFileSync(path, 'utf8')),
      error: null
    }
  } catch (error) {
    return {
      path,
      exists: exists(path),
      value: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function resultOf(result) {
  return {
    status: typeof result?.status === 'number' ? result.status : null,
    stdout: typeof result?.stdout === 'string' ? result.stdout : '',
    stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    error: result?.error ? String(result.error?.message ?? result.error) : null
  }
}

export function runCommand(command, args, options = {}) {
  try {
    return resultOf(
      spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options
      })
    )
  } catch (error) {
    return resultOf({ error })
  }
}
const commandOptions = (home) => ({ env: { ...process.env, ...(home ? { HOME: home } : {}) } })
const commandError = (result, command, args) => {
  const detail = result.error || result.stderr.trim()
  return `${command} ${args.join(' ')} command failed${detail ? `: ${detail}` : ` (exit ${result.status ?? 'unknown'})`}`
}

function collectPackageFacts(packageRoot, home, run) {
  const facts = {
    root: packageRoot,
    rootExists: Boolean(packageRoot && isDirectory(packageRoot)),
    head: null,
    headError: null,
    agentsDirectoryExists: false,
    agentNames: [],
    requiredExtensions: Object.fromEntries(REQUIRED_EXTENSIONS.map((name) => [name, false]))
  }
  if (!facts.rootExists) return facts
  const headArgs = ['-C', packageRoot, 'rev-parse', 'HEAD']
  const head = resultOf(run('git', headArgs, commandOptions(home)))
  if (head.status === 0 && /^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    facts.head = head.stdout.trim().toLowerCase()
  } else {
    facts.headError = commandError(head, 'git', headArgs)
  }

  const agents = join(packageRoot, 'agents')
  if (isDirectory(agents)) {
    try {
      facts.agentNames = readdirSync(agents)
        .filter((name) => name.endsWith('.md'))
        .sort()
      facts.agentsDirectoryExists = true
    } catch {
      /* an existing but unreadable agents directory is a failure */
    }
  }
  for (const name of REQUIRED_EXTENSIONS) {
    facts.requiredExtensions[name] = isFile(join(packageRoot, REQUIRED_EXTENSION_ENTRYPOINTS[name]))
  }

  return facts
}

function collectAgentLinkFacts(packageFacts, home) {
  const agentDir = home ? join(home, '.pi/agent/agents') : null
  const links = {}
  for (const name of packageFacts.agentNames) {
    const path = agentDir && join(agentDir, name)
    const expectedPath = join(packageFacts.root, 'agents', name)

    if (!path) {
      links[name] = { state: 'missing', path: null, target: null, expectedPath }
      continue
    }

    try {
      const stat = lstatSync(path)
      if (!stat.isSymbolicLink()) {
        links[name] = { state: 'not-symlink', path, target: null, expectedPath }
      } else {
        const target = resolve(dirname(path), readlinkSync(path))
        links[name] = { state: target === expectedPath ? 'linked' : 'wrong-target', path, target, expectedPath }
      }
    } catch {
      links[name] = { state: 'missing', path, target: null, expectedPath }
    }
  }
  const deprecatedPresent = DEPRECATED_AGENT_NAMES.filter((name) => agentDir && exists(join(agentDir, name)))
  return { agentDir, links, deprecatedPresent }
}

function collectExtensionOverrides(settings, packageRoot) {
  const value = isObject(settings) ? settings.extensions : undefined
  return {
    value,
    invalid: value !== undefined && !Array.isArray(value),
    overrides: Array.isArray(value) ? value.filter((path) => typeof path === 'string' && isAbsolute(path)) : [],
    packageRoot,
    sourceCheckoutRoot: SOURCE_CHECKOUT_ROOT
  }
}

function collectModelFacts(packageFacts, home, run) {
  if (!packageFacts.rootExists || !packageFacts.agentsDirectoryExists)
    return {
      kind: 'collection-failure',
      detail: 'cannot read configured agent models because the installed package agents directory is unavailable'
    }
  try {
    const result = validateAgentModels({
      directory: join(packageFacts.root, 'agents'),
      listModels: () => {
        const inventory = resultOf(run('pi', ['--offline', '--list-models'], commandOptions(home)))
        if (inventory.error || inventory.status !== 0) {
          const detail = inventory.error || inventory.stderr.trim() || `exit ${inventory.status ?? 'unknown'}`
          const error = new Error(`pi --offline --list-models command/inventory failure: ${detail}`)
          error.code = 'MODEL_INVENTORY_FAILURE'
          throw error
        }
        return inventory.stdout
      }
    })
    return {
      kind: 'ok',
      configuredIds: [...new Set(result.configuredIds.map(normalizeModelId).filter(Boolean))].sort(),
      unavailableIds: result.unavailableIds,
      availableIds: [...result.availableIds].sort()
    }
  } catch (error) {
    return {
      kind: error?.code === 'MODEL_INVENTORY_FAILURE' ? 'inventory-failure' : 'collection-failure',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function collectStartupFacts(home, run) {
  const args = ['--offline', '--no-session', '--no-tools', '--help']
  const result = resultOf(run('pi', args, commandOptions(home)))

  return {
    args,
    ok: !result.error && result.status === 0,
    detail: result.error || result.stderr.trim() || (result.status === 0 ? '' : `exit ${result.status ?? 'unknown'}`)
  }
}

export function collectEnvironment({ home = process.env.HOME, runCommand: run = runCommand } = {}) {
  const file = readSettings(home)
  const packageEntries = findSkillsPackageEntries(file.value)
  const selected = packageEntries[0]?.entry ?? null
  const source = sourceOf(selected)
  const sourceInfo = parseSkillsPackageSource(source)
  const packageFacts = collectPackageFacts(resolveSkillsPackageRoot(source, home), home, run)
  const settings = {
    ...file,
    shapeValid: isObject(file.value),
    packageEntries,
    selected,
    source,
    sourceInfo,
    extensionOverrides: collectExtensionOverrides(file.value, packageFacts.root)
  }
  return {
    home,
    settings,
    package: packageFacts,
    agentLinks: collectAgentLinkFacts(packageFacts, home),
    models: collectModelFacts(packageFacts, home, run),
    startup: collectStartupFacts(home, run)
  }
}

export function isPathInsideOrEqual(candidate, parent) {
  if (!candidate || !parent) return false
  const rest = relative(resolve(parent), resolve(candidate))
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}
export function isDevelopmentSkillsExtensionOverride(path, packageRoot, sourceCheckoutRoot = SOURCE_CHECKOUT_ROOT) {
  const sourcePath = resolve(path)
  return (
    isPathInsideOrEqual(sourcePath, packageRoot) ||
    isPathInsideOrEqual(sourcePath, sourceCheckoutRoot) ||
    /(?:^|[\\/])dowdiness[\\/]skills(?:[\\/]|$)/i.test(sourcePath)
  )
}

function normalizedFilter(filter) {
  let value = String(filter).replaceAll('\\', '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value
}
function extensionEntrypointPath(extensionName) {
  const value = normalizedFilter(extensionName)
  return value.startsWith('extensions/') ? value : `extensions/${value}/index.ts`
}
function entrypointCandidates(entrypoint, packageRoot) {
  const relativePath = normalizedFilter(entrypoint)
  const candidates = [relativePath, basename(relativePath)]
  if (packageRoot) candidates.push(normalizedFilter(resolve(packageRoot, relativePath)))
  return candidates
}
function matchesGlobFilter(filter, entrypoint, packageRoot) {
  const pattern = normalizedFilter(filter)
  if (!pattern) return false
  return entrypointCandidates(entrypoint, packageRoot).some((candidate) => {
    try {
      return matchesGlob(candidate, pattern)
    } catch {
      return false
    }
  })
}
function matchesExactFilter(filter, entrypoint, packageRoot) {
  const pattern = normalizedFilter(filter)
  const [relativePath, , absolutePath] = entrypointCandidates(entrypoint, packageRoot)
  return pattern === relativePath || pattern === absolutePath
}
function extensionFilterEnabled(filters, extensionName, packageRoot, autoload) {
  if (!Array.isArray(filters)) return autoload
  if (filters.length === 0) return false

  const entrypoint = extensionEntrypointPath(extensionName)
  const strings = filters.filter((filter) => typeof filter === 'string')

  if (!autoload) {
    let enabled = false
    for (const rawFilter of strings) {
      const filter = rawFilter
      if (!filter) continue
      const prefix = filter[0]
      const target = prefix === '+' || prefix === '-' || prefix === '!' ? filter.slice(1) : filter
      if (prefix === '+' || prefix === '-') {
        if (matchesExactFilter(target, entrypoint, packageRoot)) enabled = prefix === '+'
      } else if (matchesGlobFilter(target, entrypoint, packageRoot)) {
        enabled = prefix !== '!'
      }
    }
    return enabled
  }

  const includes = strings.filter((filter) => !/^[!+-]/.test(filter))
  const excludes = strings.filter((filter) => filter.startsWith('!')).map((filter) => filter.slice(1))
  const forceIncludes = strings
    .filter((filter) => filter.startsWith('+'))
    .map((filter) => filter.slice(1))
  const forceExcludes = strings
    .filter((filter) => filter.startsWith('-'))
    .map((filter) => filter.slice(1))

  let enabled = includes.length === 0 || includes.some((filter) => matchesGlobFilter(filter, entrypoint, packageRoot))
  if (excludes.some((filter) => matchesGlobFilter(filter, entrypoint, packageRoot))) enabled = false
  if (forceIncludes.some((filter) => matchesExactFilter(filter, entrypoint, packageRoot))) enabled = true
  if (forceExcludes.some((filter) => matchesExactFilter(filter, entrypoint, packageRoot))) enabled = false
  return enabled
}
export function extensionFilterExcludes(filters, extensionName, packageRoot, autoload = true) {
  return !extensionFilterEnabled(filters, extensionName, packageRoot, autoload)
}

export function checkPackagePin(settings) {
  if (!settings?.exists && settings?.error)
    return check('package-pin', 'FAIL', `cannot read settings.json: ${settings.error}`)
  if (settings?.error) return check('package-pin', 'FAIL', `cannot parse settings.json: ${settings.error}`)
  if (!settings?.shapeValid) return check('package-pin', 'FAIL', 'settings.json is not a JSON object')
  const entries = settings.packageEntries ?? []
  if (entries.length === 0) return check('package-pin', 'FAIL', 'dowdiness/skills package entry is missing')
  if (entries.length > 1) return check('package-pin', 'FAIL', 'multiple dowdiness/skills package entries found')
  const info = entries[0].sourceInfo ?? parseSkillsPackageSource(settings.source)
  return info
    ? check('package-pin', 'PASS', `package entry is pinned to ${info.pin}`)
    : check('package-pin', 'FAIL', `package source must be ${SKILLS_SOURCE}@<40-hex-sha>`)
}

export function checkCheckout(settings, packageFacts) {
  if (!settings?.sourceInfo?.pin) return check('checkout', 'FAIL', 'cannot verify checkout without a valid package pin')
  if (!packageFacts?.rootExists) return check('checkout', 'FAIL', 'installed package checkout is missing')
  if (!packageFacts.head)
    return check('checkout', 'FAIL', packageFacts.headError ?? 'installed package Git HEAD could not be read')
  if (packageFacts.head !== settings.sourceInfo.pin)
    return check('checkout', 'FAIL', `checkout HEAD ${packageFacts.head} does not match pin ${settings.sourceInfo.pin}`)
  return check('checkout', 'PASS', 'installed package Git HEAD matches the pinned commit')
}

export function checkAgentLinks(packageFacts, agentLinks) {
  if (!packageFacts?.rootExists)
    return check('agent-links', 'FAIL', 'cannot inspect agents without the installed package checkout')
  if (!packageFacts.agentsDirectoryExists || packageFacts.agentNames.length === 0)
    return check('agent-links', 'FAIL', 'installed package has no readable agents/*.md definitions')
  const invalid = Object.entries(agentLinks?.links ?? {})
    .filter(([, link]) => link.state !== 'linked')
    .map(([name, link]) => `${name} (${link.state})`)
  const deprecated = agentLinks?.deprecatedPresent ?? []
  if (invalid.length) return check('agent-links', 'FAIL', `package-managed agent links invalid: ${invalid.join(', ')}`)
  if (deprecated.length)
    return check('agent-links', 'FAIL', `deprecated lens agent names present: ${deprecated.join(', ')}`)
  return check(
    'agent-links',
    'PASS',
    `${packageFacts.agentNames.length} package-managed agent links verified; unrelated agents ignored`
  )
}

export function checkExtensions(settings, packageFacts) {
  if (!packageFacts?.rootExists)
    return check('extensions', 'FAIL', 'cannot inspect extensions without the installed package checkout')
  const missing = REQUIRED_EXTENSIONS.filter((name) => !packageFacts.requiredExtensions?.[name])
  if (missing.length)
    return check(
      'extensions',
      'FAIL',
      `installed package is missing ${missing.map((name) => REQUIRED_EXTENSION_ENTRYPOINTS[name]).join(' and ')}`
    )
  const selected = isObject(settings?.selected) ? settings.selected : null
  const autoload = selected?.autoload !== false
  const filters = selected && Object.hasOwn(selected, 'extensions') ? selected.extensions : undefined
  if (filters !== undefined && !Array.isArray(filters))
    return check('extensions', 'FAIL', 'package extension filter is not an array')
  const filtered = REQUIRED_EXTENSIONS.filter((name) =>
    extensionFilterExcludes(filters, name, packageFacts.root, autoload)
  )
  return filtered.length
    ? check('extensions', 'FAIL', `package extension filter excludes ${filtered.join(', ')}`)
    : check(
        'extensions',
        'PASS',
        'extensions/scheduler/index.ts and extensions/subagent/index.ts are present and enabled'
      )
}

export function checkExtensionOverrides(settings) {
  const overrides = settings?.extensionOverrides
  if (overrides?.invalid) return check('extension-overrides', 'FAIL', 'settings.extensions is not an array')
  const rejected = (overrides?.overrides ?? [])
    .filter((path) => isDevelopmentSkillsExtensionOverride(path, overrides.packageRoot, overrides.sourceCheckoutRoot))
    .sort()
  return rejected.length
    ? check(
        'extension-overrides',
        'FAIL',
        `development-only absolute skills extension override: ${rejected.join(', ')}`
      )
    : check('extension-overrides', 'PASS', 'no development-only absolute skills extension overrides found')
}

export function checkModels(modelFacts) {
  if (modelFacts?.kind === 'inventory-failure') return check('models', 'FAIL', modelFacts.detail)
  if (modelFacts?.kind !== 'ok')
    return check('models', 'FAIL', modelFacts?.detail ?? 'configured agent models could not be inspected')
  if (modelFacts.unavailableIds.length)
    return check('models', 'WARN', `configured model IDs unavailable: ${modelFacts.unavailableIds.join(', ')}`)
  return check(
    'models',
    'PASS',
    `${modelFacts.configuredIds.length} configured agent model IDs are available in pi --offline --list-models`
  )
}

export function checkStartup(startupFacts) {
  return startupFacts?.ok
    ? check('startup', 'PASS', 'zero-inference Pi CLI startup check passed')
    : check(
        'startup',
        'FAIL',
        `zero-inference Pi CLI startup check failed${startupFacts?.detail ? `: ${startupFacts.detail}` : ''}`
      )
}

export function diagnoseAgentEnvironment(snapshot) {
  const checks = [
    checkPackagePin(snapshot.settings),
    checkCheckout(snapshot.settings, snapshot.package),
    checkAgentLinks(snapshot.package, snapshot.agentLinks),
    checkExtensions(snapshot.settings, snapshot.package),
    checkExtensionOverrides(snapshot.settings),
    checkModels(snapshot.models),
    checkStartup(snapshot.startup)
  ]
  const fail = checks.filter((item) => item.status === 'FAIL').length
  const warn = checks.filter((item) => item.status === 'WARN').length
  const summary = {
    status: fail ? 'FAIL' : warn ? 'WARN' : 'PASS',
    pass: checks.length - fail - warn,
    warn,
    fail
  }

  return {
    checks,
    summary,
    exitCode: fail ? 1 : 0
  }
}

function usage() {
  return 'Usage: npm run check-agent-env [-- --json]\n\nRead-only diagnostics for the pinned dowdiness/skills Pi package installation.'
}
export function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return 0
  }
  const unknown = argv.filter((arg) => arg !== '--json')
  if (unknown.length) {
    console.error(`Unknown option: ${unknown[0]}`)
    return 1
  }
  const report = diagnoseAgentEnvironment(
    collectEnvironment({
      home: dependencies.home ?? process.env.HOME,
      runCommand: dependencies.runCommand ?? runCommand
    })
  )
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    for (const item of report.checks) {
      console.log(`${item.status} ${item.name} ${item.detail}`)
    }
    console.log(
      `Summary: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed`
    )
  }

  return report.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
