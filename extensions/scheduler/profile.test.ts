import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canopyProfile, genericProfile, resolveSchedulerProfile, resolveRouteDefinition, routeFor } from "./profile.js";

async function makeRepository(marker?: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-profile-test-"));
	await fs.mkdir(path.join(root, ".git"));
	if (marker) await fs.writeFile(path.join(root, "moon.mod"), marker);
	return root;
}

describe("scheduler profiles", () => {
	test("falls back to a disabled generic profile", async () => {
		const root = await makeRepository();
		const profile = await resolveSchedulerProfile(path.join(root, "nested"));
		expect(profile.id).toBe(genericProfile.id);
		expect(profile.defaultMode).toBe("off");
		expect(routeFor(profile, "review")?.name).toBe("review");
		expect(routeFor(profile, "moonbit-review")).toBeUndefined();
	});

	test("detects Canopy markers from nested worktrees", async () => {
		const root = await makeRepository('name = "dowdiness/canopy"');
		const nested = path.join(root, "worktree", "src");
		await fs.mkdir(nested, { recursive: true });
		expect(await canopyProfile.detect(nested, [])).toBe(true);
		const profile = await resolveSchedulerProfile(nested);
		expect(profile.id).toBe("canopy");
		expect(profile.defaultMode).toBe("auto");
	});

	test("explicit repository config overrides marker detection", async () => {
		const root = await makeRepository('name = "dowdiness/canopy"');
		await fs.writeFile(path.join(root, ".scheduler.json"), JSON.stringify({ profile: "generic" }));
		const profile = await resolveSchedulerProfile(root);
		expect(profile.id).toBe("generic");
	});

	test("maps parallel review only in the Canopy profile", () => {
		const route = resolveRouteDefinition(canopyProfile, "parallel-review", "inspect the diff", true, []);
		expect(route?.name).toBe("parallel-review");
		expect(routeFor(genericProfile, "parallel-review")).toBeUndefined();
	});

	test("keeps validation and generated-file policy in profiles", () => {
		expect(canopyProfile.validation.rules.some((rule) => rule.name === "moonbit")).toBe(true);
		expect(canopyProfile.generated.block).toContain("^_build/");
		expect(genericProfile.validation.rules.some((rule) => rule.name === "python")).toBe(true);
	});

	test("keeps Canopy MoonBit post-steps for an explicit implement route", () => {
		const route = resolveRouteDefinition(canopyProfile, "implement", "change src/editor.mbt", true, ["src/editor.mbt"]);
		const agents = route?.steps.map((step) => step.agent) ?? [];
		expect(agents.slice(0, 3)).toEqual(["scout", "planner", "worker"]);
		expect(agents).toContain("moonbit-refactor");
		expect(agents).toContain("ensemble-reviewer");
		expect(agents.filter((agent) => agent === "worker")).toHaveLength(2);
	});
	test("keeps explicit generic routes on their requested agents", () => {
		const route = resolveRouteDefinition(canopyProfile, "scout", "inspect src/editor.mbt", true, ["src/editor.mbt"]);
		expect(route?.steps[0]?.agent).toBe("scout");
	});

	test("matches both current and legacy MoonBit module manifests", () => {
		const rule = canopyProfile.validation.rules.find((item) => item.name === "moonbit");
		expect(rule?.pathPatterns.some((pattern) => new RegExp(pattern).test("moon.mod"))).toBe(true);
		expect(rule?.pathPatterns.some((pattern) => new RegExp(pattern).test("moon.mod.json"))).toBe(true);
	});
});
