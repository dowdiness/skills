import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateIncident as validateIncidentShared } from "../../scripts/agent-observation-validation.mjs";

export const AUTOMATION_SCHEMA_VERSION = 1;
export const AUTOMATION_STATE_FILE = "automation-state.json";
export const AUTOMATION_KEY_FILE = "automation-key";
export const ACTIVE_POINTER_FILE = "active-cohort.json";
export const METADATA_FILE = "metadata.json";
export const INCIDENT_FILE = "incidents.tsv";
export const REPORT_FILE = "latest-report.json";
export const PENDING_FINISH_FILE = ".pending-finish.json";
export const LOCK_FILE = ".operation.lock";
export const INCIDENT_CATEGORIES = ["false_clarification", "false_stop", "unsafe_proceed", "wrong_route", "false_complete", "rework", "good_assumption"] as const;
export const INCIDENT_SEVERITIES = ["low", "medium", "high"] as const;
export const MAX_NOTE_LENGTH = 240;
export const OBSERVATION_MEMORY_CATEGORY = "agent-observations";

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "contextTokens", "turns"] as const;
const RUNTIME_FIELDS = ["success", "failure", "aborted", "unresolved"] as const;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+@:-]{0,199}$/u;
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CASE_PATTERN = /^case-[a-f0-9]{18}$/u;
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// Persisted observation state is private and bounded. The bound is deliberately
// generous for fingerprinted session state, while preventing untrusted files from
// turning a status/checkpoint read into an unbounded allocation.
export const MAX_PRIVATE_STATE_BYTES = 4 * 1024 * 1024;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface CohortInfo {
  stateRoot: string;
  directory: string;
  commit: string;
  shortHead: string;
  startedAt: string;
  agentNames: Set<string>;
  trustedModelIds: Set<string>;
}

export interface UsageReport {
  schemaVersion: number;
  agents: Array<{
    agent: string;
    invocations: number;
    runtime: Record<string, number>;
    models: string[];
    usage: Record<string, number>;
    durationMs: number;
  }>;
  totals: {
    invocations: number;
    runtime: Record<string, number>;
    models: string[];
    usage: Record<string, number>;
    durationMs: number;
    callDurationMs: number;
  };
  unknownRecords: number;
  malformedRecords: number;
  missingLeaves: number;
}

export interface AutomationState {
  schemaVersion: number;
  commit: string;
  updatedAt: string;
  aggregate: UsageReport;
  sessions: Record<string, string[]>;
}

export interface CheckpointResult {
  report: UsageReport;
  observedSessions: number;
  observedEntries: number;
  invocationCount: number;
  shortHead: string;
}

function stateRootDefault(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "skills-agent-observation");
}

export function defaultStateRoot(): string {
  return stateRootDefault();
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateFile(path: string, content: string | Buffer, exclusive = false): void {
  const fd = openSync(path, exclusive ? (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY) : "w", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function atomicPrivateFile(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomBytes(9).toString("hex")}`;
  let created = false;
  try {
    privateFile(temporary, content, true);
    created = true;
    renameSync(temporary, path);
    created = false;
    chmodSync(path, 0o600);
  } finally {
    if (created) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

function privateAppend(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

function withLock<T>(stateRoot: string, operation: () => T): T {
  privateDirectory(stateRoot);
  const path = join(stateRoot, LOCK_FILE);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST" || (error as NodeJS.ErrnoException)?.code === "ELOOP") throw new Error("observation operation already in progress");
    throw new Error("could not lock observation state");
  }
  try {
    return operation();
  } finally {
    try {
      if (fd !== undefined) {
        const lockInfo = lstatSync(path);
        const ownerInfo = fstatSync(fd);
        if (lockInfo.isFile() && lockInfo.dev === ownerInfo.dev && lockInfo.ino === ownerInfo.ino) unlinkSync(path);
      }
    } catch {}
    if (fd !== undefined) closeSync(fd);
  }
}

class InvalidPrivateStateError extends Error {
  constructor() {
    super("invalid private state");
  }
}

class MissingPrivateStateError extends Error {
  readonly code = "ENOENT";

  constructor() {
    super("private state is missing");
  }
}

/**
 * Read a private state file through one descriptor. O_NOFOLLOW protects the
 * open itself; all subsequent reads use that descriptor, so replacement after
 * open cannot redirect the read to a symlink target.
 */
export function readPrivateState(path: string, maxBytes = MAX_PRIVATE_STATE_BYTES): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    const owned = typeof process.getuid !== "function" || before.uid === process.getuid();
    if (!before.isFile() || before.isSymbolicLink() || !owned || (before.mode & 0o077) !== 0 || (before.mode & 0o400) === 0) {
      throw new InvalidPrivateStateError();
    }
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) throw new InvalidPrivateStateError();

    const buffer = Buffer.alloc(before.size);
    let total = 0;
    while (total < before.size) {
      const count = readSync(fd, buffer, total, before.size - total, null);
      if (count === 0) break;
      total += count;
    }
    const extra = Buffer.alloc(1);
    const extraCount = readSync(fd, extra, 0, 1, null);
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || after.size > maxBytes
      || after.size !== before.size || total !== before.size || extraCount !== 0) {
      throw new InvalidPrivateStateError();
    }
    return buffer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new MissingPrivateStateError();
    throw new InvalidPrivateStateError();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readObject(path: string): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(readPrivateState(path).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
  } catch {
    return null;
  }
}

function readCohort(stateRoot: string): CohortInfo | null {
  try {
    lstatSync(join(stateRoot, PENDING_FINISH_FILE));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
  }
  const pointer = readObject(join(stateRoot, ACTIVE_POINTER_FILE));
  if (!pointer || pointer.schemaVersion !== 1 || typeof pointer.commit !== "string" || !/^[a-f0-9]{40}$/u.test(pointer.commit)
    || typeof pointer.shortHead !== "string" || !/^[a-f0-9]{12}$/u.test(pointer.shortHead) || pointer.shortHead !== pointer.commit.slice(0, 12)) return null;
  const directory = join(stateRoot, pointer.shortHead);
  const metadata = readObject(join(directory, METADATA_FILE));
  if (!metadata || metadata.schemaVersion !== 1 || metadata.commit !== pointer.commit || metadata.shortHead !== pointer.shortHead
    || typeof metadata.startedAt !== "string" || !ISO_PATTERN.test(metadata.startedAt)
    || !Array.isArray(metadata.agentNames) || !Array.isArray(metadata.modelIds)) return null;
  const agentNames = new Set(metadata.agentNames.filter((value: unknown): value is string => typeof value === "string" && AGENT_PATTERN.test(value)));
  const trustedModelIds = new Set(metadata.modelIds.filter((value: unknown): value is string => typeof value === "string" && MODEL_PATTERN.test(value)));
  if (agentNames.size !== metadata.agentNames.length || trustedModelIds.size !== metadata.modelIds.length) return null;
  return { stateRoot, directory, commit: pointer.commit, shortHead: pointer.shortHead, startedAt: metadata.startedAt, agentNames, trustedModelIds };
}

function readKey(cohort: CohortInfo): Buffer | null {
  const path = join(cohort.directory, AUTOMATION_KEY_FILE);
  try {
    const key = readPrivateState(path, 32);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function ensureKey(cohort: CohortInfo): Buffer {
  const current = readKey(cohort);
  if (current) return current;
  const path = join(cohort.directory, AUTOMATION_KEY_FILE);
  try {
    lstatSync(path);
    throw new Error(INVALID_AUTOMATION_STATE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      if (error instanceof Error && error.message === INVALID_AUTOMATION_STATE) throw error;
      throw new Error(INVALID_AUTOMATION_STATE);
    }
  }
  try {
    privateFile(path, randomBytes(32), true);
  } catch {
    throw new Error(INVALID_AUTOMATION_STATE);
  }
  return readKey(cohort) ?? (() => { throw new Error(INVALID_AUTOMATION_STATE); })();
}

function emptyUsage(): Record<string, number> {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
}
function emptyRuntime(): Record<string, number> {
  return Object.fromEntries(RUNTIME_FIELDS.map((field) => [field, 0]));
}
function emptyReport(agentNames: Set<string>): UsageReport {
  const names = [...agentNames].sort();
  const agents = names.map((agent) => ({ agent, invocations: 0, runtime: emptyRuntime(), models: [], usage: emptyUsage(), durationMs: 0 }));
  return {
    schemaVersion: 1,
    agents,
    totals: { invocations: 0, runtime: emptyRuntime(), models: [], usage: emptyUsage(), durationMs: 0, callDurationMs: 0 },
    unknownRecords: 0,
    malformedRecords: 0,
    missingLeaves: 0,
  };
}

function safeAdd(target: Record<string, number>, field: string, value: unknown): boolean {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || !Number.isSafeInteger(target[field]) || target[field] > Number.MAX_SAFE_INTEGER - (value as number)) return false;
  target[field] += value as number;
  return true;
}

function timestampMs(record: any): number | null {
  const value = record?.timestamp ?? record?.message?.timestamp ?? record?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function recordContent(record: any): any[] | null {
  if (!record || typeof record !== "object") return null;
  if (Array.isArray(record.content)) return record.content;
  if (record.message && Array.isArray(record.message.content)) return record.message.content;
  return null;
}
function resultMessage(record: any): any {
  if (!record || typeof record !== "object") return null;
  return record.message && typeof record.message === "object" ? record.message : record;
}
function requestedAgents(value: any, agents: Set<string>): { requested: string[]; unknown: number } {
  const requested: string[] = [];
  let unknown = 0;
  const add = (item: unknown) => {
    if (typeof item !== "string" || !item.trim()) { unknown += 1; return; }
    const name = item.trim();
    if (agents.has(name)) requested.push(name); else unknown += 1;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { requested, unknown: 1 };
  if (value.agent !== undefined) add(value.agent);
  for (const field of ["tasks", "chain"]) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field])) { unknown += 1; continue; }
    for (const task of value[field]) add(task && typeof task === "object" ? task.agent : task);
  }
  return { requested, unknown };
}

export function aggregateSessionRecords(records: unknown[], cohort: Pick<CohortInfo, "agentNames" | "trustedModelIds">): UsageReport {
  const report = emptyReport(cohort.agentNames);
  const agents = new Map(report.agents.map((agent) => [agent.agent, agent]));
  const calls = new Map<string, { requested: string[]; timestamp: number | null }>();
  const results: Array<{ toolCallId: unknown; leaves: unknown[]; timestamp: number | null }> = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) { report.malformedRecords += 1; continue; }
    const content = recordContent(record);
    if (content) for (const item of content) {
      if (!item || typeof item !== "object" || item.name !== "subagent") continue;
      if (item.type !== "toolCall" || typeof item.id !== "string" || !item.id) { report.malformedRecords += 1; continue; }
      const request = requestedAgents(item.arguments, cohort.agentNames);
      report.unknownRecords += request.unknown;
      calls.set(item.id, { requested: request.requested, timestamp: timestampMs(record) });
      if (request.requested.length === 0) report.unknownRecords += 1;
    }
    const message = resultMessage(record);
    if (message?.toolName !== "subagent") {
      if (record.type === "unknown" || record.kind === "unknown") report.unknownRecords += 1;
      continue;
    }
    const details = message.details ?? record.details;
    if (!details || typeof details !== "object" || !Array.isArray(details.results)) {
      report.malformedRecords += 1;
      results.push({ toolCallId: message.toolCallId ?? record.toolCallId, leaves: [], timestamp: timestampMs(record) });
    } else results.push({ toolCallId: message.toolCallId ?? record.toolCallId, leaves: details.results, timestamp: timestampMs(record) });
  }
  const matched = new Set<string>();
  const returned = new Map<string, Map<string, number>>();
  const addLeaf = (leaf: any): string | null => {
    if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) { report.malformedRecords += 1; return null; }
    if (typeof leaf.agent !== "string" || !agents.has(leaf.agent)) { report.unknownRecords += 1; return null; }
    const aggregate = agents.get(leaf.agent)!;
    aggregate.invocations += 1;
    if (leaf.exitCode === 0) aggregate.runtime.success += 1;
    else if (leaf.stopReason === "aborted" || leaf.exitCode === 130) aggregate.runtime.aborted += 1;
    else aggregate.runtime.failure += 1;
    if ("model" in leaf) {
      if (typeof leaf.model !== "string") report.malformedRecords += 1;
      else {
        const modelId = normalizeModelId(leaf.model);
        if (!MODEL_PATTERN.test(modelId)) report.malformedRecords += 1;
        else if (!cohort.trustedModelIds.has(modelId)) report.unknownRecords += 1;
        else if (!aggregate.models.includes(modelId)) aggregate.models.push(modelId);
      }
    }
    if ("usage" in leaf) {
      if (!leaf.usage || typeof leaf.usage !== "object" || Array.isArray(leaf.usage)) report.malformedRecords += 1;
      else for (const field of USAGE_FIELDS) if (field in leaf.usage && !safeAdd(aggregate.usage, field, leaf.usage[field])) report.malformedRecords += 1;
    }
    if ("durationMs" in leaf && !safeAdd(aggregate, "durationMs", leaf.durationMs)) report.malformedRecords += 1;
    return leaf.agent;
  };
  for (const result of results) {
    const id = typeof result.toolCallId === "string" ? result.toolCallId : undefined;
    const call = id ? calls.get(id) : undefined;
    if (call && !matched.has(id)) {
      matched.add(id);
      if (call.timestamp !== null && result.timestamp !== null) {
        const duration = result.timestamp - call.timestamp;
        if (!safeAdd(report.totals, "callDurationMs", duration)) report.malformedRecords += 1;
      }
    }
    for (const leaf of result.leaves) {
      const agent = addLeaf(leaf);
      if (call && agent) {
        const byAgent = returned.get(id! ) ?? new Map<string, number>();
        byAgent.set(agent, (byAgent.get(agent) ?? 0) + 1);
        returned.set(id!, byAgent);
      }
    }
  }
  for (const [id, call] of calls) {
    const seen = returned.get(id) ?? new Map<string, number>();
    for (const agent of call.requested) {
      const count = seen.get(agent) ?? 0;
      if (count > 0) seen.set(agent, count - 1);
      else { agents.get(agent)!.runtime.unresolved += 1; report.missingLeaves += 1; }
    }
  }
  for (const aggregate of report.agents) {
    if (!safeAdd(report.totals, "invocations", aggregate.invocations)) report.malformedRecords += 1;
    for (const field of RUNTIME_FIELDS) if (!safeAdd(report.totals.runtime, field, aggregate.runtime[field])) report.malformedRecords += 1;
    for (const model of aggregate.models) if (!report.totals.models.includes(model)) report.totals.models.push(model);
    for (const field of USAGE_FIELDS) if (!safeAdd(report.totals.usage, field, aggregate.usage[field])) report.malformedRecords += 1;
    if (!safeAdd(report.totals, "durationMs", aggregate.durationMs)) report.malformedRecords += 1;
    aggregate.models.sort();
  }
  report.totals.models.sort();
  return report;
}

export function mergeUsageReports(reports: UsageReport[], cohort: Pick<CohortInfo, "agentNames" | "trustedModelIds">): UsageReport {
  const result = emptyReport(cohort.agentNames);
  const agents = new Map(result.agents.map((agent) => [agent.agent, agent]));
  const mergeCounter = (target: Record<string, number>, field: string, value: unknown) => {
    if (value === undefined) return;
    if (!safeAdd(target, field, value)) result.malformedRecords += 1;
  };
  if (!Array.isArray(reports)) {
    result.malformedRecords += 1;
    return result;
  }
  for (const report of reports) {
    if (!report || typeof report !== "object" || Array.isArray(report)) { result.malformedRecords += 1; continue; }
    if (report.schemaVersion !== undefined && report.schemaVersion !== 1) result.malformedRecords += 1;
    if (!Array.isArray(report.agents)) result.malformedRecords += 1;
    else for (const source of report.agents) {
      if (!source || typeof source !== "object" || Array.isArray(source)) { result.malformedRecords += 1; continue; }
      if (typeof source.agent !== "string" || !agents.has(source.agent)) { result.unknownRecords += 1; continue; }
      const target = agents.get(source.agent)!;
      mergeCounter(target, "invocations", source.invocations);
      for (const field of RUNTIME_FIELDS) mergeCounter(target.runtime, field, source.runtime?.[field]);
      for (const field of USAGE_FIELDS) mergeCounter(target.usage, field, source.usage?.[field]);
      mergeCounter(target, "durationMs", source.durationMs);
      if (Array.isArray(source.models)) for (const model of source.models) {
        if (typeof model !== "string") result.malformedRecords += 1;
        else {
          const modelId = normalizeModelId(model);
          if (!MODEL_PATTERN.test(modelId)) result.malformedRecords += 1;
          else if (!cohort.trustedModelIds.has(modelId)) result.unknownRecords += 1;
          else if (!target.models.includes(modelId)) target.models.push(modelId);
        }
      }
      else if (source.models !== undefined) result.malformedRecords += 1;
    }
    mergeCounter(result, "unknownRecords", report.unknownRecords);
    mergeCounter(result, "malformedRecords", report.malformedRecords);
    mergeCounter(result, "missingLeaves", report.missingLeaves);
    mergeCounter(result.totals, "callDurationMs", report.totals?.callDurationMs);
  }
  for (const aggregate of result.agents) {
    if (!safeAdd(result.totals, "invocations", aggregate.invocations)) result.malformedRecords += 1;
    for (const field of RUNTIME_FIELDS) if (!safeAdd(result.totals.runtime, field, aggregate.runtime[field])) result.malformedRecords += 1;
    for (const model of aggregate.models) if (!result.totals.models.includes(model)) result.totals.models.push(model);
    for (const field of USAGE_FIELDS) if (!safeAdd(result.totals.usage, field, aggregate.usage[field])) result.malformedRecords += 1;
    if (!safeAdd(result.totals, "durationMs", aggregate.durationMs)) result.malformedRecords += 1;
    aggregate.models.sort();
  }
  result.totals.models.sort();
  return result;
}

function canonicalize(value: unknown, isHeader = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  const object = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    if (key === "parentId") continue;
    output[key] = canonicalize(object[key], isHeader);
  }
  return output;
}

export function canonicalEntry(entry: unknown): string {
  const object = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  return JSON.stringify(canonicalize(object, object.type === "session"));
}

function normalizeModelId(value: string): string {
  const modelId = value.trim();
  const separator = modelId.lastIndexOf(":");
  const slash = modelId.lastIndexOf("/");
  return separator > slash && THINKING_LEVELS.has(modelId.slice(separator + 1)) ? modelId.slice(0, separator) : modelId;
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}
export function sessionIdentity(key: Buffer, sessionId: string): string {
  return hmacHex(key, `session\0${sessionId}`);
}
export function entryFingerprint(key: Buffer, entry: unknown): string {
  return hmacHex(key, `entry\0${canonicalEntry(entry)}`);
}

export function validatePersistedAggregate(value: unknown, cohort: Pick<CohortInfo, "agentNames" | "trustedModelIds">): UsageReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const canonical = mergeUsageReports([value as UsageReport], cohort);
  return isDeepStrictEqual(value, canonical) ? canonical : null;
}

function validateState(value: any, cohort: CohortInfo): AutomationState | null {
  if (!value || value.schemaVersion !== AUTOMATION_SCHEMA_VERSION || value.commit !== cohort.commit || typeof value.updatedAt !== "string" || !ISO_PATTERN.test(value.updatedAt)
    || !value.aggregate || !Array.isArray(value.aggregate.agents) || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)) return null;
  for (const [session, fingerprints] of Object.entries(value.sessions)) {
    if (!HASH_PATTERN.test(session) || !Array.isArray(fingerprints) || fingerprints.some((fingerprint) => typeof fingerprint !== "string" || !HASH_PATTERN.test(fingerprint))) return null;
  }
  const aggregate = validatePersistedAggregate(value.aggregate, cohort);
  if (!aggregate) return null;
  return { schemaVersion: AUTOMATION_SCHEMA_VERSION, commit: cohort.commit, updatedAt: value.updatedAt, aggregate, sessions: value.sessions as Record<string, string[]> };
}

const INVALID_AUTOMATION_STATE = "invalid automation state";

function readExistingObject(path: string): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(readPrivateState(path).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID_AUTOMATION_STATE);
    return value as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (error instanceof Error && error.message === INVALID_AUTOMATION_STATE) throw error;
    throw new Error(INVALID_AUTOMATION_STATE);
  }
}

function readAutomationState(cohort: CohortInfo): AutomationState | null {
  const value = readExistingObject(join(cohort.directory, AUTOMATION_STATE_FILE));
  if (!value) return null;
  const state = validateState(value, cohort);
  if (!state) throw new Error(INVALID_AUTOMATION_STATE);
  return state;
}

function readLegacyAggregate(cohort: CohortInfo): UsageReport | null {
  const value = readExistingObject(join(cohort.directory, REPORT_FILE));
  if (!value) return null;
  if (value.schemaVersion !== 1 || typeof value.generatedAt !== "string" || !ISO_PATTERN.test(value.generatedAt)
    || !Number.isSafeInteger(value.fileCount) || value.fileCount < 0 || !value.aggregate || typeof value.aggregate !== "object" || Array.isArray(value.aggregate)) {
    throw new Error(INVALID_AUTOMATION_STATE);
  }
  const aggregate = validatePersistedAggregate(value.aggregate, cohort);
  if (!aggregate) throw new Error(INVALID_AUTOMATION_STATE);
  return aggregate;
}

function firstActivationEntries(entries: unknown[], fingerprints: string[], globallySeen: Set<string>, startedAt: string): unknown[] {
  const boundary = Date.parse(startedAt);
  const unseen = entries.filter((_entry, index) => !globallySeen.has(fingerprints[index]));
  const calls = new Map<string, number | null>();
  for (const entry of entries) {
    const content = recordContent(entry);
    if (!content) continue;
    for (const item of content) {
      if (item && typeof item === "object" && item.name === "subagent" && item.type === "toolCall" && typeof item.id === "string" && item.id) {
        calls.set(item.id, timestampMs(entry));
      }
    }
  }
  const allowedCalls = new Set<string>();
  for (const [id, timestamp] of calls) if (timestamp !== null && timestamp >= boundary) allowedCalls.add(id);
  return unseen.filter((entry) => {
    const timestamp = timestampMs(entry);
    if (timestamp === null || timestamp < boundary) return false;
    const content = recordContent(entry);
    const hasAllowedCall = !!content?.some((item) => item && typeof item === "object" && item.name === "subagent"
      && item.type === "toolCall" && typeof item.id === "string" && allowedCalls.has(item.id));
    const message = resultMessage(entry);
    const toolCallId = message?.toolName === "subagent" ? (message.toolCallId ?? (entry as any)?.toolCallId) : undefined;
    const isAllowedResult = typeof toolCallId === "string" && allowedCalls.has(toolCallId);
    // First activation only admits complete invocation groups. This prevents an
    // old call paired with a new result (or an unrelated result) from leaking.
    return hasAllowedCall || isAllowedResult;
  });
}

export function checkpoint(options: { stateRoot?: string; sessionId: string; entries: unknown[]; now?: Date; writeState?: (path: string, content: string) => void }): CheckpointResult | null {
  const stateRoot = options.stateRoot ?? stateRootDefault();
  return withLock(stateRoot, () => {
    const cohort = readCohort(stateRoot);
    if (!cohort) return null;
    const current = readAutomationState(cohort);
    const legacy = !current ? readLegacyAggregate(cohort) : null;
    const key = ensureKey(cohort);
    const identity = sessionIdentity(key, options.sessionId);
    const fingerprints = options.entries.map((entry) => entryFingerprint(key, entry));
    const previous = current?.sessions[identity];
    const sessions = { ...(current?.sessions ?? {}) };
    const globallySeen = new Set(Object.values(sessions).flat());
    let aggregate: UsageReport;
    if (previous !== undefined && current) {
      const unseen = options.entries.filter((_entry, index) => !globallySeen.has(fingerprints[index]));
      aggregate = unseen.length > 0
        ? mergeUsageReports([current.aggregate, aggregateSessionRecords(unseen, cohort)], cohort)
        : current.aggregate;
    } else {
      if (legacy) {
        aggregate = legacy;
      } else {
        const unseen = firstActivationEntries(options.entries, fingerprints, globallySeen, cohort.startedAt);
        const base = current?.aggregate ?? emptyReport(cohort.agentNames);
        aggregate = unseen.length > 0
          ? mergeUsageReports([base, aggregateSessionRecords(unseen, cohort)], cohort)
          : base;
      }
    }
    sessions[identity] = [...new Set([...(previous ?? []), ...fingerprints])].sort();
    const state: AutomationState = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      commit: cohort.commit,
      updatedAt: (options.now ?? new Date()).toISOString(),
      aggregate,
      sessions,
    };
    const content = `${JSON.stringify(state, null, 2)}\n`;
    (options.writeState ?? atomicPrivateFile)(join(cohort.directory, AUTOMATION_STATE_FILE), content);
    const observedEntries = Object.values(sessions).reduce((total, value) => total + value.length, 0);
    return { report: aggregate, observedSessions: Object.keys(sessions).length, observedEntries, invocationCount: aggregate.totals.invocations, shortHead: cohort.shortHead };
  });
}

export function readAutomationAggregate(stateRoot = stateRootDefault()): CheckpointResult | null {
  const cohort = readCohort(stateRoot);
  if (!cohort) return null;
  const state = readAutomationState(cohort);
  if (!state) return null;
  const observedEntries = Object.values(state.sessions).reduce((total, value) => total + value.length, 0);
  return { report: state.aggregate, observedSessions: Object.keys(state.sessions).length, observedEntries, invocationCount: state.aggregate.totals.invocations, shortHead: cohort.shortHead };
}

export function validateIncident(input: unknown, agentNames: Set<string>): { agent: string; category: string; severity: string; note: string } {
  return validateIncidentShared(input, agentNames, MAX_NOTE_LENGTH);
}

export interface ObservationMemoryFilesystem {
  lstatSync: typeof lstatSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  writeFileSync: typeof writeFileSync;
  fchmodSync: typeof fchmodSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  rmdirSync: typeof rmdirSync;
}

export interface ObservationMemoryDocument {
  caseId: string;
  date: string;
  agent: string;
  category: string;
  severity: string;
  note: string;
}

const MEMORY_FILESYSTEM: ObservationMemoryFilesystem = {
  lstatSync,
  mkdirSync,
  openSync,
  fstatSync,
  writeFileSync,
  fchmodSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  rmdirSync,
};

export function defaultMemoryRoot(): string {
  return join(homedir(), ".Codex", "skills", "agent-memory", "memories");
}

const DUAL_SAVE_JAPANESE_PATTERN = /観測/u;
const DUAL_SAVE_JAPANESE_MEMORY_PATTERN = /メモリ/u;
const DUAL_SAVE_JAPANESE_ACTION_PATTERN = /(?:記録|保存)/u;
const DUAL_SAVE_ENGLISH_PATTERN = /\b(?:observation|incident)\b/iu;
const DUAL_SAVE_ENGLISH_MEMORY_PATTERN = /\b(?:memory|remember)\b/iu;
const DUAL_SAVE_ENGLISH_ACTION_PATTERN = /\b(?:record|save)\b/iu;
const DUAL_SAVE_NEGATION_PATTERN = /(?:\b(?:cannot|can't|couldn't|don't|doesn't|isn't|never|no|not|shouldn't|without|won't)\b|しない|しません|しないで|ない|ません|禁止|不要|ず)/iu;
const DUAL_SAVE_AMBIGUOUS_PATTERN = /(?:\b(?:maybe|perhaps|should|could|might|whether|wonder|think)\b|かな|かも|でしょう|ですか|ますか)/iu;

/**
 * The dual-save contract is intentionally small: the latest user message must
 * affirmatively mention observation/incident, memory/remember, and record/save.
 * Questions, quoted text, and negations are not consent.
 */
export function hasDualSaveConsent(text: unknown): boolean {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  if (/[?？]|["“”「」『』`]/u.test(text)
    || /(?:^|\s)'[^'\n]+'(?=\s|$|[.,!?])/u.test(text)
    || DUAL_SAVE_NEGATION_PATTERN.test(text)
    || DUAL_SAVE_AMBIGUOUS_PATTERN.test(text)) return false;
  const japanese = DUAL_SAVE_JAPANESE_PATTERN.test(text)
    && DUAL_SAVE_JAPANESE_MEMORY_PATTERN.test(text)
    && DUAL_SAVE_JAPANESE_ACTION_PATTERN.test(text);
  const english = DUAL_SAVE_ENGLISH_PATTERN.test(text)
    && DUAL_SAVE_ENGLISH_MEMORY_PATTERN.test(text)
    && DUAL_SAVE_ENGLISH_ACTION_PATTERN.test(text);
  return japanese || english;
}

function textFromUserEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const value = entry as Record<string, unknown>;
  const message = value.message && typeof value.message === "object" && !Array.isArray(value.message)
    ? value.message as Record<string, unknown>
    : value;
  if (message.role !== "user") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).text === "string") {
      return (item as Record<string, string>).text;
    }
    return "";
  }).join("");
  return text.length > 0 ? text : undefined;
}

/** Return only the latest user-authored text from the caller's in-memory entries. */
export function latestUserMessageText(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const text = textFromUserEntry(entries[index]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function memoryError(message: string): Error {
  return new Error(message);
}

function validMemoryDocument(document: ObservationMemoryDocument): boolean {
  if (!isSafeCaseId(document.caseId) || !MEMORY_DATE_PATTERN.test(document.date)) return false;
  try {
    validateIncidentShared({ agent: document.agent, category: document.category, severity: document.severity, note: document.note }, new Set([document.agent]), MAX_NOTE_LENGTH);
    return true;
  } catch {
    return false;
  }
}

/** Pure, allowlisted Markdown rendering for the global observation memory. */
export function renderObservationMemory(document: ObservationMemoryDocument): string {
  if (!validMemoryDocument(document)) throw memoryError("invalid observation memory");
  return [
    "---",
    `summary: \"Agent observation ${document.caseId} (${document.category})\"`,
    `created: ${document.date}`,
    "---",
    "",
    "# Agent observation",
    "",
    `- Case ID: ${document.caseId}`,
    `- Agent: ${document.agent}`,
    `- Category: ${document.category}`,
    `- Severity: ${document.severity}`,
    `- Note: ${document.note}`,
    "",
  ].join("\n");
}

type MemoryFilesystemOverrides = Partial<ObservationMemoryFilesystem>;
type DirectoryIdentity = { dev: number; ino: number };
type MemoryTarget = { categoryDirectory: string; destination: string; filesystem: ObservationMemoryFilesystem };

function currentUserOwns(info: { uid?: number }): boolean {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function directoryIdentity(info: { dev: number; ino: number }): DirectoryIdentity {
  return { dev: info.dev, ino: info.ino };
}

function inspectMemoryDirectory(path: string, filesystem: ObservationMemoryFilesystem, kind: "root" | "category"): DirectoryIdentity | null {
  try {
    const info = filesystem.lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || !currentUserOwns(info) || (info.mode & 0o022) !== 0) {
      throw memoryError(kind === "category" ? "invalid observation memory category" : "invalid observation memory root");
    }
    return directoryIdentity(info);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (error instanceof Error && (error.message === "invalid observation memory category" || error.message === "invalid observation memory root")) throw error;
    throw memoryError("could not prepare observation memory");
  }
}

function ensureMemoryRoot(path: string, filesystem: ObservationMemoryFilesystem): DirectoryIdentity {
  const existing = inspectMemoryDirectory(path, filesystem, "root");
  if (existing) return existing;
  try {
    filesystem.mkdirSync(path, { recursive: true, mode: 0o700 });
    const created = inspectMemoryDirectory(path, filesystem, "root");
    if (!created) throw memoryError("could not prepare observation memory");
    return created;
  } catch (error) {
    if (error instanceof Error && (error.message === "invalid observation memory root" || error.message === "could not prepare observation memory")) throw error;
    throw memoryError("could not prepare observation memory");
  }
}

function ensureMemoryCategory(path: string, filesystem: ObservationMemoryFilesystem): boolean {
  const existing = inspectMemoryDirectory(path, filesystem, "category");
  if (existing) return false;
  try {
    filesystem.mkdirSync(path, { recursive: false, mode: 0o700 });
    if (!inspectMemoryDirectory(path, filesystem, "category")) throw memoryError("could not prepare observation memory");
    return true;
  } catch (error) {
    if (error instanceof Error && (error.message === "invalid observation memory category" || error.message === "could not prepare observation memory")) throw error;
    throw memoryError("could not prepare observation memory");
  }
}

function assertCategoryPath(target: MemoryTarget, fd: number, expected: DirectoryIdentity): void {
  const opened = target.filesystem.fstatSync(fd);
  if (!opened.isDirectory() || opened.isSymbolicLink() || !currentUserOwns(opened) || (opened.mode & 0o022) !== 0
    || opened.dev !== expected.dev || opened.ino !== expected.ino) throw memoryError("could not write observation memory");
  const pathInfo = target.filesystem.lstatSync(target.categoryDirectory);
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink() || !currentUserOwns(pathInfo) || (pathInfo.mode & 0o022) !== 0
    || pathInfo.dev !== expected.dev || pathInfo.ino !== expected.ino) throw memoryError("could not write observation memory");
}

function prepareMemoryTarget(root: string, caseId: string, filesystem: ObservationMemoryFilesystem): MemoryTarget {
  // Validate existing directories without chmodding them. Missing directories are
  // created only once the incident append has succeeded.
  inspectMemoryDirectory(root, filesystem, "root");
  const categoryDirectory = join(root, OBSERVATION_MEMORY_CATEGORY);
  const categoryExists = inspectMemoryDirectory(categoryDirectory, filesystem, "category");
  const destination = join(categoryDirectory, `${caseId}.md`);
  if (categoryExists) {
    try {
      filesystem.lstatSync(destination);
      throw memoryError("observation memory already exists");
    } catch (error) {
      if (error instanceof Error && error.message === "observation memory already exists") throw error;
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw memoryError("could not prepare observation memory");
    }
  }
  return { categoryDirectory, destination, filesystem };
}

function writeObservationMemory(target: MemoryTarget, root: string, content: string): void {
  let categoryCreated = false;
  let temporary: string | undefined;
  let fd: number | undefined;
  let categoryFd: number | undefined;
  let destinationWritten = false;
  let categoryIdentity: DirectoryIdentity | undefined;
  try {
    ensureMemoryRoot(root, target.filesystem);
    categoryCreated = ensureMemoryCategory(target.categoryDirectory, target.filesystem);
    categoryFd = target.filesystem.openSync(target.categoryDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    categoryIdentity = directoryIdentity(target.filesystem.fstatSync(categoryFd));
    assertCategoryPath(target, categoryFd, categoryIdentity);
    try {
      target.filesystem.lstatSync(target.destination);
      throw memoryError("observation memory already exists");
    } catch (error) {
      if (error instanceof Error && error.message === "observation memory already exists") throw error;
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw memoryError("could not write observation memory");
    }
    assertCategoryPath(target, categoryFd, categoryIdentity);
    for (;;) {
      temporary = `${target.destination}.tmp-${randomBytes(9).toString("hex")}`;
      try {
        fd = target.filesystem.openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw memoryError("could not write observation memory");
        assertCategoryPath(target, categoryFd, categoryIdentity);
      }
    }
    assertCategoryPath(target, categoryFd, categoryIdentity);
    target.filesystem.writeFileSync(fd, content, "utf8");
    target.filesystem.fchmodSync(fd, 0o600);
    target.filesystem.fsyncSync(fd);
    target.filesystem.closeSync(fd);
    fd = undefined;
    assertCategoryPath(target, categoryFd, categoryIdentity);
    target.filesystem.renameSync(temporary, target.destination);
    temporary = undefined;
    destinationWritten = true;
    assertCategoryPath(target, categoryFd, categoryIdentity);
  } catch (error) {
    if (fd !== undefined) {
      try { target.filesystem.closeSync(fd); } catch {}
    }
    if (temporary && categoryFd !== undefined && categoryIdentity) {
      try { assertCategoryPath(target, categoryFd, categoryIdentity); target.filesystem.unlinkSync(temporary); } catch {}
    }
    if (destinationWritten && categoryFd !== undefined && categoryIdentity) {
      try { assertCategoryPath(target, categoryFd, categoryIdentity); target.filesystem.unlinkSync(target.destination); } catch {}
    }
    if (categoryFd !== undefined) {
      try { target.filesystem.closeSync(categoryFd); } catch {}
    }
    if (categoryCreated) {
      try {
        const category = target.filesystem.lstatSync(target.categoryDirectory);
        if (categoryIdentity && category.isDirectory() && !category.isSymbolicLink() && currentUserOwns(category)
          && (category.mode & 0o022) === 0 && category.dev === categoryIdentity.dev && category.ino === categoryIdentity.ino) {
          target.filesystem.rmdirSync(target.categoryDirectory);
        }
      } catch {}
    }
    if (error instanceof Error && ["observation memory already exists", "could not write observation memory"].includes(error.message)) throw error;
    throw memoryError("could not write observation memory");
  }
  if (categoryFd !== undefined) target.filesystem.closeSync(categoryFd);
}

type IncidentSnapshot = { size: number; dev: number; ino: number };

function incidentSnapshot(path: string): IncidentSnapshot {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("could not record observation");
  return { size: info.size, dev: info.dev, ino: info.ino };
}

function rollbackIncident(path: string, snapshot: IncidentSnapshot): void {
  let fd: number | undefined;
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== snapshot.dev || current.ino !== snapshot.ino) return;
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== snapshot.dev || opened.ino !== snapshot.ino) return;
    ftruncateSync(fd, snapshot.size);
    fsyncSync(fd);
  } catch {
    // Best effort only: cross-directory writes cannot be fully atomic.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recordIncident(options: { stateRoot?: string; incident: unknown; now?: Date; saveToMemory?: boolean; memoryRoot?: string; filesystem?: MemoryFilesystemOverrides; sessionEntries?: unknown }): { id: string; category: string; memorySaved: boolean } | null {
  const stateRoot = options.stateRoot ?? stateRootDefault();
  return withLock(stateRoot, () => {
    const cohort = readCohort(stateRoot);
    if (!cohort) return null;
    const raw = options.incident as any;
    if (options.saveToMemory !== undefined && typeof options.saveToMemory !== "boolean") throw new Error("invalid observation option");
    if (raw && typeof raw === "object" && raw.saveToMemory !== undefined && typeof raw.saveToMemory !== "boolean") throw new Error("invalid observation option");
    const saveToMemory = options.saveToMemory ?? (raw?.saveToMemory === true);
    const incident = validateIncident(options.incident, cohort.agentNames);
    if (saveToMemory && !hasDualSaveConsent(latestUserMessageText(options.sessionEntries))) throw new Error("dual-save consent required");
    const id = `case-${randomBytes(9).toString("hex")}`;
    const timestamp = (options.now ?? new Date()).toISOString();
    const memoryRoot = options.memoryRoot ?? defaultMemoryRoot();
    const filesystem = { ...MEMORY_FILESYSTEM, ...(options.filesystem ?? {}) };
    const memory = saveToMemory
      ? { target: prepareMemoryTarget(memoryRoot, id, filesystem), content: renderObservationMemory({ caseId: id, date: timestamp.slice(0, 10), ...incident }) }
      : null;
    const incidentPath = join(cohort.directory, INCIDENT_FILE);
    const snapshot = incidentSnapshot(incidentPath);
    const line = [id, timestamp, incident.agent, incident.category, incident.severity, incident.note].join("\t") + "\n";
    privateAppend(incidentPath, line);
    if (memory) {
      try {
        writeObservationMemory(memory.target, memoryRoot, memory.content);
      } catch (error) {
        rollbackIncident(incidentPath, snapshot);
        throw error;
      }
    }
    return { id, category: incident.category, memorySaved: memory !== null };
  });
}

export function isSafeCaseId(value: string): boolean {
  return CASE_PATTERN.test(value);
}
