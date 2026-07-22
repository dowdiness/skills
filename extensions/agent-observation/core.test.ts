import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AUTOMATION_KEY_FILE, AUTOMATION_STATE_FILE, INCIDENT_FILE, LOCK_FILE, aggregateSessionRecords, canonicalEntry, checkpoint, entryFingerprint, readPrivateState, recordIncident, renderObservationMemory } from "./core.ts";

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

test("an unknown resumed session uses the post-start filter after automation state exists", () => {
  const f = fixture();
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [] })?.invocationCount).toBe(0);
  const preCall = { ...call("old-pre"), timestamp: "2025-12-31T23:59:59.000Z" };
  const preResult = { ...result("old-pre"), timestamp: "2026-01-01T00:00:00.500Z" };
  const postCall = { ...call("old-post"), timestamp: "2026-01-01T00:00:01.000Z" };
  const postResult = { ...result("old-post"), timestamp: "2026-01-01T00:00:02.000Z" };
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "old-session", entries: [preCall, preResult, postCall, postResult] })?.invocationCount).toBe(1);
});

test("an unknown fork does not recount globally seen copied history after automation state exists", () => {
  const f = fixture();
  const copied = [call("seen-copy"), result("seen-copy")];
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "source", entries: copied })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "fork", entries: copied })?.invocationCount).toBe(1);
});

test("an unknown copied invocation is counted once before its source activates", () => {
  const f = fixture();
  const copied = [call("unobserved-copy"), result("unobserved-copy")];
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [] })?.invocationCount).toBe(0);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "fork", entries: copied })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "source", entries: copied })?.invocationCount).toBe(1);
});

test("legacy aggregate migration baselines current entries without recounting", () => {
  const f = fixture();
  const invocation = [call("legacy"), result("legacy")];
  const aggregate = checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [] })!.report;
  aggregate.agents.find((agent) => agent.agent === "worker")!.invocations = 1;
  aggregate.agents.find((agent) => agent.agent === "worker")!.runtime.success = 1;
  aggregate.totals.invocations = 1;
  aggregate.totals.runtime.success = 1;
  writeFileSync(join(f.cohort, "latest-report.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:03.000Z", fileCount: 1, aggregate }), { mode: 0o600 });
  rmSync(join(f.cohort, AUTOMATION_STATE_FILE));
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: invocation })?.invocationCount).toBe(1);
  expect(checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: [...invocation, call("new"), result("new")] })?.invocationCount).toBe(2);
});

test("invalid existing automation state fails closed without mutating private state", () => {
  for (const invalidState of [
    "malformed JSON",
    (state: Record<string, unknown>) => JSON.stringify({ ...state, schemaVersion: 99 }),
  ] as const) {
    const f = fixture();
    checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [call("seed"), result("seed")] });
    const statePath = join(f.cohort, AUTOMATION_STATE_FILE);
    const keyPath = join(f.cohort, AUTOMATION_KEY_FILE);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const content = typeof invalidState === "string" ? invalidState : invalidState(state);
    writeFileSync(statePath, content);
    const keyBefore = readFileSync(keyPath);
    let writeCalled = false;
    expect(() => checkpoint({
      stateRoot: f.stateRoot,
      sessionId: "new",
      entries: [call("new"), result("new")],
      writeState: () => { writeCalled = true; },
    })).toThrow("invalid automation state");
    expect(writeCalled).toBe(false);
    expect(readFileSync(statePath, "utf8")).toBe(content);
    expect(readFileSync(keyPath)).toEqual(keyBefore);
  }
});

test("persisted aggregates must be canonical exact reports for automation and legacy reads", () => {
  const mutations: Array<[string, (aggregate: any) => void]> = [
    ["empty agents", (aggregate) => { aggregate.agents = []; }],
    ["missing agent", (aggregate) => { aggregate.agents.pop(); }],
    ["duplicate agent", (aggregate) => { aggregate.agents.push(structuredClone(aggregate.agents[0])); }],
    ["extra agent", (aggregate) => { aggregate.agents.push({ ...structuredClone(aggregate.agents[0]), agent: "extra" }); }],
    ["invalid invocation counter", (aggregate) => { aggregate.agents[0].invocations = -1; }],
    ["invalid runtime counter", (aggregate) => { aggregate.agents[0].runtime.success = "one"; }],
    ["invalid usage counter", (aggregate) => { aggregate.agents[0].usage.input = -1; }],
    ["untrusted model", (aggregate) => { aggregate.agents[0].models = ["untrusted/model"]; }],
    ["inconsistent totals", (aggregate) => { aggregate.totals.invocations = 0; }],
    ["wrong aggregate schema", (aggregate) => { aggregate.schemaVersion = 99; }],
    ["extra aggregate field", (aggregate) => { aggregate.extra = true; }],
    ["missing aggregate field", (aggregate) => { delete aggregate.totals.callDurationMs; }],
  ];
  for (const [name, mutate] of mutations) {
    for (const legacy of [false, true]) {
      const f = fixture();
      checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [call("seed"), result("seed")] });
      const statePath = join(f.cohort, AUTOMATION_STATE_FILE);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const aggregate = structuredClone(state.aggregate);
      mutate(aggregate);
      const content = legacy
        ? JSON.stringify({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:03.000Z", fileCount: 1, aggregate })
        : JSON.stringify({ ...state, aggregate });
      if (legacy) rmSync(statePath);
      writeFileSync(legacy ? join(f.cohort, "latest-report.json") : statePath, content);
      let writeCalled = false;
      expect(() => checkpoint({
        stateRoot: f.stateRoot,
        sessionId: "new",
        entries: [],
        writeState: () => { writeCalled = true; },
      }), name).toThrow("invalid automation state");
      expect(writeCalled, name).toBe(false);
      expect(readFileSync(legacy ? join(f.cohort, "latest-report.json") : statePath, "utf8")).toBe(content);
      if (legacy) expect(() => readFileSync(statePath)).toThrow();
    }
  }
});

test("valid nonzero diagnostic counters survive strict persisted aggregate validation", () => {
  const f = fixture();
  const aggregate = aggregateSessionRecords([
    null,
    { content: [{ type: "toolCall", name: "subagent", id: "unknown", arguments: { agent: "not-packaged" } }] },
    { content: [{ type: "toolCall", name: "subagent", id: "missing", arguments: { agent: "worker" } }] },
  ], { agentNames: new Set(["worker"]), trustedModelIds: new Set(["test/model"]) });
  expect(aggregate.unknownRecords).toBeGreaterThan(0);
  expect(aggregate.malformedRecords).toBeGreaterThan(0);
  expect(aggregate.missingLeaves).toBeGreaterThan(0);
  writeFileSync(join(f.cohort, "latest-report.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:03.000Z",
    fileCount: 1,
    aggregate,
  }), { mode: 0o600 });
  const result = checkpoint({ stateRoot: f.stateRoot, sessionId: "diagnostics", entries: [] });
  expect(result?.report).toEqual(aggregate);
  expect(result?.report.unknownRecords).toBeGreaterThan(0);
  expect(result?.report.malformedRecords).toBeGreaterThan(0);
  expect(result?.report.missingLeaves).toBeGreaterThan(0);
});

test("private descriptor reads reject symlinks without exposing or changing their targets", () => {
  const f = fixture();
  const target = join(f.stateRoot, "secret-state");
  const link = join(f.cohort, "linked-state");
  writeFileSync(target, "PRIVATE_TARGET_SECRET", { mode: 0o600 });
  symlinkSync(target, link);
  expect(() => readPrivateState(link)).toThrow("invalid private state");
  expect(readFileSync(target, "utf8")).toBe("PRIVATE_TARGET_SECRET");
  expect(readlinkSync(link)).toBe(target);
});

test("automation state symlinks fail closed without replacing the link or target", () => {
  for (const broken of [false, true]) {
    const f = fixture();
    checkpoint({ stateRoot: f.stateRoot, sessionId: "seed", entries: [call("seed"), result("seed")] });
    const statePath = join(f.cohort, AUTOMATION_STATE_FILE);
    const keyPath = join(f.cohort, AUTOMATION_KEY_FILE);
    const target = join(f.stateRoot, broken ? "missing-state-target" : "state-target");
    if (!broken) writeFileSync(target, "private target\n");
    rmSync(statePath);
    symlinkSync(target, statePath);
    const keyBefore = readFileSync(keyPath);
    const targetBefore = broken ? null : readFileSync(target, "utf8");
    expect(() => checkpoint({ stateRoot: f.stateRoot, sessionId: "new", entries: [] })).toThrow("invalid automation state");
    expect(lstatSync(statePath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(statePath)).toBe(target);
    if (broken) expect(() => lstatSync(target)).toThrow();
    else expect(readFileSync(target, "utf8")).toBe(targetBefore);
    expect(readFileSync(keyPath)).toEqual(keyBefore);
  }
});

test("invalid legacy reports fail closed without creating automation state", () => {
  for (const invalidReport of [
    "malformed JSON",
    JSON.stringify({ schemaVersion: 99 }),
  ]) {
    const f = fixture();
    const reportPath = join(f.cohort, "latest-report.json");
    writeFileSync(reportPath, invalidReport);
    expect(() => checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: [] })).toThrow("invalid automation state");
    expect(readFileSync(reportPath, "utf8")).toBe(invalidReport);
    expect(() => readFileSync(join(f.cohort, AUTOMATION_KEY_FILE))).toThrow();
    expect(() => readFileSync(join(f.cohort, AUTOMATION_STATE_FILE))).toThrow();
  }
});

test("legacy report symlinks fail closed without replacing the link or target", () => {
  for (const broken of [false, true]) {
    const f = fixture();
    const reportPath = join(f.cohort, "latest-report.json");
    const target = join(f.stateRoot, broken ? "missing-report-target" : "report-target");
    if (!broken) writeFileSync(target, "private legacy target\n");
    symlinkSync(target, reportPath);
    expect(() => checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: [] })).toThrow("invalid automation state");
    expect(lstatSync(reportPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(reportPath)).toBe(target);
    if (broken) expect(() => lstatSync(target)).toThrow();
    else expect(readFileSync(target, "utf8")).toBe("private legacy target\n");
    expect(() => readFileSync(join(f.cohort, AUTOMATION_KEY_FILE))).toThrow();
    expect(() => readFileSync(join(f.cohort, AUTOMATION_STATE_FILE))).toThrow();
  }
});

test("unreadable legacy reports fail closed", () => {
  const f = fixture();
  const reportPath = join(f.cohort, "latest-report.json");
  const content = "private legacy report\n";
  writeFileSync(reportPath, content, { mode: 0o600 });
  chmodSync(reportPath, 0o000);
  try {
    expect(() => checkpoint({ stateRoot: f.stateRoot, sessionId: "legacy", entries: [] })).toThrow("invalid automation state");
  } finally {
    chmodSync(reportPath, 0o600);
  }
  expect(readFileSync(reportPath, "utf8")).toBe(content);
  expect(() => readFileSync(join(f.cohort, AUTOMATION_KEY_FILE))).toThrow();
  expect(() => readFileSync(join(f.cohort, AUTOMATION_STATE_FILE))).toThrow();
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

test("observation memory is omitted for the compatible incident-only flow", () => {
  const f = fixture();
  const memoryRoot = join(f.stateRoot, "memory");
  recordIncident({ stateRoot: f.stateRoot, memoryRoot, incident: { agent: "worker", category: "wrong_route", severity: "low", note: "short", saveToMemory: false } });
  expect(readFileSync(join(f.cohort, INCIDENT_FILE), "utf8")).toContain("\tworker\twrong_route\tlow\tshort\n");
  expect(() => lstatSync(join(memoryRoot, "agent-observations"))).toThrow();
});

test("dual recording writes one correlated incident and contract-valid memory", () => {
  const f = fixture();
  const memoryRoot = join(f.stateRoot, "memory");
  const result = recordIncident({ stateRoot: f.stateRoot, memoryRoot, now: new Date("2026-02-03T04:05:06.000Z"), incident: { agent: "worker", category: "wrong_route", severity: "high", note: "short operator note", saveToMemory: true } })!;
  const memory = readFileSync(join(memoryRoot, "agent-observations", `${result.id}.md`), "utf8");
  expect(memory).toContain(`summary: \"Agent observation ${result.id} (wrong_route)\"`);
  expect(memory).toContain("created: 2026-02-03");
  expect(memory).toContain(`Case ID: ${result.id}`);
  expect(memory).toContain("Agent: worker");
  expect(memory).toContain("Category: wrong_route");
  expect(memory).toContain("Severity: high");
  expect(memory).toContain("Note: short operator note");
  expect(memory).not.toMatch(/task|response|session|cwd|repository|path|model|token|credential/iu);
  expect(readFileSync(join(f.cohort, INCIDENT_FILE), "utf8")).toContain(`${result.id}\t2026-02-03T04:05:06.000Z\tworker\twrong_route\thigh\tshort operator note\n`);
  expect(statSync(join(memoryRoot, "agent-observations", `${result.id}.md`)).mode & 0o777).toBe(0o600);
});

test("unsafe dual-save input is rejected before either write", () => {
  const f = fixture();
  const memoryRoot = join(f.stateRoot, "memory");
  expect(() => recordIncident({ stateRoot: f.stateRoot, memoryRoot, incident: { agent: "worker", category: "wrong_route", severity: "low", note: "leak /private/path", saveToMemory: true } })).toThrow("invalid incident note");
  expect(readFileSync(join(f.cohort, INCIDENT_FILE), "utf8")).toBe("");
  expect(() => lstatSync(memoryRoot)).toThrow();
});

test("memory category and destination collisions fail closed", () => {
  const f = fixture();
  const memoryRoot = join(f.stateRoot, "memory");
  mkdirSync(memoryRoot, { recursive: true });
  symlinkSync(join(f.stateRoot, "elsewhere"), join(memoryRoot, "agent-observations"));
  expect(() => recordIncident({ stateRoot: f.stateRoot, memoryRoot, incident: { agent: "worker", category: "wrong_route", severity: "low", note: "short", saveToMemory: true } })).toThrow("invalid observation memory category");
  expect(readFileSync(join(f.cohort, INCIDENT_FILE), "utf8")).toBe("");

  rmSync(join(memoryRoot, "agent-observations"));
  mkdirSync(join(memoryRoot, "agent-observations"));
  const filesystem = { lstatSync: (path: string) => path.endsWith(".md") ? { isSymbolicLink: () => true, isDirectory: () => false } as any : lstatSync(path) };
  expect(() => recordIncident({ stateRoot: f.stateRoot, memoryRoot, filesystem, incident: { agent: "worker", category: "wrong_route", severity: "low", note: "short", saveToMemory: true } })).toThrow("observation memory already exists");
  expect(readFileSync(join(f.cohort, INCIDENT_FILE), "utf8")).toBe("");
});

test("dual-save failures do not report success and roll back the incident", () => {
  const f = fixture();
  const memoryRoot = join(f.stateRoot, "memory");
  const filesystem = { renameSync: () => { throw new Error("injected failure"); } };
  expect(() => recordIncident({ stateRoot: f.stateRoot, memoryRoot, filesystem, incident: { agent: "worker", category: "wrong_route", severity: "low", note: "short", saveToMemory: true } })).toThrow("could not write observation memory");
  expect(readFileSync(join(f.cohort, INCIDENT_FILE), "utf8")).toBe("");
});

test("memory rendering is pure and rejects invalid documents", () => {
  expect(renderObservationMemory({ caseId: "case-aaaaaaaaaaaaaaaaaa", date: "2026-02-03", agent: "worker", category: "wrong_route", severity: "low", note: "short" })).toContain("created: 2026-02-03");
  expect(() => renderObservationMemory({ caseId: "not-a-case", date: "2026-02-03", agent: "worker", category: "wrong_route", severity: "low", note: "short" })).toThrow("invalid observation memory");
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
