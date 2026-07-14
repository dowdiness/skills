import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const reviewerNames = ["moonbit-reviewer", "reviewer-flash", "reviewer-mimo", "reviewer-qwen"];

function git(cwd, ...args) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeAgentFiles(home) {
	const agentsDir = join(home, ".pi", "agent", "agents");
	for (const name of readdirSync(agentsDir)) rmSync(join(agentsDir, name), { recursive: true, force: true });
	writeFileSync(join(agentsDir, "parallel-reviewer.md"), `---\nname: parallel-reviewer\ndescription: coordinator\nmodel: local-openai/gpt-test\ntools: read,grep,find,ls,subagent\n---\nCoordinate the four reviewers.\n`);
	for (const name of reviewerNames) {
		writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: reviewer\nmodel: local-openai/gpt-test\ntools: read,grep,find,ls\n---\nYou are ${name}. Return a concise review report.\n`);
	}
}

test("runs the packaged parallel-review coordinator with four child reviewers", async () => {
	const home = mkdtempSync(join(tmpdir(), "parallel-review-process-e2e-"));
	const fixture = join(home, "repo");
	mkdirSync(fixture);
	const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1", LOCAL_OPENAI_API_KEY: "test" };
	const gitFixture = (...args) => git(fixture, ...args);
	let server;
	let child;
	try {
		gitFixture("init", "-q", "-b", "main");
		gitFixture("config", "user.email", "test@example.com");
		gitFixture("config", "user.name", "Test");
		writeFileSync(join(fixture, "moon.mod"), 'name = "dowdiness/canopy"\n');
		writeFileSync(join(fixture, "sample.mbt"), "fn sample() -> Int { 1 }\n");
		gitFixture("add", ".");
		gitFixture("commit", "-qm", "base");
		gitFixture("checkout", "-qb", "feature");
		writeFileSync(join(fixture, "sample.mbt"), "fn sample() -> Int { 2 }\n");
		gitFixture("commit", "-qam", "change");

		const install = spawnSync("node", ["scripts/install-pi-package.mjs", "./"], { cwd: sourceRoot, env, encoding: "utf8", timeout: 120000 });
		expect(install.status).toBe(0);
		writeAgentFiles(home);
		const modelsDir = join(home, ".pi", "agent");
		writeFileSync(join(modelsDir, "models.json"), JSON.stringify({ providers: { "local-openai": { baseUrl: "http://127.0.0.1:0/v1", api: "openai-completions", apiKey: "$LOCAL_OPENAI_API_KEY", models: [{ id: "gpt-test", name: "gpt-test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 2000 }] } } }));

		let coordinatorCalls = 0;
		let reviewerCalls = 0;
		const invokedReviewers = new Set();
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const payload = JSON.parse(body);
				const hasSubagent = payload.tools?.some((tool) => tool.function?.name === "subagent");
				const chunks = [];
				if (hasSubagent && coordinatorCalls++ === 0) {
					const tasks = reviewerNames.map((agent) => ({ agent, task: "Review the supplied context" }));
					chunks.push({ id: "coord-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "subagent", arguments: JSON.stringify({ tasks, agentScope: "user", confirmProjectAgents: false }) } }] }, finish_reason: null }] });
					chunks.push({ id: "coord-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
				} else {
					const serialized = JSON.stringify(payload);
					if (!hasSubagent) {
						reviewerCalls++;
						for (const name of reviewerNames) if (serialized.includes(name)) invokedReviewers.add(name);
					}
					const text = hasSubagent ? reviewerNames.map((name) => `- \`${name}\`: usable report received`).join("\n") : "review complete";
					chunks.push({ id: "text-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
					chunks.push({ id: "text-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const models = JSON.parse(readFileSync(join(modelsDir, "models.json"), "utf8"));
		models.providers["local-openai"].baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
		writeFileSync(join(modelsDir, "models.json"), JSON.stringify(models));

		child = spawn("pi", ["--mode", "rpc", "--no-session", "--provider", "local-openai", "--model", "local-openai/gpt-test"], { cwd: fixture, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let pending = "";
		const events = [];
		let completeResolve;
		const routeComplete = new Promise((resolve) => { completeResolve = resolve; });
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			pending += chunk.toString();
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					events.push(event);
					if (event.type === "agent_settled" || (event.type === "message_end" && event.message?.customType === "scheduler")) completeResolve(event);
				} catch {}
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.stdin.write(JSON.stringify({ type: "prompt", message: "/scheduler parallel-review inspect the current diff" }) + "\n");
		const completion = await Promise.race([routeComplete, new Promise((resolve) => setTimeout(() => resolve(null), 20000))]);
		expect(completion).not.toBeNull();
		child.stdin.end();
		const closeResult = await Promise.race([
			new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
			new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
		]);
		expect(closeResult).not.toBeNull();
		expect(closeResult.code).toBe(0);
		expect(coordinatorCalls).toBe(2);
		expect(reviewerCalls).toBe(4);
		expect([...invokedReviewers].sort()).toEqual([...reviewerNames].sort());
		expect(stdout).toContain("# Scheduler completed");
		for (const name of reviewerNames) expect(stdout).toContain(`\`${name}\`: usable report received`);
		expect(stderr).toBe("");
	} finally {
		if (child && child.exitCode === null) child.kill("SIGKILL");
		if (server) await new Promise((resolve) => server.close(resolve));
		rmSync(home, { recursive: true, force: true });
	}
});
