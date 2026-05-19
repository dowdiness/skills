export type SkillKind = 'manual' | 'vendor' | 'generated'

export interface SkillMeta {
  name: string
  kind: SkillKind
  source: string
  vendorPath?: string
  sourceSkillPath?: string
  outputPath?: string
  notes?: string
}

export const skills: SkillMeta[] = [
  { name: 'moonbit', kind: 'manual', source: '~/.agents/skills/moonbit' },
  { name: 'moonbit-agent-guide', kind: 'vendor', source: 'https://github.com/moonbitlang/moonbit-agent-guide/tree/main/moonbit-agent-guide' },
  { name: 'moonbit-c-binding', kind: 'vendor', source: 'https://github.com/moonbitlang/moonbit-agent-guide/tree/main/moonbit-c-binding' },
  { name: 'moonbit-refactoring', kind: 'vendor', source: 'https://github.com/moonbitlang/moonbit-agent-guide/tree/main/moonbit-refactoring' },
  { name: 'moonbit-agent-setup', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-deprecated-syntax', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-error-handling', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-expression-problem', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-housekeeping', kind: 'manual', source: 'dowdiness/moonbit-skills', notes: 'Includes BAML schemas and parser fixtures for worker-output intake.' },
  { name: 'moonbit-opaque-types', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-perf-investigation', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-refactoring-safety', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-traits', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'moonbit-verification', kind: 'manual', source: 'dowdiness/moonbit-skills' },
  { name: 'incr', kind: 'vendor', source: 'https://github.com/dowdiness/incr', vendorPath: 'vendor/dowdiness/incr', sourceSkillPath: 'vendor/dowdiness/incr/skills/incr/SKILL.md', outputPath: 'skills/incr/SKILL.md', notes: 'User-owned library skill copied from the local incr project context.' },
  { name: 'loom', kind: 'vendor', source: 'https://github.com/dowdiness/loom', vendorPath: 'vendor/dowdiness/loom', sourceSkillPath: 'vendor/dowdiness/loom/skills/loom/SKILL.md', outputPath: 'skills/loom/SKILL.md', notes: 'User-owned library skill copied from the local loom project context.' },
  { name: 'tuple-wrapper-api-style', kind: 'manual', source: '~/.agents/skills/tuple-wrapper-api-style' },
]

export const deferredLocalSkills = [
  'vercel-react-best-practices',
  'web-design-guidelines',
  'impeccable',
  'adapt',
  'animate',
  'audit',
  'bolder',
  'clarify',
  'colorize',
  'critique',
  'delight',
  'distill',
  'layout',
  'optimize',
  'overdrive',
  'polish',
  'quieter',
  'shape',
  'typeset',
]
