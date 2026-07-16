#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const home = process.env.HOME
const defaultSource = 'git:github.com/dowdiness/skills'

function usage() {
  console.log(`Usage: node scripts/install-pi-package.mjs [source] [--dry-run] [--no-install] [--keep-package-skills]

Installs this repository as a pi package without duplicate local resources.

Default behavior:
  - back up local extension copies that would conflict with package extensions
  - back up local skill copies/symlinks managed by this repo
  - back up local agent definitions managed by this repo
  - run pi install
  - disable this package's pi skill resources in settings
  - recreate ~/.agents, ~/.claude, and ~/.codex skill symlinks to the installed package
  - recreate ~/.pi/agent/agents symlinks to the installed package

This keeps pi extensions package-managed while preserving skill compatibility
for hosts that still discover skills from ~/.agents/skills.

Defaults:
  source: ${defaultSource}

Examples:
  npm run install-pi-package
  node scripts/install-pi-package.mjs ${defaultSource}
  node scripts/install-pi-package.mjs ./ --dry-run`)
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}

const dryRun = args.includes('--dry-run')
const noInstall = args.includes('--no-install')
const keepPackageSkills = args.includes('--keep-package-skills')
const source = args.find((arg) => !arg.startsWith('--')) ?? defaultSource

if (!home) {
  console.error('ERROR: HOME is not set')
  process.exit(1)
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

function inferInstalledPackageRoot() {
  if (isAbsolute(source) || source.startsWith('./') || source.startsWith('../')) return resolve(source)
  if (!source.startsWith('git:')) return null
  const repoPath = source.slice('git:'.length).split('/').filter(Boolean)
  if (repoPath.length < 3 || repoPath.some((part) => part === '.' || part === '..')) return null
  return join(home, '.pi', 'agent', 'git', ...repoPath)
}

const installedPackageRoot = inferInstalledPackageRoot()

function packageEntryMatches(entry) {
  const entrySource = typeof entry === 'string' ? entry : entry?.source
  if (typeof entrySource !== 'string') return false
  if (entrySource === source) return true
  if (!installedPackageRoot || entrySource.startsWith('git:')) return false
  try {
    return resolve(join(home, '.pi', 'agent'), entrySource) === installedPackageRoot
  } catch {
    return false
  }
}
const backupRoot = join(home, '.pi', 'agent', `dowdiness-skills-local-backup-${timestamp()}`)
const backupSkills = join(backupRoot, 'skills')
const backupExtensions = join(backupRoot, 'extensions')
const backupAgents = join(backupRoot, 'agents')
const moves = []
const skillNames = listSkillNames()
const extensionNames = listExtensionNames()
const agentNames = listAgentNames()

const skillTargets = [
  { label: 'agents', dir: join(home, '.agents', 'skills') },
  { label: 'claude', dir: join(home, '.claude', 'skills') },
  { label: 'codex', dir: join(home, '.codex', 'skills') },
]

for (const name of skillNames) {
  for (const target of skillTargets) {
    const from = join(target.dir, name)
    const expected = installedPackageRoot ? join(installedPackageRoot, 'skills', name) : null
    if (pathExists(from) && (!expected || !sameSymlink(from, expected))) {
      moves.push({ from, to: join(backupSkills, target.label, name) })
    }
  }
}

const legacyExtensionNames = ['canopy-scheduler']
for (const name of [...new Set([...extensionNames, ...legacyExtensionNames])]) {
  const candidates = name.endsWith('.ts')
    ? [join(home, '.pi', 'agent', 'extensions', name)]
    : [join(home, '.pi', 'agent', 'extensions', name), join(home, '.pi', 'agent', 'extensions', `${name}.ts`)]
  for (const from of candidates) {
    if (pathExists(from)) moves.push({ from, to: join(backupExtensions, basename(from)) })
  }
}

for (const name of agentNames) {
  const from = join(home, '.pi', 'agent', 'agents', name)
  const expected = installedPackageRoot ? join(installedPackageRoot, 'agents', name) : null
  if (pathExists(from) && (!expected || !sameSymlink(from, expected))) {
    moves.push({ from, to: join(backupAgents, name) })
  }
}

// These lens names were previously shipped by this repository. Migrate only
// this explicit legacy set; unrelated user-defined agents remain untouched.
const legacyAgentNames = ['reviewer-flash.md', 'reviewer-mimo.md', 'reviewer-qwen.md']
for (const name of legacyAgentNames) {
  const from = join(home, '.pi', 'agent', 'agents', name)
  if (pathExists(from)) moves.push({ from, to: join(backupAgents, name) })
}

if (moves.length === 0) {
  console.log('No local skill, extension, or agent collisions found.')
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
  process.exit(0)
}

if (!noInstall) {
  const result = spawnSync('pi', ['install', source], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
} else {
  console.log('Skipped pi install (--no-install).')
}

if (!keepPackageSkills) {
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

if (!keepPackageSkills && installedPackageRoot && pathExists(join(installedPackageRoot, 'skills'))) {
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

if (installedPackageRoot && pathExists(join(installedPackageRoot, 'agents'))) {
  const agentTarget = join(home, '.pi', 'agent', 'agents')
  mkdirSync(agentTarget, { recursive: true })
  for (const name of agentNames) {
    const target = join(installedPackageRoot, 'agents', name)
    const linkPath = join(agentTarget, name)
    if (pathExists(target) && !pathExists(linkPath)) symlinkSync(target, linkPath)
  }
  console.log('Linked agent definitions from the installed package.')
}

console.log(noInstall ? '\nPrepared local resources. Run this smoke test after pi install:' : '\nInstalled pi package. Run this smoke test to verify startup:')
console.log('  pi --offline --no-session --no-tools -p "respond ok"')
if (moves.length > 0) console.log(`\nKeep backup until verified: ${backupRoot}`)
