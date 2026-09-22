/**
 * History and branch management for sequential thinking.
 *
 * This module provides the `HistoryManager` class which manages thought history,
 * branching, and optional persistence with per-session state isolation.
 *
 * Internally delegates to three focused collaborators:
 * - `EdgeEmitter` — DAG edge emission
 * - `PersistenceBuffer` — buffered persistence + retry/backoff
 * - `SessionManager` — session lifecycle (TTL/LRU eviction)
 *
 * @module HistoryManager
 */

import type { IEdgeStore, IMetrics, ISessionLock } from '../contracts/interfaces.js';
import { asSessionId, type BranchId, type SessionId, type ThoughtId } from '../contracts/ids.js';
import type { ISummaryStore } from '../contracts/summary.js';
import {
	ERROR_CODES,
	InvalidBacktrackError,
	MaxSessionsReachedError,
	SequentialThinkingError,
	ValidationError,
} from '../errors.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import {
	DehydrationPolicy,
	type DehydrationOptions,
	type HydratedEntry,
} from './compression/DehydrationPolicy.js';
import type { Summary } from './compression/Summary.js';
import { SessionAccessDeniedError } from './SessionErrors.js';
import { EdgeEmitter } from './graph/EdgeEmitter.js';
import type {
	HistorySessionSnapshot,
	IHistoryManager,
	ThoughtAdmissionContext,
} from './IHistoryManager.js';
import { PersistenceBuffer, type PersistenceEventEmitter } from './PersistenceBuffer.js';
import { SessionManager } from './SessionManager.js';
import { SessionResetCoordinator } from './SessionResetCoordinator.js';
import { stagePersistenceRestore, type RestoredSession } from './PersistenceRestore.js';
import type { ThoughtData } from './thought.js';
import { getOwner } from '../context/RequestContext.js';
import { ThoughtReferenceIndex, type ThoughtReferenceResolution } from './ThoughtReferenceIndex.js';
import { resolveThoughtReferencesForAdmission } from './CrossReferenceValidator.js';
import { SessionLifecycleCoordinator } from './SessionLifecycleCoordinator.js';
import { resolvedVerificationTarget } from './evaluator/VerificationLinks.js';
import { reconstructVerificationTargets } from './VerificationTargetRestore.js';

/** Absolute maximum history size (~20MB at 2KB/thought). Cannot be overridden. */
export const ABSOLUTE_MAX_HISTORY_SIZE = 10_000;

interface SessionState {
	thought_history: ThoughtData[];
	branches: Record<string, ThoughtData[]>;
	verificationTargets: Map<ThoughtId, ThoughtId>;
	availableMcpTools: string[] | undefined;
	availableSkills: string[] | undefined;
	lastAccessedAt: number;
	branchIdentities: Set<BranchId>;
	pendingRestoreBranchDeletes: Set<BranchId>;
	/** Owner identifier set on first owner-aware access. Immutable thereafter. */
	owner?: string;
	/** Non-persisted startup provenance used to block unverified network ownership. */
	provenance?: 'restored';
}

export interface HistoryManagerConfig {
	/** Maximum number of thoughts to keep in main history. @default 1000 */
	maxHistorySize?: number;
	/** Maximum number of branches to maintain. @default 50 */
	maxBranches?: number;
	/** Maximum size of each branch. @default 100 */
	maxBranchSize?: number;
	logger?: Logger;
	persistence?: PersistenceBackend | null;
	metrics?: IMetrics;
	/** Maximum number of thoughts to buffer before flushing. @default 100 */
	persistenceBufferSize?: number;
	/** Periodic flush interval in ms. @default 1000 */
	persistenceFlushInterval?: number;
	/** Max retries for failed persistence flushes. @default 3 */
	persistenceMaxRetries?: number;
	persistenceHistorySize?: number;
	persistBranches?: boolean;
	eventEmitter?: PersistenceEventEmitter;
	edgeStore?: IEdgeStore;
	summaryStore?: ISummaryStore;
	/** Whether to emit DAG edges (gated independently of edgeStore). @default false */
	dagEdges?: boolean;
	/** Maximum sessions per owner (per-owner LRU bucket). @default 50 */
	maxSessionsPerOwner?: number;
	/** Shared processor lock used to serialize session resets. */
	sessionLock?: ISessionLock;
	/** Shared admission and exclusive lifecycle coordinator. */
	lifecycleCoordinator?: SessionLifecycleCoordinator;
	/** Clears processor-owned state after a session is actually removed. */
	clearSessionAuxiliaryState?: (sessionId: SessionId) => void;
	/** Clears all processor-owned state after a successful global lifecycle operation. */
	clearAllAuxiliaryState?: () => void;
}

/**
 * Manages thought history and branching for sequential thinking.
 *
 * Owns the per-session `Map<string, SessionState>`. Delegates DAG edge emission,
 * buffered persistence, and session TTL/LRU eviction to focused collaborators while
 * preserving test-coupled private member names (`_flushTimer`, `_startFlushTimer`,
 * `_flushBuffer`, `_sessions`).
 */
export class HistoryManager implements IHistoryManager {
	private static readonly SESSION_TTL_MS = 30 * 60 * 1000;
	private static readonly MAX_SESSIONS = 100;
	private _sessions: Map<SessionId, SessionState> = new Map();
	private _maxHistorySize: number;
	private _maxBranches: number;
	private _maxBranchSize: number;
	private _logger: Logger;
	private _persistence: PersistenceBackend | null;
	private _persistenceEnabled: boolean;
	private _metrics?: IMetrics;

	private _edgeStore?: IEdgeStore;
	private _summaryStore?: ISummaryStore;
	private _dagEdges: boolean;

	private _eventEmitter: PersistenceEventEmitter | null;

	private readonly _edgeEmitter: EdgeEmitter;
	private _referenceIndex = new ThoughtReferenceIndex();
	private _persistenceBuffer: PersistenceBuffer | null;
	private readonly _sessionManager: SessionManager<SessionState>;
	private readonly _resetCoordinator: SessionResetCoordinator<SessionState>;
	private readonly _sessionLock?: ISessionLock;
	private readonly _lifecycle: SessionLifecycleCoordinator;
	private _shutdownOwner: (() => Promise<void>) | null = null;
	private readonly _clearSessionAuxiliaryState?: (sessionId: SessionId) => void;
	private readonly _clearAllAuxiliaryState?: () => void;

	constructor(config: HistoryManagerConfig = {}) {
		this._logger = config.logger ?? new NullLogger();
		const requestedMaxSize = config.maxHistorySize ?? 10000;
		this._maxHistorySize = Math.min(requestedMaxSize, ABSOLUTE_MAX_HISTORY_SIZE);
		if (requestedMaxSize > ABSOLUTE_MAX_HISTORY_SIZE) {
			this._logger.warn('maxHistorySize exceeds absolute maximum, capped', {
				requested: requestedMaxSize,
				applied: ABSOLUTE_MAX_HISTORY_SIZE,
			});
		}
		this._maxBranches = config.maxBranches ?? 50;
		this._maxBranchSize = config.maxBranchSize || 100;
		this._persistence = config.persistence ?? null;
		this._persistenceEnabled = this._persistence !== null;
		this._metrics = config.metrics;
		this._eventEmitter = config.eventEmitter ?? null;
		this._edgeStore = config.edgeStore;
		this._summaryStore = config.summaryStore;
		this._dagEdges = config.dagEdges ?? true;
		this._sessionLock = config.sessionLock;
		this._lifecycle = config.lifecycleCoordinator ?? new SessionLifecycleCoordinator();
		this._clearSessionAuxiliaryState = config.clearSessionAuxiliaryState;
		this._clearAllAuxiliaryState = config.clearAllAuxiliaryState;

		// Wire delegates
		this._edgeEmitter = new EdgeEmitter({
			edgeStore: this._edgeStore,
			dagEdges: this._dagEdges,
			logger: this._logger,
		});

		this._sessionManager = new SessionManager<SessionState>({
			sessionTtlMs: HistoryManager.SESSION_TTL_MS,
			cleanupIntervalMs: 5 * 60 * 1000,
			getMaxSessions: () => HistoryManager.MAX_SESSIONS,
			maxSessionsPerOwner: config.maxSessionsPerOwner ?? 50,
			logger: this._logger,
		});

		this._persistenceBuffer = null;
		if (this._persistenceEnabled && this._persistence) {
			this._persistenceBuffer = new PersistenceBuffer({
				persistence: this._persistence,
				bufferSize: config.persistenceBufferSize ?? 100,
				flushInterval: config.persistenceFlushInterval ?? 1000,
				maxRetries: config.persistenceMaxRetries ?? 3,
				durableHistorySize: config.persistenceHistorySize ?? ABSOLUTE_MAX_HISTORY_SIZE,
				persistBranches: config.persistBranches ?? true,
				eventEmitter: this._eventEmitter,
				logger: this._logger,
			});
			this._startFlushTimer();
		}
		const resetDurability =
			this._persistence === null || this._persistenceBuffer === null
				? { persistence: null, barrier: null }
				: { persistence: this._persistence, barrier: this._persistenceBuffer };
		this._resetCoordinator = new SessionResetCoordinator({
			...resetDurability,
			edgeStore: this._edgeStore,
			summaryStore: this._summaryStore,
			sessions: this._sessions,
			createSessionState: (owner) => this._createSessionState(owner),
			logger: this._logger,
		});

		this._sessionManager.startCleanupTimer(
			this._sessions,
			(sessionId) => this._isTtlEvictionEligible(sessionId),
			(sessionIds) => this._evictSessions(sessionIds)
		);
	}

	// Test-coupled accessors: these private member names must remain reachable
	// via `manager as unknown as { _flushTimer; _startFlushTimer }`.
	private get _flushTimer(): ReturnType<typeof setInterval> | null {
		return this._persistenceBuffer?.timer ?? null;
	}

	private _startFlushTimer(): void {
		this._persistenceBuffer?.startFlushTimer();
	}

	private _stopFlushTimer(): void {
		if (this._flushTimer === null) return;
		this._persistenceBuffer?.stopFlushTimer();
	}

	/** @internal Public for test coupling. */
	public _flushBuffer(): Promise<void> {
		this._stageAllRestoreBranchReconciliation();
		return this._persistenceBuffer?.flush() ?? Promise.resolve();
	}

	/**
	 * Drains accepted persistence work and projects terminal failures to one session.
	 *
	 * @param sessionId - Authoritative session whose persistence barrier to await.
	 * @returns A promise that settles when the session's accepted work settles.
	 */
	public drainSession(sessionId: SessionId): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session !== undefined) this._stageRestoreBranchReconciliation(sessionId, session);
		return this._persistenceBuffer?.drainSession(sessionId) ?? Promise.resolve();
	}

	/**
	 * Registers the latest summary snapshot for coordinator-owned persistence.
	 *
	 * @param sessionId - Authoritative session that owns the summaries.
	 * @param summaries - Complete current summary snapshot for the session.
	 */
	public bufferSummaries(sessionId: SessionId, summaries: readonly Summary[]): void {
		this._lifecycle.runMutation(sessionId, () => {
			this._persistenceBuffer?.bufferSummaries(sessionId, summaries);
			const session = this._sessions.get(sessionId);
			if (session !== undefined) this._stageRestoreBranchReconciliation(sessionId, session);
		});
	}

	/** EdgeStore instance, if configured. Used by ThoughtProcessor for StrategyContext. */
	public getEdgeStore(): IEdgeStore | undefined {
		return this._edgeStore;
	}

	private log(message: string, meta?: Record<string, unknown>): void {
		this._logger.info(message, meta);
	}

	/** Reads owner from RequestContext (AsyncLocalStorage). Stdio path returns undefined. */
	private _getCurrentOwner(): string | undefined {
		return getOwner();
	}

	/**
	 * Gets or creates session state; updates lastAccessedAt.
	 *
	 * Ownership semantics:
	 * - `owner === undefined` (stdio path): never rejects, never sets owner.
	 * - `owner !== undefined`: if session has a different owner, throws
	 *   `SessionAccessDeniedError`. If session was created without an owner
	 *   (e.g. by stdio), the owner is set on first owner-aware access.
	 */
	private _getSession(sessionId: string, owner?: string): SessionState {
		const key = asSessionId(sessionId);
		const existing = this._sessions.get(key);
		if (existing !== undefined) {
			this._assertSessionOwner(key, existing, owner);
			existing.lastAccessedAt = Date.now();
			return existing;
		}
		return this._lifecycle.runMutation(key, () => this._getSessionWithinOperation(key, owner));
	}

	private _getSessionWithinOperation(key: SessionId, owner?: string): SessionState {
		let session = this._sessions.get(key);
		if (!session) {
			this._makeCapacityForSession(owner);
			session = this._createSessionState(owner);
			this._sessions.set(key, session);
		} else {
			this._assertSessionOwner(key, session, owner);
		}
		session.lastAccessedAt = Date.now();
		return session;
	}

	private _assertSessionOwner(
		sessionId: SessionId,
		session: SessionState,
		owner: string | undefined
	): void {
		if (owner === undefined) return;
		if (session.provenance === 'restored') {
			throw new SessionAccessDeniedError(sessionId, 'unavailable', owner);
		}
		if (session.owner !== undefined && session.owner !== owner) {
			throw new SessionAccessDeniedError(sessionId, session.owner, owner);
		}
		if (session.owner === undefined) session.owner = owner;
	}

	private _makeCapacityForSession(owner: string | undefined): void {
		const victims = this._sessionManager.planProspectiveAdmission(
			this._sessions,
			owner,
			(sessionId) => this._isCapacityEvictionEligible(sessionId)
		);
		if (victims === undefined) throw new MaxSessionsReachedError(HistoryManager.MAX_SESSIONS);
		if (victims.length === 0) return;
		const evicted = this._lifecycle.tryEvictIdleSessions(victims, (sessionIds) => {
			if (sessionIds.some((sessionId) => !this._isPersistenceQuiescent(sessionId))) {
				throw new MaxSessionsReachedError(HistoryManager.MAX_SESSIONS);
			}
			for (const sessionId of sessionIds) this._removeLiveSession(sessionId);
		});
		if (!evicted) throw new MaxSessionsReachedError(HistoryManager.MAX_SESSIONS);
	}

	private _isCapacityEvictionEligible(sessionId: SessionId): boolean {
		return this._lifecycle.isIdle(sessionId) && this._isPersistenceQuiescent(sessionId);
	}

	private _isTtlEvictionEligible(sessionId: SessionId): boolean {
		const persistenceState =
			this._persistenceBuffer?.sessionEvictionState(sessionId) ?? 'quiescent';
		return (
			this._lifecycle.isIdle(sessionId) &&
			persistenceState !== 'failed' &&
			persistenceState !== 'barrier'
		);
	}

	private _isPersistenceQuiescent(sessionId: SessionId): boolean {
		return (
			(this._persistenceBuffer?.sessionEvictionState(sessionId) ?? 'quiescent') === 'quiescent'
		);
	}

	private async _evictSessions(sessionIds: readonly SessionId[]): Promise<void> {
		const results = await Promise.allSettled(
			sessionIds.map((sessionId) => this._evictSession(sessionId))
		);
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : []
		);
		if (failures.length > 0) throw new AggregateError(failures, 'Session eviction failed');
	}

	private _evictSession(sessionId: SessionId): Promise<void> {
		return this._lifecycle.withSessionEviction(sessionId, async () => {
			if (this._persistenceBuffer === null) {
				this._removeLiveSession(sessionId);
				return;
			}
			const session = this._sessions.get(sessionId);
			if (session !== undefined) this._stageRestoreBranchReconciliation(sessionId, session);
			await this._persistenceBuffer.withSessionEvictionBarrier(sessionId, async () => {
				this._removeLiveSession(sessionId);
			});
		});
	}

	private _removeLiveSession(sessionId: SessionId): void {
		this._clearSessionAuxiliaryState?.(sessionId);
		this._edgeStore?.clearSession(sessionId);
		this._summaryStore?.clearSession(sessionId);
		this._referenceIndex.clearSession(sessionId);
		this._sessions.delete(sessionId);
		this._persistenceBuffer?.forgetQuiescentSession(sessionId);
	}

	private _createSessionState(owner?: string, provenance?: 'restored'): SessionState {
		return {
			thought_history: [],
			branches: {},
			verificationTargets: new Map<ThoughtId, ThoughtId>(),
			availableMcpTools: undefined,
			availableSkills: undefined,
			lastAccessedAt: Date.now(),
			branchIdentities: new Set<BranchId>(),
			pendingRestoreBranchDeletes: new Set<BranchId>(),
			owner,
			provenance,
		};
	}

	private _authorizeExistingSession(
		sessionId: SessionId,
		owner: string | undefined
	): string | undefined {
		const sessionOwner = this._sessions.get(sessionId)?.owner;
		if (owner !== undefined && this._sessions.get(sessionId)?.provenance === 'restored') {
			throw new SessionAccessDeniedError(sessionId, 'unavailable', owner);
		}
		if (owner !== undefined && sessionOwner !== undefined && sessionOwner !== owner) {
			throw new SessionAccessDeniedError(sessionId, sessionOwner, owner);
		}
		return sessionOwner ?? owner;
	}

	private _assertOwnerlessResetAll(): void {
		const owner = this._getCurrentOwner();
		if (owner === undefined) return;
		const firstSessionId = this._sessions.keys().next().value;
		if (firstSessionId !== undefined) {
			throw new SessionAccessDeniedError(firstSessionId, 'trusted ownerless context', owner);
		}
		throw new SequentialThinkingError(
			`Access denied to all sessions: trusted ownerless context required, accessed by '${owner}'`,
			ERROR_CODES.SESSION_ACCESS_DENIED
		);
	}

	/**
	 * Adds a thought to the history. Routes per-session, applies retraction for backtrack,
	 * caches tools/skills, trims, branches, emits DAG edges, and buffers for persistence.
	 */
	public addThought(thought: ThoughtData, context?: ThoughtAdmissionContext): void {
		const sessionId = asSessionId(thought.session_id);
		this._lifecycle.runMutation(sessionId, () =>
			this._addThoughtWithinOperation(sessionId, thought, context)
		);
	}

	public assertThoughtIdentityAvailable(thought: ThoughtData): void {
		if (thought.id === undefined) return;
		const sessionId = asSessionId(thought.session_id);
		this._authorizeExistingSession(sessionId, this._getCurrentOwner());
		if (
			this._referenceIndex.has(sessionId, thought.id) ||
			this._persistenceBuffer?.hasThoughtIdentity(sessionId, thought.id) === true
		) {
			throw new ValidationError('id', `Thought id already exists in session: ${thought.id}`);
		}
	}

	private _addThoughtWithinOperation(
		sessionId: SessionId,
		thought: ThoughtData,
		context?: ThoughtAdmissionContext
	): void {
		this._persistenceBuffer?.assertSessionAdmissionOpen(sessionId);
		const owner = this._getCurrentOwner();
		this._authorizeExistingSession(sessionId, owner);
		this.assertThoughtIdentityAvailable(thought);
		const resolvedReferences = this._resolveAdmissionReferences(sessionId, thought, context);
		const session = this._getSessionWithinOperation(sessionId, owner);
		this._metrics?.counter(
			'thought_requests_total',
			1,
			{},
			'Total thought requests added to history'
		);

		session.thought_history.push(thought);
		this._recordVerificationTarget(session, thought, resolvedReferences);

		// Logical retraction: when a backtrack thought is added, mark its target
		// as retracted (append-only — target remains in history).
		if (resolvedReferences.backtrackTargetThoughtId !== undefined) {
			this._applyRetraction(session, resolvedReferences.backtrackTargetThoughtId);
		}

		// Cache available_mcp_tools/available_skills for cross-call persistence
		if (thought.available_mcp_tools) {
			session.availableMcpTools = thought.available_mcp_tools;
		}
		if (thought.available_skills) {
			session.availableSkills = thought.available_skills;
		}

		if (thought.branch_from_thought && thought.branch_id) {
			this._addToSessionBranch(session, thought.branch_id, thought);
		}

		if (thought.merge_from_thoughts?.length || thought.merge_branch_ids?.length) {
			this._metrics?.counter(
				'thought_merge_operations_total',
				1,
				{},
				'Total merge operations (graph topology)'
			);
		}

		const edgeAdded = this._edgeEmitter.emitEdgesForThought(session, thought, {
			...context,
			resolvedReferences,
		});
		const evictedBranchIds = this._enforceRetention(session, thought.branch_id);
		this._pruneVerificationTargets(session);
		this._rebuildReferenceIndex(sessionId, session);
		const prunedEdges = this._pruneUnretainedEdges(sessionId, session);
		this._bufferRetainedState(
			sessionId,
			session,
			thought,
			evictedBranchIds,
			edgeAdded,
			prunedEdges,
			resolvedReferences.backtrackTargetThoughtId
		);
	}

	private _resolveAdmissionReferences(
		sessionId: SessionId,
		thought: ThoughtData,
		context?: ThoughtAdmissionContext
	): NonNullable<ThoughtAdmissionContext['resolvedReferences']> {
		const resolved =
			context?.resolvedReferences ??
			resolveThoughtReferencesForAdmission(thought, (thoughtNumber) =>
				this._referenceIndex.resolve(sessionId, thoughtNumber)
			);
		if (
			thought.thought_type === 'backtrack' &&
			thought.backtrack_target !== undefined &&
			resolved.backtrackTargetThoughtId === undefined
		) {
			throw new InvalidBacktrackError(
				`backtrack_target ${thought.backtrack_target} is missing in session history`
			);
		}
		return resolved;
	}

	private _enforceRetention(
		session: SessionState,
		branchId: BranchId | undefined
	): readonly BranchId[] {
		if (session.thought_history.length > this._maxHistorySize) {
			session.thought_history = session.thought_history.slice(-this._maxHistorySize);
			this.log(`History trimmed to ${this._maxHistorySize} items`, {
				maxSize: this._maxHistorySize,
			});
		}
		if (branchId !== undefined) this._trimSessionBranchSize(session, branchId);
		return this._cleanupSessionBranches(session);
	}

	private _recordVerificationTarget(
		session: SessionState,
		thought: ThoughtData,
		references: NonNullable<ThoughtAdmissionContext['resolvedReferences']>
	): void {
		const targetId = resolvedVerificationTarget(thought, references);
		if (thought.id !== undefined && targetId !== undefined) {
			session.verificationTargets.set(thought.id, targetId);
		}
	}

	private _pruneVerificationTargets(session: SessionState): void {
		const retainedIds = new Set(
			[session.thought_history, ...Object.values(session.branches)]
				.flat()
				.flatMap((thought) => (thought.id === undefined ? [] : [thought.id]))
		);
		for (const [verifierId, targetId] of session.verificationTargets) {
			if (!retainedIds.has(verifierId) || !retainedIds.has(targetId)) {
				session.verificationTargets.delete(verifierId);
			}
		}
	}

	private _pruneUnretainedEdges(sessionId: SessionId, session: SessionState): number {
		if (this._edgeStore === undefined) return 0;
		const retainedIds = new Set<ThoughtId>();
		const retainedBranchThoughtIds = new Set<ThoughtId>();
		for (const thought of [session.thought_history, ...Object.values(session.branches)].flat()) {
			if (thought.id !== undefined) retainedIds.add(thought.id);
		}
		for (const thought of Object.values(session.branches).flat()) {
			if (thought.id !== undefined) retainedBranchThoughtIds.add(thought.id);
		}
		return this._edgeStore.pruneSession(sessionId, retainedIds, retainedBranchThoughtIds);
	}

	private _bufferRetainedState(
		sessionId: SessionId,
		session: SessionState,
		thought: ThoughtData,
		evictedBranchIds: readonly BranchId[],
		edgeAdded: boolean,
		prunedEdges: number,
		backtrackTargetThoughtId?: ThoughtId
	): void {
		const buffer = this._persistenceBuffer;
		if (buffer === null) return;
		if (backtrackTargetThoughtId === undefined) buffer.bufferThought(sessionId, thought);
		else buffer.bufferBacktrack(sessionId, thought, backtrackTargetThoughtId);
		if (
			thought.branch_id !== undefined ||
			backtrackTargetThoughtId !== undefined ||
			evictedBranchIds.length > 0 ||
			session.pendingRestoreBranchDeletes.size > 0
		) {
			this._stageBranchPersistence(sessionId, session, evictedBranchIds);
		}
		if (this._edgeStore !== undefined && (edgeAdded || prunedEdges > 0)) {
			buffer.bufferEdges(sessionId, this._edgeStore.edgesForSession(sessionId));
		}
	}

	private _stageAllRestoreBranchReconciliation(): void {
		for (const [sessionId, session] of this._sessions) {
			this._stageRestoreBranchReconciliation(sessionId, session);
		}
	}

	private _stageRestoreBranchReconciliation(sessionId: SessionId, session: SessionState): void {
		if (session.pendingRestoreBranchDeletes.size === 0) return;
		this._stageBranchPersistence(sessionId, session, []);
	}

	private _stageBranchPersistence(
		sessionId: SessionId,
		session: SessionState,
		ordinaryDeletes: readonly BranchId[]
	): void {
		const buffer = this._persistenceBuffer;
		if (buffer === null) return;
		for (const branchId of session.branchIdentities) {
			const branch = session.branches[branchId];
			if (branch !== undefined) buffer.bufferBranch(sessionId, branchId, branch);
		}
		const branchIdsToDelete = new Set([...session.pendingRestoreBranchDeletes, ...ordinaryDeletes]);
		for (const branchId of branchIdsToDelete) {
			if (session.branches[branchId] === undefined) buffer.deleteBranch(sessionId, branchId);
		}
		session.pendingRestoreBranchDeletes.clear();
	}

	/** Marks the thought as retracted within the session (append-only). */
	private _applyRetraction(session: SessionState, targetId: ThoughtId): void {
		for (const t of session.thought_history) {
			if (t.id === targetId) t.retracted = true;
		}
		for (const branchThoughts of Object.values(session.branches)) {
			for (const t of branchThoughts) {
				if (t.id === targetId) t.retracted = true;
			}
		}
	}

	private _rebuildReferenceIndex(sessionId: SessionId, session: SessionState): void {
		const retained = [session.thought_history, ...Object.values(session.branches)].flat();
		this._referenceIndex.replaceSession(sessionId, retained);
	}

	public resolveThoughtReference(
		sessionId: SessionId,
		thoughtNumber: number
	): ThoughtReferenceResolution {
		this._authorizeExistingSession(sessionId, this._getCurrentOwner());
		return this._referenceIndex.resolve(sessionId, thoughtNumber);
	}

	private _addToSessionBranch(
		session: SessionState,
		branchId: BranchId,
		thought: ThoughtData
	): void {
		if (!session.branches[branchId]) {
			session.branches[branchId] = [];
		}
		session.branchIdentities.add(branchId);
		session.branches[branchId].push(thought);
	}

	private _cleanupSessionBranches(session: SessionState): readonly BranchId[] {
		const branchCount = session.branchIdentities.size;
		if (branchCount <= this._maxBranches) return [];
		const identitiesToRemove = Array.from(session.branchIdentities).slice(
			0,
			branchCount - this._maxBranches
		);
		const branchesToDelete: BranchId[] = [];
		for (const branchId of identitiesToRemove) {
			session.branchIdentities.delete(branchId);
			if (session.branches[branchId] !== undefined) branchesToDelete.push(branchId);
			delete session.branches[branchId];
			this.log(`Removed old branch: ${branchId}`, { branchId });
		}
		return branchesToDelete;
	}

	private _trimSessionBranchSize(session: SessionState, branchId: BranchId): void {
		const branch = session.branches[branchId];
		if (branch !== undefined && branch.length > this._maxBranchSize) {
			const removed = branch.length - this._maxBranchSize;
			session.branches[branchId] = branch.slice(-this._maxBranchSize);
			this.log(`Trimmed branch '${branchId}': removed ${removed} old thoughts`, {
				branchId,
				removed,
			});
		}
	}

	public getHistory(sessionId: string): ThoughtData[] {
		return this._getSession(sessionId, this._getCurrentOwner()).thought_history;
	}

	/**
	 * Returns history with optional sliding-window dehydration. Non-mutating: when
	 * `dagEdges` is off OR no `ISummaryStore` is configured, returns same as getHistory.
	 */
	public getHistoryHydrated(sessionId: string, opts?: DehydrationOptions): HydratedEntry[] {
		const history = this.getHistory(sessionId);
		if (!this._dagEdges || !this._summaryStore) {
			return history.slice();
		}
		const policy = new DehydrationPolicy(this._summaryStore);
		return policy.apply(history, asSessionId(sessionId), opts);
	}

	public getHistoryLength(sessionId: string): number {
		return this._getSession(sessionId, this._getCurrentOwner()).thought_history.length;
	}

	public getBranches(sessionId: string): Record<BranchId, ThoughtData[]> {
		return this._getSession(sessionId, this._getCurrentOwner()).branches;
	}

	public getBranchIds(sessionId: string): BranchId[] {
		return Array.from(this._getSession(sessionId, this._getCurrentOwner()).branchIdentities);
	}

	/** Returns validation state without creating a session, binding an owner, or updating LRU data. */
	public inspectSession(sessionId: string): HistorySessionSnapshot {
		const canonicalSessionId = asSessionId(sessionId);
		this._authorizeExistingSession(canonicalSessionId, this._getCurrentOwner());
		const session = this._sessions.get(canonicalSessionId);
		if (session === undefined) {
			return {
				history: [],
				branches: {},
				verificationTargets: new Map(),
				branchIds: [],
				availableMcpTools: undefined,
				availableSkills: undefined,
			};
		}
		return {
			history: [...session.thought_history],
			branches: Object.fromEntries(
				Object.entries(session.branches).map(([branchId, thoughts]) => [branchId, [...thoughts]])
			) as Record<BranchId, readonly ThoughtData[]>,
			verificationTargets: new Map(session.verificationTargets),
			branchIds: Array.from(session.branchIdentities),
			availableMcpTools:
				session.availableMcpTools === undefined ? undefined : [...session.availableMcpTools],
			availableSkills:
				session.availableSkills === undefined ? undefined : [...session.availableSkills],
		};
	}

	/** @throws {ValidationError} If branchId is empty or already exists. */
	public registerBranch(sessionId: string, branchId: BranchId): void {
		if (typeof branchId !== 'string' || branchId.length === 0) {
			throw new ValidationError('branch_id', 'branch_id must be a non-empty string');
		}
		const canonicalSessionId = asSessionId(sessionId);
		this._lifecycle.runMutation(canonicalSessionId, () => {
			this._persistenceBuffer?.assertSessionAdmissionOpen(canonicalSessionId);
			const session = this._getSessionWithinOperation(canonicalSessionId, this._getCurrentOwner());
			if (session.branchIdentities.has(branchId)) {
				throw new ValidationError('branch_id', `Branch already exists: ${branchId}`);
			}
			session.branchIdentities.add(branchId);
			const evictedBranchIds = this._cleanupSessionBranches(session);
			this._rebuildReferenceIndex(canonicalSessionId, session);
			const prunedEdges = this._pruneUnretainedEdges(canonicalSessionId, session);
			if (evictedBranchIds.length > 0 || session.pendingRestoreBranchDeletes.size > 0) {
				this._stageBranchPersistence(canonicalSessionId, session, evictedBranchIds);
			}
			if (this._edgeStore !== undefined && prunedEdges > 0) {
				this._persistenceBuffer?.bufferEdges(
					canonicalSessionId,
					this._edgeStore.edgesForSession(canonicalSessionId)
				);
			}
			this.log('Registered branch', { branchId, sessionId });
		});
	}

	public branchExists(sessionId: string, branchId: BranchId): boolean {
		const session = this._getSession(sessionId, this._getCurrentOwner());
		return session.branchIdentities.has(branchId);
	}

	public getAvailableMcpTools(sessionId: string): string[] | undefined {
		return this._getSession(sessionId, this._getCurrentOwner()).availableMcpTools;
	}

	public getAvailableSkills(sessionId: string): string[] | undefined {
		return this._getSession(sessionId, this._getCurrentOwner()).availableSkills;
	}

	public getBranch(branchId: BranchId, sessionId: string): ThoughtData[] | undefined {
		return this._getSession(sessionId, this._getCurrentOwner()).branches[branchId];
	}

	/** Awaitably deletes one authorized durable namespace before replacing its live state. */
	public async resetSession(sessionId: string, clearAuxiliaryState?: () => void): Promise<void> {
		const canonicalSessionId = asSessionId(sessionId);
		this._authorizeExistingSession(canonicalSessionId, this._getCurrentOwner());
		await this._lifecycle.withSessionReset(canonicalSessionId, async () => {
			const reset = async (): Promise<void> =>
				await this.resetSessionWithinExclusive(canonicalSessionId, clearAuxiliaryState);
			if (this._sessionLock === undefined) return await reset();
			await this._sessionLock.withLock(canonicalSessionId, reset);
		});
	}

	/** Performs scoped reset work while its lifecycle exclusive is already owned. */
	public async resetSessionWithinExclusive(
		sessionId: SessionId,
		clearAuxiliaryState?: () => void
	): Promise<void> {
		const preservedOwner = this._authorizeExistingSession(sessionId, this._getCurrentOwner());
		await this._resetCoordinator.resetSession(
			sessionId,
			preservedOwner,
			clearAuxiliaryState ??
				(this._clearSessionAuxiliaryState === undefined
					? undefined
					: () => this._clearSessionAuxiliaryState?.(sessionId))
		);
		this._referenceIndex.clearSession(sessionId);
	}

	/** Awaitably deletes all durable namespaces from a trusted ownerless context. */
	public async resetAll(clearAuxiliaryState?: () => void): Promise<void> {
		this._assertOwnerlessResetAll();
		await this._lifecycle.withGlobalReset(
			async () => await this.resetAllWithinExclusive(clearAuxiliaryState)
		);
	}

	/** Performs global reset work while its lifecycle exclusive is already owned. */
	public async resetAllWithinExclusive(clearAuxiliaryState?: () => void): Promise<void> {
		this._assertOwnerlessResetAll();
		await this._resetCoordinator.resetAll(clearAuxiliaryState ?? this._clearAllAuxiliaryState);
		this._referenceIndex.clearAll();
	}

	public getSessionIds(): string[] {
		return Array.from(this._sessions.keys());
	}

	public getSessionCount(): number {
		return this._sessions.size;
	}

	private _restoredState(restored: RestoredSession): SessionState {
		const session = this._createSessionState(undefined, 'restored');
		session.verificationTargets = reconstructVerificationTargets(
			restored.sessionId,
			restored.history,
			restored.branches
		);
		for (let index = restored.history.length - 1; index >= 0; index--) {
			const thought = restored.history[index];
			if (thought === undefined) continue;
			if (session.availableMcpTools === undefined && thought.available_mcp_tools !== undefined) {
				session.availableMcpTools = [...thought.available_mcp_tools];
			}
			if (session.availableSkills === undefined && thought.available_skills !== undefined) {
				session.availableSkills = [...thought.available_skills];
			}
			if (session.availableMcpTools !== undefined && session.availableSkills !== undefined) break;
		}
		session.thought_history = restored.history.slice(-this._maxHistorySize);
		const retainedStart = Math.max(0, restored.branches.length - this._maxBranches);
		const retainedBranches = restored.branches.slice(retainedStart);
		for (const branch of restored.branches.slice(0, retainedStart)) {
			session.pendingRestoreBranchDeletes.add(branch.branchId);
		}
		for (const branch of retainedBranches) {
			session.branchIdentities.add(branch.branchId);
			session.branches[branch.branchId] = branch.thoughts.slice(-this._maxBranchSize);
		}
		this._pruneVerificationTargets(session);
		return session;
	}

	/** Loads and atomically commits every authoritative persistence namespace. Call at init. */
	public async loadFromPersistence(): Promise<void> {
		if (!this._persistenceEnabled || !this._persistence) {
			return;
		}

		const restored = await stagePersistenceRestore(this._persistence);
		const sessions = restored.sessions.map(
			(session) => [session.sessionId, this._restoredState(session)] as const
		);
		const referenceIndex = new ThoughtReferenceIndex();
		const retainedThoughtIds = new Map<SessionId, ReadonlySet<ThoughtId>>();
		const retainedBranchThoughtIds = new Map<SessionId, ReadonlySet<ThoughtId>>();
		for (const [sessionId, session] of sessions) {
			const retained = [session.thought_history, ...Object.values(session.branches)].flat();
			referenceIndex.replaceSession(sessionId, retained);
			retainedThoughtIds.set(
				sessionId,
				new Set(retained.flatMap((thought) => (thought.id === undefined ? [] : [thought.id])))
			);
			retainedBranchThoughtIds.set(
				sessionId,
				new Set(
					Object.values(session.branches).flatMap((branch) =>
						branch.flatMap((thought) => (thought.id === undefined ? [] : [thought.id]))
					)
				)
			);
		}
		this._persistenceBuffer?.replaceDurableThoughtIdentities(restored.sessions);

		this._edgeStore?.clearAll();
		this._summaryStore?.clearAll();
		this._sessions.clear();
		for (const [sessionId, session] of sessions) this._sessions.set(sessionId, session);
		this._referenceIndex = referenceIndex;
		for (const session of restored.sessions) {
			const retainedIds = retainedThoughtIds.get(session.sessionId) ?? new Set<ThoughtId>();
			const retainedBranchIds =
				retainedBranchThoughtIds.get(session.sessionId) ?? new Set<ThoughtId>();
			for (const edge of session.edges) {
				if (!retainedIds.has(edge.from) || !retainedIds.has(edge.to)) continue;
				if (edge.kind === 'branch' && !retainedBranchIds.has(edge.to)) continue;
				this._edgeStore?.addEdge(edge);
			}
			for (const summary of session.summaries) this._summaryStore?.add(summary);
		}
		this.log(`Restored ${restored.sessions.length} persistence namespaces`);
	}

	public isPersistenceEnabled(): boolean {
		return this._persistenceEnabled;
	}

	public getPersistenceBackend(): PersistenceBackend | null {
		return this._persistence;
	}

	/** Sets the event emitter for persistence error events (post-construction wiring). */
	public setEventEmitter(emitter: PersistenceEventEmitter): void {
		this._eventEmitter = emitter;
		this._persistenceBuffer?.setEventEmitter(emitter);
	}

	/**
	 * Binds shutdown to the resource owner responsible for the complete cleanup sequence.
	 *
	 * @internal
	 * @param owner - Callback returning the owner's memoized shutdown promise.
	 * @throws {TypeError} When a shutdown owner has already been bound.
	 */
	public bindShutdownOwner(owner: () => Promise<void>): void {
		if (this._shutdownOwner !== null) {
			throw new TypeError('HistoryManager shutdown owner is already bound');
		}
		this._shutdownOwner = owner;
	}

	/** Stops timers, drains writes, and clears live state under one memoized lifecycle settlement. */
	public shutdown(): Promise<void> {
		if (this._shutdownOwner !== null) return this._shutdownOwner();
		return this._lifecycle.shutdown(async () => {
			await this.shutdownWithinLifecycle();
			this.clearLiveStateAfterShutdown();
		});
	}

	/** Stops timers and drains writes while the caller owns global shutdown. */
	public async shutdownWithinLifecycle(): Promise<void> {
		this._stopFlushTimer();
		this._sessionManager.stopCleanupTimer();
		await this._flushBuffer();
	}

	/** Clears non-durable state after every shutdown resource has closed successfully. */
	public clearLiveStateAfterShutdown(): void {
		for (const sessionId of this._sessions.keys()) {
			this._persistenceBuffer?.forgetQuiescentSession(sessionId);
		}
		this._sessions.clear();
		this._referenceIndex.clearAll();
		this._edgeStore?.clearAll();
		this._summaryStore?.clearAll();
		this._clearAllAuxiliaryState?.();
	}

	/** Number of coordinator-owned thought writes not yet acknowledged successful. */
	public getWriteBufferLength(): number {
		return this._persistenceBuffer?.pendingThoughtCount ?? 0;
	}
}
