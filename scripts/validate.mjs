import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { agents, extensions, skills } from '../meta.ts'
import { parseFrontmatter } from './frontmatter.mjs'
import { diffDirs, outputDir, rel, sourceDir, vendorSkills } from './vendor-skills.mjs'
import {
  diffDirs as diffExtensionDirs,
  outputDir as extensionOutputDir,
  sourceDir as extensionSourceDir,
  vendorExtensions,
} from './vendor-extensions.mjs'

const root = new URL('..', import.meta.url).pathname
const skillsDir = join(root, 'skills')
const extensionsDir = join(root, 'extensions')
const agentsDir = join(root, 'agents')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function hasDefaultExport(text) {
  return /export\s+default\s+(async\s+)?function/.test(text)
}

let failures = 0
let count = 0
const actual = new Set()

for (const entry of await readdir(skillsDir)) {
  const dir = join(skillsDir, entry)
  if (!(await stat(dir)).isDirectory()) continue
  actual.add(entry)
  count += 1
  const skillPath = join(dir, 'SKILL.md')
  let text = ''
  try {
    text = await readFile(skillPath, 'utf8')
  } catch {
    console.error(`FAIL ${entry}: missing SKILL.md`)
    failures += 1
    continue
  }
  const fm = parseFrontmatter(text)
  if (!fm) {
    console.error(`FAIL ${entry}: missing YAML frontmatter`)
    failures += 1
    continue
  }
  if (fm.name !== entry) {
    console.error(`FAIL ${entry}: frontmatter name is ${fm.name || '(missing)'}`)
    failures += 1
  }
  if (!('description' in fm)) {
    console.error(`FAIL ${entry}: missing description`)
    failures += 1
  }
}

const catalog = new Set(skills.map((skill) => skill.name))
for (const name of actual) {
  if (!catalog.has(name)) {
    console.error(`FAIL ${name}: missing from meta.ts`)
    failures += 1
  }
}
for (const name of catalog) {
  if (!actual.has(name)) {
    console.error(`FAIL ${name}: present in meta.ts but missing from skills/`)
    failures += 1
  }
}

let agentFailures = 0
let agentCount = 0
const actualAgents = new Set()
if (await exists(agentsDir)) {
  for (const entry of await readdir(agentsDir)) {
    const filePath = join(agentsDir, entry)
    const entryStat = await stat(filePath)
    if (!entryStat.isFile() || !entry.endsWith('.md')) continue
    const name = entry.slice(0, -3)
    actualAgents.add(name)
    agentCount += 1
    const text = await readFile(filePath, 'utf8')
    const fm = parseFrontmatter(text)
    if (!fm) {
      console.error(`FAIL ${name}: missing YAML frontmatter`)
      agentFailures += 1
      continue
    }
    if (fm.name !== name) {
      console.error(`FAIL ${name}: frontmatter name is ${fm.name || '(missing)'}`)
      agentFailures += 1
    }
    if (!('description' in fm)) {
      console.error(`FAIL ${name}: missing description`)
      agentFailures += 1
    }
  }
}

const agentCatalog = new Set(agents.map((agent) => agent.name))
for (const name of actualAgents) {
  if (!agentCatalog.has(name)) {
    console.error(`FAIL ${name}: missing from meta.ts agents`)
    agentFailures += 1
  }
}
for (const name of agentCatalog) {
  if (!actualAgents.has(name)) {
    console.error(`FAIL ${name}: present in meta.ts agents but missing from agents/`)
    agentFailures += 1
  }
}

for (const skill of vendorSkills()) {
  const diffs = await diffDirs(sourceDir(skill), outputDir(skill))
  if (diffs.length > 0) {
    console.error(`FAIL ${skill.name}: vendor drift from ${rel(sourceDir(skill))}`)
    for (const diff of diffs.slice(0, 5)) {
      console.error(`  - ${diff}`)
    }
    if (diffs.length > 5) {
      console.error(`  - ... ${diffs.length - 5} more`)
    }
    failures += 1
  }
}

let extensionFailures = 0
let extensionCount = 0
const actualExtensions = new Set()

if (await exists(extensionsDir)) {
  for (const entry of await readdir(extensionsDir)) {
    if (entry === '.gitkeep') continue
    const fullPath = join(extensionsDir, entry)
    const entryStat = await stat(fullPath)

    if (entryStat.isDirectory()) {
      const indexPath = join(fullPath, 'index.ts')
      if (!(await exists(indexPath))) {
        console.error(`FAIL extension ${entry}: directory missing index.ts`)
        extensionFailures += 1
        continue
      }
      actualExtensions.add(entry)
      extensionCount += 1
      const text = await readFile(indexPath, 'utf8')
      if (!hasDefaultExport(text)) {
        console.error(`FAIL extension ${entry}: missing default export function in index.ts`)
        extensionFailures += 1
      }
    } else if (entryStat.isFile() && entry.endsWith('.ts')) {
      const name = entry.replace(/\.ts$/, '')
      actualExtensions.add(name)
      extensionCount += 1
      const text = await readFile(fullPath, 'utf8')
      if (!hasDefaultExport(text)) {
        console.error(`FAIL extension ${name}: missing default export function in ${entry}`)
        extensionFailures += 1
      }
    }
  }
}

const extensionCatalog = new Set(extensions.map((ext) => ext.name))
for (const name of actualExtensions) {
  if (!extensionCatalog.has(name)) {
    console.error(`FAIL extension ${name}: missing from meta.ts extensions[]`)
    extensionFailures += 1
  }
}
for (const name of extensionCatalog) {
  if (!actualExtensions.has(name)) {
    console.error(`FAIL extension ${name}: present in meta.ts extensions[] but missing from extensions/`)
    extensionFailures += 1
  }
}

for (const ext of vendorExtensions()) {
  const diffs = await diffExtensionDirs(extensionSourceDir(ext), extensionOutputDir(ext))
  if (diffs.length > 0) {
    console.error(`FAIL extension ${ext.name}: vendor drift from ${rel(extensionSourceDir(ext))}`)
    for (const diff of diffs.slice(0, 5)) {
      console.error(`  - ${diff}`)
    }
    if (diffs.length > 5) {
      console.error(`  - ... ${diffs.length - 5} more`)
    }
    extensionFailures += 1
  }
}

if (count === 0 && extensionCount === 0 && agentCount === 0) {
  console.error('FAIL: no skills, agents, or extensions found')
  failures += 1
}

const totalCount = count + extensionCount + agentCount
const totalFailures = failures + extensionFailures + agentFailures

if (totalFailures > 0) {
  console.error(`RESULT: ${Math.max(0, totalCount - totalFailures)}/${totalCount}`)
  process.exit(1)
}

console.log(`RESULT: ${totalCount}/${totalCount}`)
