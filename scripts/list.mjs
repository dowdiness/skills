import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const skillsDir = join(root, 'skills')

function frontmatter(text) {
  if (!text.startsWith('---\n')) return {}
  const end = text.indexOf('\n---', 4)
  if (end === -1) return {}
  const lines = text.slice(4, end).trim().split('\n')
  const out = {}
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    if (match[2] === '>' || match[2] === '|') {
      const parts = []
      while (lines[i + 1]?.startsWith('  ')) {
        i += 1
        parts.push(lines[i].trim())
      }
      out[match[1]] = parts.join(' ')
    } else {
      out[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return out
}

for (const entry of (await readdir(skillsDir)).sort()) {
  const dir = join(skillsDir, entry)
  if (!(await stat(dir)).isDirectory()) continue
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const info = frontmatter(text)
  console.log(`${entry}\t${info.description || ''}`)
}
