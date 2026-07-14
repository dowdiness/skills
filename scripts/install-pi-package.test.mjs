import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const installer = join(repositoryRoot, "scripts", "install-pi-package.mjs");

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
test("installs Canopy parallel-review agent compatibility links into a clean home", () => {
	const home = mkdtempSync(join(tmpdir(), "skills-installer-test-"));
	const agents = [
		"parallel-reviewer.md",
		"moonbit-reviewer.md",
		"reviewer-flash.md",
		"reviewer-mimo.md",
		"reviewer-qwen.md",
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
