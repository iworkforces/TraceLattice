/**
 * Read-only view of the persistence write backlog, for readiness reporting.
 *
 * @module contracts/persistence-backlog
 */

/** Point-in-time counts describing unflushed or failed persistence work. */
export interface PersistenceBacklogView {
	/** A global reset failed, so every session is refused admission until a reset succeeds. */
	readonly globalQuarantined: boolean;
	/**
	 * Sessions refused admission after a failed reset, including those whose eviction had failed
	 * before. Only another reset recovers them.
	 */
	readonly quarantinedSessionCount: number;
	/**
	 * Sessions whose eviction failed and that a later sweep tick retries, or that an authorized
	 * reset recovers. Disjoint from {@link quarantinedSessionCount}.
	 */
	readonly evictionRetrySessionCount: number;
	/**
	 * Sessions with a retained thought or backtrack failure. Every write such a session accepted
	 * later is held until that write succeeds or the session is reset.
	 */
	readonly blockedSessionCount: number;
	/**
	 * Accepted writes that exhausted their retries. Explicit drains retry them at once; timer and
	 * size-triggered drains retry them on a capped backoff.
	 */
	readonly retainedFailureCount: number;
	/** Accepted thought writes not yet acknowledged successful. */
	readonly pendingThoughtCount: number;
}

/** Anything that can report its persistence backlog; `null` when persistence is disabled. */
export interface PersistenceBacklogSource {
	getPersistenceBacklogView(): PersistenceBacklogView | null;
}
