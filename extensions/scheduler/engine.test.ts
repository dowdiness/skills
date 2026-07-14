import { expect, test } from "bun:test";
import type { RouteStep } from "./profile.js";
import { executeAgentProcess, executeRouteSteps, runValidationCommands } from "./engine.js";

const agent = {
	name: "test-agent",
	systemPrompt: "",
};

function nodeInvocation(script: string): { command: string; args: string[] } {
	return { command: process.execPath, args: ["-e", script] };
}

test("executes profile steps with template and review-context interpolation", async () => {
	const steps: RouteStep[] = [
		{ agent: "scout", task: "Scout {task}" },
		{ agent: "reviewer", task: "Review {previous} {reviewContext}", reviewContext: true },
	];
	const tasks: string[] = [];
	const results = await executeRouteSteps(steps, "parser change", undefined, {
		getReviewContext: async () => "changed files: parser.ts",
		runStep: async (_step, task) => {
			tasks.push(task);
			return { exitCode: 0, output: "scout output" };
		},
		makeAbortedResult: () => ({ exitCode: 130, stopReason: "aborted" }),
	});
	expect(results).toHaveLength(2);
	expect(tasks[0]).toBe("Scout parser change");
	expect(tasks[1]).toContain("scout output");
	expect(tasks[1]).toContain("changed files: parser.ts");
});

test("stops before the next step when the signal is aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	let invoked = false;
	const results = await executeRouteSteps([{ agent: "worker", task: "edit" }], "edit", controller.signal, {
		runStep: async () => {
			invoked = true;
			return { exitCode: 0 };
		},
		makeAbortedResult: () => ({ exitCode: 130, stopReason: "aborted" }),
	});
	expect(invoked).toBe(false);
	expect(results[0]?.stopReason).toBe("aborted");
});

test("parses agent message events and returns the final output", async () => {
	const result = await executeAgentProcess(".", agent, "inspect", undefined, undefined, {
		getInvocation: () => nodeInvocation("process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:'done'}})+'\\n')"),
		writePrompt: async () => ({ dir: "/tmp", filePath: "/tmp/unused" }),
		summarizeMessage: () => "done",
		getFinalOutput: (messages) => `${messages.length} messages`,
	});
	expect(result.exitCode).toBe(0);
	expect(result.messages).toHaveLength(1);
	expect(result.output).toBe("1 messages");
});
test("removes the abort listener after an agent exits", async () => {
	let removed = 0;
	const signal = {
		aborted: false,
		addEventListener: () => undefined,
		removeEventListener: () => { removed += 1; },
	} as unknown as AbortSignal;
	await executeAgentProcess(".", agent, "inspect", signal, undefined, {
		getInvocation: () => nodeInvocation("process.stdout.write('done')"),
		writePrompt: async () => ({ dir: "/tmp", filePath: "/tmp/unused" }),
		summarizeMessage: () => undefined,
		getFinalOutput: () => "",
	});
	expect(removed).toBe(1);
});

test("returns an aborted result when an agent is canceled", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await executeAgentProcess(".", agent, "wait", controller.signal, undefined, {
		getInvocation: () => nodeInvocation("while (true) {}"),
		writePrompt: async () => ({ dir: "/tmp", filePath: "/tmp/unused" }),
		summarizeMessage: () => undefined,
		getFinalOutput: () => "",
	});
	expect(result.exitCode).toBe(130);
	expect(result.stopReason).toBe("aborted");
});

test("reports spawn errors without throwing", async () => {
	const result = await executeAgentProcess(".", agent, "inspect", undefined, undefined, {
		getInvocation: () => ({ command: "/definitely/missing/pi", args: [] }),
		writePrompt: async () => ({ dir: "/tmp", filePath: "/tmp/unused" }),
		summarizeMessage: () => undefined,
		getFinalOutput: () => "",
	});
	expect(result.exitCode).toBe(1);
});

test("stops validation after the first failed command", async () => {
	let secondRan = false;
	const result = await runValidationCommands([
		{ label: "fail", command: process.execPath, args: ["-e", "process.exit(3)"], cwd: "." },
		{ label: "skip", command: process.execPath, args: ["-e", "process.stdout.write('ran');"], cwd: "." },
	], undefined);
	secondRan = result.some((item) => item.label === "skip");
	expect(result).toHaveLength(1);
	expect(secondRan).toBe(false);
	expect(result[0]?.code).toBe(3);
});
test("removes the abort listener after validation exits", async () => {
	let removed = 0;
	const signal = {
		aborted: false,
		addEventListener: () => undefined,
		removeEventListener: () => { removed += 1; },
	} as unknown as AbortSignal;
	await runValidationCommands([
		{ label: "check", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: "." },
	], signal);
	expect(removed).toBe(1);
});
