export interface RouteUiOutcome {
	completed: boolean;
	error?: unknown;
}

export async function settleRouteUi(
	ui: Promise<boolean>,
	execution: () => Promise<void>,
): Promise<RouteUiOutcome> {
	const completed = await ui;
	try {
		await execution();
		return { completed };
	} catch (error) {
		return { completed: true, error };
	}
}
