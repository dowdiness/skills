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

test('operational prompts retain evidence, decision, STOP, and completion concepts', () => {
  const prompts = currentPrompts()
  for (const name of ['scout', 'moonbit-scout', 'planner', 'moonbit-planner', 'worker', 'mechanic', 'doc-writer']) {
    expect(checkAgentPrompt(name, prompts.get(name))).toEqual([])
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
