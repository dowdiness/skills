import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { extensions } from '../meta.ts'
import { abs, rel, root } from './vendor-skills.mjs'

const execFileAsync = promisify(execFile)

export { abs, rel, root }

export function vendorExtensions() {
  return extensions.filter((ext) => ext.sourceExtensionPath && ext.outputPath)
}

export function sourceDir(ext) {
  return abs(ext.sourceExtensionPath)
}

export function outputDir(ext) {
  return abs(ext.outputPath)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function listEntries(path, base = path, out = new Map()) {
  const s = await stat(path)
  if (s.isFile()) {
    out.set(relative(dirname(base), path) || basename(path), 'file')
    return out
  }
  if (s.isSymbolicLink()) {
    out.set(relative(dirname(base), path) || basename(path), 'symlink')
    return out
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'SYNC.md' || entry.name.endsWith('.SYNC.md')) continue
    const full = join(path, entry.name)
    if (entry.isDirectory()) {
      await listEntries(full, base, out)
    } else if (entry.isFile()) {
      out.set(relative(base, full), 'file')
    } else if (entry.isSymbolicLink()) {
      out.set(relative(base, full), 'symlink')
    }
  }
  return out
}

export async function diffDirs(left, right) {
  if (!(await exists(left))) return [`missing source path: ${rel(left)}`]
  if (!(await exists(right))) return [`missing output path: ${rel(right)}`]

  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)])
  if (leftStat.isFile() && rightStat.isFile()) {
    const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)])
    return leftContent.equals(rightContent) ? [] : [`content differs: ${rel(right)}`]
  }
  if (leftStat.isDirectory() !== rightStat.isDirectory()) {
    return [`type differs: ${rel(right)}`]
  }

  const leftEntries = await listEntries(left)
  const rightEntries = await listEntries(right)
  const diffs = []

  for (const file of [...leftEntries.keys()].sort()) {
    if (!rightEntries.has(file)) diffs.push(`missing output file: ${join(rel(right), file)}`)
  }
  for (const file of [...rightEntries.keys()].sort()) {
    if (!leftEntries.has(file)) diffs.push(`extra output file: ${join(rel(right), file)}`)
  }
  for (const file of [...leftEntries.keys()].filter((file) => rightEntries.has(file)).sort()) {
    const leftType = leftEntries.get(file)
    const rightType = rightEntries.get(file)
    if (leftType !== rightType) {
      diffs.push(`type differs: ${join(rel(right), file)} (${leftType} != ${rightType})`)
    } else if (leftType === 'file') {
      const [leftContent, rightContent] = await Promise.all([
        readFile(join(left, file)),
        readFile(join(right, file)),
      ])
      if (!leftContent.equals(rightContent)) {
        diffs.push(`content differs: ${join(rel(right), file)}`)
      }
    } else if (leftType === 'symlink') {
      const [leftTarget, rightTarget] = await Promise.all([
        readlink(join(left, file)),
        readlink(join(right, file)),
      ])
      if (leftTarget !== rightTarget) {
        diffs.push(`symlink differs: ${join(rel(right), file)}`)
      }
    }
  }

  return diffs
}

export async function gitSha(ext) {
  if (!ext.vendorPath) return 'unknown'
  try {
    const { stdout } = await execFileAsync('git', ['-C', abs(ext.vendorPath), 'rev-parse', 'HEAD'])
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}

function syncInfoPath(ext) {
  const to = outputDir(ext)
  return to.endsWith('.ts') ? join(dirname(to), `${basename(to, '.ts')}.SYNC.md`) : join(to, 'SYNC.md')
}

export async function recordedSha(ext) {
  try {
    const text = await readFile(syncInfoPath(ext), 'utf8')
    const match = text.match(/\*\*Git SHA:\*\*\s+`([a-f0-9]+)`/)
    return match?.[1] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function localDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function syncMarkdown(ext, sha, date) {
  return `# Sync Info\n\n- **Source:** \`${rel(sourceDir(ext))}\`\n- **Git SHA:** \`${sha}\`\n- **Synced:** ${date}\n\n`
}

export async function syncExtension(ext, date = localDate()) {
  const from = sourceDir(ext)
  const to = outputDir(ext)
  const sha = await gitSha(ext)

  await rm(to, { recursive: true, force: true })
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    errorOnExist: false,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  })
  const syncPath = syncInfoPath(ext)
  await mkdir(dirname(syncPath), { recursive: true })
  await writeFile(syncPath, syncMarkdown(ext, sha, date))

  return { from, to, sha }
}
