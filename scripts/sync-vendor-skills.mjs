import { diffDirs, outputDir, rel, sourceDir, syncSkill, vendorSkills } from './vendor-skills.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const names = args.filter((arg) => arg !== '--dry-run')
const all = vendorSkills()
const selected = names.length === 0 ? all : all.filter((skill) => names.includes(skill.name))
const selectedNames = new Set(selected.map((skill) => skill.name))
const unknown = names.filter((name) => !selectedNames.has(name))

if (unknown.length > 0) {
  console.error(`Unknown vendor skill(s): ${unknown.join(', ')}`)
  console.error(`Known vendor skill(s): ${all.map((skill) => skill.name).sort().join(', ')}`)
  process.exit(1)
}

for (const skill of selected) {
  if (dryRun) {
    const diffs = await diffDirs(sourceDir(skill), outputDir(skill))
    const status = diffs.length === 0 ? 'clean' : `${diffs.length} diff(s)`
    console.log(`DRY ${skill.name}: ${rel(sourceDir(skill))} -> ${rel(outputDir(skill))} (${status})`)
    continue
  }

  const { from, to, sha } = await syncSkill(skill)
  console.log(`SYNC ${skill.name}: ${rel(from)} -> ${rel(to)} @ ${sha}`)
}

console.log(`RESULT: ${selected.length}/${selected.length}`)
