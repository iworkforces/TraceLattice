/**
 * Shared interface contracts for dependency injection.
 *
 * This module centralizes all cross-module interface definitions so that
 * the DI container (ServiceRegistry) and other modules can depend on
 * interfaces rather than concrete implementations.
 *
 * By importing from contracts/ instead of individual module files,
 * we reduce lateral coupling and keep the dependency graph shallow.
 *
 * @module contracts
 */
import type { Edge } from '../core/graph/Edge.js';
import type { EdgeId, SessionId, ThoughtId } from './ids.js';
import type { ThoughtType } from './reasoning-types.js';

/**
 * Metrics interface for observability.
 *
 * Defines the contract for metrics collection used across modules.
 * Implementations include the Prometheus-compatible Metrics class.
 */
export interface IMetrics {
	counter(name: string, value?: number, labels?: Record<string, string>, help?: string): void;
	gauge(name: string, value: number, labels?: Record<string, string>, help?: string): void;
	histogram(name: string, value: number, labels?: Record<string, string>, buckets?: number[]): void;
	get(name: string, labels?: Record<string, string>): number | undefined;
	inc(name: string, labels?: Record<string, string>): void;
	dec(name: string, labels?: Record<string, string>): void;
	reset(): void;
	export(): string;
}

/**
 * Discovery cache interface for caching tool/skill discovery results.
 *
 * Defines the contract for LRU+TTL caching used by registries.
 * Implementations include the DiscoveryCache class.
 *
 * @template T - The type of data being cached
 */
export interface IDiscoveryCache<T> {
	get(key: string): T[] | null;
	set(key: string, data: T[]): void;
	has(key: string): boolean;
	invalidate(key: string): void;
	clear(): void;
	dispose(): void;
	size(): number;
	getStats(): { size: number; keys: string[] };
}

/**
 * Configuration options for creating a discovery cache.
 */
export interface DiscoveryCacheOptions {
	maxSize?: number;
	ttl?: number;
	cleanupInterval?: number;
	metrics?: IMetrics;
}

/**
 * Outcome recording interface for calibration data collection.
 *
 * Captures verification outcomes (predicted vs actual) to enable
 * confidence calibration (Brier score, ECE) in later phases.
 */
export interface VerificationOutcome {
	/** The thought id that made the prediction. */
	thoughtId: ThoughtId;
	/** The session this outcome belongs to. */
	sessionId: SessionId;
	/** The predicted confidence (0-1). */
	predicted: number;
	/** The actual outcome (0 = wrong, 1 = correct). */
	actual: 0 | 1;
	/** The thought type that made the prediction. */
	type: ThoughtType;
	/** Timestamp of outcome recording. */
	recordedAt: number;
}

/**
 * Interface for recording verification outcomes for calibration.
 *
 * Implementation is no-op when feature flags disable outcome recording.
 * Enabled outcomes feed into the Calibrator (Phase 1 Wave A.3) for
 * Brier score and ECE computation.
 */
export interface IOutcomeRecorder {
	/**
	 * Assert that a target has not already received an outcome in this session.
	 * This preflight is side-effect free and a no-op when recording is disabled.
	 */
	assertCanRecord(sessionId: SessionId, thoughtId: ThoughtId): void;

	/**
	 * Record a verification outcome.
	 * No-op when outcome recording is disabled.
	 */
	recordVerification(outcome: Omit<VerificationOutcome, 'recordedAt'>): void;

	/**
	 * Get all recorded outcomes for a session.
	 * Returns empty array when disabled or no outcomes recorded.
	 */
	getOutcomes(sessionId: SessionId): VerificationOutcome[];

	/**
	 * Get outcomes across all sessions.
	 * Returns empty array when disabled.
	 */
	getAllOutcomes(): VerificationOutcome[];

	/**
	 * Clear outcomes for a specific session.
	 */
	clearOutcomes(sessionId: SessionId): void;

	/**
	 * Discard outcomes from every session namespace.
	 * Use only for a trusted process-wide reset; scoped callers must use `clearOutcomes`.
	 */
	clearAllOutcomes(): void;

	/**
	 * Whether outcome recording is currently enabled.
	 */
	readonly enabled: boolean;
}

/**
 * Edge store interface for managing directed acyclic graph edges.
 *
 * Stores relationships between thoughts as typed directed edges.
 * Each edge connects two thoughts (by their `id` field) with a semantic
 * relationship kind that drives reasoning controller decisions.
 *
 * Implementations must provide per-session isolation — edges in one
 * session are invisible to another.
 *
 * @example
 * ```typescript
 * const store: IEdgeStore = new EdgeStore();
 * store.addEdge({ id: 'abc', from: 'thought-1', to: 'thought-2', kind: 'sequence', sessionId: 's1', createdAt: Date.now() });
 * const edges = store.outgoing('s1', 'thought-1');
 * ```
 */
export interface IEdgeStore {
	/**
	 * Add a directed edge to the store.
	 * Rejects self-edges (from === to) by throwing InvalidEdgeError.
	 * Deduplicates identical (from, to, kind, sessionId) tuples silently.
	 *
	 * @param edge - The edge to add
	 * @throws {InvalidEdgeError} When from === to
	 */
	addEdge(edge: Edge): void;

	/**
	 * Retrieve a specific edge by its id.
	 *
	 * @param id - The edge's unique identifier
	 * @returns The edge, or undefined if not found
	 */
	getEdge(id: EdgeId): Edge | undefined;

	/**
	 * Get all outgoing edges from a thought, sorted by createdAt ascending.
	 *
	 * @param sessionId - Session to query within
	 * @param from - Source thought id
	 * @returns Array of outgoing edges (may be empty)
	 */
	outgoing(sessionId: SessionId, from: ThoughtId): readonly Edge[];

	/**
	 * Get all incoming edges to a thought, sorted by createdAt ascending.
	 *
	 * @param sessionId - Session to query within
	 * @param to - Target thought id
	 * @returns Array of incoming edges (may be empty)
	 */
	incoming(sessionId: SessionId, to: ThoughtId): readonly Edge[];

	/**
	 * Get all edges in a session.
	 *
	 * @param sessionId - Session to query
	 * @returns All edges in the session (may be empty)
	 */
	edgesForSession(sessionId: SessionId): readonly Edge[];

	/**
	 * Remove unless both endpoints are retained; leave other sessions untouched and delete empty containers.
	 * @param sessionId - Session whose edges should be pruned
	 * @param retainedThoughtIds - Union of all retained thought ids in the session
	 * @returns The exact number of removed edges
	 */
	pruneSession(
		sessionId: SessionId,
		retainedThoughtIds: ReadonlySet<ThoughtId>,
		retainedBranchThoughtIds?: ReadonlySet<ThoughtId>
	): number;

	/**
	 * Clear all edges for a specific session.
	 * Other sessions are unaffected.
	 *
	 * @param sessionId - Session to clear
	 */
	clearSession(sessionId: SessionId): void;

	/**
	 * Discard edges from every session namespace.
	 * Use only for a trusted process-wide reset; scoped callers must use `clearSession`.
	 */
	clearAll(): void;

	/**
	 * Count edges.
	 *
	 * @param sessionId - If provided, count for that session only
	 * @returns Total edge count (across all sessions if no sessionId provided)
	 */
	size(sessionId?: SessionId): number;
}

/**
 * Tool registry interface used for tool_name allowlisting in ThoughtProcessor.
 *
 * Provides the minimal read-only contract needed to validate tool_call thoughts.
 * Implementations include the concrete `ToolRegistry` class.
 */
export interface IToolRegistry {
	/**
	 * Returns true if a tool with the given name is registered.
	 */
	has(name: string): boolean;

	/**
	 * Returns the names of all registered tools.
	 */
	getNames(): string[];
}

/**
 * Per-session async lock used to serialize state-mutating operations.
 *
 * Implementations must guarantee:
 * - Concurrent calls for the same session id are serialized in arrival order.
 * - Calls for different session ids never block each other.
 * - The lock is always released, even when the critical section throws.
 * - A waiter that times out does not corrupt the chain — later waiters
 *   still observe correct serialization.
 *
 * Used by `ThoughtProcessor.process()` to prevent `reset_state` from
 * interleaving with concurrent `addThought` calls for the same session.
 */
export interface ISessionLock {
	/**
	 * Execute `fn` while holding the lock for the given session.
	 *
	 * @param sessionId - Session to lock.
	 * @param fn - Critical section to run while holding the lock.
	 * @param timeoutMs - Max wait for lock acquisition (default 5000ms).
	 * @throws {LockTimeoutError} If the lock is not acquired before `timeoutMs`.
	 */
	withLock<T>(sessionId: SessionId, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;

	/** Whether the session currently has a holder or queued operation. */
	isActive(sessionId: SessionId): boolean;

	/** Number of currently held lock chains (diagnostics). */
	readonly size: number;
}
