import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inferInstalledPackageRoot, parseInstallerArgs } from "./install-pi-package.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const installer = join(repositoryRoot, "scripts", "install-pi-package.mjs");

test("parses SSH transport markers separately from git refs", () => {
	const home = "/tmp/skills-installer-test-home";
	const unpinned = "git:git@github.com:owner/repo";
	const pinned = `${unpinned}@main`;
	const expectedRoot = join(home, ".pi", "agent", "git", "github.com", "owner", "repo");

	expect(parseInstallerArgs([unpinned, "--ref", "main"]).source).toBe(pinned);
	expect(() => parseInstallerArgs([pinned, "--ref", "other"])).toThrow("already pinned");
	expect(inferInstalledPackageRoot(unpinned, home)).toBe(expectedRoot);
	expect(inferInstalledPackageRoot(pinned, home)).toBe(expectedRoot);
});

test("migrates the legacy canopy-scheduler extension link", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const oldExtensions = join(home, ".pi", "agent", "extensions");
	mkdirSync(oldExtensions, { recursive: true });
	const oldTarget = join(home, "removed-canopy-scheduler");
	const oldLink = join(oldExtensions, "canopy-scheduler");
	symlinkSync(oldTarget, oldLink, "dir");
	try {
		const result = spawnSync(process.execPath, [installer, repositoryRoot, "--no-install"], {
			cwd: repositoryRoot,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(() => lstatSync(oldLink)).toThrow();
		const backupRoot = result.stdout.match(/Backing up \d+ local resource\(s\) to (.+)/)?.[1]?.trim();
		expect(backupRoot).toBeString();
		expect(() => lstatSync(join(backupRoot, "extensions", "canopy-scheduler"))).not.toThrow();
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(oldTarget, { recursive: true, force: true });
	}
});
test("backs up deprecated lens names without touching unrelated agents", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const agentsDir = join(home, ".pi", "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	const legacy = join(agentsDir, "reviewer-flash.md");
	const custom = join(agentsDir, "my-custom-agent.md");
	writeFileSync(legacy, "legacy");
	writeFileSync(custom, "custom");
	try {
		const result = spawnSync(process.execPath, [installer, repositoryRoot, "--no-install"], {
			cwd: repositoryRoot,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(() => lstatSync(legacy)).toThrow();
		expect(lstatSync(custom).isFile()).toBe(true);
		const backupRoot = result.stdout.match(/Backing up \d+ local resource\(s\) to (.+)/)?.[1]?.trim();
		expect(backupRoot).toBeString();
		expect(lstatSync(join(backupRoot, "agents", "reviewer-flash.md")).isFile()).toBe(true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
test("agents-only backs up and links agents without touching unrelated resources", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const skillsDir = join(home, ".agents", "skills");
	const extensionsDir = join(home, ".pi", "agent", "extensions");
	const agentsDir = join(home, ".pi", "agent", "agents");
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	mkdirSync(skillsDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(skillsDir, "parallel-review"), "local skill");
	writeFileSync(join(extensionsDir, "scheduler"), "local extension");
	writeFileSync(join(agentsDir, "reviewer.md"), "local agent");
	writeFileSync(join(agentsDir, "custom.md"), "custom agent");
	writeFileSync(settingsPath, '{"packages":[{"source":"git:github.com/dowdiness/skills","skills":["parallel-review"]}]}\n');
	const settingsBefore = readFileSync(settingsPath, "utf8");
	try {
		const result = spawnSync(process.execPath, [installer, repositoryRoot, "--agents-only", "--no-install"], {
			cwd: repositoryRoot,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(lstatSync(join(skillsDir, "parallel-review")).isFile()).toBe(true);
		expect(lstatSync(join(extensionsDir, "scheduler")).isFile()).toBe(true);
		expect(lstatSync(join(agentsDir, "custom.md")).isFile()).toBe(true);
		expect(lstatSync(join(agentsDir, "reviewer.md")).isSymbolicLink()).toBe(true);
		expect(resolve(join(agentsDir), readlinkSync(join(agentsDir, "reviewer.md")))).toBe(
			join(repositoryRoot, "agents", "reviewer.md"),
		);
		expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
		const backupRoot = result.stdout.match(/Backing up \d+ local resource\(s\) to (.+)/)?.[1]?.trim();
		expect(backupRoot).toBeString();
		expect(() => lstatSync(join(backupRoot, "skills"))).toThrow();
		expect(() => lstatSync(join(backupRoot, "extensions"))).toThrow();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("extensions-only backs up extensions without touching skills, agents, or settings", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const skillsDir = join(home, ".agents", "skills");
	const extensionsDir = join(home, ".pi", "agent", "extensions");
	const agentsDir = join(home, ".pi", "agent", "agents");
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	mkdirSync(skillsDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(skillsDir, "parallel-review"), "local skill");
	writeFileSync(join(extensionsDir, "scheduler"), "local extension");
	writeFileSync(join(agentsDir, "reviewer.md"), "local agent");
	writeFileSync(settingsPath, '{"packages":[{"source":"git:github.com/dowdiness/skills","skills":["parallel-review"]}]}\n');
	const settingsBefore = readFileSync(settingsPath, "utf8");
	try {
		const result = spawnSync(process.execPath, [installer, repositoryRoot, "--extensions-only", "--no-install"], {
			cwd: repositoryRoot,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(lstatSync(join(skillsDir, "parallel-review")).isFile()).toBe(true);
		expect(lstatSync(join(agentsDir, "reviewer.md")).isFile()).toBe(true);
		expect(() => lstatSync(join(extensionsDir, "scheduler"))).toThrow();
		expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
		const backupRoot = result.stdout.match(/Backing up \d+ local resource\(s\) to (.+)/)?.[1]?.trim();
		expect(backupRoot).toBeString();
		expect(lstatSync(join(backupRoot, "extensions", "scheduler")).isFile()).toBe(true);
		expect(() => lstatSync(join(backupRoot, "skills"))).toThrow();
		expect(() => lstatSync(join(backupRoot, "agents"))).toThrow();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rejects mutually exclusive modes and invalid ref combinations", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const run = (...args) => spawnSync(process.execPath, [installer, ...args], {
		cwd: repositoryRoot,
		env: { ...process.env, HOME: home },
		encoding: "utf8",
	});
	try {
		const both = run("--agents-only", "--extensions-only", "--dry-run");
		expect(both.status).toBe(1);
		expect(both.stderr).toContain("mutually exclusive");

		const local = run(repositoryRoot, "--ref", "main", "--dry-run");
		expect(local.status).toBe(1);
		expect(local.stderr).toContain("local-path source");

		const pinned = run("git:github.com/dowdiness/skills@main", "--ref", "other", "--dry-run");
		expect(pinned.status).toBe(1);
		expect(pinned.stderr).toContain("already pinned");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("composes a git ref and reports the requested source", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	try {
		const result = spawnSync(process.execPath, [installer, "--ref", "main", "--dry-run"], {
			cwd: repositoryRoot,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Requested source: git:github.com/dowdiness/skills@main");
		expect(result.stdout).toContain("Resolved Git revision: could not be resolved");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("installs Canopy parallel-review agent compatibility links into a clean home", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const agents = [
		"doc-writer.md",
		"ensemble-reviewer.md",
		"mechanic.md",
		"moonbit-planner.md",
		"moonbit-refactor.md",
		"moonbit-reviewer.md",
		"moonbit-scout.md",
		"parallel-reviewer.md",
		"planner.md",
		"review-router.md",
		"reviewer.md",
		"reviewer-api-boundary.md",
		"reviewer-correctness.md",
		"reviewer-idioms.md",
		"scout.md",
		"worker.md",
	];
	try {
		const result = spawnSync(process.execPath, [installer, repositoryRoot, "--no-install"], {
			cwd: repositoryRoot,
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		for (const name of agents) {
			const link = join(home, ".pi", "agent", "agents", name);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(resolve(join(home, ".pi", "agent", "agents"), readlinkSync(link))).toBe(
				join(repositoryRoot, "agents", name),
			);
		}
		const skillLink = join(home, ".agents", "skills", "parallel-review");
		expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
		expect(resolve(join(home, ".agents", "skills"), readlinkSync(skillLink))).toBe(
			join(repositoryRoot, "skills", "parallel-review"),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
