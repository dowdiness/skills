import {
  diffDirs,
  gitSha,
  outputDir,
  recordedSha,
  rel,
  sourceDir,
  syncExtension,
  vendorExtensions,
} from './vendor-extensions.mjs'

function short(sha) {
  return sha === 'unknown' ? '?' : sha.slice(0, 7)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const names = args.filter((arg) => arg !== '--dry-run')
const all = vendorExtensions()
const selected = names.length === 0 ? all : all.filter((ext) => names.includes(ext.name))
const selectedNames = new Set(selected.map((ext) => ext.name))
const unknown = names.filter((name) => !selectedNames.has(name))

if (unknown.length > 0) {
  console.error(`Unknown vendor extension(s): ${unknown.join(', ')}`)
  console.error(`Known vendor extension(s): ${all.map((ext) => ext.name).sort().join(', ')}`)
  process.exit(1)
}

if (selected.length === 0) {
  console.log('No vendor extensions to sync.')
  process.exit(0)
}

for (const ext of selected) {
  if (dryRun) {
    const [diffs, snapshot, upstream] = await Promise.all([
      diffDirs(sourceDir(ext), outputDir(ext)),
      recordedSha(ext),
      gitSha(ext),
    ])
    const status = diffs.length === 0 ? 'clean' : `${diffs.length} diff(s)`
    const stale = snapshot !== 'unknown' && upstream !== 'unknown' && snapshot !== upstream ? ' STALE' : ''
    console.log(
      `DRY ${ext.name}: ${rel(sourceDir(ext))} -> ${rel(outputDir(ext))} (${status}) [snapshot=${short(snapshot)} upstream=${short(upstream)}${stale}]`,
    )
    continue
  }

  const { from, to, sha } = await syncExtension(ext)
  console.log(`SYNC ${ext.name}: ${rel(from)} -> ${rel(to)} @ ${sha}`)
}

console.log(`RESULT: ${selected.length}/${selected.length}`)
