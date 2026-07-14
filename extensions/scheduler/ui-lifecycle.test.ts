import { expect, test } from "bun:test";
import { settleRouteUi } from "./ui-lifecycle.js";

test("waits for route execution after the UI reports an abort", async () => {
	let resolveExecution!: () => void;
	const execution = new Promise<void>((resolve) => { resolveExecution = resolve; });
	let resolveUi!: (completed: boolean) => void;
	const ui = new Promise<boolean>((resolve) => { resolveUi = resolve; });
	const settled = settleRouteUi(ui, () => execution);
	let finished = false;
	settled.then(() => { finished = true; });

	resolveUi(false);
	await Promise.resolve();
	expect(finished).toBe(false);

	resolveExecution();
	expect(await settled).toEqual({ completed: false });
});

test("waits for route execution when the UI rejects", async () => {
	let resolveExecution!: () => void;
	const execution = new Promise<void>((resolve) => { resolveExecution = resolve; });
	const uiError = new Error("ui closed unexpectedly");
	const settled = settleRouteUi(Promise.reject(uiError), () => execution);
	let finished = false;
	settled.then(() => { finished = true; });

	await Promise.resolve();
	expect(finished).toBe(false);

	resolveExecution();
	const result = await settled;
	expect(result.completed).toBe(true);
	expect(result.error).toBe(uiError);
});

test("reports execution errors as failures rather than aborts", async () => {
	const error = new Error("child failed");
	const result = await settleRouteUi(Promise.resolve(true), async () => { throw error; });
	expect(result.completed).toBe(true);
	expect(result.error).toBe(error);
});
