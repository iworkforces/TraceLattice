/**
 * Interface for history and branch management.
 *
 * This module provides the `IHistoryManager` interface which defines the contract
 * for history manager implementations. This allows for decoupling and testability.
 *
 * @module IHistoryManager
 */

import type { IEdgeStore } from '../contracts/interfaces.js';
import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import type { ThoughtReferenceResolution } from './ThoughtReferenceIndex.js';
import type { ThoughtData } from './thought.js';

/** Non-mutating view used to validate one operation before state admission. */
export interface HistorySessionSnapshot {
	readonly history: readonly ThoughtData[];
	readonly branches: Readonly<Record<BranchId, readonly ThoughtData[]>>;
	readonly branchIds: readonly BranchId[];
	readonly availableMcpTools: readonly string[] | undefined;
	readonly availableSkills: readonly string[] | undefined;
}

export interface ResolvedThoughtReferences {
	readonly verificationTargetThoughtId?: ThoughtId;
	readonly revisesThoughtId?: ThoughtId;
	readonly branchFromThoughtId?: ThoughtId;
	readonly synthesisSourceThoughtIds?: readonly ThoughtId[];
	readonly mergeFromThoughtIds?: readonly ThoughtId[];
	readonly backtrackTargetThoughtId?: ThoughtId;
}

export interface ThoughtAdmissionContext {
	readonly resolvedReferences?: ResolvedThoughtReferences;
	readonly toolInvocationSourceThoughtId?: ThoughtId;
}

/**
 * Interface for history and branch management.
 *
 * This interface defines the contract for history manager implementations,
 * allowing for decoupling between components like ThoughtProcessor and
 * concrete implementations. It supports dependency injection and mocking
 * for testing purposes.
 *
 * @example
 * ```typescript
 * // Using the interface for dependency injection
 * class MyComponent {
 *   constructor(private history: IHistoryManager) {}
 *
 *   addThought(thought: ThoughtData) {
 *     this.history.addThought(thought);
 *   }
 * }
 *
 * // Mock implementation for testing
 * class MockHistoryManager implements IHistoryManager {
 *   private _history: ThoughtData[] = [];
 *   addThought(thought: ThoughtData): void { this._history.push(thought); }
 *   getHistory(_sessionId: string): ThoughtData[] { return this._history; }
 *   getHistoryLength(_sessionId: string): number { return this._history.length; }
 *   getBranches(_sessionId: string): Record<string, ThoughtData[]> { return {}; }
 *   getBranchIds(_sessionId: string): string[] { return []; }
 *   async resetSession(_sessionId: string): Promise<void> { this._history = []; }
 * }
 * ```
 */
export interface IHistoryManager {
	/**
	 * Adds a thought to the history.
	 * Session is determined by the required `thought.session_id`.
	 *
	 * @param thought - The thought data to add
	 */
	addThought(thought: ThoughtData, context?: ThoughtAdmissionContext): void;

	/** Resolves a retained same-session numeric reference to stable thought identity. */
	resolveThoughtReference(sessionId: SessionId, thoughtNumber: number): ThoughtReferenceResolution;

	/**
	 * Gets the complete thought history.
	 *
	 * @param sessionId - Session ID for session-scoped results
	 * @returns An array of all thoughts in chronological order
	 */
	getHistory(sessionId: string): ThoughtData[];

	/**
	 * Gets the current length of the thought history.
	 *
	 * @param sessionId - Session ID for session-scoped results
	 * @returns The number of thoughts in history
	 */
	getHistoryLength(sessionId: string): number;

	/**
	 * Gets all branches.
	 *
	 * @param sessionId - Session ID for session-scoped results
	 * @returns A record mapping branch IDs to their thought arrays
	 */
	getBranches(sessionId: string): Record<BranchId, ThoughtData[]>;

	/**
	 * Gets all branch IDs.
	 *
	 * @param sessionId - Session ID for session-scoped results
	 * @returns An array of branch identifiers
	 */
	getBranchIds(sessionId: string): BranchId[];

	/** Awaitably clears one authorized live and durable session. */
	resetSession(sessionId: string, clearAuxiliaryState?: () => void): Promise<void>;

	/** Clears one session while the caller already owns its lifecycle exclusive. */
	resetSessionWithinExclusive(
		sessionId: SessionId,
		clearAuxiliaryState?: () => void
	): Promise<void>;

	/** Awaitably clears every live and durable session from an ownerless context. */
	resetAll(clearAuxiliaryState?: () => void): Promise<void>;

	/** Clears every session while the caller already owns the global lifecycle exclusive. */
	resetAllWithinExclusive(clearAuxiliaryState?: () => void): Promise<void>;

	/** Returns a non-mutating session snapshot without creating or binding state. */
	inspectSession(sessionId: string): HistorySessionSnapshot;

	/** Returns the currently materialized session identifiers without binding ownership. */
	getSessionIds(): string[];

	/**
	 * Gets the most recently available MCP tools from the session.
	 *
	 * @param sessionId - Session ID for session-scoped results
	 * @returns The last-seen array of MCP tool names, or undefined if never set
	 */
	getAvailableMcpTools(sessionId: string): string[] | undefined;

	/**
	 * Gets the most recently available skills from the session.
	 *
	 * @param sessionId - Session ID for session-scoped results
	 * @returns The last-seen array of skill names, or undefined if never set
	 */
	getAvailableSkills(sessionId: string): string[] | undefined;

	/**
	 * Pre-declares a branch ID without adding any thoughts.
	 * Allows merge_branch_ids to reference branches that have not yet received thoughts.
	 *
	 * @param sessionId - Session ID that owns the branch
	 * @param branchId - The branch identifier to register
	 * @throws ValidationError if branchId is empty or already exists
	 */
	registerBranch(sessionId: string, branchId: BranchId): void;

	/**
	 * Checks whether a branch exists (has thoughts OR was pre-declared).
	 *
	 * @param sessionId - Session ID that owns the branch
	 * @param branchId - The branch identifier to check
	 * @returns true if the branch exists or has been registered
	 */
	branchExists(sessionId: string, branchId: BranchId): boolean;

	/**
	 * Access the EdgeStore, if configured.
	 *
	 * Returns undefined when DAG edges are not enabled.
	 * Used by ThoughtProcessor to build StrategyContext.
	 *
	 * @returns The edge store, or undefined if not configured
	 */
	getEdgeStore(): IEdgeStore | undefined;
}
