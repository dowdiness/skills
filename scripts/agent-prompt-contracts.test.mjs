import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_PROMPT_CONTRACTS,
  EXPECTED_AGENT_NAMES,
  SUCCESS_MESSAGE,
  checkAgentPrompt,
  checkAgentPromptContracts,
  readAgentPromptFiles,
} from './agent-prompt-contracts.mjs'

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname)
const agentDirectory = resolve(repositoryRoot, 'agents')

function currentPrompts() {
  return readAgentPromptFiles(agentDirectory)
}

test('covers exactly the 16 current agents with explicit contracts', () => {
  const prompts = currentPrompts()
  expect(Object.keys(AGENT_PROMPT_CONTRACTS).sort()).toEqual([...EXPECTED_AGENT_NAMES].sort())
  expect([...prompts.keys()].sort()).toEqual([...EXPECTED_AGENT_NAMES].sort())
  expect(checkAgentPromptContracts(prompts)).toEqual([])
})

test('each progressive role declares every decision label independently', () => {
  const prompts = currentPrompts()
  const roles = ['scout', 'moonbit-scout', 'planner', 'moonbit-planner', 'worker', 'doc-writer']
  const labels = ['PROCEED', 'PROCEED WITH ASSUMPTIONS', 'CLARIFICATION NEEDED', 'STOPPED']
  for (const role of roles) {
    expect(checkAgentPrompt(role, prompts.get(role))).toEqual([])
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')
      const mutated = prompts.get(role).replace(new RegExp('`' + escaped + '`', 'g'), '')
      expect(checkAgentPrompt(role, mutated).join('\\n')).toContain(`decision label ${label}`)
    }
  }
})

test('mechanic deliberately has no progressive decision ladder', () => {
  const prompt = currentPrompts().get('mechanic')
  expect(checkAgentPrompt('mechanic', prompt)).toEqual([])
  expect(checkAgentPrompt('mechanic', prompt.replace(/STOP when a requested operation requires an unsupported capability/, 'Continue when a requested operation requires an unsupported capability')).join('\\n')).toContain('unsupported capability STOP behavior')
})

test('role-specific rules are mutation-tested as actionable contracts', () => {
  const prompts = currentPrompts()
  const mutations = [
    ['scout', /^.*one bounded discovery pass.*$/gm, 'bounded discovery'],
    ['scout', /^.*requires editing or bash.*$/gm, 'edit/bash/conflict STOP boundary'],
    ['moonbit-scout', /^.*one bounded discovery pass.*$/gm, 'bounded discovery'],
    ['moonbit-scout', /^.*requires editing or bash.*$/gm, 'edit/bash/conflict STOP boundary'],
    ['planner', /editing and validation execution are normal downstream handoffs, not reasons to stop/g, 'downstream editing and validation are not STOP reasons'],
    ['planner', /required capability outside this role applies only when that capability is required to safely inspect evidence or produce the plan/g, 'capability STOP is evidence/plan-only'],
    ['moonbit-planner', /editing and validation execution are normal downstream handoffs, not reasons to stop/g, 'downstream editing and validation are not STOP reasons'],
    ['moonbit-planner', /required capability outside this role applies only when that capability is required to safely inspect evidence or produce the plan/g, 'capability STOP is evidence/plan-only'],
    ['worker', /Run the lightest relevant validation/g, 'lightest relevant validation'],
    ['worker', /^.*Delegation and scope.*$/gm, 'explicit authorization for external effects'],
    ['doc-writer', /Prefer partial, source-backed progress/g, 'partial source-backed progress'],
    ['doc-writer', /this is distinct from `STOPPED`/g, 'INCOMPLETE versus STOPPED distinction'],
    ['mechanic', /Unsupported operations are/g, 'unsupported operations'],
    ['mechanic', /STOP when .* ambiguous/g, 'ambiguity STOP behavior'],
  ]
  for (const [role, pattern, label] of mutations) {
    const mutated = prompts.get(role).replace(pattern, '')
    expect(checkAgentPrompt(role, mutated).join('\\n')).toContain(label)
  }
})

test('specialist reviewer descriptions reject provider and model branding', () => {
  const prompts = currentPrompts()
  for (const name of ['reviewer-correctness', 'reviewer-api-boundary', 'reviewer-idioms']) {
    const branded = prompts.get(name).replace(/^description:.*$/m, 'description: OpenAI GPT review specialist')
    expect(checkAgentPrompt(name, branded).join('\n')).toContain('forbidden provider/model branding in description')
  }
})

test('coordinators retain status and incomplete-review semantics', () => {
  const prompts = currentPrompts()
  for (const name of ['ensemble-reviewer', 'parallel-reviewer']) {
    expect(checkAgentPrompt(name, prompts.get(name))).toEqual([])
    const incomplete = prompts.get(name).replace(/failed-or-missing/g, 'missing-status')
    expect(checkAgentPrompt(name, incomplete).join('\n')).toContain('failed-or-missing status')
    const statusless = prompts.get(name).replace(/INCOMPLETE REVIEW/g, 'REVIEW STATUS')
    expect(checkAgentPrompt(name, statusless).join('\n')).toContain('incomplete review semantics')
  }
})

test('malformed frontmatter and missing headings produce actionable failures', () => {
  expect(checkAgentPrompt('worker', 'not frontmatter')).toEqual([
    'agent worker: malformed or missing YAML frontmatter',
  ])
  const source = currentPrompts().get('worker').replace(/^## Validation$/m, '## Checks')
  expect(checkAgentPrompt('worker', source).join('\n')).toContain('agent worker: missing heading "## Validation"')
})

test('static checker has no model invocation dependency and states its boundary', () => {
  const source = readFileSync(resolve(repositoryRoot, 'scripts/agent-prompt-contracts.mjs'), 'utf8')
  expect(source).not.toContain('spawnSync')
  expect(source).not.toContain('spawn(')
  expect(source).not.toContain('list-models')
  expect(SUCCESS_MESSAGE).toContain('not a behavioral model evaluation')
})
