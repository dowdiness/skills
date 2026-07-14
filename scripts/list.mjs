import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { agents, extensions } from '../meta.ts'
import { parseFrontmatter } from './frontmatter.mjs'

const root = new URL('..', import.meta.url).pathname
const skillsDir = join(root, 'skills')
const extensionsDir = join(root, 'extensions')
const agentsDir = join(root, 'agents')

for (const entry of (await readdir(skillsDir)).sort()) {
  const dir = join(skillsDir, entry)
  if (!(await stat(dir)).isDirectory()) continue
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const info = parseFrontmatter(text) ?? {}
  console.log(`${entry}\t${info.description || ''}`)
}

console.log('\n--- Agents ---')
if (!existsSync(agentsDir)) {
  console.log('(none)')
} else {
  let printed = false
  for (const entry of (await readdir(agentsDir)).sort()) {
    if (!entry.endsWith('.md')) continue
    const name = entry.replace(/\.md$/, '')
    const text = await readFile(join(agentsDir, entry), 'utf8')
    const info = parseFrontmatter(text) ?? {}
    const description = agents.find((agent) => agent.name === name)?.notes ?? info.description ?? ''
    console.log(`${name}\t${description}`)
    printed = true
  }
  if (!printed) console.log('(none)')
}

console.log('\n--- Extensions ---')
if (!existsSync(extensionsDir)) {
  console.log('(none)')
} else {
  let printed = false
  for (const entry of (await readdir(extensionsDir)).sort()) {
    if (entry === '.gitkeep') continue
    const fullPath = join(extensionsDir, entry)
    const entryStat = await stat(fullPath)
    let name = ''
    let sourcePath = ''

    if (entryStat.isDirectory()) {
      name = entry
      sourcePath = join(fullPath, 'index.ts')
    } else if (entryStat.isFile() && entry.endsWith('.ts')) {
      name = entry.replace(/\.ts$/, '')
      sourcePath = fullPath
    }
    if (!name) continue

    let description = extensions.find((ext) => ext.name === name)?.notes ?? ''
    if (!description) {
      try {
        const text = await readFile(sourcePath, 'utf8')
        description = text.match(/description:\s*['"]([^'"]+)['"]/)?.[1] ?? ''
      } catch {}
    }
    console.log(`${name}\t${description}`)
    printed = true
  }
  if (!printed) console.log('(none)')
}
