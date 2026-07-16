#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const agentDir = join(root, 'agents')
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function normalizeModelId(modelId) {
  const value = String(modelId ?? '').trim()
  const separator = value.lastIndexOf(':')
  const slash = value.lastIndexOf('/')
  if (separator > slash && thinkingLevels.has(value.slice(separator + 1))) {
    return value.slice(0, separator)
  }
  return value
}

export function parseFallbackModels(value) {
  return String(value ?? '')
    .split(',')
    .map((modelId) => modelId.trim())
    .filter(Boolean)
}

export function extractAgentModelIds(text) {
  const frontmatter = parseFrontmatter(text)
  if (!frontmatter) return []
  return [frontmatter.model, ...parseFallbackModels(frontmatter.fallbackModels)].filter(Boolean)
}

export function parseAvailableModelIds(output) {
  const ids = new Set()
  const withoutAnsi = String(output ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  for (const line of withoutAnsi.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (
      columns.length < 1 ||
      columns[0] === 'provider' ||
      columns[0].startsWith('-') ||
      columns[1]?.startsWith('-')
    ) continue

    let modelId
    if (columns[0].includes('/')) {
      modelId = columns[0]
    } else if (columns.length >= 2 && columns[1] !== 'model') {
      modelId = `${columns[0]}/${columns[1]}`
    }
    if (modelId) ids.add(normalizeModelId(modelId))
  }
  return ids
}

export function collectConfiguredAgentModelIds(directory = agentDir) {
  const ids = []
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.md')).sort()) {
    const text = readFileSync(join(directory, name), 'utf8')
    ids.push(...extractAgentModelIds(text))
  }
  return ids
}

export function findUnavailableModelIds(configuredIds, availableIds) {
  const available = new Set([...availableIds].map(normalizeModelId))
  return [...new Set(configuredIds.map(normalizeModelId).filter((modelId) => modelId && !available.has(modelId)))].sort()
}

export function validateAgentModels({ directory = agentDir, listModels = listPiModels } = {}) {
  const configuredIds = collectConfiguredAgentModelIds(directory)
  const availableIds = parseAvailableModelIds(listModels())
  return {
    configuredIds,
    availableIds,
    unavailableIds: findUnavailableModelIds(configuredIds, availableIds),
  }
}

function listPiModels() {
  const result = spawnSync('pi', ['--list-models'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit status ${result.status ?? 'unknown'}`
    throw new Error(`could not read model inventory from pi --list-models (${detail})`)
  }
  return result.stdout ?? ''
}

function main() {
  let result
  try {
    result = validateAgentModels()
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    return 1
  }

  if (result.unavailableIds.length > 0) {
    console.error(`Unavailable agent model IDs: ${result.unavailableIds.join(', ')}`)
    return 1
  }

  console.log(`Validated ${new Set(result.configuredIds.map(normalizeModelId)).size} agent model IDs against pi --list-models.`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
