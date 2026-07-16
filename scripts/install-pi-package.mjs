#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultSource = 'git:github.com/dowdiness/skills'
const legacyExtensionNames = ['canopy-scheduler']
const legacyAgentNames = ['reviewer-flash.md', 'reviewer-mimo.md', 'reviewer-qwen.md']

export function isLocalPathSource(source) {
  return (
    isAbsolute(source) ||
    source === '.' ||
    source === '..' ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('file:')
  )
}

function gitRevisionDelimiter(source) {
  const body = source.slice('git:'.length)
  const scpLike = body.match(/^git@[^:]+:/)
  return body.indexOf('@', scpLike?.[0].length ?? 0)
}

export function gitSourceBase(source) {
  if (!source.startsWith('git:')) return source
  const body = source.slice('git:'.length)
  const at = gitRevisionDelimiter(source)
  return at > -1 ? `git:${body.slice(0, at)}` : source
}

export function isPinnedGitSource(source) {
  if (!source.startsWith('git:')) return false
  return gitRevisionDelimiter(source) > -1
}

export function composeGitSource(source, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') throw new Error('--ref requires a non-empty commit or tag')
  if (isLocalPathSource(source)) throw new Error('--ref cannot be used with a local-path source')
  if (!source.startsWith('git:')) throw new Error('--ref requires a git source')
  if (isPinnedGitSource(source)) throw new Error('--ref is ambiguous because the git source is already pinned')
  if (/\s/.test(ref)) throw new Error('--ref must not contain whitespace')
  return `${source}@${ref}`
}

export function parseInstallerArgs(argv, sourceDefault = defaultSource) {
  let source
  let ref
  let refSeen = false
  let dryRun = false
  let noInstall = false
  let keepPackageSkills = false
  let agentsOnly = false
  let extensionsOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--no-install') {
      noInstall = true
    } else if (arg === '--keep-package-skills') {
      keepPackageSkills = true
    } else if (arg === '--agents-only') {
      agentsOnly = true
    } else if (arg === '--extensions-only') {
      extensionsOnly = true
    } else if (arg === '--ref') {
      if (refSeen) throw new Error('--ref may only be supplied once')
      refSeen = true
      ref = argv[++index]
      if (ref === undefined || ref.startsWith('--')) throw new Error('--ref requires a commit or tag')
    } else if (arg.startsWith('--ref=')) {
      if (refSeen) throw new Error('--ref may only be supplied once')
      refSeen = true
      ref = arg.slice('--ref='.length)
      if (ref === '') throw new Error('--ref requires a commit or tag')
    } else if (!arg.startsWith('--')) {
      if (source !== undefined) throw new Error('only one package source may be supplied')
      source = arg
    }
  }

  if (agentsOnly && extensionsOnly) {
    throw new Error('--agents-only and --extensions-only are mutually exclusive')
  }

  const requestedSource = source ?? sourceDefault
  const mode = agentsOnly ? 'agents-only' : extensionsOnly ? 'extensions-only' : 'all'
  const resolvedSource = refSeen ? composeGitSource(requestedSource, ref) : requestedSource

  return {
    source: resolvedSource,
    mode,
    dryRun,
    noInstall,
    keepPackageSkills,
  }
}

function usage() {
  console.log(`Usage: node scripts/install-pi-package.mjs [source] [--dry-run] [--no-install] [--keep-package-skills] [--agents-only|--extensions-only] [--ref <commit-or-tag>]

Installs this repository as a pi package without duplicate local resources.

Default behavior:
  - back up local extension copies that would conflict with package extensions
  - back up local skill copies/symlinks managed by this repo
  - back up local agent definitions managed by this repo
  - run pi install
  - disable this package's pi skill resources in settings
  - recreate ~/.agents, ~/.claude, and ~/.codex skill symlinks to the installed package
  - recreate ~/.pi/agent/agents symlinks to the installed package

Modes:
  --agents-only      back up/link agents only; do not install or touch skills, settings, or extensions
  --extensions-only  back up extension collisions and install/update the package only

A git source can be pinned with --ref. The ref is composed as @<ref> on the
source and cannot be combined with an already-pinned git source or a local path.

This keeps pi extensions package-managed while preserving skill compatibility
for hosts that still discover skills from ~/.agents/skills.

Defaults:
  source: ${defaultSource}

Examples:
  npm run install-pi-package
  node scripts/install-pi-package.mjs ${defaultSource} --ref v1.2.3
  node scripts/install-pi-package.mjs --agents-only --no-install
  node scripts/install-pi-package.mjs ./ --dry-run`)
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function listSkillNames() {
  const dir = join(root, 'skills')
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => pathExists(join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
}

function listExtensionNames() {
  const dir = join(root, 'extensions')
  if (!pathExists(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.gitkeep')
    .flatMap((entry) => {
      if (entry.isDirectory() && pathExists(join(dir, entry.name, 'index.ts'))) return [entry.name]
      if (entry.isFile() && entry.name.endsWith('.ts')) return [entry.name]
      return []
    })
    .sort()
}

function listAgentNames() {
  const dir = join(root, 'agents')
  if (!pathExists(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
}

function timestamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function sameSymlink(linkPath, targetPath) {
  try {
    const stat = lstatSync(linkPath)
    if (!stat.isSymbolicLink()) return false
    return resolve(join(linkPath, '..'), readlinkSync(linkPath)) === targetPath
  } catch {
    return false
  }
}

export function inferInstalledPackageRoot(source, home) {
  if (isLocalPathSource(source)) return resolve(source)
  if (!source.startsWith('git:')) return null
  const body = gitSourceBase(source).slice('git:'.length)
  const scpLike = body.match(/^git@([^:]+):(.+)$/)
  const repoPath = scpLike
    ? [scpLike[1], ...(scpLike[2] ?? '').split('/').filter(Boolean)]
    : body.split('/').filter(Boolean)
  if (repoPath.length < 3 || repoPath.some((part) => part === '.' || part === '..')) return null
  return join(home, '.pi', 'agent', 'git', ...repoPath)
}

export function resolveGitRevision(checkoutPath) {
  if (!checkoutPath || !pathExists(checkoutPath)) return null
  const result = spawnSync('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  const revision = result.stdout.trim()
  return revision || null
}

function printSourceResolution(source, installedPackageRoot) {
  console.log(`Requested source: ${source}`)
  const revision = resolveGitRevision(installedPackageRoot)
  if (revision) {
    console.log(`Resolved Git revision: ${revision}`)
  } else {
    console.log('Resolved Git revision: could not be resolved')
  }
}

function runInstaller({ source, mode, dryRun, noInstall, keepPackageSkills }) {
  const home = process.env.HOME
  if (!home) {
    console.error('ERROR: HOME is not set')
    return 1
  }

  const installedPackageRoot = inferInstalledPackageRoot(source, home)
  const backupRoot = join(home, '.pi', 'agent', `dowdiness-skills-local-backup-${timestamp()}`)
  const backupSkills = join(backupRoot, 'skills')
  const backupExtensions = join(backupRoot, 'extensions')
  const backupAgents = join(backupRoot, 'agents')
  const moves = []
  const managesSkills = mode === 'all'
  const managesExtensions = mode === 'all' || mode === 'extensions-only'
  const managesAgents = mode === 'all' || mode === 'agents-only'
  const skillNames = managesSkills ? listSkillNames() : []
  const extensionNames = managesExtensions ? listExtensionNames() : []
  const agentNames = managesAgents ? listAgentNames() : []

  const skillTargets = [
    { label: 'agents', dir: join(home, '.agents', 'skills') },
    { label: 'claude', dir: join(home, '.claude', 'skills') },
    { label: 'codex', dir: join(home, '.codex', 'skills') },
  ]

  if (managesSkills) {
    for (const name of skillNames) {
      for (const target of skillTargets) {
        const from = join(target.dir, name)
        const expected = installedPackageRoot ? join(installedPackageRoot, 'skills', name) : null
        if (pathExists(from) && (!expected || !sameSymlink(from, expected))) {
          moves.push({ from, to: join(backupSkills, target.label, name) })
        }
      }
    }
  }

  if (managesExtensions) {
    for (const name of [...new Set([...extensionNames, ...legacyExtensionNames])]) {
      const candidates = name.endsWith('.ts')
        ? [join(home, '.pi', 'agent', 'extensions', name)]
        : [join(home, '.pi', 'agent', 'extensions', name), join(home, '.pi', 'agent', 'extensions', `${name}.ts`)]
      for (const from of candidates) {
        if (pathExists(from)) moves.push({ from, to: join(backupExtensions, basename(from)) })
      }
    }
  }

  if (managesAgents) {
    for (const name of agentNames) {
      const from = join(home, '.pi', 'agent', 'agents', name)
      const expected = installedPackageRoot ? join(installedPackageRoot, 'agents', name) : null
      if (pathExists(from) && (!expected || !sameSymlink(from, expected))) {
        moves.push({ from, to: join(backupAgents, name) })
      }
    }

    // These lens names were previously shipped by this repository. Migrate only
    // this explicit legacy set; unrelated user-defined agents remain untouched.
    for (const name of legacyAgentNames) {
      const from = join(home, '.pi', 'agent', 'agents', name)
      if (pathExists(from)) moves.push({ from, to: join(backupAgents, name) })
    }
  }

  if (moves.length === 0) {
    if (mode === 'all') console.log('No local skill, extension, or agent collisions found.')
    else if (mode === 'agents-only') console.log('No local agent collisions found.')
    else console.log('No local extension collisions found.')
  } else {
    console.log(`Backing up ${moves.length} local resource(s) to ${backupRoot}`)
    for (const move of moves) console.log(`${dryRun ? 'DRY ' : ''}MOVE ${move.from} -> ${move.to}`)
    if (!dryRun) {
      for (const move of moves) {
        mkdirSync(join(move.to, '..'), { recursive: true })
        renameSync(move.from, move.to)
      }
    }
  }

  if (dryRun) {
    console.log('Dry run complete; pi install not run and settings not changed.')
    printSourceResolution(source, installedPackageRoot)
    return 0
  }

  if (mode === 'agents-only') {
    console.log('Skipped pi install (--agents-only).')
  } else if (!noInstall) {
    const result = spawnSync('pi', ['install', source], { stdio: 'inherit' })
    if (result.status !== 0) return result.status ?? 1
  } else {
    console.log('Skipped pi install (--no-install).')
  }

  const packageEntryMatches = (entry) => {
    const entrySource = typeof entry === 'string' ? entry : entry?.source
    if (typeof entrySource !== 'string') return false
    if (entrySource === source || entrySource === gitSourceBase(source)) return true
    if (!installedPackageRoot || entrySource.startsWith('git:')) return false
    try {
      return resolve(join(home, '.pi', 'agent'), entrySource) === installedPackageRoot
    } catch {
      return false
    }
  }

  if (mode === 'all' && !keepPackageSkills) {
    const settingsPath = join(home, '.pi', 'agent', 'settings.json')
    if (pathExists(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
      settings.packages = (settings.packages ?? []).map((entry) => {
        if (!packageEntryMatches(entry)) return entry
        if (typeof entry === 'string') return { source: entry, skills: [] }
        return { ...entry, skills: [] }
      })
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      console.log(`Disabled package skill resources for ${source}; compatibility symlinks will provide skills.`)
    }
  }

  if (mode === 'all' && !keepPackageSkills && installedPackageRoot && pathExists(join(installedPackageRoot, 'skills'))) {
    for (const skillTarget of skillTargets) {
      mkdirSync(skillTarget.dir, { recursive: true })
      for (const name of skillNames) {
        const target = join(installedPackageRoot, 'skills', name)
        const linkPath = join(skillTarget.dir, name)
        if (pathExists(target) && !pathExists(linkPath)) symlinkSync(target, linkPath, 'dir')
      }
    }
    console.log('Linked compatibility skill directories from the installed package.')
  }

  if ((mode === 'all' || mode === 'agents-only') && installedPackageRoot && pathExists(join(installedPackageRoot, 'agents'))) {
    const agentTarget = join(home, '.pi', 'agent', 'agents')
    mkdirSync(agentTarget, { recursive: true })
    for (const name of agentNames) {
      const target = join(installedPackageRoot, 'agents', name)
      const linkPath = join(agentTarget, name)
      if (pathExists(target) && !pathExists(linkPath)) symlinkSync(target, linkPath)
    }
    console.log('Linked agent definitions from the installed package.')
  }

  printSourceResolution(source, installedPackageRoot)
  const preparedOnly = noInstall || mode === 'agents-only'
  console.log(preparedOnly ? '\nPrepared local resources. Run this smoke test after pi install:' : '\nInstalled pi package. Run this smoke test to verify startup:')
  console.log('  pi --offline --no-session --no-tools -p "respond ok"')
  if (moves.length > 0) console.log(`\nKeep backup until verified: ${backupRoot}`)
  return 0
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage()
    return 0
  }

  let options
  try {
    options = parseInstallerArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    return 1
  }
  return runInstaller(options)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
