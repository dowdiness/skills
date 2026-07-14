export interface RouteUiOutcome {
	completed: boolean;
	error?: unknown;
}

export async function settleRouteUi(
	ui: Promise<boolean>,
	execution: () => Promise<void>,
): Promise<RouteUiOutcome> {
	let completed = false;
	let uiError: unknown;
	let uiFailed = false;
	try {
		completed = await ui;
	} catch (error) {
		uiFailed = true;
		uiError = error;
	}
	try {
		await execution();
	} catch (error) {
		return { completed: true, error };
	}
	return uiFailed ? { completed: true, error: uiError } : { completed };
}
