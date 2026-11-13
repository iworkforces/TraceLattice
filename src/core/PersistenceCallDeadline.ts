/**
 * Deadline for one persistence backend call.
 *
 * A timer cannot interrupt a synchronous driver: a call that blocks the event loop
 * settles before its deadline callback can run.
 *
 * @module PersistenceCallDeadline
 */

/** Real outcome of one backend call. */
export type PersistenceCallOutcome =
	{ readonly kind: 'fulfilled' } | { readonly kind: 'rejected'; readonly reason: unknown };

/**
 * Outcome seen by the caller: the call's own outcome when it settles in time, or the
 * deadline together with a promise for the eventual outcome of that same call.
 */
export type PersistenceDeadlineOutcome =
	| PersistenceCallOutcome
	| { readonly kind: 'timedOut'; readonly lateOutcome: Promise<PersistenceCallOutcome> };

const FULFILLED: PersistenceCallOutcome = Object.freeze({ kind: 'fulfilled' });

/**
 * Starts one backend call and races it against a deadline.
 *
 * The call is started exactly once. Its deadline timer is cleared when the call settles
 * first. The returned promise and `lateOutcome` never reject.
 *
 * @param call - Starts the backend call; a synchronous throw counts as a rejection.
 * @param timeoutMs - Deadline in milliseconds, at most 2147483647.
 * @returns The call outcome, or `timedOut` with the late outcome handle.
 */
export function callWithinDeadline(
	call: () => Promise<void>,
	timeoutMs: number
): Promise<PersistenceDeadlineOutcome> {
	const settled = new Promise<void>((resolve) => resolve(call())).then(
		(): PersistenceCallOutcome => FULFILLED,
		(reason: unknown): PersistenceCallOutcome => ({ kind: 'rejected', reason })
	);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ kind: 'timedOut', lateOutcome: settled }), timeoutMs);
		void settled.then((outcome) => {
			clearTimeout(timer);
			resolve(outcome);
		});
	});
}
