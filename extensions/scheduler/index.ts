import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveRouteDefinition, resolveSchedulerProfile, routeFor, routeNames, type AutopilotMode, type RouteDefinition, type SchedulerMode, type SchedulerProfile, type ValidationCommandSpec } from "./profile.js";
import { executeAgentProcess, executeRouteSteps, runValidationCommands } from "./engine.js";
import { settleRouteUi } from "./ui-lifecycle.js";

type RouteKind = string;
type ClassifierRoute = RouteKind | "inline";
type ProgressCallback = (line: string) => void;

interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
	filePath: string;
}

interface StepResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	output: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	isolated?: boolean;
	worktreeRoot?: string;
	patchPath?: string;
	appliedToParent?: boolean;
	patchPaths?: string[];
	diffStat?: string;
	worktreeStatus?: string;
	baseWarning?: string;
	submoduleWarning?: string;
	generatedWarning?: string;
	generatedBlockedPaths?: string[];
	applyCheckExitCode?: number;
	applyCheckOutput?: string;
}

interface RouteDecision {
	kind: RouteKind;
	reason: string;
	task: string;
	explicit: boolean;
}

interface RouteRecord {
	timestamp: number;
	route: RouteDecision;
	status: "completed" | "failed" | "aborted";
	patchPaths: string[];
	validationHints: string[];
	parentStat?: string;
}

interface SchedulerState {
	mode: SchedulerMode;
	classifierEnabled: boolean;
	autopilotMode: AutopilotMode;
}

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ValidationCommand extends ValidationCommandSpec {
	cwd: string;
}

interface ValidationCommandResult extends ValidationCommand {
	code: number;
	stdout: string;
	stderr: string;
}

interface ValidationPlan {
	affectedPaths: string[];
	commands: ValidationCommand[];
	warnings: string[];
}

interface ClassifierDecision {
	route: ClassifierRoute;
	confidence: number;
	reason: string;
}

interface RouteRunSummary {
	status: RouteRecord["status"];
	results: StepResult[];
	patchPaths: string[];
	validationHints: string[];
	parentStat?: string;
}
function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

const CUSTOM_TYPE = "scheduler";
const STATE_TYPE = "scheduler-state";
const ROUTE_RECORD_TYPE = "scheduler-route";
const PATCH_DIR = path.join(getAgentDir(), "scheduler-patches");

function stripPrefix(text: string, prefix: string): string | undefined {
	const pattern = new RegExp(`^${prefix}\\s*:\\s*`, "i");
	if (!pattern.test(text)) return undefined;
	return text.replace(pattern, "").trim();
}

function looksMechanical(text: string): boolean {
	const lower = text.toLowerCase();
	if (/\b(mechanical|rote|exact-pattern|exact pattern|all occurrences|repeated)\b/.test(lower)) return true;
	if (/^rename\b/.test(lower) && /\b(to|as)\b/.test(lower)) return true;
	if (/^replace\b/.test(lower) && /\b(with|by)\b/.test(lower)) return true;
	if (/^update\b/.test(lower) && /\b(import|imports|path|paths|module path|module paths|generated path|generated paths|reference|references)\b/.test(lower)) return true;
	if (/^migrate\b/.test(lower) && /\b(from|to|pattern|deprecated)\b/.test(lower)) return true;
	if (/^apply\b/.test(lower) && /\b(patch|specified patch|exact change|exact edit)\b/.test(lower)) return true;
	if (/\b(deprecated syntax|deprecated api|deprecated constructor|deprecated call)\b/.test(lower) && /\b(rewrite|replace|update|migrate)\b/.test(lower)) return true;
	return false;
}

function looksScoped(text: string): boolean {
	return /`[^`]+`/.test(text) || /\b[a-zA-Z0-9_./-]+\.(mbt|ts|tsx|js|json|md|css|html|yml|yaml)\b/.test(text);
}

function classify(text: string, profile: SchedulerProfile): RouteDecision | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	for (const route of profile.routes) {
		for (const prefix of route.aliases) {
			const task = stripPrefix(trimmed, prefix);
			if (task) return { kind: route.name, task, reason: `explicit ${prefix} prefix`, explicit: true };
		}
	}

	const lower = trimmed.toLowerCase();
	const has = (name: string) => routeFor(profile, name) !== undefined;
	if (looksMechanical(trimmed) && looksScoped(trimmed) && has("mechanic")) {
		return { kind: "mechanic", task: trimmed, reason: "high-confidence mechanical scoped edit", explicit: false };
	}
	if (/^(find|locate|where\s+(is|are)|investigate|explore|trace|map)\b/.test(lower) && has("scout")) {
		return { kind: "scout", task: trimmed, reason: "code reconnaissance request", explicit: false };
	}
	if (/^(plan|design|propose)\b/.test(lower) || /\bimplementation plan\b/.test(lower)) {
		if (has("plan")) return { kind: "plan", task: trimmed, reason: "planning request", explicit: false };
	}
	if (/\bensemble[- ]?review\b/.test(lower) && has("ensemble-review")) {
		return { kind: "ensemble-review", task: trimmed, reason: "ensemble review request", explicit: false };
	}
	if (/\bparallel[- ]?review\b/.test(lower) && has("parallel-review")) {
		return { kind: "parallel-review", task: trimmed, reason: "parallel review request", explicit: false };
	}
	if (/\breview[- ]?router\b/.test(lower) && has("review-router")) {
		return { kind: "review-router", task: trimmed, reason: "review router request", explicit: false };
	}
	if ((/^(review|audit)\b/.test(lower) || /\b(pre-merge|premerge|code review)\b/.test(lower)) && has("review")) {
		return { kind: "review", task: trimmed, reason: "review request", explicit: false };
	}
	if (/^(implement|add|fix|refactor)\b/.test(lower) && /\b(across|multiple files|end-to-end|delegate|scheduler)\b/.test(lower) && has("implement")) {
		return { kind: "implement", task: trimmed, reason: "larger implementation request", explicit: false };
	}
	return undefined;
}

function expandUserPath(input: string, cwd: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function truncate(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let next = text.slice(0, maxBytes);
	while (Buffer.byteLength(next, "utf8") > maxBytes) next = next.slice(0, -1);
	return `${next}\n… truncated …`;
}

function loadAgents(): AgentConfig[] {
	const dir = path.join(getAgentDir(), "agents");
	if (!fs.existsSync(dir)) return [];

	const agents: AgentConfig[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			model: frontmatter.model,
			tools: tools && tools.length > 0 ? tools : undefined,
			systemPrompt: body,
			filePath,
		});
	}
	return agents;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function summarizeMessage(message: Message): string | undefined {
	if (message.role !== "assistant") return undefined;
	for (const part of message.content) {
		if (part.type === "text") {
			const firstLine = part.text.trim().split("\n").find((line) => line.trim().length > 0);
			if (firstLine) return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
		}
	}
	return undefined;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writePrompt(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-scheduler-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

async function execCapture(
	cwd: string,
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<ExecResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
	const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	let killTimer: NodeJS.Timeout | undefined;
	const cleanup = () => {
		signal?.removeEventListener("abort", abort);
		clearTimeout(killTimer);
	};
	const settle = (result: ExecResult) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(result);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const abort = () => {
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (!settled) proc.kill("SIGKILL");
		}, 2500);
		killTimer.unref?.();
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	proc.stdout.on("data", (data) => { stdout += data.toString(); });
	proc.stderr.on("data", (data) => { stderr += data.toString(); });
	proc.on("close", (code) => settle({ code: code ?? 0, stdout, stderr }));
	proc.on("error", fail);
	return promise;
}

async function gitCapture(cwd: string, args: string[], signal?: AbortSignal): Promise<ExecResult> {
	return execCapture(cwd, "git", args, signal);
}

async function parentDiffStat(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await gitCapture(cwd, ["diff", "--stat"], signal).catch(() => undefined);
	if (!result || result.code !== 0) return undefined;
	return result.stdout.trim() || "(no parent working-tree diff)";
}

async function repoRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await gitCapture(cwd, ["rev-parse", "--show-toplevel"], signal).catch(() => undefined);
	if (!result || result.code !== 0) return undefined;
	return result.stdout.trim();
}

async function getSubmodulePaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const root = await repoRoot(cwd, signal);
	if (!root) return [];
	const result = await gitCapture(root, ["config", "--file", ".gitmodules", "--get-regexp", "path"], signal).catch(() => undefined);
	if (!result || result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).slice(1).join(" ").trim())
		.filter(Boolean);
}

function pathTouchesSubmodule(filePath: string, submodulePaths: string[]): boolean {
	return submodulePaths.some((submodule) => filePath === submodule || filePath.startsWith(`${submodule}/`));
}

function assessGeneratedPaths(paths: string[], profile: SchedulerProfile): { blocked: string[]; warnings: string[] } {
	const blocked = paths.filter((filePath) => profile.generated.block.some((source) => new RegExp(source).test(filePath)));
	const warningPaths = paths.filter((filePath) => profile.generated.warn.some((source) => new RegExp(source).test(filePath)));
	const warnings = warningPaths.map((filePath) => `${filePath} looks generated; prefer regenerating it in the parent checkout when possible.`);
	return { blocked, warnings };
}


function extractPatchPathsFromText(diff: string): string[] {
	const paths = new Set<string>();
	for (const line of diff.split("\n")) {
		const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
		if (!match) continue;
		const left = match[1];
		const right = match[2];
		if (left && left !== "/dev/null") paths.add(left);
		if (right && right !== "/dev/null") paths.add(right);
	}
	return Array.from(paths).sort();
}

function patchSize(diff: string): { files: number; changedLines: number } {
	const files = extractPatchPathsFromText(diff).length;
	let changedLines = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+") || line.startsWith("-")) changedLines++;
	}
	return { files, changedLines };
}

async function isParentTreeClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
	const status = await gitCapture(cwd, ["status", "--porcelain"], signal).catch(() => undefined);
	return Boolean(status && status.code === 0 && status.stdout.trim().length === 0);
}

async function runPromptNoTools(cwd: string, prompt: string, profile: SchedulerProfile, signal?: AbortSignal): Promise<string> {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-tools", "--model", profile.classifier.model, prompt];
	let output = "";
	const { promise, resolve } = Promise.withResolvers<void>();
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_SCHEDULER_CHILD: "1" },
	});
	let buffer = "";
	let settled = false;
	let killTimer: NodeJS.Timeout | undefined;
	const finish = () => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		clearTimeout(killTimer);
		resolve();
	};
	const abort = () => {
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => { if (!settled) proc.kill("SIGKILL"); }, 2500);
		killTimer.unref?.();
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const processLine = (line: string) => {
		if (!line.trim()) return;
		const event = parseJsonRecord(line);
		if (!event) return;
		if (event.type === "message_end" && event.message) output = getFinalOutput([event.message as Message]);
	};
	proc.stdout.on("data", (data) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) processLine(line);
	});
	proc.on("close", () => {
		if (buffer.trim()) processLine(buffer);
		finish();
	});
	proc.on("error", finish);
	await promise;
	return output;
}

function parseClassifierJson(output: string, profile: SchedulerProfile): ClassifierDecision | undefined {
	const stripped = output.replace(/```(?:json)?/g, "```").replace(/```/g, "");
	const match = stripped.match(/\{[\s\S]*\}/);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]) as ClassifierDecision;
		if (typeof parsed.route !== "string") return undefined;
		const route = parsed.route as ClassifierRoute;
		if (route !== "inline" && routeFor(profile, route) === undefined) return undefined;
		const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
		const reason = typeof parsed.reason === "string" ? parsed.reason : "classifier";
		return { route, confidence, reason };
	} catch {
		return undefined;
	}
}

async function classifyWithCheapModel(cwd: string, text: string, profile: SchedulerProfile, signal?: AbortSignal): Promise<ClassifierDecision | undefined> {
	const prompt = [
		"Classify this coding-agent user request for a hard task scheduler.",
		"Return only compact JSON with keys route, confidence, reason.",
		"Routes:",
		...profile.classifier.instructions.map((instruction) => `- ${instruction}`),
		"",
		`Request: ${text}`,
	].join("\n");
	const output = await runPromptNoTools(cwd, prompt, profile, signal);
	return parseClassifierJson(output, profile);
}

async function runAgent(
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
): Promise<StepResult> {
	const agent = agents.find((item) => item.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent ${agentName}. Available: ${agents.map((item) => item.name).join(", ") || "none"}`,
			output: "",
		};
	}
	return executeAgentProcess(cwd, agent, task, signal, onProgress, {
		getInvocation: getPiInvocation,
		writePrompt,
		summarizeMessage,
		getFinalOutput,
	});
}

async function runAgentInWorktree(
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	profile: SchedulerProfile,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
): Promise<StepResult> {
	const repo = await gitCapture(cwd, ["rev-parse", "--show-toplevel"], signal);
	if (repo.code !== 0) {
		return { agent: agentName, task, exitCode: repo.code, messages: [], stderr: repo.stderr || "Not in a git repository; cannot isolate editing agent.", output: "" };
	}

	const repoRoot = repo.stdout.trim();
	const relativeCwd = path.relative(repoRoot, cwd);
	const [parentStatus, submodulePaths] = await Promise.all([
		gitCapture(cwd, ["status", "--short"], signal).catch(() => undefined),
		getSubmodulePaths(cwd, signal),
	]);
	const warnings: string[] = [];
	if (parentStatus?.stdout.trim()) {
		warnings.push("Parent working tree has uncommitted changes; isolated patch is based on HEAD and may need manual reconciliation.");
	}
	const mentionedSubmodules = submodulePaths.filter((submodule) => task.includes(submodule));
	const submoduleWarning = mentionedSubmodules.length > 0
		? `Task mentions submodule path(s): ${mentionedSubmodules.join(", ")}. Worktree isolation does not initialize or commit inside submodules; handle submodule changes manually.`
		: undefined;
	if (submoduleWarning) warnings.push(submoduleWarning);

	const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-scheduler-worktree-"));
	const worktreeRoot = path.join(tmpRoot, "worktree");
	await fs.promises.mkdir(PATCH_DIR, { recursive: true });
	const patchPath = path.join(PATCH_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${agentName}-${process.pid}.patch`);

	let result: StepResult | undefined;
	try {
		onProgress?.(`${agentName}: creating isolated git worktree`);
		const add = await gitCapture(repoRoot, ["worktree", "add", "--detach", worktreeRoot, "HEAD"], signal);
		if (add.code !== 0) {
			return { agent: agentName, task, exitCode: add.code, messages: [], stderr: add.stderr, output: "", isolated: true, worktreeRoot, baseWarning: warnings.join(" "), submoduleWarning };
		}

		const childCwd = relativeCwd ? path.join(worktreeRoot, relativeCwd) : worktreeRoot;
		result = await runAgent(childCwd, agents, agentName, task, signal, onProgress);
		result.isolated = true;
		result.worktreeRoot = worktreeRoot;
		result.baseWarning = warnings.join(" ") || undefined;
		result.submoduleWarning = submoduleWarning;

		if (signal?.aborted) return result;

		await gitCapture(worktreeRoot, ["add", "-N", "."], signal).catch(() => undefined);
		const [diff, stat, status] = await Promise.all([
			gitCapture(worktreeRoot, ["diff", "--binary"], signal),
			gitCapture(worktreeRoot, ["diff", "--stat"], signal),
			gitCapture(worktreeRoot, ["status", "--short"], signal),
		]);
		result.diffStat = stat.stdout.trim();
		result.worktreeStatus = status.stdout.trim();
		result.patchPaths = extractPatchPathsFromText(diff.stdout);
		const touchedSubmodules = result.patchPaths.filter((filePath) => pathTouchesSubmodule(filePath, submodulePaths));
		if (touchedSubmodules.length > 0) {
			result.submoduleWarning = `Patch touches submodule path(s): ${touchedSubmodules.join(", ")}. Review submodule workflow before applying.`;
		}
		const generated = assessGeneratedPaths(result.patchPaths, profile);
		if (generated.warnings.length > 0) {
			result.generatedWarning = generated.warnings.join(" ");
		}
		if (generated.blocked.length > 0) {
			result.generatedBlockedPaths = generated.blocked;
			result.generatedWarning = `Patch blocked because it touches generated/output paths: ${generated.blocked.join(", ")}. Regenerate these artifacts in the parent checkout instead.`;
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
			result.errorMessage = result.errorMessage ?? "Scheduler blocked generated/output artifact patch.";
			onProgress?.(`${agentName}: blocked generated/output patch paths`);
			return result;
		}

		if (diff.stdout.trim()) {
			await fs.promises.writeFile(patchPath, diff.stdout, { encoding: "utf8", mode: 0o600 });
			result.patchPath = patchPath;
			const applyCheck = await gitCapture(cwd, ["apply", "--check", patchPath], signal).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
			result.applyCheckExitCode = applyCheck.code;
			result.applyCheckOutput = (applyCheck.stdout + applyCheck.stderr).trim();
			onProgress?.(
				applyCheck.code === 0
					? `${agentName}: patch written and cleanly applicable to parent`
					: `${agentName}: patch written but parent apply check failed`,
			);
		} else {
			onProgress?.(`${agentName}: no patch produced`);
		}
		return result;
	} finally {
		if (fs.existsSync(worktreeRoot)) await gitCapture(repoRoot, ["worktree", "remove", "--force", worktreeRoot]).catch(() => undefined);
		await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function runRoute(cwd: string, route: RouteDecision, profile: SchedulerProfile, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<StepResult[]> {
	const agents = loadAgents();
	const results: StepResult[] = [];
	const changedPaths = await currentChangedPaths(cwd).catch(() => []);
	const routeDefinition = resolveRouteDefinition(profile, route.kind, route.task, route.explicit, changedPaths);
	if (!routeDefinition) {
		return [{
			agent: "scheduler",
			task: route.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown route ${route.kind}. Available: ${routeNames(profile).join(", ")}`,
			output: "",
		}];
	}

	let previousPatchApplied = false;
	const getReviewContext = async () => {
		const [root, changedPaths, diffStat] = await Promise.all([
			repoRoot(cwd).catch(() => undefined),
			currentChangedPaths(cwd).catch(() => []),
			parentDiffStat(cwd).catch(() => undefined),
		]);
		return [
			root ? `Package root: ${root}` : "Package root: (unavailable)",
			"Applicable validation: inspect the package instructions and report recommended commands; do not claim commands were executed unless their output is supplied.",
			"Known risks: verify the complete diff, public API/package boundaries, generated files, tests, and stale references.",
			changedPaths.length > 0 ? `Changed files:\n${changedPaths.map((filePath) => `- ${filePath}`).join("\n")}` : "Changed files: (none)",
			diffStat ? `Current diff stat:\n\n${diffStat}` : "Current diff stat: (unavailable)",
			"Actual diff/hunks: supplied by the scheduler parent context when available.",
		].join("\n\n");
	};

	const executionResults = await executeRouteSteps<StepResult>(routeDefinition.steps, route.task, signal, {
		onProgress,
		getReviewContext,
		makeAbortedResult: (step, task) => ({
			agent: step.agent,
			task,
			exitCode: 130,
			messages: [],
			stderr: "",
			output: "",
			stopReason: "aborted",
			errorMessage: "Scheduler route aborted before this step started",
		}),
		prepareStep: async (step, stepResults) => {
			if (!step.applyPreviousPatch) return true;
			const previousResult = stepResults[stepResults.length - 1];
			if (!previousResult?.patchPath || previousResult.applyCheckExitCode !== 0) {
				onProgress?.(`${step.agent}: skipped because the previous step produced no applicable patch`);
				return false;
			}
			const parentStatus = await gitCapture(cwd, ["status", "--short"], signal).catch(() => undefined);
			if (parentStatus?.stdout.trim()) {
				onProgress?.(`${step.agent}: skipped because parent working tree has uncommitted changes`);
				return false;
			}
			const apply = await gitCapture(cwd, ["apply", previousResult.patchPath], signal).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
			if (apply.code !== 0) {
				stepResults.push({ agent: step.agent, task: step.task ?? route.task, exitCode: 1, messages: [], stderr: apply.stderr || apply.stdout, output: "", errorMessage: "Previous worker patch could not be applied to the parent checkout." });
				return false;
			}
			previousResult.appliedToParent = true;
			previousPatchApplied = true;
			onProgress?.(`${step.agent}: previous worker patch applied to parent checkout`);
			return true;
		},
		runStep: async (step, task) => step.isolate
			? runAgentInWorktree(cwd, agents, step.agent, task, profile, signal, onProgress)
			: runAgent(cwd, agents, step.agent, task, signal, onProgress),
	});
	results.push(...executionResults);

	if (previousPatchApplied) onProgress?.("scheduler: profile post-step pipeline completed");
	return results;
}

function collectPatchPaths(results: StepResult[]): string[] {
	return results.flatMap((result) => result.patchPath ? [result.patchPath] : []);
}

function collectAffectedPaths(results: StepResult[]): string[] {
	return Array.from(new Set(results.flatMap((result) => result.patchPaths ?? []))).sort();
}

function validationHints(route: RouteDecision, results: StepResult[], cwd: string, profile: SchedulerProfile): string[] {
	if (!profile.isEditingRoute(route.kind)) return [];
	const patchPaths = collectPatchPaths(results);
	const affected = collectAffectedPaths(results);
	const appliedToParent = results.some((result) => result.appliedToParent);
	const hints = new Set<string>();
	if (patchPaths.length > 0) {
		hints.add(appliedToParent
			? `Patch already applied to the parent checkout: ${patchPaths[patchPaths.length - 1]}`
			: `Preview/apply with /scheduler apply ${patchPaths[patchPaths.length - 1]}`);
	}
	hints.add(appliedToParent ? "Inspect the parent checkout diff and run validation." : "Inspect git diff --stat after applying the patch.");
	for (const rule of profile.validation.rules) {
		if (affected.some((filePath) => rule.pathPatterns.some((source) => new RegExp(source).test(filePath)))) {
			for (const hint of rule.hints) hints.add(hint);
		}
	}
	if (affected.length > 0 && !profile.validation.rules.some((rule) => affected.some((filePath) => rule.pathPatterns.some((source) => new RegExp(source).test(filePath))))) {
		hints.add(profile.validation.fallbackHint);
	}
	if (results.some((result) => result.generatedWarning)) hints.add("Patch touches generated-looking files; prefer regenerating artifacts in the parent checkout when possible.");
	if (results.some((result) => result.submoduleWarning)) hints.add("For submodule changes, commit and push inside the submodule before updating the parent pointer.");
	return Array.from(hints);
}

function formatResults(route: RouteDecision, results: StepResult[], hints: string[], profile: SchedulerProfile, parentStat?: string): string {
	const failed = results.find((result) => result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
	const status = failed ? "failed" : "completed";
	const sections = [`# Scheduler ${status}`, `Profile: **${profile.displayName}**`, `Route: **${route.kind}** (${route.reason})`, `Task: ${route.task}`];

	for (const [index, result] of results.entries()) {
		const stepStatus = result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted" ? "completed" : "failed";
		sections.push([
			`## Step ${index + 1}: ${result.agent} — ${stepStatus}`,
			result.model ? `Model: ${result.model}` : undefined,
			result.isolated ? "Isolation: temporary git worktree" : undefined,
			result.baseWarning ? `Warning: ${result.baseWarning}` : undefined,
			result.submoduleWarning ? `Submodule warning: ${result.submoduleWarning}` : undefined,
			result.generatedWarning ? `Generated/output warning: ${result.generatedWarning}` : undefined,
			result.generatedBlockedPaths && result.generatedBlockedPaths.length > 0 ? `Blocked generated/output paths: ${result.generatedBlockedPaths.join(", ")}` : undefined,
			result.patchPath ? `${result.appliedToParent ? "Patch applied to parent (provenance)" : "Patch"}: \`${result.patchPath}\`` : result.isolated ? "Patch: (none produced)" : undefined,
			result.applyCheckExitCode !== undefined
				? `Parent apply check: ${result.applyCheckExitCode === 0 ? "clean" : "failed"}${result.applyCheckOutput ? `\n\n\`\`\`\n${result.applyCheckOutput}\n\`\`\`` : ""}`
				: undefined,
			result.diffStat ? `Patch diff stat:\n\n\`\`\`\n${result.diffStat}\n\`\`\`` : undefined,
			result.worktreeStatus ? `Worktree status:\n\n\`\`\`\n${result.worktreeStatus}\n\`\`\`` : undefined,
			result.errorMessage ? `Error: ${result.errorMessage}` : undefined,
			result.stderr.trim() ? `stderr:\n\n\`\`\`\n${result.stderr.trim()}\n\`\`\`` : undefined,
			result.output.trim() || "(no output)",
		].filter(Boolean).join("\n\n"));
	}

	if (parentStat !== undefined) sections.push(`## Parent working-tree diff stat\n\n\`\`\`\n${parentStat}\n\`\`\``);
	if (hints.length > 0) sections.push(`## Validation hints\n${hints.map((hint) => `- ${hint}`).join("\n")}`);
	const parentWasModified = results.some((result) => result.appliedToParent);
	if (profile.isEditingRoute(route.kind)) {
		sections.push([
			"## Parent follow-up",
			parentWasModified
				? "The isolated worker patch was applied to the parent checkout; subsequent post-step agents may also have modified the parent checkout."
				: "Delegated edits were run in an isolated temporary git worktree. The parent checkout was not modified by the editing agent.",
			parentWasModified
				? "Inspect the parent diff and run validation in the parent session."
				: "Inspect any patch path above, apply it manually if desired, then run validation in the parent session.",
		].join("\n"));
	}
	return sections.join("\n\n");
}

function formatLast(record: RouteRecord | undefined): string {
	if (!record) return "# Scheduler last\n\nNo scheduler route has run in this session branch.";
	return [
		"# Scheduler last",
		`Time: ${new Date(record.timestamp).toISOString()}`,
		`Status: **${record.status}**`,
		`Route: **${record.route.kind}** (${record.route.reason})`,
		`Task: ${record.route.task}`,
		record.patchPaths.length > 0 ? `Patches:\n${record.patchPaths.map((patchPath) => `- \`${patchPath}\``).join("\n")}` : undefined,
		record.parentStat ? `Parent diff stat:\n\n\`\`\`\n${record.parentStat}\n\`\`\`` : undefined,
		record.validationHints.length > 0 ? `Validation hints:\n${record.validationHints.map((hint) => `- ${hint}`).join("\n")}` : undefined,
	].filter(Boolean).join("\n\n");
}

function statusFromResults(results: StepResult[]): RouteRecord["status"] {
	if (results.some((result) => result.stopReason === "aborted" || result.exitCode === 130)) return "aborted";
	if (results.some((result) => result.exitCode !== 0 || result.stopReason === "error")) return "failed";
	return "completed";
}

async function runRouteWithUi(pi: ExtensionAPI, ctx: ExtensionContext, route: RouteDecision): Promise<RouteRunSummary> {
	const controller = new AbortController();
	const changedPaths = await currentChangedPaths(ctx.cwd).catch(() => []);
	const profile = await resolveSchedulerProfile(ctx.cwd, changedPaths);
	const progress: string[] = [`profile: ${profile.id}`, `route: ${route.kind}`, `reason: ${route.reason}`, "starting…"];
	const pushProgress = (line: string) => {
		progress.push(line);
		if (progress.length > 16) progress.splice(3, progress.length - 16);
	};

	let results: StepResult[] = [];
	let error: unknown;
	let parentStat: string | undefined;
	let execution: Promise<void> | undefined;

	const execute = async (onProgress: ProgressCallback) => {
		results = await runRoute(ctx.cwd, route, profile, controller.signal, onProgress);
		if (profile.isEditingRoute(route.kind)) parentStat = await parentDiffStat(ctx.cwd, controller.signal);
	};

	if (ctx.mode === "tui") {
		const ui = ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				done(value);
			};

			const requestRender = () => tui.requestRender();
			execution = execute((line) => {
				pushProgress(line);
				requestRender();
			});
			execution.then(() => finish(!controller.signal.aborted)).catch((caught) => {
				error = caught;
				finish(true);
			});

			return {
				render(width: number) {
					const fit = (line: string) => (width <= 0 ? "" : truncateToWidth(line, width));
					const header = theme.fg("accent", theme.bold(`${profile.displayName}`));
					const hint = theme.fg("dim", "Esc aborts child agent/worktree run");
					return [header, hint, "", ...progress.map((line) => theme.fg("muted", `• ${line}`))].map(fit);
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, "escape")) {
						controller.abort();
						pushProgress("abort requested");
						requestRender();
						finish(false);
						return true;
					}
					return true;
				},
			};
		});
		const outcome = await settleRouteUi(ui, () => execution ?? Promise.resolve());
		const completed = outcome.completed;
		if (outcome.error !== undefined) error = outcome.error;
		if (!completed) {
			const summary: RouteRunSummary = { status: "aborted", results, patchPaths: collectPatchPaths(results), validationHints: validationHints(route, results, ctx.cwd, profile), parentStat };
			pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler aborted\n\nProfile: **${profile.displayName}**\n\nRoute: **${route.kind}**\n\nChild process termination was requested.`, display: true, details: { route, profile: profile.id } });
			return summary;
		}
	} else {
		await execute(pushProgress).catch((caught) => {
			error = caught;
		});
	}

	if (error) {
		const message = error instanceof Error ? error.message : String(error);
		const summary: RouteRunSummary = { status: "failed", results, patchPaths: collectPatchPaths(results), validationHints: validationHints(route, results, ctx.cwd, profile), parentStat };
		pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler failed\n\nProfile: **${profile.displayName}**\n\nRoute: **${route.kind}**\n\n${message}`, display: true, details: { route, error: message } });
		return summary;
	}

	const hints = validationHints(route, results, ctx.cwd, profile);
	const summary: RouteRunSummary = { status: statusFromResults(results), results, patchPaths: collectPatchPaths(results), validationHints: hints, parentStat };
	pi.sendMessage({ customType: CUSTOM_TYPE, content: formatResults(route, results, hints, profile, parentStat), display: true, details: { route, results, parentStat, hints, profile: profile.id } });
	return summary;
}

async function currentChangedPaths(cwd: string): Promise<string[]> {
	const [unstaged, staged, untracked] = await Promise.all([
		gitCapture(cwd, ["diff", "--name-only"]).catch(() => ({ code: 1, stdout: "", stderr: "" })),
		gitCapture(cwd, ["diff", "--cached", "--name-only"]).catch(() => ({ code: 1, stdout: "", stderr: "" })),
		gitCapture(cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => ({ code: 1, stdout: "", stderr: "" })),
	]);
	return Array.from(new Set(`${unstaged.stdout}\n${staged.stdout}\n${untracked.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean))).sort();
}

function executableOnPath(command: string): boolean {
	const pathValue = process.env.PATH ?? "";
	return pathValue.split(path.delimiter).some((directory) => {
		for (const candidate of process.platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command]) {
			try {
				fs.accessSync(path.join(directory, candidate), fs.constants.X_OK);
				return true;
			} catch {
				continue;
			}
		}
		return false;
	});
}

function validationCommandConfigured(root: string, command: ValidationCommandSpec): boolean {
	if (!executableOnPath(command.command)) return false;
	if (command.requiredFiles && !command.requiredFiles.some((file) => fs.existsSync(path.join(root, file)))) return false;
	if (!command.requiredScript) return true;
	const manifest = command.scriptManifest ? path.join(root, command.scriptManifest) : undefined;
	if (!manifest || !fs.existsSync(manifest)) return false;
	try {
		const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { scripts?: Record<string, unknown> };
		return typeof parsed.scripts?.[command.requiredScript] === "string";
	} catch {
		return false;
	}
}
function buildValidationPlan(root: string, affectedPaths: string[], profile: SchedulerProfile): ValidationPlan {
	const warnings: string[] = [];
	const commands: ValidationCommand[] = [];
	const matchedRules = profile.validation.rules.filter((rule) => affectedPaths.some((filePath) => rule.pathPatterns.some((source) => new RegExp(source).test(filePath))));
	const generated = assessGeneratedPaths(affectedPaths, profile);
	if (generated.blocked.length > 0) warnings.push(`Generated/output paths changed: ${generated.blocked.join(", ")}. Prefer regenerating, not patching, these artifacts.`);
	warnings.push(...generated.warnings);

	const seenCommands = new Set<string>();
	for (const rule of matchedRules) {
		for (const hint of rule.hints) warnings.push(hint);
		for (const command of rule.commands) {
			const key = `${command.command} ${command.args.join(" ")}`;
			if (seenCommands.has(key)) continue;
			seenCommands.add(key);
			if (validationCommandConfigured(root, command)) {
				commands.push({ ...command, cwd: root });
			} else {
				warnings.push(`Validation command unavailable or unconfigured: ${key}`);
			}
		}
	}
	if (commands.length === 0 && warnings.length === 0) warnings.push(profile.validation.fallbackHint);
	return { affectedPaths, commands, warnings };
}


function formatValidation(target: string, plan: ValidationPlan, results: ValidationCommandResult[]): string {
	const failed = results.find((result) => result.code !== 0);
	const sections = [
		`# Scheduler validation ${failed ? "failed" : "completed"}`,
		`Target: ${target}`,
		plan.affectedPaths.length > 0 ? `Affected paths:\n${plan.affectedPaths.map((filePath) => `- \`${filePath}\``).join("\n")}` : "Affected paths: (none)",
		plan.warnings.length > 0 ? `Warnings/hints:\n${plan.warnings.map((warning) => `- ${warning}`).join("\n")}` : undefined,
	];

	if (results.length > 0) {
		sections.push("## Commands");
		for (const result of results) {
			sections.push([
				`### ${result.label} — exit ${result.code}`,
				`cwd: \`${result.cwd}\``,
				`command: \`${[result.command, ...result.args].join(" ")}\``,
				result.stdout.trim() ? `stdout:\n\n\`\`\`\n${truncate(result.stdout.trim(), 6000)}\n\`\`\`` : undefined,
				result.stderr.trim() ? `stderr:\n\n\`\`\`\n${truncate(result.stderr.trim(), 6000)}\n\`\`\`` : undefined,
			].filter(Boolean).join("\n\n"));
		}
	} else {
		sections.push("## Commands\nNo automatic commands selected.");
	}
	return sections.filter(Boolean).join("\n\n");
}

async function validateTarget(pi: ExtensionAPI, ctx: ExtensionContext, targetArg: string): Promise<void> {
	const target = targetArg.trim() || "current";
	const root = await repoRoot(ctx.cwd);
	if (!root) {
		pi.sendMessage({ customType: CUSTOM_TYPE, content: "# Scheduler validation failed\n\nNot inside a git repository.", display: true });
		return;
	}

	if (target === "current") {
		const affectedPaths = await currentChangedPaths(root);
		const profile = await resolveSchedulerProfile(root, affectedPaths);
		const plan = buildValidationPlan(root, affectedPaths, profile);
		const results = await runValidationCommands(plan.commands, ctx.signal, (line) => ctx.ui.notify(line, "info"));
		pi.sendMessage({ customType: CUSTOM_TYPE, content: formatValidation(`current (${profile.displayName})`, plan, results), display: true, details: { target, plan, results, profile: profile.id } });
		return;
	}

	const patchPath = expandUserPath(target, ctx.cwd);
	if (!fs.existsSync(patchPath)) {
		pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler validation failed\n\nPatch not found: \`${patchPath}\``, display: true });
		return;
	}

	const patchText = await fs.promises.readFile(patchPath, "utf8");
	const affectedPaths = extractPatchPathsFromText(patchText);
	const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-scheduler-validate-"));
	const worktreeRoot = path.join(tmpRoot, "worktree");
	try {
		const add = await gitCapture(root, ["worktree", "add", "--detach", worktreeRoot, "HEAD"], ctx.signal);
		if (add.code !== 0) {
			pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler validation failed\n\nCould not create validation worktree.\n\n\`\`\`\n${add.stderr}\n\`\`\``, display: true });
			return;
		}
		const apply = await gitCapture(worktreeRoot, ["apply", patchPath], ctx.signal);
		if (apply.code !== 0) {
			pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler validation failed\n\nPatch did not apply in validation worktree.\n\n\`\`\`\n${apply.stderr || apply.stdout}\n\`\`\``, display: true });
			return;
		}
		const profile = await resolveSchedulerProfile(worktreeRoot, affectedPaths);
		const plan = buildValidationPlan(worktreeRoot, affectedPaths, profile);
		const results = await runValidationCommands(plan.commands, ctx.signal, (line) => ctx.ui.notify(line, "info"));
		pi.sendMessage({ customType: CUSTOM_TYPE, content: formatValidation(`${patchPath} (${profile.displayName})`, plan, results), display: true, details: { target: patchPath, plan, results, profile: profile.id } });
	} finally {
		if (fs.existsSync(worktreeRoot)) await gitCapture(root, ["worktree", "remove", "--force", worktreeRoot]).catch(() => undefined);
		await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function applyPatch(pi: ExtensionAPI, ctx: ExtensionContext, patchArg: string): Promise<void> {
	const patchPath = expandUserPath(patchArg.trim(), ctx.cwd);
	if (!fs.existsSync(patchPath)) {
		pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler apply failed\n\nPatch not found: \`${patchPath}\``, display: true });
		return;
	}

	const [stat, check] = await Promise.all([
		gitCapture(ctx.cwd, ["apply", "--stat", patchPath]).catch((error) => ({ code: 1, stdout: "", stderr: String(error) })),
		gitCapture(ctx.cwd, ["apply", "--check", patchPath]).catch((error) => ({ code: 1, stdout: "", stderr: String(error) })),
	]);

	if (check.code !== 0) {
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: [`# Scheduler apply check failed`, `Patch: \`${patchPath}\``, "```", check.stderr.trim() || check.stdout.trim() || "git apply --check failed", "```"].join("\n\n"),
			display: true,
		});
		return;
	}

	const preview = truncate([`Patch: ${patchPath}`, "", stat.stdout.trim() || "(no stat output)"].join("\n"), 6000);
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Apply scheduler patch?", preview);
		if (!ok) {
			ctx.ui.notify("Patch apply canceled", "warning");
			return;
		}
	}

	const apply = await gitCapture(ctx.cwd, ["apply", patchPath]);
	const parentStat = await parentDiffStat(ctx.cwd);
	const content = apply.code === 0
		? [`# Scheduler patch applied`, `Patch: \`${patchPath}\``, `## Applied stat`, "```", stat.stdout.trim() || "(no stat output)", "```", parentStat ? `## Parent diff stat\n\n\`\`\`\n${parentStat}\n\`\`\`` : undefined].filter(Boolean).join("\n\n")
		: [`# Scheduler apply failed`, `Patch: \`${patchPath}\``, "```", apply.stderr.trim() || apply.stdout.trim() || "git apply failed", "```"].join("\n\n");
	pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true, details: { patchPath, parentStat } });
}

function autopilotRejection(route: RouteDecision, summary: RouteRunSummary, patchText: string, parentClean: boolean, profile: SchedulerProfile): string | undefined {
	if (route.kind !== profile.autopilot.route || route.explicit) return `autopilot only auto-applies high-confidence non-explicit ${profile.autopilot.route} routes`;
	if (route.reason !== "high-confidence mechanical scoped edit") return "route was not classified as a high-confidence mechanical scoped edit";
	if (summary.status !== "completed") return `route status is ${summary.status}`;
	if (!parentClean) return "parent working tree is not clean";
	if (summary.patchPaths.length !== 1) return `expected exactly one patch, got ${summary.patchPaths.length}`;
	const result = summary.results.find((item) => item.patchPath === summary.patchPaths[0]);
	if (!result) return "patch-producing result was not found";
	if (result.applyCheckExitCode !== 0) return "patch does not cleanly apply to parent";
	if (result.generatedBlockedPaths && result.generatedBlockedPaths.length > 0) return "patch touches blocked generated/output paths";
	if (result.submoduleWarning) return "patch has submodule warnings";
	if (result.generatedWarning) return "patch has generated-file warnings";
	if (result.baseWarning) return "route has parent-base warning";
	const size = patchSize(patchText);
	if (size.files > profile.autopilot.maxFiles) return `patch touches ${size.files} files (limit ${profile.autopilot.maxFiles})`;
	if (size.changedLines > profile.autopilot.maxChangedLines) return `patch changes ${size.changedLines} lines (limit ${profile.autopilot.maxChangedLines})`;
	return undefined;
}

async function runCautiousAutopilot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	route: RouteDecision,
): Promise<{ handled: boolean; summary?: RouteRunSummary }> {
	const changedPaths = await currentChangedPaths(ctx.cwd).catch(() => []);
	const profile = await resolveSchedulerProfile(ctx.cwd, changedPaths);
	const parentCleanBefore = await isParentTreeClean(ctx.cwd, ctx.signal);
	if (!parentCleanBefore) return { handled: false };

	ctx.ui.notify(`${profile.displayName} cautious autopilot running ${profile.autopilot.route} route`, "info");
	const summary = await runRouteWithUi(pi, ctx, route);
	const patchPath = summary.patchPaths[0];
	const patchText = patchPath && fs.existsSync(patchPath) ? await fs.promises.readFile(patchPath, "utf8") : "";
	const parentCleanAfter = await isParentTreeClean(ctx.cwd, ctx.signal);
	const rejection = autopilotRejection(route, summary, patchText, parentCleanBefore && parentCleanAfter, profile);
	if (rejection) {
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: `# Scheduler autopilot stopped\n\nReason: ${rejection}\n\nPatch was not applied automatically. Use \`/scheduler apply ${patchPath ?? "<patch>"}\` after review if appropriate.`,
			display: true,
			details: { route, summary, rejection },
		});
		return { handled: true, summary };
	}

	const appliedPatchPath = patchPath as string;
	const stat = await gitCapture(ctx.cwd, ["apply", "--stat", appliedPatchPath]);
	const apply = await gitCapture(ctx.cwd, ["apply", appliedPatchPath], ctx.signal);
	const parentStat = await parentDiffStat(ctx.cwd, ctx.signal);
	if (apply.code !== 0) {
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: [`# Scheduler autopilot apply failed`, `Patch: \`${appliedPatchPath}\``, "```", apply.stderr.trim() || apply.stdout.trim() || "git apply failed", "```"].join("\n\n"),
			display: true,
			details: { route, summary, patchPath: appliedPatchPath },
		});
		return { handled: true, summary: { ...summary, status: "failed", parentStat } };
	}

	pi.sendMessage({
		customType: CUSTOM_TYPE,
		content: [
			"# Scheduler autopilot applied patch",
			`Patch: \`${appliedPatchPath}\``,
			"## Applied stat",
			"```",
			stat.stdout.trim() || "(no stat output)",
			"```",
			parentStat ? `## Parent diff stat\n\n\`\`\`\n${parentStat}\n\`\`\`` : undefined,
		].filter(Boolean).join("\n\n"),
		display: true,
		details: { route, summary, patchPath: appliedPatchPath, parentStat },
	});

	await validateTarget(pi, ctx, "current");
	return { handled: true, summary: { ...summary, parentStat } };
}

interface SessionEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

interface SessionManagerLike {
	getBranch?: () => unknown;
}

function isSessionEntry(value: unknown): value is SessionEntry {
	return typeof value === "object" && value !== null;
}

function isSchedulerState(value: unknown): value is SchedulerState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return (state.mode === "auto" || state.mode === "off") &&
		typeof state.classifierEnabled === "boolean" &&
		(state.autopilotMode === "off" || state.autopilotMode === "cautious");
}

function isRouteRecord(value: unknown): value is RouteRecord {
	return typeof value === "object" && value !== null;
}
export default function scheduler(pi: ExtensionAPI) {
	let mode: SchedulerMode = "off";
	let autopilotMode: AutopilotMode = "off";
	let classifierEnabled = false;
	let routeHistory: RouteRecord[] = [];

	const restoreState = async (ctx: { cwd: string; sessionManager?: SessionManagerLike }) => {
		const profile = await resolveSchedulerProfile(ctx.cwd);
		mode = profile.defaultMode;
		autopilotMode = profile.autopilot.mode;
		classifierEnabled = false;
		routeHistory = [];
		const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const entries = Array.isArray(branch) ? branch : [];
		for (const rawEntry of entries) {
			if (!isSessionEntry(rawEntry)) continue;
			if (rawEntry.type === "custom" && rawEntry.customType === STATE_TYPE && isSchedulerState(rawEntry.data)) {
				mode = rawEntry.data.mode;
				autopilotMode = rawEntry.data.autopilotMode;
				classifierEnabled = rawEntry.data.classifierEnabled;
			}
			if (rawEntry.type === "custom" && rawEntry.customType === ROUTE_RECORD_TYPE && isRouteRecord(rawEntry.data)) {
				routeHistory.push(rawEntry.data);
			}
		}
		routeHistory = routeHistory.slice(-20);
	};

	const persistState = () => {
		pi.appendEntry<SchedulerState>(STATE_TYPE, { mode, classifierEnabled, autopilotMode });
	};

	const recordRoute = (route: RouteDecision, summary: RouteRunSummary) => {
		const record: RouteRecord = {
			timestamp: Date.now(),
			route,
			status: summary.status,
			patchPaths: summary.patchPaths,
			validationHints: summary.validationHints,
			parentStat: summary.parentStat,
		};
		routeHistory.push(record);
		routeHistory = routeHistory.slice(-20);
		pi.appendEntry<RouteRecord>(ROUTE_RECORD_TYPE, record);
	};

	pi.registerMessageRenderer(CUSTOM_TYPE, (message) => new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme()));

	pi.registerCommand("scheduler", {
		description: "Control or invoke the active scheduler profile: /scheduler on|off|status|autopilot|last|apply|validate|classify|<route> <task>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const profile = await resolveSchedulerProfile(ctx.cwd);
			const arg = trimmed.toLowerCase();
			if (arg === "on" || arg === "auto") {
				mode = "auto";
				persistState();
				ctx.ui.notify(`${profile.displayName} enabled`, "info");
				return;
			}
			if (arg === "off") {
				mode = "off";
				persistState();
				ctx.ui.notify(`${profile.displayName} disabled`, "info");
				return;
			}
			const autopilotMatch = trimmed.match(/^autopilot\s+(off|cautious|status)$/i);
			if (autopilotMatch) {
				const value = autopilotMatch[1].toLowerCase() as AutopilotMode | "status";
				if (value === "off" || value === "cautious") {
					autopilotMode = value;
					persistState();
				}
				ctx.ui.notify(`Scheduler autopilot: ${autopilotMode}`, "info");
				return;
			}
			if (arg === "last") {
				pi.sendMessage({ customType: CUSTOM_TYPE, content: formatLast(routeHistory[routeHistory.length - 1]), display: true });
				return;
			}
			const classifyMatch = trimmed.match(/^classif(?:y|ier)\s+(on|off|status)$/i);
			if (classifyMatch) {
				const value = classifyMatch[1].toLowerCase();
				if (value === "on") classifierEnabled = true;
				if (value === "off") classifierEnabled = false;
				if (value !== "status") persistState();
				ctx.ui.notify(`Scheduler classifier: ${classifierEnabled ? "on" : "off"}`, "info");
				return;
			}
			const applyMatch = trimmed.match(/^apply\s+([\s\S]+)$/i);
			if (applyMatch) {
				await applyPatch(pi, ctx, applyMatch[1]);
				return;
			}
			const validateMatch = trimmed.match(/^validate(?:\s+([\s\S]+))?$/i);
			if (validateMatch) {
				await validateTarget(pi, ctx, validateMatch[1] ?? "current");
				return;
			}

			const explicit = trimmed.match(/^(\S+)\s+([\s\S]+)$/i);
			if (explicit) {
				const definition = resolveRouteDefinition(profile, explicit[1].toLowerCase(), explicit[2].trim(), true, []);
				if (definition) {
					const route: RouteDecision = { kind: definition.name, task: explicit[2].trim(), reason: "explicit /scheduler command", explicit: true };
					ctx.ui.setStatus("scheduler", `scheduler:${route.kind}`);
					ctx.ui.notify(`${profile.displayName} routing to ${route.kind}`, "info");
					try {
						const summary = await runRouteWithUi(pi, ctx, route);
						recordRoute(route, summary);
					} finally {
						ctx.ui.setStatus("scheduler", mode === "auto" ? "scheduler:auto" : undefined);
					}
					return;
				}
			}

			ctx.ui.notify(
				`${profile.displayName}: ${mode}; autopilot: ${autopilotMode}; classifier: ${classifierEnabled ? "on" : "off"}. Use direct: <task>, /scheduler autopilot off|cautious|status, /scheduler last, /scheduler apply <patch>, /scheduler validate [current|patch], or /scheduler ${routeNames(profile).join("|")} <task>.`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreState(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("scheduler", mode === "auto" ? "scheduler:auto" : undefined);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreState(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("scheduler", mode === "auto" ? "scheduler:auto" : undefined);
	});

	pi.on("input", async (event, ctx) => {
		if (process.env.PI_SCHEDULER_CHILD === "1") return { action: "continue" as const };
		if (event.source === "extension") return { action: "continue" as const };
		if (event.streamingBehavior) return { action: "continue" as const };
		if (event.images && event.images.length > 0) return { action: "continue" as const };

		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" as const };
		const direct = stripPrefix(text, "direct");
		if (direct !== undefined) return { action: "transform" as const, text: direct };

		if (ctx.mode !== "tui" || mode !== "auto") return { action: "continue" as const };
		const changedPaths = await currentChangedPaths(ctx.cwd).catch(() => []);
		const profile = await resolveSchedulerProfile(ctx.cwd, changedPaths);
		let route = classify(text, profile);
		if (route) {
			const definition = resolveRouteDefinition(profile, route.kind, text, false, changedPaths);
			if (!definition) route = undefined;
		}
		if (!route && classifierEnabled) {
			ctx.ui.notify(`${profile.displayName} classifier checking ambiguous prompt...`, "info");
			const decision = await classifyWithCheapModel(ctx.cwd, text, profile, ctx.signal);
			if (decision && decision.route !== "inline" && decision.confidence >= profile.classifier.threshold) {
				const definition = resolveRouteDefinition(profile, decision.route, text, false, changedPaths);
				if (definition) {
					route = { kind: definition.name, task: text, reason: `classifier: ${decision.reason} (${decision.confidence.toFixed(2)})`, explicit: false };
				}
			}
		}
		if (!route) return { action: "continue" as const };

		if (autopilotMode === "cautious" && route.kind === profile.autopilot.route && !route.explicit && route.reason === "high-confidence mechanical scoped edit") {
			ctx.ui.setStatus("scheduler", "scheduler:autopilot");
			try {
				const autopilot = await runCautiousAutopilot(pi, ctx, route);
				if (autopilot.summary) recordRoute(route, autopilot.summary);
				if (autopilot.handled) return { action: "handled" as const };
			} finally {
				ctx.ui.setStatus("scheduler", "scheduler:auto");
			}
		}

		const ok = await ctx.ui.confirm(
			"Scheduler route?",
			`Route: ${route.kind}\nReason: ${route.reason}\n\nRun via scheduler instead of the parent model?`,
		);
		if (!ok) return { action: "continue" as const };

		ctx.ui.setStatus("scheduler", `scheduler:${route.kind}`);
		ctx.ui.notify(`Scheduler routing to ${route.kind}: ${route.reason}`, "info");
		try {
			const summary = await runRouteWithUi(pi, ctx, route);
			recordRoute(route, summary);
		} finally {
			ctx.ui.setStatus("scheduler", "scheduler:auto");
		}

		return { action: "handled" as const };
	});
}
