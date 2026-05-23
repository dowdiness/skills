export function parseFrontmatter(text) {
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
