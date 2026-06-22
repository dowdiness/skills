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

type RouteKind =
	| "mechanic"
	| "scout"
	| "moonbit-scout"
	| "plan"
	| "moonbit-plan"
	| "review"
	| "moonbit-review"
	| "ensemble-review"
	| "parallel-review"
	| "review-router"
	| "implement"
	| "worker";
type SchedulerMode = "auto" | "off";
type AutopilotMode = "off" | "cautious";
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

interface ValidationCommand {
	label: string;
	command: string;
	args: string[];
	cwd: string;
}

interface ValidationCommandResult extends ValidationCommand {
	code: number;
	stdout: string;
	stderr: string;
}

interface ValidationPlan {
	affectedPaths: string[];
	packageDirs: string[];
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

const CUSTOM_TYPE = "canopy-scheduler";
const STATE_TYPE = "canopy-scheduler-state";
const ROUTE_RECORD_TYPE = "canopy-scheduler-route";
const PATCH_DIR = path.join(getAgentDir(), "scheduler-patches");
const GENERATED_BLOCK_PATTERNS = [
	/^_build\//,
	/(^|\/)node_modules\//,
	/(^|\/)coverage\//,
	/(^|\/)dist\//,
	/(^|\/)\.next\//,
];
const GENERATED_WARN_PATTERNS = [/\.mbti$/, /(^|\/)generated\//, /\.generated\./];
const CLASSIFIER_MODEL = "openai-codex/gpt-5.3-codex-spark:minimal";
const CLASSIFIER_THRESHOLD = 0.72;
const AUTOPILOT_MAX_FILES = 3;
const AUTOPILOT_MAX_CHANGED_LINES = 100;

function isCanopyCwd(cwd: string): boolean {
	const normalized = cwd.replace(/\\/g, "/");
	return normalized.endsWith("/dowdiness/canopy") || normalized.includes("/dowdiness/canopy/");
}

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

function classify(text: string): RouteDecision | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const explicitRoutes: Array<[RouteKind, string, string]> = [
		["mechanic", "mechanic", "explicit mechanic prefix"],
		["moonbit-scout", "moonbit-scout", "explicit moonbit-scout prefix"],
		["moonbit-plan", "moonbit-plan", "explicit moonbit-plan prefix"],
		["moonbit-review", "moonbit-review", "explicit moonbit-review prefix"],
		["scout", "scout", "explicit scout prefix"],
		["plan", "plan", "explicit plan prefix"],
		["review", "review", "explicit review prefix"],
		["ensemble-review", "ensemble-review", "explicit ensemble-review prefix"],
		["parallel-review", "parallel-review", "explicit parallel-review prefix"],
		["review-router", "review-router", "explicit review-router prefix"],
		["implement", "implement", "explicit implement prefix"],
		["worker", "worker", "explicit worker prefix"],
	];

	for (const [kind, prefix, reason] of explicitRoutes) {
		const task = stripPrefix(trimmed, prefix);
		if (task) return { kind, task, reason, explicit: true };
	}

	const lower = trimmed.toLowerCase();

	if (looksMechanical(trimmed) && looksScoped(trimmed)) {
		return { kind: "mechanic", task: trimmed, reason: "high-confidence mechanical scoped edit", explicit: false };
	}

	if (/^(find|locate|where\s+(is|are)|investigate|explore|trace|map)\b/.test(lower)) {
		return { kind: "scout", task: trimmed, reason: "code reconnaissance request", explicit: false };
	}

	if (/^(plan|design|propose)\b/.test(lower) || /\bimplementation plan\b/.test(lower)) {
		return { kind: "plan", task: trimmed, reason: "planning request", explicit: false };
	}

	if (/\bensemble[- ]?review\b/.test(lower) || /\bensemble[- ]?reviewer\b/.test(lower)) {
		return { kind: "ensemble-review", task: trimmed, reason: "ensemble review request", explicit: false };
	}
	if (/\bparallel[- ]?review\b/.test(lower) || /\bparallel[- ]?reviewer\b/.test(lower) || /\bmultiple (cheap )?reviewers?\b/.test(lower)) {
		return { kind: "parallel-review", task: trimmed, reason: "parallel review request", explicit: false };
	}
	if (/\breview[- ]?router\b/.test(lower)) {
		return { kind: "review-router", task: trimmed, reason: "review router request", explicit: false };
	}
	if (/^(review|audit)\b/.test(lower) || /\b(pre-merge|premerge|code review)\b/.test(lower)) {
		return { kind: "review", task: trimmed, reason: "review request", explicit: false };
	}

	if (/^(implement|add|fix|refactor)\b/.test(lower) && /\b(across|multiple files|end-to-end|delegate|scheduler)\b/.test(lower)) {
		return { kind: "implement", task: trimmed, reason: "larger implementation request", explicit: false };
	}

	return undefined;
}

function isEditingRoute(kind: RouteKind): boolean {
	return kind === "mechanic" || kind === "worker" || kind === "implement";
}

function looksMoonBitTask(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		/\.mbt\b|\.mbti\b|moonbit|moon\.pkg|moon\.mod\.json|moon\.work/.test(lower) ||
		/\b(moon check|moon test|moon info|moon fmt|moon prove|moon ide)\b/.test(lower) ||
		/\b(pub struct|trait bound|package root|module root|existing api first|parser|lowering|projection)\b/.test(lower)
	);
}

async function routeUsesMoonBit(cwd: string, task: string): Promise<boolean> {
	if (looksMoonBitTask(task)) return true;
	const changedPaths = await currentChangedPaths(cwd).catch(() => []);
	return changedPaths.some((filePath) =>
		filePath.endsWith(".mbt") ||
		filePath.endsWith(".mbti") ||
		filePath.endsWith("moon.pkg") ||
		filePath.endsWith("moon.mod.json") ||
		filePath.endsWith("moon.work"),
	);
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
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const abort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) proc.kill("SIGKILL");
			}, 2500).unref?.();
		};

		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => settle({ code: code ?? 0, stdout, stderr }));
		proc.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
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

function assessGeneratedPaths(paths: string[]): { blocked: string[]; warnings: string[] } {
	const blocked = paths.filter((filePath) => GENERATED_BLOCK_PATTERNS.some((pattern) => pattern.test(filePath)));
	const warningPaths = paths.filter((filePath) => GENERATED_WARN_PATTERNS.some((pattern) => pattern.test(filePath)));
	const warnings = warningPaths.map((filePath) => `${filePath} looks generated; prefer regenerating it in the parent checkout when possible.`);
	return { blocked, warnings };
}

function findRepoRootSync(cwd: string): string {
	let current = cwd;
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return cwd;
		current = parent;
	}
}

function findMoonPackageDirs(cwd: string, affectedPaths: string[]): string[] {
	const root = findRepoRootSync(cwd);
	const packageDirs = new Set<string>();
	for (const affectedPath of affectedPaths) {
		if (!affectedPath.endsWith(".mbt") && !affectedPath.endsWith("moon.pkg")) continue;
		let current = path.dirname(path.join(root, affectedPath));
		if (affectedPath.endsWith("moon.pkg")) current = path.join(root, path.dirname(affectedPath));
		while (current.startsWith(root)) {
			if (fs.existsSync(path.join(current, "moon.pkg"))) {
				const relative = path.relative(root, current) || ".";
				packageDirs.add(relative);
				break;
			}
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return Array.from(packageDirs).sort();
}

function findMoonModuleRoots(cwd: string, affectedPaths: string[]): string[] {
	const root = findRepoRootSync(cwd);
	const moduleRoots = new Set<string>();
	for (const affectedPath of affectedPaths) {
		let current = path.dirname(path.join(root, affectedPath));
		if (affectedPath.endsWith("moon.mod.json") || affectedPath.endsWith("moon.work")) current = path.dirname(path.join(root, affectedPath));
		while (current.startsWith(root)) {
			if (fs.existsSync(path.join(current, "moon.mod.json"))) {
				const relative = path.relative(root, current) || ".";
				moduleRoots.add(relative);
				break;
			}
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	if (moduleRoots.size === 0 && fs.existsSync(path.join(root, "moon.mod.json"))) moduleRoots.add(".");
	return Array.from(moduleRoots).sort();
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

async function runPromptNoTools(cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-tools",
		"--model",
		CLASSIFIER_MODEL,
		prompt,
	];
	let output = "";
	await new Promise<void>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SCHEDULER_CHILD: "1" },
		});
		let buffer = "";
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		const abort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) proc.kill("SIGKILL");
			}, 2500).unref?.();
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
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
	});
	return output;
}

function parseClassifierJson(output: string): ClassifierDecision | undefined {
	const stripped = output.replace(/```(?:json)?/g, "```").replace(/```/g, "");
	const match = stripped.match(/\{[\s\S]*\}/);
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]) as { route?: unknown; confidence?: unknown; reason?: unknown };
		if (typeof parsed.route !== "string") return undefined;
		const route = parsed.route as ClassifierRoute;
		if (!["inline", "mechanic", "scout", "moonbit-scout", "plan", "moonbit-plan", "review", "moonbit-review", "ensemble-review", "parallel-review", "review-router", "implement", "worker"].includes(route)) return undefined;
		const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
		const reason = typeof parsed.reason === "string" ? parsed.reason : "classifier";
		return { route, confidence, reason };
	} catch {
		return undefined;
	}
}

async function classifyWithCheapModel(cwd: string, text: string, signal?: AbortSignal): Promise<ClassifierDecision | undefined> {
	const prompt = [
		"Classify this coding-agent user request for a hard task scheduler.",
		"Return only compact JSON with keys route, confidence, reason.",
		"Routes:",
		"- inline: small judgment-heavy task or unclear request",
		"- mechanic: tightly scoped rote edit/rename/import/path migration with exact files/patterns",
		"- scout: broad non-MoonBit codebase reconnaissance only",
		"- moonbit-scout: MoonBit/Canopy reconnaissance involving .mbt, moon.pkg, moon.mod.json, .mbti, moon ide, package boundaries, parser/lowering/projection code",
		"- plan: non-MoonBit planning/design request without implementation",
		"- moonbit-plan: MoonBit/Canopy planning/design request without implementation",
		"- review: non-MoonBit code review/audit request",
		"- moonbit-review: MoonBit/Canopy code review/audit request",
		"- ensemble-review: quick multi-model review using three cheap reviewers",
		"- parallel-review: thorough pre-merge review using four specialized reviewers",
		"- review-router: let the router choose between ensemble-review and parallel-review",
		"- implement: larger implementation needing scout then plan then worker",
		"- worker: explicit implementation by worker only",
		"Prefer inline unless confidence is high. Do not route UI/visual iteration.",
		"",
		`Request: ${text}`,
	].join("\n");
	const output = await runPromptNoTools(cwd, prompt, signal);
	return parseClassifierJson(output);
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

	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | undefined;
	let tmpPrompt: string | undefined;
	if (agent.systemPrompt.trim()) {
		const tmp = await writePrompt(agent.name, agent.systemPrompt);
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

	try {
		onProgress?.(`${agent.name}: starting`);
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SCHEDULER_CHILD: "1" },
			});

			let buffer = "";
			let wasAborted = false;
			let settled = false;
			const abort = () => {
				wasAborted = true;
				onProgress?.(`${agent.name}: abort requested`);
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!settled) proc.kill("SIGKILL");
				}, 5000).unref?.();
			};

			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start") onProgress?.(`${agent.name}: → ${event.toolName ?? "tool"}`);

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					messages.push(msg);
					const summary = summarizeMessage(msg);
					if (summary) onProgress?.(`${agent.name}: ${summary}`);
					if (msg.role === "assistant") {
						if (msg.model) model = msg.model;
						if (msg.stopReason) stopReason = msg.stopReason;
						if (msg.errorMessage) errorMessage = msg.errorMessage;
					}
				}
				if (event.type === "tool_result_end" && event.message) {
					messages.push(event.message as Message);
					onProgress?.(`${agent.name}: tool result`);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				settled = true;
				if (buffer.trim()) processLine(buffer);
				resolve(wasAborted ? 130 : (code ?? 0));
			});
			proc.on("error", () => {
				settled = true;
				resolve(1);
			});
		});

		if (signal?.aborted) {
			return {
				agent: agent.name,
				task,
				exitCode: 130,
				messages,
				stderr,
				output: getFinalOutput(messages),
				model,
				stopReason: "aborted",
				errorMessage: "Scheduler route aborted",
			};
		}

		onProgress?.(`${agent.name}: finished with exit ${exitCode}`);
		return { agent: agent.name, task, exitCode, messages, stderr, output: getFinalOutput(messages), model, stopReason, errorMessage };
	} finally {
		if (tmpPrompt) await fs.promises.unlink(tmpPrompt).catch(() => undefined);
		if (tmpDir) await fs.promises.rmdir(tmpDir).catch(() => undefined);
	}
}

async function runAgentInWorktree(
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
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
		const generated = assessGeneratedPaths(result.patchPaths);
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
		if (fs.existsSync(worktreeRoot)) await gitCapture(repoRoot, ["worktree", "remove", "--force", worktreeRoot], signal).catch(() => undefined);
		await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function runRoute(cwd: string, route: RouteDecision, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<StepResult[]> {
	const agents = loadAgents();
	const results: StepResult[] = [];
	let previous = "";

	const runStep = async (agent: string, taskTemplate: string, isolate = false) => {
		if (signal?.aborted) {
			const aborted: StepResult = { agent, task: taskTemplate, exitCode: 130, messages: [], stderr: "", output: "", stopReason: "aborted", errorMessage: "Scheduler route aborted before this step started" };
			results.push(aborted);
			return aborted;
		}

		const task = taskTemplate.replace(/\{previous\}/g, () => previous);
		onProgress?.(`${agent}: queued${isolate ? " in isolated worktree" : ""}`);
		const result = isolate
			? await runAgentInWorktree(cwd, agents, agent, task, signal, onProgress)
			: await runAgent(cwd, agents, agent, task, signal, onProgress);
		results.push(result);
		previous = result.output || result.stderr || result.errorMessage || "";
		return result;
	};

	const useMoonBit = await routeUsesMoonBit(cwd, route.task);
	const scoutAgent = route.kind === "scout" && route.explicit ? "scout" : useMoonBit ? "moonbit-scout" : "scout";
	const plannerAgent = route.kind === "plan" && route.explicit ? "planner" : useMoonBit ? "moonbit-planner" : "planner";
	const reviewerAgent = route.kind === "review" && route.explicit ? "reviewer" : useMoonBit ? "moonbit-reviewer" : "reviewer";
	const reviewContext = async () => {
		const [changedPaths, diffStat] = await Promise.all([
			currentChangedPaths(cwd).catch(() => []),
			parentDiffStat(cwd).catch(() => undefined),
		]);
		return [
			"Patch path: (not applicable; review routes inspect the current working tree)",
			changedPaths.length > 0 ? `Changed files:\n${changedPaths.map((filePath) => `- ${filePath}`).join("\n")}` : "Changed files: (none)",
			diffStat ? `Current diff stat:\n\n${diffStat}` : "Current diff stat: (unavailable)",
		].join("\n\n");
	};

	switch (route.kind) {
		case "mechanic":
			await runStep("mechanic", route.task, true);
			break;
		case "scout":
			await runStep(scoutAgent, route.task);
			break;
		case "moonbit-scout":
			await runStep("moonbit-scout", route.task);
			break;
		case "review": {
			const context = await reviewContext();
			await runStep(reviewerAgent, `${route.task}\n\nReview context:\n${context}`);
			break;
		}
		case "moonbit-review": {
			const context = await reviewContext();
			await runStep("moonbit-reviewer", `${route.task}\n\nReview context:\n${context}`);
			break;
		}
		case "ensemble-review": {
			const context = await reviewContext();
			await runStep("ensemble-reviewer", `${route.task}\n\nReview context:\n${context}`);
			break;
		}
		case "parallel-review": {
			const context = await reviewContext();
			await runStep("parallel-reviewer", `${route.task}\n\nReview context:\n${context}`);
			break;
		}
		case "review-router": {
			const context = await reviewContext();
			await runStep("review-router", `${route.task}\n\nReview context:\n${context}`);
			break;
		}
		case "worker":
			await runStep("worker", route.task, true);
			break;
		case "plan":
			await runStep(scoutAgent, `Find code relevant to this planning request:\n\n${route.task}`);
			if (results[results.length - 1].exitCode === 0) await runStep(plannerAgent, `Create an implementation plan for this request:\n\n${route.task}\n\nScout context:\n{previous}`);
			break;
		case "moonbit-plan":
			await runStep("moonbit-scout", `Find MoonBit/Canopy code relevant to this planning request:\n\n${route.task}`);
			if (results[results.length - 1].exitCode === 0) await runStep("moonbit-planner", `Create a MoonBit/Canopy implementation plan for this request:\n\n${route.task}\n\nScout context:\n{previous}`);
			break;
		case "implement":
			await runStep(scoutAgent, `Find code relevant to this implementation request:\n\n${route.task}`);
			if (results[results.length - 1].exitCode === 0) await runStep(plannerAgent, `Create an implementation plan for this request:\n\n${route.task}\n\nScout context:\n{previous}`);
			if (results[results.length - 1].exitCode === 0) {
				await runStep("worker", `Implement this request in the isolated worktree using the plan/context below.\n\nOriginal request:\n${route.task}\n\nPlan/context:\n{previous}`, true);
			}
			if (useMoonBit && results[results.length - 1].exitCode === 0) {
				const workerResult = results[results.length - 1];
				let workerPatchApplied = false;
				if (!workerResult.patchPath) {
					onProgress?.("moonbit-refactor: skipped because worker produced no patch");
				} else if (workerResult.applyCheckExitCode !== 0) {
					onProgress?.("moonbit-refactor: skipped because worker patch is not cleanly applicable to parent");
				} else {
					const parentStatus = await gitCapture(cwd, ["status", "--short"], signal).catch(() => undefined);
					if (parentStatus?.stdout.trim()) {
						onProgress?.("moonbit-refactor: skipped because parent working tree has uncommitted changes");
					} else {
						const apply = await gitCapture(cwd, ["apply", workerResult.patchPath], signal).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
						workerPatchApplied = apply.code === 0;
						if (workerPatchApplied) workerResult.patchPath = undefined;
						onProgress?.(workerPatchApplied ? "moonbit-refactor: applied worker patch to parent checkout" : "moonbit-refactor: skipped because applying worker patch failed");
					}
				}
				if (workerPatchApplied) {
					await runStep("moonbit-refactor", `Read the full moonbit-refactoring skill at ~/.agents/skills/moonbit-refactoring/SKILL.md, then apply its guidelines to the files that were just changed. Run moon check and affected moon test commands to validate.\n\nOriginal request:\n${route.task}\n\nPrevious step output (includes Files Changed):\n{previous}`);
				}
				if (workerPatchApplied && results[results.length - 1].exitCode === 0) {
					const context = await reviewContext();
					await runStep("ensemble-reviewer", `Review the full implementation including refactoring. Focus on MoonBit correctness, Existing API First, package boundaries, .mbti drift, and validation readiness.\n\nOriginal request:\n${route.task}\n\n${context}\n\nPrevious step output:\n{previous}`);
				}
				if (workerPatchApplied && results[results.length - 1].exitCode === 0) {
					await runStep("worker", `Address only high-confidence actionable findings from the ensemble review. If the review has no Critical/Warnings/actionable findings, do not edit files; report that no follow-up changes were needed. Re-read the affected files before editing, preserve the intended behavior, keep the fix minimal, and run the lightest relevant validation. Include ## Files Changed with exact paths.\n\nOriginal request:\n${route.task}\n\nEnsemble review output:\n{previous}`);
				}
			}
			break;
	}

	return results;
}

function collectPatchPaths(results: StepResult[]): string[] {
	return results.flatMap((result) => result.patchPath ? [result.patchPath] : []);
}

function collectAffectedPaths(results: StepResult[]): string[] {
	return Array.from(new Set(results.flatMap((result) => result.patchPaths ?? []))).sort();
}

function validationHints(route: RouteDecision, results: StepResult[], cwd: string): string[] {
	if (!isEditingRoute(route.kind)) return [];
	const patchPaths = collectPatchPaths(results);
	const affected = collectAffectedPaths(results);
	const packageDirs = findMoonPackageDirs(cwd, affected);
	const hints = new Set<string>();
	if (patchPaths.length > 0) hints.add(`Preview/apply with /scheduler apply ${patchPaths[patchPaths.length - 1]}`);
	hints.add("Inspect git diff --stat after applying the patch.");
	if (affected.some((filePath) => filePath.endsWith(".mbt") || filePath.endsWith("moon.pkg") || filePath.endsWith("moon.mod.json") || filePath.endsWith("moon.work"))) {
		hints.add("Run moon check.");
		if (affected.some((filePath) => filePath.endsWith("moon.mod.json") || filePath.endsWith("moon.work")) || packageDirs.length === 0 || packageDirs.length > 4) {
			hints.add("Run moon test at the workspace root.");
		} else {
			hints.add(`Run moon test in affected package dir(s): ${packageDirs.join(", ")}.`);
		}
		hints.add("Run moon fmt && moon info before committing; inspect .mbti diffs for unintended API changes.");
	}
	if (affected.some((filePath) => /(^|\/)examples\/(web|demo-react|prosemirror|canvas\/web)\//.test(filePath) || /\.(ts|tsx|css|html)$/.test(filePath))) {
		hints.add("If web/TS is affected, run moon build --target js and the relevant npm typecheck/e2e command from CI.");
	}
	if (affected.some((filePath) => filePath.startsWith("docs/") && filePath.endsWith(".md"))) hints.add("Review docs for drift; docs-only patches may not require moon test.");
	if (results.some((result) => result.generatedWarning)) hints.add("Patch touches generated-looking files; prefer regenerating artifacts in the parent checkout when possible.");
	if (results.some((result) => result.submoduleWarning)) hints.add("For submodule changes, commit and push inside the submodule before updating the parent pointer.");
	return Array.from(hints);
}

function formatResults(route: RouteDecision, results: StepResult[], hints: string[], parentStat?: string): string {
	const failed = results.find((result) => result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted");
	const status = failed ? "failed" : "completed";
	const sections = [`# Scheduler ${status}`, `Route: **${route.kind}** (${route.reason})`, `Task: ${route.task}`];

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
			result.patchPath ? `Patch: \`${result.patchPath}\`` : result.isolated ? "Patch: (none produced)" : undefined,
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

	if (isEditingRoute(route.kind)) {
		sections.push([
			"## Parent follow-up",
			"Delegated edits were run in an isolated temporary git worktree. The parent checkout was not modified by the editing agent.",
			"Inspect any patch path above, apply it manually if desired, then run validation in the parent session.",
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
	const progress: string[] = [`route: ${route.kind}`, `reason: ${route.reason}`, "starting…"];
	const pushProgress = (line: string) => {
		progress.push(line);
		if (progress.length > 16) progress.splice(3, progress.length - 16);
	};

	let results: StepResult[] = [];
	let error: unknown;
	let parentStat: string | undefined;

	const execute = async (onProgress: ProgressCallback) => {
		results = await runRoute(ctx.cwd, route, controller.signal, onProgress);
		if (isEditingRoute(route.kind)) parentStat = await parentDiffStat(ctx.cwd, controller.signal);
	};

	if (ctx.mode === "tui") {
		let requestRender = () => {};
		const completed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				done(value);
			};

			requestRender = () => tui.requestRender();
			execute((line) => {
				pushProgress(line);
				requestRender();
			}).then(() => finish(!controller.signal.aborted)).catch((caught) => {
				error = caught;
				finish(!controller.signal.aborted);
			});

			return {
				render(width: number) {
					const fit = (line: string) => (width <= 0 ? "" : truncateToWidth(line, width));
					const header = theme.fg("accent", theme.bold("Canopy scheduler"));
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

		if (!completed) {
			const summary: RouteRunSummary = { status: "aborted", results, patchPaths: collectPatchPaths(results), validationHints: validationHints(route, results, ctx.cwd), parentStat };
			pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler aborted\n\nRoute: **${route.kind}**\n\nChild process termination was requested.`, display: true, details: { route } });
			return summary;
		}
	} else {
		await execute(pushProgress).catch((caught) => {
			error = caught;
		});
	}

	if (error) {
		const message = error instanceof Error ? error.message : String(error);
		const summary: RouteRunSummary = { status: "failed", results, patchPaths: collectPatchPaths(results), validationHints: validationHints(route, results, ctx.cwd), parentStat };
		pi.sendMessage({ customType: CUSTOM_TYPE, content: `# Scheduler failed\n\nRoute: **${route.kind}**\n\n${message}`, display: true, details: { route, error: message } });
		return summary;
	}

	const hints = validationHints(route, results, ctx.cwd);
	const summary: RouteRunSummary = { status: statusFromResults(results), results, patchPaths: collectPatchPaths(results), validationHints: hints, parentStat };
	pi.sendMessage({ customType: CUSTOM_TYPE, content: formatResults(route, results, hints, parentStat), display: true, details: { route, results, parentStat, hints } });
	return summary;
}

async function currentChangedPaths(cwd: string): Promise<string[]> {
	const [unstaged, staged] = await Promise.all([
		gitCapture(cwd, ["diff", "--name-only"]).catch(() => ({ code: 1, stdout: "", stderr: "" })),
		gitCapture(cwd, ["diff", "--cached", "--name-only"]).catch(() => ({ code: 1, stdout: "", stderr: "" })),
	]);
	return Array.from(new Set(`${unstaged.stdout}\n${staged.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean))).sort();
}

function buildValidationPlan(root: string, affectedPaths: string[]): ValidationPlan {
	const warnings: string[] = [];
	const commands: ValidationCommand[] = [];
	const packageDirs = findMoonPackageDirs(root, affectedPaths);
	const moduleRoots = findMoonModuleRoots(root, affectedPaths);
	const hasMoon = affectedPaths.some((filePath) =>
		filePath.endsWith(".mbt") ||
		filePath.endsWith("moon.pkg") ||
		filePath.endsWith("moon.mod.json") ||
		filePath.endsWith("moon.work"),
	);
	const hasTsWeb = affectedPaths.some((filePath) =>
		/(^|\/)examples\/(web|demo-react|prosemirror|canvas\/web)\//.test(filePath) || /\.(ts|tsx|css|html)$/.test(filePath),
	);
	const docsOnly = affectedPaths.length > 0 && affectedPaths.every((filePath) => filePath.startsWith("docs/") && filePath.endsWith(".md"));
	const generated = assessGeneratedPaths(affectedPaths);

	if (generated.blocked.length > 0) warnings.push(`Generated/output paths changed: ${generated.blocked.join(", ")}. Prefer regenerating, not patching, these artifacts.`);
	warnings.push(...generated.warnings);

	if (hasMoon) {
		for (const moduleRoot of moduleRoots) {
			commands.push({ label: `moon check (${moduleRoot})`, command: "moon", args: ["check"], cwd: moduleRoot === "." ? root : path.join(root, moduleRoot) });
		}
		const broad = affectedPaths.some((filePath) => filePath.endsWith("moon.mod.json") || filePath.endsWith("moon.work")) || packageDirs.length === 0 || packageDirs.length > 4;
		if (broad) {
			for (const moduleRoot of moduleRoots) {
				commands.push({ label: `moon test (${moduleRoot})`, command: "moon", args: ["test"], cwd: moduleRoot === "." ? root : path.join(root, moduleRoot) });
			}
		} else {
			for (const packageDir of packageDirs) {
				commands.push({
					label: `moon test (${packageDir})`,
					command: "moon",
					args: ["test"],
					cwd: packageDir === "." ? root : path.join(root, packageDir),
				});
			}
		}
		warnings.push("Run moon fmt && moon info before committing; inspect .mbti diffs for unintended API changes.");
	}

	if (hasTsWeb) warnings.push("TS/web paths changed: build JS first and run the relevant npm typecheck/e2e command from CI when appropriate.");
	if (docsOnly) {
		const docsCheck = path.join(root, "check-docs.sh");
		if (fs.existsSync(docsCheck)) commands.push({ label: "docs check", command: "bash", args: ["check-docs.sh"], cwd: root });
		warnings.push("Docs-only change detected; run check-docs.sh when available.");
	}
	if (commands.length === 0 && warnings.length === 0) warnings.push("No automatic validation commands selected for these paths.");

	return { affectedPaths, packageDirs, commands, warnings };
}

async function runValidationCommands(plan: ValidationPlan, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<ValidationCommandResult[]> {
	const results: ValidationCommandResult[] = [];
	for (const command of plan.commands) {
		onProgress?.(`validate: ${command.label}`);
		const result = await execCapture(command.cwd, command.command, command.args, signal).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
		results.push({ ...command, ...result });
		if (result.code !== 0) break;
	}
	return results;
}

function formatValidation(target: string, plan: ValidationPlan, results: ValidationCommandResult[]): string {
	const failed = results.find((result) => result.code !== 0);
	const sections = [
		`# Scheduler validation ${failed ? "failed" : "completed"}`,
		`Target: ${target}`,
		plan.affectedPaths.length > 0 ? `Affected paths:\n${plan.affectedPaths.map((filePath) => `- \`${filePath}\``).join("\n")}` : "Affected paths: (none)",
		plan.packageDirs.length > 0 ? `MoonBit package dirs:\n${plan.packageDirs.map((dir) => `- \`${dir}\``).join("\n")}` : undefined,
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
		const plan = buildValidationPlan(root, affectedPaths);
		const results = await runValidationCommands(plan, ctx.signal, (line) => ctx.ui.notify(line, "info"));
		pi.sendMessage({ customType: CUSTOM_TYPE, content: formatValidation("current", plan, results), display: true, details: { target, plan, results } });
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
		const plan = buildValidationPlan(worktreeRoot, affectedPaths);
		const results = await runValidationCommands(plan, ctx.signal, (line) => ctx.ui.notify(line, "info"));
		pi.sendMessage({ customType: CUSTOM_TYPE, content: formatValidation(patchPath, plan, results), display: true, details: { target: patchPath, plan, results } });
	} finally {
		if (fs.existsSync(worktreeRoot)) await gitCapture(root, ["worktree", "remove", "--force", worktreeRoot], ctx.signal).catch(() => undefined);
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

function autopilotRejection(route: RouteDecision, summary: RouteRunSummary, patchText: string, parentClean: boolean): string | undefined {
	if (route.kind !== "mechanic" || route.explicit) return "cautious autopilot only auto-applies high-confidence non-explicit mechanic routes";
	if (route.reason !== "high-confidence mechanical scoped edit") return "mechanic route was not classified as high-confidence mechanical scoped edit";
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
	if (size.files > AUTOPILOT_MAX_FILES) return `patch touches ${size.files} files (limit ${AUTOPILOT_MAX_FILES})`;
	if (size.changedLines > AUTOPILOT_MAX_CHANGED_LINES) return `patch changes ${size.changedLines} lines (limit ${AUTOPILOT_MAX_CHANGED_LINES})`;
	return undefined;
}

async function runCautiousAutopilot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	route: RouteDecision,
): Promise<{ handled: boolean; summary?: RouteRunSummary }> {
	const parentCleanBefore = await isParentTreeClean(ctx.cwd, ctx.signal);
	if (!parentCleanBefore) return { handled: false };

	ctx.ui.notify("Scheduler cautious autopilot running mechanic route", "info");
	const summary = await runRouteWithUi(pi, ctx, route);
	const patchPath = summary.patchPaths[0];
	const patchText = patchPath && fs.existsSync(patchPath) ? await fs.promises.readFile(patchPath, "utf8") : "";
	const parentCleanAfter = await isParentTreeClean(ctx.cwd, ctx.signal);
	const rejection = autopilotRejection(route, summary, patchText, parentCleanBefore && parentCleanAfter);
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

export default function canopyScheduler(pi: ExtensionAPI) {
	let mode: SchedulerMode = "auto";
	let autopilotMode: AutopilotMode = "cautious";
	let classifierEnabled = false;
	let routeHistory: RouteRecord[] = [];

	const restoreState = (ctx: { cwd: string; sessionManager?: any }) => {
		mode = isCanopyCwd(ctx.cwd) ? "auto" : "off";
		autopilotMode = "cautious";
		classifierEnabled = false;
		routeHistory = [];
		const entries = ctx.sessionManager?.getBranch?.() ?? [];
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as SchedulerState | undefined;
				if (data?.mode === "auto" || data?.mode === "off") mode = data.mode;
				if (data?.autopilotMode === "off" || data?.autopilotMode === "cautious") autopilotMode = data.autopilotMode;
				if (typeof data?.classifierEnabled === "boolean") classifierEnabled = data.classifierEnabled;
			}
			if (entry.type === "custom" && entry.customType === ROUTE_RECORD_TYPE) {
				routeHistory.push(entry.data as RouteRecord);
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
		description: "Control or invoke the Canopy hard task scheduler: /scheduler on|off|status|autopilot|last|apply|validate|classify|mechanic|scout|moonbit-scout|plan|moonbit-plan|review|moonbit-review|ensemble-review|parallel-review|review-router|implement|worker",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const arg = trimmed.toLowerCase();
			if (arg === "on" || arg === "auto") {
				mode = "auto";
				persistState();
				ctx.ui.notify("Canopy scheduler enabled", "info");
				return;
			}
			if (arg === "off") {
				mode = "off";
				persistState();
				ctx.ui.notify("Canopy scheduler disabled", "info");
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

			const explicit = trimmed.match(/^(mechanic|scout|moonbit-scout|plan|moonbit-plan|review|moonbit-review|ensemble-review|parallel-review|review-router|implement|worker)\s+([\s\S]+)/i);
			if (explicit) {
				const kind = explicit[1].toLowerCase() as RouteKind;
				const task = explicit[2].trim();
				const route: RouteDecision = { kind, task, reason: "explicit /scheduler command", explicit: true };
				ctx.ui.setStatus("scheduler", `scheduler:${route.kind}`);
				ctx.ui.notify(`Scheduler routing to ${route.kind}`, "info");
				try {
					const summary = await runRouteWithUi(pi, ctx, route);
					recordRoute(route, summary);
				} finally {
					ctx.ui.setStatus("scheduler", mode === "auto" && isCanopyCwd(ctx.cwd) ? "scheduler:auto" : undefined);
				}
				return;
			}

			ctx.ui.notify(
				`Canopy scheduler: ${mode}; autopilot: ${autopilotMode}; classifier: ${classifierEnabled ? "on" : "off"}. Use direct: <task>, /scheduler autopilot off|cautious|status, /scheduler last, /scheduler apply <patch>, /scheduler validate [current|patch], or /scheduler mechanic|scout|moonbit-scout|plan|moonbit-plan|review|moonbit-review|ensemble-review|parallel-review|review-router|implement|worker <task>.`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		if (ctx.hasUI && isCanopyCwd(ctx.cwd)) ctx.ui.setStatus("scheduler", mode === "auto" ? "scheduler:auto" : undefined);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
		if (ctx.hasUI && isCanopyCwd(ctx.cwd)) ctx.ui.setStatus("scheduler", mode === "auto" ? "scheduler:auto" : undefined);
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

		if (ctx.mode !== "tui" || mode !== "auto" || !isCanopyCwd(ctx.cwd)) return { action: "continue" as const };

		let route = classify(text);
		if (!route && classifierEnabled) {
			ctx.ui.notify("Scheduler classifier checking ambiguous prompt...", "info");
			const decision = await classifyWithCheapModel(ctx.cwd, text, ctx.signal);
			if (decision && decision.route !== "inline" && decision.confidence >= CLASSIFIER_THRESHOLD) {
				route = { kind: decision.route, task: text, reason: `classifier: ${decision.reason} (${decision.confidence.toFixed(2)})`, explicit: false };
			}
		}
		if (!route) return { action: "continue" as const };

		if (autopilotMode === "cautious" && route.kind === "mechanic" && !route.explicit && route.reason === "high-confidence mechanical scoped edit") {
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
