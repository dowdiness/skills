import { expect, test } from "bun:test";
import {
	collectConfiguredAgentModelIds,
	extractAgentModelIds,
	findUnavailableModelIds,
	normalizeModelId,
	parseAvailableModelIds,
} from "./validate-agent-models.mjs";
import { resolve } from "node:path";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

test("extracts primary and comma-separated fallback model IDs", () => {
	const ids = extractAgentModelIds(`---
name: example
description: test
model: provider/primary:high
fallbackModels: provider/first, provider/second:low
---
`);

	expect(ids).toEqual(["provider/primary:high", "provider/first", "provider/second:low"]);
	expect(normalizeModelId(ids[0])).toBe("provider/primary");
});

test("parses pi model table output without hardcoding providers", () => {
	const available = parseAvailableModelIds(`provider model context\ncustom-provider custom-model 128K\nother-provider/other-model\n`);

	expect(available).toEqual(new Set(["custom-provider/custom-model", "other-provider/other-model"]));
});

test("compares model IDs after removing thinking suffixes", () => {
	expect(findUnavailableModelIds(
		["provider/available:high", "provider/missing:minimal"],
		new Set(["provider/available"]),
	)).toEqual(["provider/missing"]);
});

test("reads all packaged agent model definitions", () => {
	const ids = collectConfiguredAgentModelIds(resolve(repositoryRoot, "agents"));

	expect(ids.length).toBeGreaterThan(0);
	expect(ids).toContain("openai-codex/gpt-5.6-terra");
});
