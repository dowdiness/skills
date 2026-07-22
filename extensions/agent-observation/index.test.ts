import { afterEach, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("typebox", () => ({
  Type: {
    Object: (properties: unknown, options: unknown) => ({ type: "object", properties, options }),
    String: (options: unknown) => ({ type: "string", options }),
  },
}));
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: unknown, options: unknown) => ({ type: "string", values, options }) }));

const { default: factory } = await import("./index.ts");
const originalEnvironment = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, PI_SCHEDULER_CHILD: process.env.PI_SCHEDULER_CHILD };
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function activeFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-observation-index-"));
  const stateRoot = join(root, "state", "skills-agent-observation");
  const commit = "b".repeat(40);
  const shortHead = commit.slice(0, 12);
  const cohort = join(stateRoot, shortHead);
  mkdirSync(cohort, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, "active-cohort.json"), JSON.stringify({ schemaVersion: 1, commit, shortHead }));
  writeFileSync(join(cohort, "metadata.json"), JSON.stringify({ schemaVersion: 1, commit, shortHead, startedAt: "2026-01-01T00:00:00.000Z", agentNames: ["worker"], modelIds: ["test/model"] }));
  writeFileSync(join(cohort, "incidents.tsv"), "");
  for (const path of [stateRoot, cohort]) chmodSync(path, 0o700);
  return { root, stateRoot, cohort, shortHead };
}

function context(ephemeral = false) {
  const statuses = new Map<string, string | undefined>();
  const entries: unknown[] = [];
  return {
    statuses,
    ctx: {
      sessionManager: { isPersisted: () => !ephemeral, getSessionFile: () => ephemeral ? undefined : "opaque", getSessionId: () => "session-id", getEntries: () => entries },
      ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value) },
    } as any,
    entries,
  };
}

test("registers all automatic lifecycle checkpoints and records only explicitly requested feedback", async () => {
  const f = activeFixture();
  process.env.XDG_STATE_HOME = join(f.root, "state");
  delete process.env.PI_SCHEDULER_CHILD;
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  let tool: any;
  const pi = {
    on: (name: string, handler: any) => {
      const previous = handlers.get(name);
      handlers.set(name, previous ? async (event, ctx) => { await previous(event, ctx); await handler(event, ctx); } : handler);
    },
    registerTool: (definition: any) => { tool = definition; },
  } as any;
  factory(pi);
  expect([...handlers.keys()].sort()).toEqual(["agent_settled", "session_shutdown", "session_start", "session_tree"]);
  expect(tool.name).toBe("record_observation");
  expect(tool.promptSnippet).toContain("record_observation");
  expect(tool.promptSnippet).toContain("explicitly");
  expect(tool.promptGuidelines.join(" ")).toContain("ONLY");
  expect(tool.promptGuidelines.join(" ")).toContain("never infer or guess");
  const c = context();
  for (const reason of ["startup", "reload", "new", "resume", "fork", "clone"]) await handlers.get("session_start")?.({ reason }, c.ctx);
  for (const reason of ["quit", "reload", "new", "resume", "fork", "clone"]) await handlers.get("session_shutdown")?.({ reason }, c.ctx);
  await handlers.get("session_tree")?.({}, c.ctx);
  await handlers.get("agent_settled")?.({}, c.ctx);
  const state = JSON.parse(readFileSync(join(f.cohort, "automation-state.json"), "utf8"));
  expect(Object.keys(state)).toEqual(["schemaVersion", "commit", "updatedAt", "aggregate", "sessions"]);
  const result = await tool.execute("opaque", { agent: "worker", category: "wrong_route", severity: "low", note: "short operator note" }, undefined, undefined, c.ctx);
  expect(result.content[0].text).toMatch(/^Recorded case-[a-f0-9]{18} \(wrong_route\)\.$/);
  expect(result.content[0].text).not.toContain("short operator note");
  expect(result).not.toHaveProperty("isError");
  expect(result).not.toHaveProperty("details");
  const incidents = readFileSync(join(f.cohort, "incidents.tsv"), "utf8");
  expect(incidents).toContain("\tworker\twrong_route\tlow\tshort operator note\n");
});

test("scheduler children and ephemeral sessions are no-ops", async () => {
  process.env.PI_SCHEDULER_CHILD = "1";
  const handlers = new Map<string, unknown>();
  let registered = false;
  factory({ on: (name: string, handler: unknown) => handlers.set(name, handler), registerTool: () => { registered = true; } } as any);
  expect(handlers.size).toBe(0);
  expect(registered).toBe(false);
  delete process.env.PI_SCHEDULER_CHILD;
  const ephemeral = context(true);
  const handlers2 = new Map<string, any>();
  let tool: any;
  factory({ on: (name: string, handler: any) => handlers2.set(name, handler), registerTool: (definition: any) => { tool = definition; } } as any);
  await handlers2.get("session_start")({}, ephemeral.ctx);
  expect(ephemeral.statuses.get("agent-observation")).toBeUndefined();
  let unavailable: unknown;
  try {
    await tool.execute("opaque", { agent: "worker", category: "wrong_route", severity: "low", note: "short" }, undefined, undefined, ephemeral.ctx);
  } catch (error) {
    unavailable = error;
  }
  expect(unavailable).toBeInstanceOf(Error);
  expect((unavailable as Error).message).toBe("Observation unavailable.");
});
