#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const home = process.env.HOME

function usage() {
  console.log(`Usage: node scripts/install-pi-package.mjs [source] [--dry-run] [--no-install]

Installs this repository as a pi package without duplicate local resources.
Before running pi install, it backs up local auto-discovered skills/extensions
that would collide with the package resources.

Defaults:
  source: git:github.com/dowdiness/skills

Examples:
  npm run install-pi-package
  node scripts/install-pi-package.mjs git:github.com/dowdiness/skills
  node scripts/install-pi-package.mjs ./ --dry-run`)
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}

const dryRun = args.includes('--dry-run')
const noInstall = args.includes('--no-install')
const source = args.find((arg) => !arg.startsWith('--')) ?? 'git:github.com/dowdiness/skills'

if (!home) {
  console.error('ERROR: HOME is not set')
  process.exit(1)
}

function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function listSkillNames() {
  const dir = join(root, 'skills')
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => exists(join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
}

function listExtensionLocalPaths() {
  const dir = join(root, 'extensions')
  if (!exists(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.gitkeep')
    .flatMap((entry) => {
      if (entry.isDirectory() && exists(join(dir, entry.name, 'index.ts'))) return [entry.name]
      if (entry.isFile() && entry.name.endsWith('.ts')) return [entry.name]
      return []
    })
    .sort()
}

function timestamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const backupRoot = join(home, '.pi', 'agent', `dowdiness-skills-local-backup-${timestamp()}`)
const backupSkills = join(backupRoot, 'skills')
const backupExtensions = join(backupRoot, 'extensions')
const moves = []

for (const name of listSkillNames()) {
  const from = join(home, '.agents', 'skills', name)
  if (exists(from)) moves.push({ from, to: join(backupSkills, name) })
}

for (const entryName of listExtensionLocalPaths()) {
  const candidates = entryName.endsWith('.ts')
    ? [join(home, '.pi', 'agent', 'extensions', entryName)]
    : [join(home, '.pi', 'agent', 'extensions', entryName), join(home, '.pi', 'agent', 'extensions', `${entryName}.ts`)]
  for (const from of candidates) {
    if (exists(from)) moves.push({ from, to: join(backupExtensions, basename(from)) })
  }
}

if (moves.length === 0) {
  console.log('No local skill/extension collisions found.')
} else {
  console.log(`Backing up ${moves.length} local resource(s) to ${backupRoot}`)
  for (const move of moves) {
    console.log(`${dryRun ? 'DRY ' : ''}MOVE ${move.from} -> ${move.to}`)
  }
  if (!dryRun) {
    mkdirSync(backupSkills, { recursive: true })
    mkdirSync(backupExtensions, { recursive: true })
    for (const move of moves) renameSync(move.from, move.to)
  }
}

if (dryRun || noInstall) {
  console.log(dryRun ? 'Dry run complete; pi install not run.' : 'Skipped pi install (--no-install).')
  process.exit(0)
}

const result = spawnSync('pi', ['install', source], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

console.log('\nInstalled pi package. Run this smoke test to verify startup:')
console.log('  pi --offline --no-session --no-tools -p "respond ok"')
if (moves.length > 0) console.log(`\nKeep backup until verified: ${backupRoot}`)
