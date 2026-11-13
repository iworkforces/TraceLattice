/**
 * Phase deadlines of one bounded server stop.
 *
 * @module ServerStopBudget
 */

/** Deadlines of one bounded stop, all derived from the single start time taken by `stop()`. */
export interface ServerStopDeadlines {
	/** Bound for the idle wait and the discovery teardown together, in milliseconds. */
	readonly idleMs: number;
	/** Absolute time, in epoch milliseconds, at which the persistence flush must end. */
	readonly flushDeadline: number;
	/** Absolute time, in epoch milliseconds, at which the owned backend close must end. */
	readonly closeDeadline: number;
}

/**
 * Splits a stop budget into idle, flush and close phases: flush and close each get
 * `min(writeTimeoutMs, floor(budgetMs / 3))`, idle gets the rest, and every phase gets at least
 * 1 ms, so a budget under 3 ms is exceeded by design.
 *
 * @param startMs - Time at which `stop(budgetMs)` was called, in epoch milliseconds.
 * @param budgetMs - The whole stop budget in milliseconds.
 * @param writeTimeoutMs - `persistenceWriteTimeout`, the cap on the flush and close phases.
 */
export function serverStopDeadlines(
	startMs: number,
	budgetMs: number,
	writeTimeoutMs: number
): ServerStopDeadlines {
	const tailMs = Math.max(1, Math.min(writeTimeoutMs, Math.floor(budgetMs / 3)));
	const idleMs = Math.max(1, budgetMs - 2 * tailMs);
	return {
		idleMs,
		flushDeadline: startMs + idleMs + tailMs,
		closeDeadline: startMs + idleMs + 2 * tailMs,
	};
}

/** @returns Milliseconds left until `deadline`, never less than 1. */
export function remainingUntil(deadline: number, nowMs: number): number {
	return Math.max(1, deadline - nowMs);
}
