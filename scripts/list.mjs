import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'

const root = new URL('..', import.meta.url).pathname
const skillsDir = join(root, 'skills')

for (const entry of (await readdir(skillsDir)).sort()) {
  const dir = join(skillsDir, entry)
  if (!(await stat(dir)).isDirectory()) continue
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const info = parseFrontmatter(text) ?? {}
  console.log(`${entry}\t${info.description || ''}`)
}
