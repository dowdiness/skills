import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { skills } from '../meta.ts'

const execFileAsync = promisify(execFile)

export const root = new URL('..', import.meta.url).pathname

export function vendorSkills() {
  return skills.filter((skill) => skill.sourceSkillPath && skill.outputPath)
}

export function abs(path) {
  return join(root, path)
}

export function sourceDir(skill) {
  return dirname(abs(skill.sourceSkillPath))
}

export function outputDir(skill) {
  return dirname(abs(skill.outputPath))
}

export function rel(path) {
  return relative(root, path)
}

async function listEntries(dir, base = dir, out = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'SYNC.md') continue
    const full = join(dir, entry.name)
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

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function diffDirs(left, right) {
  if (!(await exists(left))) return [`missing source directory: ${rel(left)}`]
  if (!(await exists(right))) return [`missing output directory: ${rel(right)}`]

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

export async function gitSha(skill) {
  if (!skill.vendorPath) return 'unknown'
  const { stdout } = await execFileAsync('git', ['-C', abs(skill.vendorPath), 'rev-parse', 'HEAD'])
  return stdout.trim()
}

export function syncMarkdown(skill, sha, date) {
  return `# Sync Info

- **Source:** \`${rel(sourceDir(skill))}\`
- **Git SHA:** \`${sha}\`
- **Synced:** ${date}

`
}

function localDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export async function syncSkill(skill, date = localDate()) {
  const from = sourceDir(skill)
  const to = outputDir(skill)
  const sha = await gitSha(skill)

  await rm(to, { recursive: true, force: true })
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    errorOnExist: false,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  })
  await writeFile(join(to, 'SYNC.md'), syncMarkdown(skill, sha, date))

  return { from, to, sha }
}
