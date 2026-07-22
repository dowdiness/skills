import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOMATION_KEY_FILE, AUTOMATION_STATE_FILE, checkpoint, entryFingerprint, canonicalEntry } from "./core.ts";

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "agent-observation-extension-"));
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
  const history = [call("11111111"), result("22222222", "11111111")];
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-a", entries: history, now: new Date("2026-01-01T00:00:03.000Z") })?.invocationCount).toBe(0);
  // A second extension instance sees the persisted baseline, not a stale in-memory copy.
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-a", entries: [...history, call("33333333", "22222222"), result("44444444", "33333333")] })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-a", entries: [...history, call("33333333", "22222222"), result("44444444", "33333333")] })?.invocationCount).toBe(1);
  // Fork/clone gets a new HMAC session identity, so copied history is not counted.
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-fork", entries: [...history, call("55555555", "22222222")] })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "session-fork", entries: [...history, call("55555555", "22222222"), result("66666666", "55555555")] })?.invocationCount).toBe(2);
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
  checkpoint({ stateRoot: f.stateRoot, sessionId: "s", entries: [call("11111111")] });
  const statePath = join(f.cohort, AUTOMATION_STATE_FILE);
  const keyPath = join(f.cohort, AUTOMATION_KEY_FILE);
  expect(statSync(f.stateRoot).mode & 0o777).toBe(0o700);
  expect(statSync(f.cohort).mode & 0o777).toBe(0o700);
  expect(statSync(statePath).mode & 0o777).toBe(0o600);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ schemaVersion: 1, aggregate: expect.any(Object), sessions: expect.any(Object) });
  expect(readFileSync(statePath, "utf8")).not.toContain("session-a");
});
