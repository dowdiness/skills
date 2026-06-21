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
  { name: 'moonbit', kind: 'manual', source: 'in-tree' },
  { name: 'moonbit-agent-guide', kind: 'vendor', source: 'https://github.com/moonbitlang/moonbit-agent-guide', vendorPath: 'vendor/moonbitlang/moonbit-agent-guide', sourceSkillPath: 'vendor/moonbitlang/moonbit-agent-guide/moonbit-agent-guide/SKILL.md', outputPath: 'skills/moonbit-agent-guide/SKILL.md' },
  { name: 'moonbit-c-binding', kind: 'vendor', source: 'https://github.com/moonbitlang/moonbit-agent-guide', vendorPath: 'vendor/moonbitlang/moonbit-agent-guide', sourceSkillPath: 'vendor/moonbitlang/moonbit-agent-guide/moonbit-c-binding/SKILL.md', outputPath: 'skills/moonbit-c-binding/SKILL.md' },
  { name: 'moonbit-refactoring', kind: 'vendor', source: 'https://github.com/moonbitlang/moonbit-agent-guide', vendorPath: 'vendor/moonbitlang/moonbit-agent-guide', sourceSkillPath: 'vendor/moonbitlang/moonbit-agent-guide/moonbit-refactoring/SKILL.md', outputPath: 'skills/moonbit-refactoring/SKILL.md' },
  { name: 'moonbit-agent-setup', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-agent-setup/SKILL.md', outputPath: 'skills/moonbit-agent-setup/SKILL.md' },
  { name: 'moonbit-deprecated-syntax', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-deprecated-syntax/SKILL.md', outputPath: 'skills/moonbit-deprecated-syntax/SKILL.md' },
  { name: 'moonbit-error-handling', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-error-handling/SKILL.md', outputPath: 'skills/moonbit-error-handling/SKILL.md' },
  { name: 'moonbit-expression-problem', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-expression-problem/SKILL.md', outputPath: 'skills/moonbit-expression-problem/SKILL.md' },
  { name: 'moonbit-housekeeping', kind: 'manual', source: 'in-tree', notes: 'Includes BAML schemas and parser fixtures for worker-output intake.' },
  { name: 'moonbit-opaque-types', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-opaque-types/SKILL.md', outputPath: 'skills/moonbit-opaque-types/SKILL.md' },
  { name: 'moonbit-perf-investigation', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-perf-investigation/SKILL.md', outputPath: 'skills/moonbit-perf-investigation/SKILL.md' },
  { name: 'moonbit-refactoring-safety', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-refactoring-safety/SKILL.md', outputPath: 'skills/moonbit-refactoring-safety/SKILL.md' },
  { name: 'moonbit-traits', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-traits/SKILL.md', outputPath: 'skills/moonbit-traits/SKILL.md' },
  { name: 'moonbit-verification', kind: 'vendor', source: 'https://github.com/dowdiness/moonbit-skills', vendorPath: 'vendor/dowdiness/moonbit-skills', sourceSkillPath: 'vendor/dowdiness/moonbit-skills/moonbit-verification/SKILL.md', outputPath: 'skills/moonbit-verification/SKILL.md' },
  { name: 'incr', kind: 'vendor', source: 'https://github.com/dowdiness/incr', vendorPath: 'vendor/dowdiness/incr', sourceSkillPath: 'vendor/dowdiness/incr/skills/incr/SKILL.md', outputPath: 'skills/incr/SKILL.md', notes: 'User-owned library skill copied from the local incr project context.' },
  { name: 'loom', kind: 'vendor', source: 'https://github.com/dowdiness/loom', vendorPath: 'vendor/dowdiness/loom', sourceSkillPath: 'vendor/dowdiness/loom/skills/loom/SKILL.md', outputPath: 'skills/loom/SKILL.md', notes: 'User-owned library skill copied from the local loom project context.' },
  { name: 'handoff', kind: 'manual', source: 'in-tree' },
  { name: 'orchestrate', kind: 'manual', source: 'in-tree', notes: 'Cross-repo and multiagent session setup with delegation checkpoints and structured worker-output intake.' },
  { name: 'tuple-wrapper-api-style', kind: 'manual', source: 'in-tree' },
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

export type ExtensionKind = SkillKind

export interface ExtensionMeta {
  name: string
  kind: ExtensionKind
  source: string
  vendorPath?: string
  sourceExtensionPath?: string
  outputPath?: string
  notes?: string
}

export const extensions: ExtensionMeta[] = []

export const deferredLocalExtensions: string[] = []
