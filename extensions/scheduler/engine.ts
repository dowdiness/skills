import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { RouteStep } from "./profile.js";

export interface RouteExecutionResult {
	exitCode: number;
	stopReason?: string;
	output?: string;
	stderr?: string;
	errorMessage?: string;
}

export interface RouteExecutionCallbacks<T extends RouteExecutionResult> {
	onProgress?: (line: string) => void;
	prepareStep?: (step: RouteStep, results: T[]) => Promise<boolean>;
	getReviewContext?: () => Promise<string>;
	runStep: (step: RouteStep, task: string) => Promise<T>;
	makeAbortedResult: (step: RouteStep, task: string) => T;
}

export async function executeRouteSteps<T extends RouteExecutionResult>(
	steps: RouteStep[],
	routeTask: string,
	signal: AbortSignal | undefined,
	callbacks: RouteExecutionCallbacks<T>,
): Promise<T[]> {
	const results: T[] = [];
	let previous = "";
	let reviewContext = "";
	for (const step of steps) {
		if (signal?.aborted) {
			results.push(callbacks.makeAbortedResult(step, step.task ?? routeTask));
			break;
		}
		if (callbacks.prepareStep && !(await callbacks.prepareStep(step, results))) break;
		let task = (step.task ?? routeTask).replace(/\{task\}/g, () => routeTask).replace(/\{previous\}/g, () => previous);
		if (step.reviewContext) {
			reviewContext = reviewContext || await (callbacks.getReviewContext?.() ?? Promise.resolve(""));
			task = task.replace(/\{reviewContext\}/g, () => reviewContext);
			if (reviewContext && !task.includes(reviewContext)) task = `${task}\n\nReview context:\n${reviewContext}`;
		}
		callbacks.onProgress?.(`${step.agent}: queued${step.isolate ? " in isolated worktree" : ""}`);
		const result = await callbacks.runStep(step, task);
		results.push(result);
		previous = result.output || result.stderr || result.errorMessage || "";
		if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") break;
	}
	return results;
}

export interface AgentProcessSpec {
	name: string;
	model?: string;
	tools?: string[];
	extensions?: string[];
	systemPrompt: string;
}
export function isCompleteParallelReviewOutput(output: string): boolean {
	if (/INCOMPLETE REVIEW|failed-or-missing/i.test(output)) return false;
	const lines = output.split(/\r?\n/);
	return ["moonbit-reviewer", "reviewer-flash", "reviewer-mimo", "reviewer-qwen"]
		.every((name) => {
			const status = new RegExp("[`\"']?" + name + "[`\"']?\\s*[:=]\\s*[`\"']?usable report received[`\"']?(?=$|[\\s,}])", "i");
			return lines.some((line) => status.test(line));
		});
}

export interface AgentProcessResult extends RouteExecutionResult {
	agent: string;
	task: string;
	messages: Message[];
	stderr: string;
	output: string;
	model?: string;
}

export interface AgentProcessDependencies {
	getInvocation: (args: string[]) => { command: string; args: string[] };
	writePrompt: (agentName: string, prompt: string) => Promise<{ dir: string; filePath: string }>;
	summarizeMessage: (message: Message) => string | undefined;
	getFinalOutput: (messages: Message[]) => string;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export async function executeAgentProcess(
	cwd: string,
	agent: AgentProcessSpec,
	task: string,
	signal: AbortSignal | undefined,
	onProgress: ((line: string) => void) | undefined,
	dependencies: AgentProcessDependencies,
): Promise<AgentProcessResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (agent.extensions && agent.extensions.length > 0) {
		for (const extension of agent.extensions) args.push("--extension", extension);
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	let tmpDir: string | undefined;
	let tmpPrompt: string | undefined;
	if (agent.systemPrompt.trim()) {
		const tmp = await dependencies.writePrompt(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPrompt = tmp.filePath;
		args.push("--append-system-prompt", tmpPrompt);
	}
	args.push(`Task: ${task}`);
	const messages: Message[] = [];
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let model: string | undefined = agent.model;
	let abortHandler: (() => void) | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	try {
		onProgress?.(`${agent.name}: starting`);
		const { promise, resolve } = Promise.withResolvers<number>();
		const invocation = dependencies.getInvocation(args);
		const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SCHEDULER_CHILD: "1" } });
		let buffer = "";
		let wasAborted = false;
		let settled = false;
		const abort = () => {
			wasAborted = true;
			onProgress?.(`${agent.name}: abort requested`);
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => { if (!settled) proc.kill("SIGKILL"); }, 5000);
			killTimer.unref?.();
		};
		abortHandler = abort;
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		const processLine = (line: string) => {
			if (!line.trim()) return;
			const event = parseJsonRecord(line);
			if (!event) return;
			if (event.type === "tool_execution_start") onProgress?.(`${agent.name}: → ${event.toolName ?? "tool"}`);
			if (event.type === "message_end" && event.message) {
				const message = event.message as Message;
				messages.push(message);
				const summary = dependencies.summarizeMessage(message);
				if (summary) onProgress?.(`${agent.name}: ${summary}`);
				if (message.role === "assistant") {
					if (message.model) model = message.model;
					if (message.stopReason) stopReason = message.stopReason;
					if (message.errorMessage) errorMessage = message.errorMessage;
				}
			}
			if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message as Message);
				onProgress?.(`${agent.name}: tool result`);
			}
		};
		proc.stdout.on("data", (data) => { buffer += data.toString(); const lines = buffer.split("\n"); buffer = lines.pop() || ""; for (const line of lines) processLine(line); });
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		proc.on("close", (code, signalName) => { settled = true; if (buffer.trim()) processLine(buffer); resolve(wasAborted ? 130 : (code ?? (signalName ? 1 : 0))); });
		proc.on("error", () => { settled = true; resolve(1); });
		const exitCode = await promise;
		if (signal?.aborted) return { agent: agent.name, task, exitCode: 130, messages, stderr, output: dependencies.getFinalOutput(messages), model, stopReason: "aborted", errorMessage: "Scheduler route aborted" };
		onProgress?.(`${agent.name}: finished with exit ${exitCode}`);
		return { agent: agent.name, task, exitCode, messages, stderr, output: dependencies.getFinalOutput(messages), model, stopReason, errorMessage };
	} finally {
		if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		clearTimeout(killTimer);
		if (tmpPrompt) await fs.promises.unlink(tmpPrompt).catch(() => undefined);
		if (tmpDir) await fs.promises.rmdir(tmpDir).catch(() => undefined);
	}
}

export interface ValidationCommand {
	label: string;
	command: string;
	args: string[];
	cwd: string;
}

export interface ValidationCommandResult extends ValidationCommand {
	code: number;
	stdout: string;
	stderr: string;
}

export async function runValidationCommands(
	commands: ValidationCommand[],
	signal?: AbortSignal,
	onProgress?: (line: string) => void,
): Promise<ValidationCommandResult[]> {
	const results: ValidationCommandResult[] = [];
	for (const command of commands) {
		onProgress?.(`validate: ${command.label}`);
		const { promise, resolve } = Promise.withResolvers<ValidationCommandResult>();
		const proc = spawn(command.command, command.args, { cwd: command.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const abort = () => {
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => { if (!settled) proc.kill("SIGKILL"); }, 2500);
			killTimer.unref?.();
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		proc.stdout.on("data", (data) => { stdout += data.toString(); });
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		proc.on("error", (error) => { settled = true; resolve({ ...command, code: 1, stdout, stderr: `${stderr}${String(error)}` }); });
		proc.on("close", (code) => { settled = true; resolve({ ...command, code: code ?? 1, stdout, stderr }); });
		const result = await promise.finally(() => {
			signal?.removeEventListener("abort", abort);
			clearTimeout(killTimer);
		});
		results.push(result);
		if (result.code !== 0) break;
	}
	return results;
}
