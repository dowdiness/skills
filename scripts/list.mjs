import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'

const root = new URL('..', import.meta.url).pathname
const skillsDir = join(root, 'skills')
const extensionsDir = join(root, 'extensions')

for (const entry of (await readdir(skillsDir)).sort()) {
  const dir = join(skillsDir, entry)
  if (!(await stat(dir)).isDirectory()) continue
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const info = parseFrontmatter(text) ?? {}
  console.log(`${entry}\t${info.description || ''}`)
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

    let description = ''
    try {
      const text = await readFile(sourcePath, 'utf8')
      description = text.match(/description:\s*['"]([^'"]+)['"]/)?.[1] ?? ''
    } catch {}
    console.log(`${name}\t${description}`)
    printed = true
  }
  if (!printed) console.log('(none)')
}
