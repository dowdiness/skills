import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AUTOMATION_KEY_FILE, AUTOMATION_STATE_FILE, LOCK_FILE, checkpoint, entryFingerprint, canonicalEntry } from "./core.ts";

const fixtureRoots: string[] = [];
afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "agent-observation-extension-"));
  fixtureRoots.push(stateRoot);
  const commit = "a".repeat(40);
  const shortHead = commit.slice(0, 12);
  const cohort = join(stateRoot, shortHead);
  mkdirSync(cohort, { mode: 0o700 });
  writeFileSync(join(stateRoot, "active-cohort.json"), JSON.stringify({ schemaVersion: 1, commit, shortHead }));
  writeFileSync(join(cohort, "metadata.json"), JSON.stringify({ schemaVersion: 1, commit, shortHead, startedAt: "2026-01-01T00:00:00.000Z", agentNames: ["worker"], modelIds: ["test/model"] }));
  writeFileSync(join(cohort, "incidents.tsv"), "");
  chmodSync(stateRoot, 0o700);
  chmodSync(join(stateRoot, "active-cohort.json"), 0o600);
  chmodSync(join(cohort, "metadata.json"), 0o600);
  chmodSync(join(cohort, "incidents.tsv"), 0o600);
  return { stateRoot, cohort };
}

const call = (id: string, parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { content: [{ type: "toolCall", name: "subagent", id: `call-${id}`, arguments: { agent: "worker", task: "private task", cwd: "/private/path" } }] } });
const result = (id: string, parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:02.000Z", message: { toolName: "subagent", toolCallId: `call-${id}`, details: { results: [{ agent: "worker", model: "test/model", exitCode: 0 }] } } });

 test("unknown sessions baseline, known sessions recover, fork copies baseline, and stale instances re-read state", () => {
  const f = fixture();
  const history = [call("11111111"), result("11111111", "11111111")];
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-a", entries: history, now: new Date("2026-01-01T00:00:03.000Z") })?.invocationCount).toBe(1);
  // A second extension instance sees persisted fingerprints, not a stale in-memory copy.
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-a", entries: [...history, call("33333333", "22222222"), result("44444444", "33333333")] })?.invocationCount).toBe(2);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-a", entries: [...history, call("33333333", "22222222"), result("44444444", "33333333")] })?.invocationCount).toBe(2);
  // Fork/clone gets a new HMAC session identity: copied history is skipped, while a new invocation is counted once.
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-fork", entries: [...history, call("55555555", "22222222")] })?.invocationCount).toBe(2);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-fork", entries: [...history, call("55555555", "22222222"), result("66666666", "55555555")] })?.invocationCount).toBe(3);
  const state = JSON.parse(readFileSync(join(f.cohort, AUTOMATION_STATE_FILE), "utf8"));
  expect(Object.keys(state.sessions)).toHaveLength(2);
  expect(JSON.stringify(state)).not.toContain("private task");
  expect(JSON.stringify(state)).not.toContain("/private/path");
});

test("fingerprints exclude only parentId and distinguish colliding IDs", () => {
  const f = fixture();
  checkpoint({ stateRoot: f.stateRoot, sessionId: "s", entries: [] });
  const key = readFileSync(join(f.cohort, AUTOMATION_KEY_FILE));
  const base = { type: "message", id: "deadbeef", timestamp: "2026-01-01T00:00:00.000Z", payload: { value: 1 }, parentId: "one" };
  const same = { ...base, parentId: "two" };
  const collision = { ...base, payload: { value: 2 } };
  expect(canonicalEntry(base)).toBe(canonicalEntry(same));
  expect(entryFingerprint(key, base)).toBe(entryFingerprint(key, same));
  expect(entryFingerprint(key, base)).not.toBe(entryFingerprint(key, collision));
});

test("state and key are private and state replacement keeps one privacy-safe schema", () => {
  const f = fixture();
  checkpoint({ stateRoot: f.stateRoot, sessionId: "s", entries: [call("11111111"), { ...result("11111111"), message: { ...result("11111111").message, details: { results: [{ agent: "worker", model: "untrusted/model", exitCode: 0, note: "private note" }] } } }] });
  const statePath = join(f.cohort, AUTOMATION_STATE_FILE);
  const keyPath = join(f.cohort, AUTOMATION_KEY_FILE);
  expect(statSync(f.stateRoot).mode & 0o777).toBe(0o700);
  expect(statSync(f.cohort).mode & 0o777).toBe(0o700);
  expect(statSync(statePath).mode & 0o777).toBe(0o600);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ schemaVersion: 1, aggregate: expect.any(Object), sessions: expect.any(Object) });
  const stateText = readFileSync(statePath, "utf8");
  expect(stateText).not.toContain("session-a");
  expect(stateText).not.toContain("untrusted/model");
  expect(stateText).not.toContain("private note");
});

test("first activation counts only complete post-start invocations", () => {
  const f = fixture();
  const preCall = { ...call("pre"), timestamp: "2025-12-31T23:59:59.000Z" };
  const preResult = { ...result("pre"), timestamp: "2026-01-01T00:00:00.500Z" };
  const postCall = { ...call("post"), timestamp: "2026-01-01T00:00:01.000Z" };
  const postResult = { ...result("post"), timestamp: "2026-01-01T00:00:02.000Z" };
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "mid", entries: [preCall, preResult, postCall, postResult] })?.invocationCount).toBe(1);
  const spanning = fixture();
  expect(checkpoint({ stateRoot: spanning.stateRoot, sessionId: "spanning", entries: [preCall, preResult] })?.invocationCount).toBe(0);
});

test("legacy aggregate migration baselines current entries without recounting", () => {
  const f = fixture();
  const invocation = [call("legacy"), result("legacy")];
  const aggregate = checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [] })!.report;
  aggregate.agents.find((agent) => agent.agent === "worker")!.invocations = 1;
  aggregate.agents.find((agent) => agent.agent === "worker")!.runtime.success = 1;
  aggregate.totals.invocations = 1;
  aggregate.totals.runtime.success = 1;
  writeFileSync(join(f.cohort, "latest-report.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:03.000Z", fileCount: 1, aggregate }));
  rmSync(join(f.cohort, AUTOMATION_STATE_FILE));
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: invocation })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: [...invocation, call("new"), result("new")] })?.invocationCount).toBe(2);
});

test("globally copied fork history is counted once and known resumes recover results", () => {
  const f = fixture();
  const invocation = [call("copy"), result("copy")];
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "original", entries: invocation })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "fork", entries: invocation })?.invocationCount).toBe(1);
  const recovery = fixture();
  const partial = [call("recover")];
  expect(checkpoint({ stateRoot: recovery.stateRoot, sessionId: "resume", entries: partial })?.invocationCount).toBe(0);
  expect(checkpoint({ stateRoot: recovery.stateRoot, sessionId: "resume", entries: [...partial, result("recover")] })?.invocationCount).toBe(1);
});

test("atomic checkpoint failure preserves the old aggregate and fingerprints", () => {
  const f = fixture();
  const first = [call("old"), result("old")];
  checkpoint({ stateRoot: f.stateRoot, sessionId: "atomic", entries: first });
  const path = join(f.cohort, AUTOMATION_STATE_FILE);
  const before = readFileSync(path, "utf8");
  expect(() => checkpoint({ stateRoot: f.stateRoot, sessionId: "atomic", entries: [...first, call("new"), result("new")], writeState: () => { throw new Error("injected pre-rename failure"); } })).toThrow("injected pre-rename failure");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("lock replacement is never unlinked and stale callers re-read disk", () => {
  const f = fixture();
  const entries = [call("one"), result("one")];
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "same", entries })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "same", entries })?.invocationCount).toBe(1);
  expect(() => checkpoint({ stateRoot: f.stateRoot, sessionId: "replace", entries: [], writeState: () => {
    rmSync(join(f.stateRoot, LOCK_FILE));
    writeFileSync(join(f.stateRoot, LOCK_FILE), "replacement");
    throw new Error("stop");
  } })).toThrow("stop");
  expect(readFileSync(join(f.stateRoot, LOCK_FILE), "utf8")).toBe("replacement");
});

test("a global extension symlink resolves its local ../../scripts import without external state", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-observation-global-link-"));
  try {
    const target = join(root, ".pi", "agent", "extensions");
    mkdirSync(target, { recursive: true });
    const link = join(target, "agent-observation");
    symlinkSync(join(process.cwd(), "extensions", "agent-observation"), link, "dir");
    execFileSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(join(link, "core.ts")).href)}).then(() => process.exit(0))`], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), PI_SCHEDULER_CHILD: "1" },
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
