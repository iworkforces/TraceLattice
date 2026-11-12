/**
 * Read-only view of the persistence write backlog, for readiness reporting.
 *
 * @module contracts/persistence-backlog
 */

/** Point-in-time counts describing unflushed or failed persistence work. */
export interface PersistenceBacklogView {
	/** A global reset failed, so every session is refused admission until a reset succeeds. */
	readonly globalQuarantined: boolean;
	/** Sessions refused admission after a failed reset or eviction barrier. */
	readonly quarantinedSessionCount: number;
	/** Accepted writes that exhausted their retries and wait for an explicit drain. */
	readonly retainedFailureCount: number;
	/** Accepted thought writes not yet acknowledged successful. */
	readonly pendingThoughtCount: number;
}

/** Anything that can report its persistence backlog; `null` when persistence is disabled. */
export interface PersistenceBacklogSource {
	getPersistenceBacklogView(): PersistenceBacklogView | null;
}
