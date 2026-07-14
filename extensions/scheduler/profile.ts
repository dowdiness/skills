import * as fs from "node:fs";
import * as path from "node:path";

export type SchedulerMode = "auto" | "off";
export type AutopilotMode = "off" | "cautious";

export interface RouteStep {
	agent: string;
	task?: string;
	isolate?: boolean;
	reviewContext?: boolean;
	applyPreviousPatch?: boolean;
}

export interface RouteDefinition {
	name: string;
	aliases: string[];
	description: string;
	editing?: boolean;
	steps: RouteStep[];
}

export interface ClassifierPolicy {
	model: string;
	threshold: number;
	instructions: string[];
}

export interface GeneratedPathPolicy {
	block: string[];
	warn: string[];
}

export interface ValidationCommandSpec {
	label: string;
	command: string;
	args: string[];
	requiredFiles?: string[];
	requiredScript?: string;
	scriptManifest?: string;
}

export interface ValidationRule {
	name: string;
	pathPatterns: string[];
	commands: ValidationCommandSpec[];
	hints: string[];
}

export interface ValidationPolicy {
	rules: ValidationRule[];
	fallbackHint: string;
}

export interface AutopilotPolicy {
	mode: AutopilotMode;
	route: string;
	maxFiles: number;
	maxChangedLines: number;
}

export interface SchedulerProfile {
	id: string;
	displayName: string;
	defaultMode: SchedulerMode;
	routes: RouteDefinition[];
	classifier: ClassifierPolicy;
	generated: GeneratedPathPolicy;
	validation: ValidationPolicy;
	autopilot: AutopilotPolicy;
	resolveRoute?: (route: string, task: string, explicit: boolean, changedPaths: string[]) => RouteDefinition | undefined;
	isEditingRoute(route: string): boolean;
	detect(cwd: string, changedPaths: string[]): Promise<boolean>;
}

const genericRoutes: RouteDefinition[] = [
	{
		name: "mechanic",
		aliases: ["mechanic"],
		description: "tightly scoped rote edit, rename, import, or path migration",
		editing: true,
		steps: [{ agent: "mechanic", isolate: true }],
	},
	{ name: "scout", aliases: ["scout"], description: "broad codebase reconnaissance", steps: [{ agent: "scout" }] },
	{
		name: "plan",
		aliases: ["plan"],
		description: "planning or design without implementation",
		steps: [
			{ agent: "scout", task: "Find code relevant to this planning request:\n\n{task}" },
			{ agent: "planner", task: "Create an implementation plan for this request:\n\n{task}\n\nScout context:\n{previous}" },
		],
	},
	{ name: "review", aliases: ["review", "audit"], description: "code review or audit", steps: [{ agent: "reviewer", reviewContext: true }] },
	{
		name: "implement",
		aliases: ["implement"],
		description: "larger implementation requiring reconnaissance, planning, and an isolated worker",
		editing: true,
		steps: [
			{ agent: "scout", task: "Find code relevant to this implementation request:\n\n{task}" },
			{ agent: "planner", task: "Create an implementation plan for this request:\n\n{task}\n\nScout context:\n{previous}" },
			{ agent: "worker", task: "Implement this request in the isolated worktree using the plan/context below.\n\nOriginal request:\n{task}\n\nPlan/context:\n{previous}", isolate: true },
		],
	},
	{ name: "worker", aliases: ["worker"], description: "explicit implementation by an isolated worker", editing: true, steps: [{ agent: "worker", isolate: true }] },
];

const canopyImplementPostSteps: RouteStep[] = [
	{
		agent: "moonbit-refactor",
		applyPreviousPatch: true,
		task: "Read the full moonbit-refactoring skill at ~/.agents/skills/moonbit-refactoring/SKILL.md, then apply its guidelines to the files that were just changed. Run moon check and affected moon test commands to validate.\n\nOriginal request:\n{task}\n\nPrevious step output (includes Files Changed):\n{previous}",
	},
	{
		agent: "ensemble-reviewer",
		reviewContext: true,
		task: "Review the full implementation including refactoring. Focus on MoonBit correctness, Existing API First, package boundaries, .mbti drift, and validation readiness.\n\nOriginal request:\n{task}\n\n{reviewContext}\n\nPrevious step output:\n{previous}",
	},
	{
		agent: "worker",
		task: "Address only high-confidence actionable findings from the ensemble review. If the review has no Critical/Warnings/actionable findings, do not edit files; report that no follow-up changes were needed. Re-read the affected files before editing, preserve the intended behavior, keep the fix minimal, and run the lightest relevant validation. Include ## Files Changed with exact paths.\n\nOriginal request:\n{task}\n\nEnsemble review output:\n{previous}",
	},
];

const canopyRoutes: RouteDefinition[] = [
	...genericRoutes,
	{ name: "moonbit-scout", aliases: ["moonbit-scout"], description: "MoonBit/Canopy reconnaissance", steps: [{ agent: "moonbit-scout" }] },
	{
		name: "moonbit-plan",
		aliases: ["moonbit-plan"],
		description: "MoonBit/Canopy planning and design",
		steps: [
			{ agent: "moonbit-scout", task: "Find MoonBit/Canopy code relevant to this planning request:\n\n{task}" },
			{ agent: "moonbit-planner", task: "Create a MoonBit/Canopy implementation plan for this request:\n\n{task}\n\nScout context:\n{previous}" },
		],
	},
	{ name: "moonbit-review", aliases: ["moonbit-review"], description: "MoonBit/Canopy correctness and API review", steps: [{ agent: "moonbit-reviewer", reviewContext: true }] },
	{ name: "ensemble-review", aliases: ["ensemble-review"], description: "quick multi-model review", steps: [{ agent: "ensemble-reviewer", reviewContext: true }] },
	{ name: "parallel-review", aliases: ["parallel-review"], description: "thorough pre-merge review using four specialized reviewers", steps: [{ agent: "parallel-reviewer", reviewContext: true }] },
	{ name: "review-router", aliases: ["review-router"], description: "choose between ensemble and parallel review", steps: [{ agent: "review-router", reviewContext: true }] },
];

const genericClassifier: ClassifierPolicy = {
	model: "openai-codex/gpt-5.3-codex-spark:minimal",
	threshold: 0.72,
	instructions: [
		"inline: small judgment-heavy task or unclear request",
		"mechanic: tightly scoped rote edit/rename/import/path migration with exact files or patterns",
		"scout: broad codebase reconnaissance only",
		"plan: planning or design request without implementation",
		"review: code review or audit request",
		"implement: larger implementation needing scout then plan then worker",
		"worker: explicit implementation by an isolated worker",
		"Prefer inline unless confidence is high. Do not route UI/visual iteration.",
	],
};

const canopyClassifier: ClassifierPolicy = {
	...genericClassifier,
	instructions: [
		"inline: small judgment-heavy task or unclear request",
		"mechanic: tightly scoped rote edit/rename/import/path migration with exact files or patterns",
		"scout: broad non-MoonBit codebase reconnaissance only",
		"moonbit-scout: MoonBit/Canopy reconnaissance involving .mbt, moon.pkg, moon.mod.json, .mbti, moon ide, package boundaries, parser/lowering/projection code",
		"plan: non-MoonBit planning/design request without implementation",
		"moonbit-plan: MoonBit/Canopy planning/design request without implementation",
		"review: non-MoonBit code review/audit request",
		"moonbit-review: MoonBit/Canopy code review/audit request",
		"ensemble-review: quick multi-model review using three cheap reviewers",
		"parallel-review: thorough pre-merge review using four specialized reviewers",
		"review-router: choose between ensemble-review and parallel-review",
		"implement: larger implementation needing scout then plan then worker",
		"worker: explicit implementation by an isolated worker",
		"Prefer inline unless confidence is high. Do not route UI/visual iteration.",
	],
};

const genericGenerated: GeneratedPathPolicy = {
	block: ["(^|/)node_modules/", "(^|/)\\.git/", "(^|/)coverage/", "(^|/)dist/", "(^|/)build/"],
	warn: ["(^|/)generated/", "\\.generated\\.", "(^|/)vendor/"],
};

const canopyGenerated: GeneratedPathPolicy = {
	block: ["^_build/", "(^|/)node_modules/", "(^|/)coverage/", "(^|/)dist/", "(^|/)\\.next/"],
	warn: ["\\.mbti$", "(^|/)generated/", "\\.generated\\."],
};

const genericValidation: ValidationPolicy = {
	rules: [
		{
			name: "typescript",
			pathPatterns: ["\\.(ts|tsx|js|jsx)$", "(^|/)package\\.json$", "(^|/)tsconfig\\.json$"],
			commands: [
				{ label: "npm test", command: "npm", args: ["test"], requiredFiles: ["package.json"], requiredScript: "test", scriptManifest: "package.json" },
				{ label: "npm run typecheck", command: "npm", args: ["run", "typecheck"], requiredFiles: ["package.json"], requiredScript: "typecheck", scriptManifest: "package.json" },
			],
			hints: ["Run the repository's focused typecheck and test commands when available."],
		},
		{
			name: "python",
			pathPatterns: ["\\.py$", "(^|/)pyproject\\.toml$", "(^|/)requirements[^/]*\\.txt$"],
			commands: [{ label: "pytest", command: "pytest", args: [], requiredFiles: ["pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt"] }],
			hints: ["Run the repository's formatter and type checker when configured."],
		},
	],
	fallbackHint: "No profile-specific validation commands selected for these paths.",
};

const canopyValidation: ValidationPolicy = {
	rules: [
		{
			name: "moonbit",
			pathPatterns: ["\\.mbt$", "\\.mbti$", "(^|/)moon\\.pkg$", "(^|/)moon\\.mod(?:\\.json)?$", "(^|/)moon\\.work$"],
			commands: [{ label: "moon check", command: "moon", args: ["check"], requiredFiles: ["moon.mod", "moon.mod.json", "moon.work"] }, { label: "moon test", command: "moon", args: ["test"], requiredFiles: ["moon.mod", "moon.mod.json", "moon.work"] }],
			hints: ["Run moon fmt && moon info before committing; inspect .mbti diffs for unintended API changes."],
		},
		{
			name: "web",
			pathPatterns: ["\\.(ts|tsx|css|html)$", "(^|/)examples/(web|demo-react|prosemirror|canvas/web)/"],
			commands: [],
			hints: ["Build JS first and run the relevant npm typecheck/e2e command from CI when appropriate."],
		},
		{
			name: "docs",
			pathPatterns: ["^docs/.*\\.md$"],
			commands: [{ label: "docs check", command: "bash", args: ["check-docs.sh"], requiredFiles: ["check-docs.sh"] }],
			hints: ["Docs-only patches may not require moon test."],
		},
	],
	fallbackHint: "No automatic validation commands selected for these paths.",
};

async function repositoryRoot(cwd: string): Promise<string | undefined> {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function isCanopyProject(cwd: string, _changedPaths: string[]): Promise<boolean> {
	const root = await repositoryRoot(cwd);
	if (!root) return false;
	for (const marker of ["moon.mod", "moon.mod.json"]) {
		const markerPath = path.join(root, marker);
		if (!fs.existsSync(markerPath)) continue;
		const contents = await fs.promises.readFile(markerPath, "utf8").catch(() => "");
		if (/name\s*=\s*"dowdiness\/canopy"|["']repository["']\s*[:=]\s*["']https:\/\/github\.com\/dowdiness\/canopy/.test(contents)) return true;
	}
	return false;
}

function makeProfile(profile: Omit<SchedulerProfile, "isEditingRoute">): SchedulerProfile {
	return {
		...profile,
		isEditingRoute: (route) => profile.routes.find((item) => item.name === route)?.editing === true,
	};
}

export const genericProfile = makeProfile({
	id: "generic",
	displayName: "Generic scheduler",
	defaultMode: "off",
	routes: genericRoutes,
	classifier: genericClassifier,
	generated: genericGenerated,
	validation: genericValidation,
	autopilot: { mode: "off", route: "mechanic", maxFiles: 0, maxChangedLines: 0 },
	detect: async () => false,
});

export const canopyProfile = makeProfile({
	id: "canopy",
	displayName: "Canopy scheduler",
	defaultMode: "auto",
	routes: canopyRoutes,
	classifier: canopyClassifier,
	generated: canopyGenerated,
	validation: canopyValidation,
	autopilot: { mode: "cautious", route: "mechanic", maxFiles: 3, maxChangedLines: 100 },
	detect: isCanopyProject,
	resolveRoute: (route, task, explicit, changedPaths) => resolveCanopyRoute(route, task, explicit, changedPaths),
});

async function configuredProfile(root: string): Promise<SchedulerProfile | undefined> {
	for (const filename of [".scheduler.json", "scheduler.config.json"]) {
		const configPath = path.join(root, filename);
		if (!fs.existsSync(configPath)) continue;
		const contents = await fs.promises.readFile(configPath, "utf8").catch(() => "");
		try {
			const config = JSON.parse(contents) as { profile?: unknown };
			if (config.profile === "canopy") return canopyProfile;
			if (config.profile === "generic") return genericProfile;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
export async function resolveSchedulerProfile(cwd: string, changedPaths: string[] = []): Promise<SchedulerProfile> {
	const root = await repositoryRoot(cwd);
	if (root) {
		const configured = await configuredProfile(root);
		if (configured) return configured;
	}
	return (await canopyProfile.detect(cwd, changedPaths)) ? canopyProfile : genericProfile;
}

export function routeFor(profile: SchedulerProfile, route: string): RouteDefinition | undefined {
	return profile.routes.find((item) => item.name === route || item.aliases.includes(route));
}

export function routeNames(profile: SchedulerProfile): string[] {
	return profile.routes.map((route) => route.name);
}
function looksMoonBitTask(text: string, changedPaths: string[]): boolean {
	const lower = text.toLowerCase();
	if (/\.mbt\b|\.mbti\b|moonbit|moon\.pkg|moon\.mod(\.json)?|moon\.work|\bmoon (check|test|info|fmt|prove|ide)\b/.test(lower)) return true;
	return changedPaths.some((filePath) => /\.mbt$|\.mbti$|(^|\/)moon\.pkg$|(^|\/)moon\.mod(\.json)?$|(^|\/)moon\.work$/.test(filePath));
}

function resolveCanopyRoute(route: string, task: string, explicit: boolean, changedPaths: string[]): RouteDefinition | undefined {
	const base = canopyRoutes.find((item) => item.name === route || item.aliases.includes(route));
	if (!base || (explicit && route !== "implement") || !looksMoonBitTask(task, changedPaths)) return base;
	if (route === "scout") return canopyRoutes.find((item) => item.name === "moonbit-scout");
	if (route === "plan") return canopyRoutes.find((item) => item.name === "moonbit-plan");
	if (route === "review") return canopyRoutes.find((item) => item.name === "moonbit-review");
	if (route === "implement") {
		const implementationSteps = explicit
			? base.steps
			: [
				{ ...base.steps[0], agent: "moonbit-scout", task: "Find MoonBit/Canopy code relevant to this implementation request:\n\n{task}" },
				{ ...base.steps[1], agent: "moonbit-planner", task: "Create a MoonBit/Canopy implementation plan for this request:\n\n{task}\n\nScout context:\n{previous}" },
				...base.steps.slice(2),
			];
		return {
			...base,
			steps: [...implementationSteps, ...canopyImplementPostSteps],
		};
	}
	return base;
}

export function resolveRouteDefinition(
	profile: SchedulerProfile,
	route: string,
	task: string,
	explicit: boolean,
	changedPaths: string[],
): RouteDefinition | undefined {
	return profile.resolveRoute?.(route, task, explicit, changedPaths) ?? routeFor(profile, route);
}
