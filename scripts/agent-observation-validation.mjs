const INCIDENT_CATEGORIES = new Set([
  'false_clarification', 'false_stop', 'unsafe_proceed', 'wrong_route',
  'false_complete', 'rework', 'good_assumption',
])
const INCIDENT_SEVERITIES = new Set(['low', 'medium', 'high'])
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u
const SENSITIVE_NOTE_PATTERN = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\/|\\|:\/\/|\b(?:api[_ -]?key|bearer|credential(?:s)?|cwd|model|password|path|prompt|repo(?:sitory)?|response|secret|session|task|token)\b|モデル|応答|レスポンス|パス|リポジトリ|セッション|タスク|トークン|認証情報|資格情報|\b(?:sk|ghp|github_pat_|xox[baprs])-[A-Za-z0-9_-]+\b|\b(?:github_pat_|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]+\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b[A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password)\s*=)/iu

export function validateIncident(input, agentNames, maxNoteLength = 240) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid incident')
  const { agent, category, severity, note } = input
  if (!(agentNames instanceof Set) || typeof agent !== 'string' || !agentNames.has(agent)) throw new Error('invalid incident agent')
  if (typeof category !== 'string' || !INCIDENT_CATEGORIES.has(category)) throw new Error('invalid incident category')
  if (typeof severity !== 'string' || !INCIDENT_SEVERITIES.has(severity)) throw new Error('invalid incident severity')
  if (typeof note !== 'string' || note.length === 0 || note.length > maxNoteLength
    || CONTROL_CHARACTER_PATTERN.test(note) || SENSITIVE_NOTE_PATTERN.test(note)) throw new Error('invalid incident note')
  return { agent, category, severity, note }
}
