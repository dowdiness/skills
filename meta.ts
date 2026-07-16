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
  { name: 'pr-analysis', kind: 'manual', source: 'in-tree', notes: 'Strategic PR evaluation with concise default and full opt-in template.' },
  { name: 'git-worktree-submodule-hygiene', kind: 'manual', source: 'in-tree', notes: 'Promoted from cross-project feedback memory: worktree/submodule lifecycle, gh pr merge/delete-branch pitfalls, stacked PR merges, concurrent-agent safety.' },
  { name: 'parallel-review', kind: 'manual', source: 'in-tree', notes: 'Parallel MoonBit/Canopy review skill; install the packaged coordinator and four reviewer agents with the repository install helper.' },
  { name: 'gh-cli-markdown-quoting', kind: 'manual', source: 'in-tree', notes: 'Promoted from cross-project feedback memory: shell-quoting hazards for GitHub CLI Markdown bodies and search patterns.' },
  { name: 'moonbit-gotchas', kind: 'manual', source: 'in-tree', notes: 'Promoted from cross-project feedback memory: silent-failure MoonBit compiler/formatter behaviors not covered by moonbit-refactoring or moonbit-deprecated-syntax.' },
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
export interface AgentMeta {
  name: string
  kind: SkillKind
  source: string
  notes?: string
}

export const agents: AgentMeta[] = [
  { name: 'doc-writer', kind: 'manual', source: 'in-tree', notes: 'Writes source-backed documentation and fixes documentation drift.' },
  { name: 'ensemble-reviewer', kind: 'manual', source: 'in-tree', notes: 'Runs low-cost reviewers in parallel and consolidates findings.' },
  { name: 'mechanic', kind: 'manual', source: 'in-tree', notes: 'Applies narrowly scoped mechanical edits.' },
  { name: 'moonbit-planner', kind: 'manual', source: 'in-tree', notes: 'Plans MoonBit/Canopy changes with API and package-boundary checks.' },
  { name: 'moonbit-refactor', kind: 'manual', source: 'in-tree', notes: 'Refactors MoonBit code conservatively and validates affected packages.' },
  { name: 'moonbit-reviewer', kind: 'manual', source: 'in-tree', notes: 'Reviews MoonBit APIs, package boundaries, and validation readiness.' },
  { name: 'moonbit-scout', kind: 'manual', source: 'in-tree', notes: 'Reconstructs MoonBit/Canopy structure and existing APIs.' },
  { name: 'parallel-reviewer', kind: 'manual', source: 'in-tree', notes: 'Runs four specialized review lenses and consolidates findings.' },
  { name: 'planner', kind: 'manual', source: 'in-tree', notes: 'Turns repository context and requirements into implementation plans.' },
  { name: 'review-router', kind: 'manual', source: 'in-tree', notes: 'Chooses and invokes an appropriate review workflow.' },
  { name: 'reviewer', kind: 'manual', source: 'in-tree', notes: 'Reviews code for quality, security, and maintainability.' },
  { name: 'reviewer-api-boundary', kind: 'manual', source: 'in-tree', notes: 'Reviews public APIs and package-boundary safety.' },
  { name: 'reviewer-correctness', kind: 'manual', source: 'in-tree', notes: 'Finds correctness bugs, edge cases, and invariant violations.' },
  { name: 'reviewer-idioms', kind: 'manual', source: 'in-tree', notes: 'Reviews readability, idioms, and unnecessary complexity.' },
  { name: 'scout', kind: 'manual', source: 'in-tree', notes: 'Reconnoiters codebases and compresses findings for handoff.' },
  { name: 'worker', kind: 'manual', source: 'in-tree', notes: 'Implements scoped tasks in an isolated agent context.' },
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

export const extensions: ExtensionMeta[] = [
  { name: 'scheduler', kind: 'manual', source: 'local-pi', outputPath: 'extensions/scheduler', notes: 'Profile-driven scheduler that routes repository tasks to subagents and records validation state.' },
  { name: 'subagent', kind: 'manual', source: 'local-pi', outputPath: 'extensions/subagent', notes: 'Registers the subagent delegation tool with user/project agent discovery and fallback handling.' },
]

export const deferredLocalExtensions: string[] = []
