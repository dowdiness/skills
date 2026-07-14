import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/tmp",
	getMarkdownTheme: () => ({}),
	parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Markdown: class Markdown {},
	matchesKey: () => false,
	truncateToWidth: (text: string) => text,
}));

// Dynamic import intentionally isolates the scheduler from unavailable peer packages in this unit test.
const { execCapture, writeReviewContext } = await import("./index.ts");

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("captures committed branch diff and untracked files", async () => {
	const root = mkdtempSync(join(tmpdir(), "scheduler-context-test-"));
	let contextDir: string | undefined;
	try {
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		writeFileSync(join(root, "sample.mbt"), "fn sample() -> Int { 1 }\n");
		git(root, "add", "sample.mbt");
		git(root, "commit", "-qm", "base");
		git(root, "checkout", "-qb", "feature");
		writeFileSync(join(root, "sample.mbt"), "fn sample() -> Int { 2 }\n");
		git(root, "commit", "-qam", "change");
		writeFileSync(join(root, "untracked.mbt"), "fn untracked() -> Int { 3 }\n");

		const context = await writeReviewContext(root);
		contextDir = context?.dir;
		expect(context?.truncated).toBe(false);
		const text = context ? readFileSync(context.filePath, "utf8") : "";
		expect(text).toContain("Base revision:");
		expect(text).toContain("sample.mbt");
		expect(text).toContain("-fn sample() -> Int { 1 }");
		expect(text).toContain("+fn sample() -> Int { 2 }");
		expect(text).toContain("untracked.mbt");
		expect(text).toContain("fn untracked() -> Int { 3 }");
	} finally {
		if (contextDir) rmSync(contextDir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("marks oversized untracked context incomplete", async () => {
	const root = mkdtempSync(join(tmpdir(), "scheduler-context-large-"));
	let contextDir: string | undefined;
	try {
		git(root, "init", "-q");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		writeFileSync(join(root, "base.txt"), "base\n");
		git(root, "add", "base.txt");
		git(root, "commit", "-qm", "base");
		writeFileSync(join(root, "large.txt"), "x".repeat(300 * 1024));

		const context = await writeReviewContext(root);
		contextDir = context?.dir;
		expect(context?.truncated).toBe(true);
		const text = context ? readFileSync(context.filePath, "utf8") : "";
		expect(text).toContain("INCOMPLETE");
	} finally {
		if (contextDir) rmSync(contextDir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
test("reports a signaled generic capture as a failure", async () => {
	const result = await execCapture(".", process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]);
	expect(result.code).not.toBe(0);
});
