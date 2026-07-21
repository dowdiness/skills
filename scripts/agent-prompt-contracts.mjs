#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'

export const EXPECTED_AGENT_NAMES = Object.freeze([
  'doc-writer',
  'ensemble-reviewer',
  'mechanic',
  'moonbit-planner',
  'moonbit-refactor',
  'moonbit-reviewer',
  'moonbit-scout',
  'parallel-reviewer',
  'planner',
  'review-router',
  'reviewer-api-boundary',
  'reviewer-correctness',
  'reviewer-idioms',
  'reviewer',
  'scout',
  'worker',
])

const heading = (value) => ({ label: `heading "## ${value}"`, test: (text) => new RegExp(`^## ${escapeRegExp(value)}$`, 'm').test(text) })
const concept = (label, pattern) => ({ kind: 'concept', label, test: (text) => pattern.test(text) })
const forbiddenDescription = (label, pattern) => ({ kind: 'forbidden-description', label, test: (description) => !pattern.test(description) })

const PROVIDER_OR_MODEL_BRAND = /\b(?:OpenAI|Anthropic|Claude|Codex|GPT(?:-[0-9.]+)?|DeepSeek|Qwen|Nemotron|Gemini|MiMo|OpenCode|Google)\b/i

export const AGENT_PROMPT_CONTRACTS = Object.freeze({
  'doc-writer': {
    required: [
      heading('Decision ladder'), heading('Workflow'), heading('Execution Decision'),
      heading('Completed'), heading('Files Changed'), heading('Validation'),
    ],
    concepts: [
      concept('source-backed documentation rules', /source-backed/i),
      concept('deliverable reread/existence check', /reread every changed|confirm that every requested target exists/i),
      concept('requested-target coverage', /coverage list/i),
      concept('unsupported quantitative claims ban', /word-count|percentage reduction/i),
      concept('INCOMPLETE completion status', /INCOMPLETE/),
    ],
  },
  'ensemble-reviewer': {
    required: [heading('Workflow'), heading('Reviewer Status'), heading('Files Reviewed'), heading('Summary')],
    concepts: [
      concept('usable report status', /usable report received/i),
      concept('failed-or-missing status', /failed-or-missing/i),
      concept('incomplete review semantics', /INCOMPLETE REVIEW/),
      concept('missing leaf names', /name every missing reviewer/i),
      concept('no manual retry', /Do not manually retry/i),
    ],
  },
  'mechanic': {
    required: [heading('Completed'), heading('Files Changed'), heading('Validation')],
    concepts: [
      concept('unsupported operations', /unsupported operations/i),
      concept('delete/move limits', /file deletion, file moves/i),
      concept('validation execution limit', /validation execution/i),
      concept('mechanical coverage counts', /requested, matched, applied, and skipped counts/i),
      concept('ambiguity STOP behavior', /STOP when .* ambiguous/i),
    ],
  },
  'moonbit-planner': {
    required: [
      heading('Goal'), heading('Execution Decision'), heading('Evidence and Assumptions'),
      heading('Non-goals'), heading('Reuse Check'), heading('Plan'), heading('Validation Plan'),
    ],
    concepts: [
      concept('reuse provenance labels', /source-verified.*inherited-unverified.*requires-tool-confirmation/s),
      concept('worker preflight verification', /worker must.*verify named files, symbols, package roots, and assumptions/i),
      concept('30-step ceiling', /30 numbered steps/i),
      concept('MoonBit validation is planned, not run', /cannot run `moon ide`, `moon check`, or `moon test`/i),
      concept('objective/package STOP behavior', /CLARIFICATION NEEDED.*STOPPED/s),
    ],
  },
  'moonbit-refactor': {
    required: [heading('Completed'), heading('Files Changed'), heading('Notes (if any)')],
    concepts: [
      concept('authoritative refactoring skill', /~\/\.agents\/skills\/moonbit-refactoring\/SKILL\.md/i),
      concept('conservative public API preservation', /Preserve behavior and public API/i),
      concept('validation readiness', /moon check|affected `moon test`/i),
      concept('API drift check', /\.mbti/),
    ],
  },
  'moonbit-reviewer': {
    required: [heading('Files Reviewed'), heading('Critical (must fix)'), heading('Warnings (should fix)'), heading('Summary')],
    concepts: [
      concept('MoonBit correctness review', /Correctness and semantics/i),
      concept('public API/package safety', /Package\/public API safety/i),
      concept('module validation commands', /moon check|moon test/i),
      concept('mbti validation', /\.mbti/),
    ],
  },
  'moonbit-scout': {
    required: [
      heading('Execution Decision'), heading('Files Retrieved'), heading('Existing API Candidates'),
      heading('Architecture'), heading('Validation / Follow-up'), heading('Start Here'),
    ],
    concepts: [
      concept('bounded evidence citations', /exact line ranges? that .* actually read/i),
      concept('source-verified API labels', /source-verified/),
      concept('moon ide confirmation labels', /needs moon ide confirmation/),
      concept('generated mbti caution', /Do not infer generated `?\.mbti/i),
      concept('600-word output bound', /at most 600 words/i),
      concept('STOP behavior', /STOPPED/),
    ],
  },
  'parallel-reviewer': {
    required: [heading('Workflow'), heading('Reviewer Status'), heading('Files Reviewed'), heading('Summary')],
    concepts: [
      concept('four-reviewer roster', /moonbit-reviewer.*reviewer-correctness.*reviewer-idioms.*reviewer-api-boundary/s),
      concept('failed-or-missing status', /failed-or-missing/),
      concept('incomplete review semantics', /INCOMPLETE REVIEW/),
      concept('complete context requirement', /complete review context/i),
    ],
  },
  'planner': {
    required: [
      heading('Goal'), heading('Execution Decision'), heading('Evidence and Assumptions'),
      heading('Non-goals'), heading('Reuse Check'), heading('Plan'), heading('Validation Plan'),
    ],
    concepts: [
      concept('reuse provenance labels', /source-verified.*inherited-unverified.*requires-tool-confirmation/s),
      concept('worker preflight verification', /worker must.*verify named files, symbols, package roots, and assumptions/i),
      concept('30-step ceiling', /30 numbered steps/i),
      concept('objective/package STOP behavior', /CLARIFICATION NEEDED.*STOPPED/s),
    ],
  },
  'review-router': {
    required: [heading('Decision criteria'), heading('Workflow')],
    concepts: [
      concept('coordinator routing choices', /ensemble-reviewer.*parallel-reviewer/s),
      concept('nested subagent invocation', /subagent/),
      concept('preserved coordinator output', /Return the chosen agent's output verbatim/i),
    ],
  },
  'reviewer-api-boundary': {
    required: [heading('Files Reviewed'), heading('Critical (must fix)'), heading('Warnings (should fix)'), heading('Summary')],
    concepts: [
      concept('API boundary scope', /public APIs, package boundaries/i),
      concept('trait-bound safety', /trait-bound safety/i),
      forbiddenDescription('provider/model branding in description', PROVIDER_OR_MODEL_BRAND),
    ],
  },
  'reviewer-correctness': {
    required: [heading('Files Reviewed'), heading('Critical (must fix)'), heading('Warnings (should fix)'), heading('Summary')],
    concepts: [
      concept('correctness scope', /correctness, edge cases, invariants/i),
      concept('semantic regression scope', /semantic regressions/i),
      forbiddenDescription('provider/model branding in description', PROVIDER_OR_MODEL_BRAND),
    ],
  },
  'reviewer-idioms': {
    required: [heading('Files Reviewed'), heading('Critical (must fix)'), heading('Warnings (should fix)'), heading('Summary')],
    concepts: [
      concept('idiom scope', /readability, naming, mutation, loops/i),
      concept('project convention scope', /project idioms/i),
      forbiddenDescription('provider/model branding in description', PROVIDER_OR_MODEL_BRAND),
    ],
  },
  reviewer: {
    required: [heading('Scope and routing'), heading('Files Reviewed'), heading('Critical (must fix)'), heading('Warnings (should fix)'), heading('Summary')],
    concepts: [
      concept('generic reviewer boundary', /Generic reviewer: broad, risk-sensitive quality, security, and maintainability/i),
      concept('high-confidence findings', /high-confidence findings only/i),
      concept('observed versus inferred evidence', /observed evidence from inference/i),
      concept('style-only duplication boundary', /do not duplicate style-only findings/i),
    ],
  },
  scout: {
    required: [
      heading('Execution Decision'), heading('Files Retrieved'), heading('Key Code'),
      heading('Architecture'), heading('Follow-up Checks'), heading('Start Here'),
    ],
    concepts: [
      concept('bounded evidence citations', /exact line ranges? that .* actually read/i),
      concept('inference status', /inferred.*unverified/s),
      concept('sensitive-content exclusion', /secrets, credentials, tokens, or PII/i),
      concept('600-word output bound', /at most 600 words/i),
      concept('STOP behavior', /STOPPED/),
    ],
  },
  worker: {
    required: [heading('Completed'), heading('Files Changed'), heading('Validation'), heading('Remaining Risks')],
    concepts: [
      concept('instruction-file preflight', /AGENTS\.md.*CLAUDE\.md/i),
      concept('dirty-tree inspection', /working-tree changes/i),
      concept('delegated scope boundary', /delegated scope and acceptance criteria are authoritative/i),
      concept('validation command reporting', /exact command, working directory, and pass\/fail status/i),
      concept('INCOMPLETE completion status', /INCOMPLETE/),
      concept('ambiguity STOP behavior', /CLARIFICATION NEEDED|STOPPED/),
    ],
  },
})

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultAgentDirectory = join(repositoryRoot, 'agents')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function asEntries(files) {
  if (files instanceof Map) return [...files.entries()]
  if (Array.isArray(files)) return files
  return Object.entries(files ?? {})
}

export function checkAgentPrompt(agentName, text) {
  const failures = []
  const contract = AGENT_PROMPT_CONTRACTS[agentName]
  if (!contract) return [`agent ${agentName}: no explicit prompt contract is declared`]

  const source = String(text ?? '')
  const frontmatter = parseFrontmatter(source)
  if (!frontmatter) {
    failures.push(`agent ${agentName}: malformed or missing YAML frontmatter`)
    return failures
  }
  if (frontmatter.name !== agentName) {
    failures.push(`agent ${agentName}: frontmatter name must be "${agentName}"`)
  }
  if (!('description' in frontmatter)) {
    failures.push(`agent ${agentName}: frontmatter is missing description`)
  }

  for (const assertion of contract.required ?? []) {
    if (!assertion.test(source)) failures.push(`agent ${agentName}: missing ${assertion.label}`)
  }
  for (const assertion of contract.concepts ?? []) {
    const value = assertion.kind === 'forbidden-description'
      ? assertion.test(frontmatter.description ?? '')
      : assertion.test(source)
    if (!value) {
      const verb = assertion.kind === 'forbidden-description' ? 'forbidden' : 'missing'
      failures.push(`agent ${agentName}: ${verb} ${assertion.label}`)
    }
  }
  return failures
}

export function checkAgentPromptContracts(files) {
  const entries = asEntries(files)
  const actual = new Set(entries.map(([name]) => name))
  const failures = []
  for (const name of EXPECTED_AGENT_NAMES) {
    if (!actual.has(name)) failures.push(`agent ${name}: missing prompt file and contract coverage`)
  }
  for (const [name, text] of entries) {
    failures.push(...checkAgentPrompt(name, text))
  }
  return failures
}

export const validateAgentPromptContracts = checkAgentPromptContracts
export const checkPromptContracts = checkAgentPromptContracts
export const checkPromptText = checkAgentPrompt

export function readAgentPromptFiles(directory = defaultAgentDirectory) {
  const files = new Map()
  for (const entry of readdirSync(directory).filter((name) => name.endsWith('.md')).sort()) {
    files.set(entry.slice(0, -3), readFileSync(join(directory, entry), 'utf8'))
  }
  return files
}

export function checkAgentPromptDirectory(directory = defaultAgentDirectory) {
  return checkAgentPromptContracts(readAgentPromptFiles(directory))
}

export const SUCCESS_MESSAGE = 'Validated static prompt shape for 16 agents; this is not a behavioral model evaluation.'

export function main(directory = defaultAgentDirectory) {
  let failures
  try {
    failures = checkAgentPromptDirectory(directory)
  } catch {
    console.error('ERROR: could not read agent prompt files')
    return 1
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`)
    console.error(`RESULT: prompt contracts failed (${failures.length})`)
    return 1
  }
  console.log(SUCCESS_MESSAGE)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
