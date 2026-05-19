import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { skills } from '../meta.ts'
import { diffDirs, outputDir, rel, sourceDir, vendorSkills } from './vendor-skills.mjs'

const root = new URL('..', import.meta.url).pathname
const skillsDir = join(root, 'skills')

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end === -1) return null
  const body = text.slice(4, end).trim().split('\n')
  const out = {}
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i]
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    if (match[2] === '>' || match[2] === '|') {
      const parts = []
      while (body[i + 1]?.startsWith('  ')) {
        i += 1
        parts.push(body[i].trim())
      }
      out[match[1]] = parts.join(' ')
    } else {
      out[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return out
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

if (count === 0) {
  console.error('FAIL: no skills found')
  failures += 1
}

if (failures > 0) {
  console.error(`RESULT: ${count - failures}/${count}`)
  process.exit(1)
}

console.log(`RESULT: ${count}/${count}`)
