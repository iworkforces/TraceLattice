/**
 * Joinable coordinator for attributable persistence work.
 *
 * @module PersistenceBuffer
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import type { PersistenceWork, PersistenceWorkToken } from '../contracts/persistence-work.js';
import type { PersistenceBacklogView } from '../contracts/persistence-backlog.js';
import {
	PersistenceBacklogFullError,
	PersistenceDrainError,
	PersistenceSessionAdmissionClosedError,
	PersistenceSessionBarrierReentrancyError,
	PersistenceWriteTimeoutError,
} from './PersistenceBufferErrors.js';
import { ServerStopTimeoutError } from '../errors.js';
import { callWithinDeadline, type PersistenceCallOutcome } from './PersistenceCallDeadline.js';
import { SessionLifecycleClosedError } from './SessionErrors.js';
import type { SessionFailurePhase } from './SessionLifecycleCoordinator.js';
import { PersistenceQuarantine } from './PersistenceQuarantine.js';
import {
	PersistenceWriteGate,
	timedOutClearCall,
	type StalledCall,
} from './PersistenceWriteGate.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { assertNever } from '../utils.js';
import type { Summary } from './compression/Summary.js';
import type { DurableIdentitySession } from './DurableThoughtIdentityIndex.js';
import type { Edge } from './graph/Edge.js';
import {
	PersistenceWorkQueue,
	type PersistenceRetrySchedule,
	type PersistenceSelectionMode,
} from './PersistenceWorkQueue.js';
import {
	PersistenceWriter,
	type PersistenceDelay,
	type PersistenceRetryAdmission,
	type PersistenceWriteResult,
} from './PersistenceWriter.js';
import type { ThoughtData } from './thought.js';

/** Event emitter contract for persistence error events. */
export interface PersistenceEventEmitter {
	emit(event: 'persistenceError', payload: { operation: string; error: Error }): boolean;
}

/** Observable persistence state relevant to safe in-memory session eviction. */
export type SessionEvictionState = 'quiescent' | 'pending' | 'failed' | 'barrier';

/** Options for {@link PersistenceBuffer.withSessionEvictionBarrier}. */
export interface SessionEvictionBarrierOptions {
	/**
	 * Retry of a failed eviction: waits for the session's work with background selection, so it
	 * sends nothing outside the retry backoff, and rejects while the session holds any retained
	 * failure.
	 * @default false
	 */
	readonly retry?: boolean;
}

/** Time source for background retry backoff. */
export interface PersistenceClock {
	now(): number;
}

/** Configuration options for {@link PersistenceBuffer}. */
export interface PersistenceBufferConfig {
	readonly persistence: PersistenceBackend;
	readonly bufferSize: number;
	readonly flushInterval: number;
	readonly maxRetries: number;
	/** Optional emitter for `persistenceError` events. */
	readonly eventEmitter?: PersistenceEventEmitter | null;
	readonly logger?: Logger;
	/** Optional retry scheduler for deterministic coordination and testing. */
	readonly delay?: PersistenceDelay;
	/**
	 * Clock that gates background retries of retained failures. A retained failure becomes
	 * eligible for timer and size-triggered drains `min(flushInterval * 2^(n-1), 60000)` ms after
	 * its n-th terminal failure; explicit drains retry it at once.
	 * @default Date.now
	 */
	readonly clock?: PersistenceClock;
	readonly durableHistorySize?: number;
	readonly persistBranches?: boolean;
	/**
	 * Per-session limit on unacknowledged thought and backtrack writes, terminal failures
	 * included. Enforced by {@link PersistenceBuffer.assertThoughtBacklogAvailable}.
	 * @default 10000
	 */
	readonly maxPendingThoughtsPerSession?: number;
	/** Deadline per backend write in milliseconds; `undefined` waits without a deadline. */
	readonly writeTimeout?: number;
}

const DEFAULT_MAX_PENDING_THOUGHTS_PER_SESSION = 10_000;
const MAX_BACKGROUND_RETRY_BACKOFF_MS = 60_000;
const SYSTEM_CLOCK: PersistenceClock = Object.freeze({ now: () => Date.now() });

function backgroundRetrySchedule(
	clock: PersistenceClock,
	flushInterval: number
): PersistenceRetrySchedule {
	return {
		now: () => clock.now(),
		backoffAfter: (failures) =>
			Math.min(flushInterval * 2 ** (failures - 1), MAX_BACKGROUND_RETRY_BACKOFF_MS),
	};
}

type ActiveDrain = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
	readonly selectedTokens: Set<PersistenceWorkToken>;
	mode: PersistenceSelectionMode;
	backgroundObserved: boolean;
	retainedNewFailure: boolean;
	stalledWrite: PersistenceWriteTimeoutError | null;
	/** Whether the stalled write is retained as failed; `false` when a newer version replaced it. */
	stalledWriteRetained: boolean;
	/** Oldest stall of the closed gate that stopped this generation before its work ran out. */
	gateError: PersistenceWriteTimeoutError | null;
	inFlightWork: PersistenceWork | null;
	settlement: DrainSettlement | null;
};

type SessionBarrierState = {
	tail: Promise<void>;
	pendingOwners: number;
};

type DrainTermination =
	{ readonly kind: 'result' } | { readonly kind: 'fault'; readonly fault: unknown };

type DrainSettlement =
	{ readonly kind: 'resolved' } | { readonly kind: 'rejected'; readonly reason: unknown };

type SessionQuiescence =
	| { readonly kind: 'pending' }
	| { readonly kind: 'resolved' }
	| { readonly kind: 'rejected'; readonly reason: unknown };

/**
 * Coordinates one globally joinable persistence generation at a time.
 *
 * Accepted work is owned by a queue independent of live session state. Explicit
 * callers can join and upgrade a background generation without starting another writer.
 */
export class PersistenceBuffer {
	private readonly _bufferSize: number;
	private readonly _flushInterval: number;
	private readonly _maxPendingThoughtsPerSession: number;
	private readonly _queue: PersistenceWorkQueue;
	private readonly _writer: PersistenceWriter;
	private _eventEmitter: PersistenceEventEmitter | null;
	private readonly _logger: Logger;

	private _flushTimer: ReturnType<typeof setInterval> | null = null;
	private _activeDrain: ActiveDrain | null = null;
	/** While closed, no backend call is dispatched: at most one call is ever in flight. */
	private readonly _writeGate = new PersistenceWriteGate();
	private readonly _sessionBarriers = new Map<SessionId, SessionBarrierState>();
	private readonly _sessionBarrierOwnership = new AsyncLocalStorage<ReadonlySet<SessionId>>();
	private readonly _sessionProgressWaiters = new Map<SessionId, Set<() => void>>();
	private readonly _quarantine = new PersistenceQuarantine();
	private _globalResetTail: Promise<void> = Promise.resolve();
	private _globalResetOwners = 0;
	private _globalQuarantined = false;
	/** Set by {@link closeForShutdown}: no buffering, trigger, backlog drain or barrier afterwards. */
	private _shutdownSealed = false;
	/** Set once a bounded shutdown flush settles or overruns: no backend call is dispatched. */
	private _dispatchSealed = false;

	/**
	 * Creates a persistence-drain coordinator.
	 *
	 * @param config - Persistence dependencies, trigger thresholds, and retry policy.
	 */
	public constructor(config: PersistenceBufferConfig) {
		this._queue = new PersistenceWorkQueue(
			config.durableHistorySize,
			config.persistBranches,
			backgroundRetrySchedule(config.clock ?? SYSTEM_CLOCK, config.flushInterval)
		);
		this._bufferSize = config.bufferSize;
		this._flushInterval = config.flushInterval;
		this._maxPendingThoughtsPerSession =
			config.maxPendingThoughtsPerSession ?? DEFAULT_MAX_PENDING_THOUGHTS_PER_SESSION;
		this._eventEmitter = config.eventEmitter ?? null;
		this._logger = config.logger ?? new NullLogger();
		this._writer = new PersistenceWriter({
			persistence: config.persistence,
			maxRetries: config.maxRetries,
			delay: config.delay,
			writeTimeout: config.writeTimeout,
			admitRetry: () => this._retryAdmitted(),
		});
	}

	/** @returns The underlying flush timer for lifecycle introspection. */
	public get timer(): ReturnType<typeof setInterval> | null {
		return this._flushTimer;
	}

	/** @returns Whether a global drain generation is active. */
	public get isFlushing(): boolean {
		return this._activeDrain !== null;
	}

	/** @returns Number of accepted thought writes not yet acknowledged successful. */
	public get pendingThoughtCount(): number {
		return this._queue.pendingThoughtCount;
	}

	public hasThoughtIdentity(sessionId: SessionId, thoughtId: ThoughtId): boolean {
		return this._queue.hasThoughtIdentity(sessionId, thoughtId);
	}

	public replaceDurableThoughtIdentities(sessions: readonly DurableIdentitySession[]): void {
		this._queue.replaceDurableThoughtIdentities(sessions);
	}

	/**
	 * Sets or clears the persistence error event emitter.
	 *
	 * @param emitter - Replacement emitter, or `null` to disable events.
	 */
	public setEventEmitter(emitter: PersistenceEventEmitter | null): void {
		this._eventEmitter = emitter;
	}

	/**
	 * Accepts a thought with authoritative session attribution.
	 *
	 * Never rejects on backlog: callers enforce the per-session limit before they mutate state
	 * with {@link assertThoughtBacklogAvailable}.
	 *
	 * @param sessionId - Session that owns the accepted thought.
	 * @param thought - Thought to persist.
	 */
	public bufferThought(sessionId: SessionId, thought: ThoughtData): void {
		this._assertSessionAdmissionOpen(sessionId);
		this._queue.enqueueThought(sessionId, thought);
		if (this._queue.pendingThoughtCount >= this._bufferSize) this._triggerBackgroundDrain();
	}

	public bufferBacktrack(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): void {
		this._assertSessionAdmissionOpen(sessionId);
		this._queue.enqueueBacktrack(sessionId, thought, targetThoughtId);
		if (this._queue.pendingThoughtCount >= this._bufferSize) this._triggerBackgroundDrain();
	}

	/**
	 * Accepts the latest snapshot for one session-owned branch.
	 *
	 * @param sessionId - Session that owns the branch.
	 * @param branchId - Stable branch coordinate.
	 * @param thoughts - Branch snapshot copied by the queue.
	 */
	public bufferBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): void {
		this._assertSessionAdmissionOpen(sessionId);
		this._queue.replaceBranch(sessionId, branchId, thoughts);
	}

	/**
	 * @param sessionId - Session that owns the branch.
	 * @param branchId - Stable branch coordinate to delete.
	 */
	public deleteBranch(sessionId: SessionId, branchId: BranchId): void {
		this._assertSessionAdmissionOpen(sessionId);
		this._queue.deleteBranch(sessionId, branchId);
	}

	/**
	 * Accepts the latest edge snapshot for one session.
	 *
	 * @param sessionId - Session that owns the edges.
	 * @param edges - Edge snapshot copied by the queue.
	 */
	public bufferEdges(sessionId: SessionId, edges: readonly Edge[]): void {
		this._assertSessionAdmissionOpen(sessionId);
		this._queue.replaceEdges(sessionId, edges);
	}

	/**
	 * Accepts the latest summary snapshot for one session.
	 *
	 * @param sessionId - Session that owns the summaries.
	 * @param summaries - Summary snapshot copied by the queue.
	 */
	public bufferSummaries(sessionId: SessionId, summaries: readonly Summary[]): void {
		this._assertSessionAdmissionOpen(sessionId);
		this._queue.replaceSummaries(sessionId, summaries);
	}

	/** Rejects synchronously when lifecycle coordination has closed persistence admission. */
	public assertSessionAdmissionOpen(sessionId: SessionId): void {
		this._assertSessionAdmissionOpen(sessionId);
	}

	/**
	 * Rejects synchronously when the session already holds its limit of unacknowledged thought
	 * and backtrack writes, terminal failures included.
	 *
	 * At the limit this starts or joins an explicit drain without awaiting it, so retained
	 * failures are retried and a later call succeeds once the backend recovers. Call it before
	 * any session state changes: {@link bufferThought} and {@link bufferBacktrack} never reject.
	 *
	 * @param sessionId - Session whose thought backlog is checked.
	 * @throws {@link PersistenceBacklogFullError} when the session is at its limit.
	 */
	public assertThoughtBacklogAvailable(sessionId: SessionId): void {
		this._assertNotSealed(sessionId);
		const pending = this._queue.pendingThoughtCountForSession(sessionId);
		if (pending < this._maxPendingThoughtsPerSession) return;
		void this._joinOrStart('explicit').promise.catch(() => undefined);
		this._logger.warn('Persistence backlog full, rejecting thought', {
			sessionId,
			pending,
			limit: this._maxPendingThoughtsPerSession,
		});
		throw new PersistenceBacklogFullError(sessionId, pending, this._maxPendingThoughtsPerSession);
	}

	/** Starts the periodic background-drain timer without keeping the process alive. */
	public startFlushTimer(): void {
		if (this._flushTimer !== null) return;
		this._flushTimer = setInterval(() => this._triggerBackgroundDrain(), this._flushInterval);
		if (typeof this._flushTimer === 'object' && 'unref' in this._flushTimer) {
			this._flushTimer.unref();
		}
	}

	/** Stops the periodic background-drain timer. */
	public stopFlushTimer(): void {
		if (this._flushTimer === null) return;
		clearInterval(this._flushTimer);
		this._flushTimer = null;
	}

	/**
	 * Starts or joins an explicit global drain generation.
	 *
	 * @returns The exact shared promise for the active generation.
	 */
	public drain(): Promise<void> {
		return this._joinOrStart('explicit').promise;
	}

	/** @returns The exact same promise as {@link drain} for the active generation. */
	public flush(): Promise<void> {
		return this.drain();
	}

	/**
	 * Seals the buffer for shutdown, then drains the work accepted before the seal.
	 *
	 * Callers stage everything the shutdown must persist first. Once sealed, `buffer*` calls,
	 * `assertSessionAdmissionOpen`, backlog checks and session barriers throw
	 * `SessionLifecycleClosedError` (phase `shutting_down`) without touching the queue, and timer
	 * and size triggers start nothing. Without `timeoutMs` the drain is unbounded. With it, dispatch
	 * is sealed as soon as the drain settles or the bound elapses, so no backend call starts after
	 * this method settles; at the bound it rejects with `ServerStopTimeoutError('flush', timeoutMs,
	 * pending)`, where `pending` counts queued and failed writes, and the abandoned generation stops
	 * once its in-flight call settles, rejecting rather than resolving for work it did not send.
	 *
	 * @param timeoutMs - Optional flush bound in milliseconds, at most 2147483647.
	 */
	public async closeForShutdown(timeoutMs?: number): Promise<void> {
		this._shutdownSealed = true;
		this.stopFlushTimer();
		if (timeoutMs === undefined) return this.drain();
		const outcome = await callWithinDeadline(() => this.drain(), timeoutMs);
		this._dispatchSealed = true;
		switch (outcome.kind) {
			case 'fulfilled':
				return;
			case 'rejected':
				throw outcome.reason;
			case 'timedOut':
				throw new ServerStopTimeoutError('flush', timeoutMs, this._queue.pendingWorkCount);
			default:
				assertNever(outcome);
		}
	}

	/**
	 * Joins the global explicit generation and projects its terminal failures to one session.
	 * This method does not close admission; lifecycle owners must use
	 * {@link withSessionBarrier} when work must not cross an owner callback.
	 *
	 * @param sessionId - Session whose accepted writes form the barrier projection.
	 * @returns A promise that rejects only for that session's failures or an unknown fault.
	 */
	public drainSession(sessionId: SessionId): Promise<void> {
		const generation = this._joinOrStart('explicit');
		return generation.promise.catch((reason: unknown) => {
			const failure = this._sessionDrainFailure(generation, sessionId, reason);
			if (failure !== undefined) throw failure;
		});
	}

	/**
	 * Projects a generation's rejection to one session. A write deadline rejects the session only
	 * while it still has queued or failed work, or while a pending stall belongs to it.
	 */
	private _sessionDrainFailure(
		generation: ActiveDrain,
		sessionId: SessionId,
		reason: unknown
	): unknown {
		if (reason instanceof PersistenceDrainError) {
			const failures = reason.failures.filter((failure) => failure.sessionId === sessionId);
			if (failures.length > 0) return new PersistenceDrainError(failures);
		} else if (!(reason instanceof PersistenceWriteTimeoutError)) {
			return reason;
		}
		const owned = this._writeGate.oldestErrorOf(sessionId);
		if (owned !== undefined) return owned;
		const timeout =
			reason instanceof PersistenceWriteTimeoutError
				? reason
				: (generation.stalledWrite ?? generation.gateError);
		return timeout !== null && this._queue.hasSessionWork(sessionId) ? timeout : undefined;
	}

	/** Returns queue-derived persistence state for safe session eviction planning. */
	public sessionEvictionState(sessionId: SessionId): SessionEvictionState {
		if (this._globalResetOwners > 0 || this._sessionBarriers.has(sessionId)) return 'barrier';
		if (
			this._globalQuarantined ||
			this._queue.hasSessionTerminalFailure(sessionId) ||
			this._quarantine.has(sessionId)
		) {
			return 'failed';
		}
		return this._queue.hasSessionWork(sessionId) ? 'pending' : 'quiescent';
	}

	/**
	 * Whether a sweep may retry the failed eviction of `sessionId` now. Not while the session
	 * holds a retained write failure, a timed-out backend call is pending or a reset clear is in
	 * flight, a barrier or reset owns it, or a failed reset quarantined it: a retry then could
	 * only fail again or resend writes outside their backoff.
	 */
	public canRetryEviction(sessionId: SessionId): boolean {
		return !(
			this._shutdownSealed ||
			this._dispatchBlocked() ||
			this._globalResetOwners > 0 ||
			this._globalQuarantined ||
			this._sessionBarriers.has(sessionId) ||
			this._quarantine.hasResetFailure(sessionId) ||
			this._queue.hasSessionTerminalFailure(sessionId)
		);
	}

	/**
	 * Quarantines a session that its lifecycle exclusive left failed, also when the failure
	 * happened before any barrier of this buffer ran: an invalid reset, or capacity eviction.
	 */
	public quarantineFailedSession(sessionId: SessionId, phase: SessionFailurePhase): void {
		if (phase === 'reset_failed') this._quarantine.addResetFailure(sessionId);
		else this._quarantine.addEvictionFailure(sessionId);
	}

	/**
	 * Drains accepted session work before ordinary in-memory eviction cleanup.
	 *
	 * Unlike reset barriers, this operation never clears durable state or discards
	 * accepted work. Failure retains admission quarantine until a later invocation
	 * successfully drains and completes cleanup, or a reset succeeds.
	 */
	public withSessionEvictionBarrier<T>(
		sessionId: SessionId,
		operation: () => Promise<T>,
		options: SessionEvictionBarrierOptions = {}
	): Promise<T> {
		if (
			this._globalResetOwners > 0 ||
			this._globalQuarantined ||
			this._quarantine.hasResetFailure(sessionId)
		) {
			return Promise.reject(new PersistenceSessionAdmissionClosedError(sessionId));
		}
		const currentOwnership = this._sessionBarrierOwnership.getStore();
		if (currentOwnership?.has(sessionId) === true) {
			return Promise.reject(new PersistenceSessionBarrierReentrancyError(sessionId));
		}
		const operationOwnership = new Set(currentOwnership);
		operationOwnership.add(sessionId);
		const state = this._sessionBarriers.get(sessionId) ?? {
			tail: Promise.resolve(),
			pendingOwners: 0,
		};
		this._sessionBarriers.set(sessionId, state);
		state.pendingOwners += 1;

		const result = state.tail.then(async () => {
			try {
				await this._awaitSessionQuiescence(
					sessionId,
					options.retry === true ? 'background' : 'explicit'
				);
				const value = await this._sessionBarrierOwnership.run(operationOwnership, operation);
				this._queue.forgetQuiescentSession(sessionId);
				this._quarantine.liftEvictionFailure(sessionId);
				return value;
			} catch (error) {
				this._quarantine.addEvictionFailure(sessionId);
				throw error;
			} finally {
				state.pendingOwners -= 1;
				if (state.pendingOwners === 0) this._sessionBarriers.delete(sessionId);
			}
		});
		state.tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/** Forgets queue coordinates only when the session is fully quiescent. */
	public forgetQuiescentSession(sessionId: SessionId): boolean {
		return this.sessionEvictionState(sessionId) === 'quiescent'
			? this._queue.forgetQuiescentSession(sessionId)
			: false;
	}

	/**
	 * Runs one lifecycle operation while persistence admission is closed for a session.
	 *
	 * Admission closes synchronously when this method is called. Already accepted work for
	 * the session is settled first; an exhausted session failure rejects without invoking
	 * `operation`. Concurrent calls for the same session execute in FIFO call order and keep
	 * admission closed until the final callback settles. Other sessions remain admissible and
	 * may be owned by a nested callback. Reacquiring the same session from the owning callback's
	 * async call chain rejects before joining the FIFO because awaiting it would deadlock its owner.
	 *
	 * @example
	 * ```ts
	 * await buffer.withSessionBarrier(sessionId, async () => {
	 *   await persistence.clearSession(sessionId);
	 * });
	 * ```
	 *
	 * @param sessionId - Session exclusively owned for the callback duration.
	 * @param operation - Awaited lifecycle operation run only after prior work settles.
	 * @returns The callback result after admission has reopened when no owner remains.
	 * @throws {@link PersistenceSessionBarrierReentrancyError} when the owning async call chain
	 * attempts to reacquire `sessionId`.
	 */
	public withSessionBarrier<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		const currentOwnership = this._sessionBarrierOwnership.getStore();
		if (currentOwnership?.has(sessionId) === true) {
			return Promise.reject(new PersistenceSessionBarrierReentrancyError(sessionId));
		}
		const operationOwnership = new Set(currentOwnership);
		operationOwnership.add(sessionId);

		const state = this._sessionBarriers.get(sessionId) ?? {
			tail: Promise.resolve(),
			pendingOwners: 0,
		};
		this._sessionBarriers.set(sessionId, state);
		state.pendingOwners += 1;

		const result = state.tail.then(async () => {
			try {
				await this._awaitSessionQuiescence(sessionId);
				return await this._sessionBarrierOwnership.run(operationOwnership, operation);
			} finally {
				state.pendingOwners -= 1;
				if (state.pendingOwners === 0) this._sessionBarriers.delete(sessionId);
			}
		});
		state.tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/**
	 * Runs a scoped reset, retaining admission quarantine on failure.
	 * A retry may pass retained write failures because successful durable deletion
	 * invalidates those stale queue entries before admission reopens.
	 */
	public withSessionResetBarrier<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		if (this._globalResetOwners > 0 || this._globalQuarantined) {
			return Promise.reject(new PersistenceSessionAdmissionClosedError(sessionId));
		}
		const currentOwnership = this._sessionBarrierOwnership.getStore();
		if (currentOwnership?.has(sessionId) === true) {
			return Promise.reject(new PersistenceSessionBarrierReentrancyError(sessionId));
		}
		const operationOwnership = new Set(currentOwnership);
		operationOwnership.add(sessionId);
		const state = this._sessionBarriers.get(sessionId) ?? {
			tail: Promise.resolve(),
			pendingOwners: 0,
		};
		this._sessionBarriers.set(sessionId, state);
		state.pendingOwners += 1;

		const result = state.tail.then(async () => {
			try {
				try {
					await this._awaitSessionQuiescence(sessionId);
				} catch (error) {
					if (!(error instanceof PersistenceDrainError)) throw error;
				}
				return await this._runResetOperation(
					sessionId,
					() => this._sessionBarrierOwnership.run(operationOwnership, operation),
					() => {
						this._queue.discardSession(sessionId);
						this._quarantine.lift(sessionId);
					}
				);
			} catch (error) {
				this._quarantine.addResetFailure(sessionId);
				throw error;
			} finally {
				state.pendingOwners -= 1;
				if (state.pendingOwners === 0) this._sessionBarriers.delete(sessionId);
			}
		});
		state.tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/** Runs a trusted global reset behind a global admission barrier. */
	public withGlobalResetBarrier<T>(operation: () => Promise<T>): Promise<T> {
		this._globalResetOwners += 1;
		const prior = this._globalResetTail;
		const result = prior.then(async () => {
			try {
				await Promise.all(Array.from(this._sessionBarriers.values(), (state) => state.tail));
				try {
					await this.drain();
				} catch (error) {
					if (!(error instanceof PersistenceDrainError)) throw error;
				}
				this._assertWriteGateOpen();
				return await this._runResetOperation(undefined, operation, () => {
					this._queue.discardAll();
					this._quarantine.liftAll();
					this._globalQuarantined = false;
				});
			} catch (error) {
				this._globalQuarantined = true;
				throw error;
			} finally {
				this._globalResetOwners -= 1;
			}
		});
		this._globalResetTail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/** @returns A frozen point-in-time view of quarantine and unflushed work for readiness probes. */
	public getBacklogView(): PersistenceBacklogView {
		return Object.freeze({
			globalQuarantined: this._globalQuarantined,
			quarantinedSessionCount: this._quarantine.resetFailedCount,
			evictionRetrySessionCount: this._quarantine.evictionRetryCount,
			blockedSessionCount: this._queue.blockedSessionCount,
			retainedFailureCount: this._queue.currentFailures().length,
			pendingThoughtCount: this._queue.pendingThoughtCount,
		});
	}

	private _joinOrStart(mode: PersistenceSelectionMode): ActiveDrain {
		const active = this._activeDrain;
		if (active !== null) {
			if (mode === 'explicit') active.mode = mode;
			return active;
		}

		const generation = this._createGeneration(mode);
		const gateError = this._writeGate.oldestError();
		if (gateError !== undefined) {
			generation.settlement = { kind: 'rejected', reason: gateError };
			generation.reject(gateError);
			return generation;
		}
		this._activeDrain = generation;
		void this._runDrain(generation).catch((fault: unknown) => {
			this._closeGeneration(generation, { kind: 'fault', fault });
		});
		return generation;
	}

	private _createGeneration(mode: PersistenceSelectionMode): ActiveDrain {
		let resolveGeneration = (): void => undefined;
		let rejectGeneration = (_reason: unknown): void => undefined;
		const promise = new Promise<void>((resolve, reject) => {
			resolveGeneration = resolve;
			rejectGeneration = reject;
		});
		return {
			promise,
			resolve: resolveGeneration,
			reject: rejectGeneration,
			selectedTokens: new Set<PersistenceWorkToken>(),
			mode,
			backgroundObserved: false,
			retainedNewFailure: false,
			stalledWrite: null,
			stalledWriteRetained: false,
			gateError: null,
			inFlightWork: null,
			settlement: null,
		};
	}

	private _triggerBackgroundDrain(): void {
		if (this._shutdownSealed || this._dispatchBlocked()) return;
		const generation = this._joinOrStart('background');
		if (generation.backgroundObserved) return;
		generation.backgroundObserved = true;
		void generation.promise.catch(() => undefined);
	}

	private async _runDrain(generation: ActiveDrain): Promise<void> {
		while (true) {
			while (this._writeGate.clearInFlight && !this._writeGate.isClosed) {
				await this._writeGate.clearsSettled();
			}
			if (this._dispatchBlocked()) {
				generation.gateError = this._writeGate.oldestError() ?? null;
				this._closeGeneration(generation, { kind: 'result' });
				return;
			}
			const work = this._queue.nextEligibleWork(generation.selectedTokens, generation.mode);
			if (work === undefined) {
				this._closeGeneration(generation, { kind: 'result' });
				return;
			}

			generation.inFlightWork = work;
			const result = await this._writer.write(work);
			this._acknowledge(generation, work, result);
			generation.inFlightWork = null;
			this._notifySessionProgress();
		}
	}

	private _acknowledge(
		generation: ActiveDrain,
		work: PersistenceWork,
		result: PersistenceWriteResult
	): void {
		if (result === true) {
			this._queue.acknowledgeSuccess(work);
			return;
		}
		if (this._queue.acknowledgeFailure(work, result)) generation.retainedNewFailure = true;
		if (result.cause instanceof PersistenceWriteTimeoutError) {
			generation.stalledWriteRetained = this._queue.isRetainedFailure(work);
			this._closeWriteGate(generation, { kind: 'work', work, error: result.cause });
		}
	}

	/**
	 * Background generations report a failure only when it is first retained, not per retry.
	 * A timed-out write that left nothing retained, because a newer version replaced it, is
	 * reported once by the generation that dispatched it.
	 */
	private _reportsFailures(generation: ActiveDrain): boolean {
		return (
			generation.mode === 'explicit' ||
			generation.retainedNewFailure ||
			(generation.stalledWrite !== null && !generation.stalledWriteRetained)
		);
	}

	/**
	 * Single predicate read by every dispatch decision: gate closed, a clear in flight, or dispatch
	 * sealed by a bounded shutdown flush.
	 */
	private _dispatchBlocked(): boolean {
		return this._writeGate.isClosed || this._writeGate.clearInFlight || this._dispatchSealed;
	}

	/**
	 * Answers a write's retry attempt under the rules of a first dispatch. While a clear is in
	 * flight and the gate is open the answer is that clear's settlement, and the writer asks again
	 * afterwards. Otherwise the answer is final and synchronous, so a reset that waited on the same
	 * clear cannot start its own clear between an admission and the writer's dispatch.
	 */
	private _retryAdmitted(): PersistenceRetryAdmission {
		if (this._writeGate.clearInFlight && !this._writeGate.isClosed) {
			return this._writeGate.clearsSettled();
		}
		return !this._dispatchBlocked();
	}

	private _closeWriteGate(
		generation: ActiveDrain,
		stalled: Extract<StalledCall, { kind: 'work' }>
	): void {
		generation.stalledWrite = stalled.error;
		this._logger.warn('Persistence write timed out; later writes wait until it settles', {
			sessionId: stalled.work.sessionId,
			kind: stalled.work.kind,
			token: stalled.work.token,
			timeoutMs: stalled.error.timeoutMs,
		});
		this._holdGateUntilSettled(stalled);
	}

	/**
	 * Runs a reset barrier's operation, its backend clear, as the only clear in flight, and
	 * applies `commit` on success. No write is dispatched until both are done, so a retained
	 * write of the reset scope cannot land after the clear. A clear that outlived the write
	 * deadline keeps running, so it then closes the gate like a stalled write until its real
	 * outcome settles. A reset that waited behind another clear across the shutdown seal is
	 * refused before its clear starts, as a failed reset of `sessionId` (undefined: global).
	 */
	private async _runResetOperation<T>(
		sessionId: SessionId | undefined,
		operation: () => Promise<T>,
		commit: () => void
	): Promise<T> {
		while (this._writeGate.clearInFlight) await this._writeGate.clearsSettled();
		if (this._shutdownSealed) throw new SessionLifecycleClosedError(sessionId, 'shutting_down');
		this._assertWriteGateOpen();
		const finishClear = this._writeGate.beginClear();
		try {
			const value = await operation();
			commit();
			return value;
		} catch (error) {
			this._closeWriteGateOnClear(error);
			throw error;
		} finally {
			finishClear();
			this._notifySessionProgress();
		}
	}

	private _closeWriteGateOnClear(error: unknown): void {
		if (!(error instanceof PersistenceWriteTimeoutError) || this._writeGate.holds(error)) return;
		const call = timedOutClearCall(error);
		if (call !== undefined) this._holdGateUntilSettled({ kind: 'clear', call, error });
	}

	private _holdGateUntilSettled(stalled: StalledCall): void {
		this._writeGate.close(stalled);
		void stalled.error.lateOutcome.then((outcome) => this._reopenWriteGate(stalled, outcome));
	}

	/**
	 * Applies the real outcome of a timed-out write once, through the queue's token checks.
	 * A settled clear touches no queue entry and lifts no reset or eviction quarantine.
	 */
	private _reopenWriteGate(stalled: StalledCall, outcome: PersistenceCallOutcome): void {
		switch (stalled.kind) {
			case 'work':
				this._applyLateWriteOutcome(stalled.work, outcome);
				break;
			case 'clear':
				this._logger.info('Timed-out persistence reset clear settled', {
					...stalled.call,
					outcome: outcome.kind,
				});
				break;
			default:
				assertNever(stalled);
		}
		this._writeGate.settle(stalled);
		this._notifySessionProgress();
	}

	private _applyLateWriteOutcome(work: PersistenceWork, outcome: PersistenceCallOutcome): void {
		switch (outcome.kind) {
			case 'fulfilled':
				this._queue.acknowledgeSuccess(work);
				break;
			case 'rejected':
				this._queue.replaceFailureCause(work, outcome.reason);
				break;
			default:
				assertNever(outcome);
		}
		this._logger.info('Timed-out persistence write settled', {
			sessionId: work.sessionId,
			token: work.token,
			outcome: outcome.kind,
		});
	}

	private _assertWriteGateOpen(): void {
		const gateError = this._writeGate.oldestError();
		if (gateError !== undefined) throw gateError;
	}

	private _closeGeneration(generation: ActiveDrain, termination: DrainTermination): void {
		if (this._activeDrain !== generation) return;
		let settlement: DrainSettlement;
		switch (termination.kind) {
			case 'result':
				settlement = this._generationSettlement(generation);
				break;
			case 'fault':
				settlement = { kind: 'rejected', reason: termination.fault };
				break;
			default:
				assertNever(termination);
		}

		generation.inFlightWork = null;
		generation.settlement = settlement;
		this._activeDrain = null;
		this._notifySessionProgress();
		switch (settlement.kind) {
			case 'resolved':
				generation.resolve();
				return;
			case 'rejected':
				generation.reject(settlement.reason);
				if (
					(settlement.reason instanceof PersistenceDrainError ||
						(settlement.reason instanceof PersistenceWriteTimeoutError &&
							settlement.reason === generation.stalledWrite)) &&
					this._reportsFailures(generation)
				) {
					this._observeFailure(generation, settlement.reason);
				}
				return;
			default:
				assertNever(settlement);
		}
	}

	/**
	 * A generation that dispatched a timed-out write never resolves, even when no failure was
	 * retained because a newer version superseded that write while its call was in flight.
	 * Neither does one that the closed gate stopped: it rejects with the gate's oldest stall. One
	 * that the shutdown dispatch seal stopped with work still eligible rejects as lifecycle-closed.
	 */
	private _generationSettlement(generation: ActiveDrain): DrainSettlement {
		const { failures } = this._queue.generationResult(generation.selectedTokens);
		if (failures.length > 0) {
			return { kind: 'rejected', reason: new PersistenceDrainError(failures) };
		}
		const timeout = generation.stalledWrite ?? generation.gateError;
		if (timeout !== null) return { kind: 'rejected', reason: timeout };
		if (
			this._dispatchSealed &&
			this._queue.hasEligibleWork(generation.selectedTokens, generation.mode)
		) {
			return {
				kind: 'rejected',
				reason: new SessionLifecycleClosedError(undefined, 'shutting_down'),
			};
		}
		return { kind: 'resolved' };
	}

	private async _awaitSessionQuiescence(
		sessionId: SessionId,
		mode: PersistenceSelectionMode = 'explicit'
	): Promise<void> {
		const generation = this._joinOrStart(mode);
		void generation.promise.catch(() => undefined);
		while (true) {
			this._assertNotSealed(sessionId);
			const quiescence = this._sessionQuiescence(generation, sessionId);
			switch (quiescence.kind) {
				case 'pending':
					await this._waitForSessionProgress(sessionId);
					break;
				case 'resolved':
					return;
				case 'rejected':
					throw quiescence.reason;
				default:
					return assertNever(quiescence);
			}
		}
	}

	private _sessionQuiescence(generation: ActiveDrain, sessionId: SessionId): SessionQuiescence {
		const gateError = this._writeGate.oldestError();
		if (gateError !== undefined) return { kind: 'rejected', reason: gateError };
		if (
			generation.settlement?.kind === 'rejected' &&
			!(generation.settlement.reason instanceof PersistenceDrainError)
		) {
			return { kind: 'rejected', reason: generation.settlement.reason };
		}
		if (generation.inFlightWork?.sessionId === sessionId) return { kind: 'pending' };
		if (this._queue.hasEligibleWork(generation.selectedTokens, generation.mode, sessionId)) {
			return { kind: 'pending' };
		}

		// A background generation skips failures still in backoff, so it counts every retained one.
		const failures = this._queue.currentFailures(
			generation.mode === 'background' ? undefined : generation.selectedTokens,
			sessionId
		);
		if (failures.length > 0)
			return { kind: 'rejected', reason: new PersistenceDrainError(failures) };
		const blocking = this._queue.blockingFailure(sessionId);
		return blocking === undefined
			? { kind: 'resolved' }
			: { kind: 'rejected', reason: new PersistenceDrainError([blocking]) };
	}

	private _waitForSessionProgress(sessionId: SessionId): Promise<void> {
		return new Promise((resolve) => {
			const waiters = this._sessionProgressWaiters.get(sessionId) ?? new Set<() => void>();
			waiters.add(resolve);
			this._sessionProgressWaiters.set(sessionId, waiters);
		});
	}

	private _notifySessionProgress(): void {
		for (const [sessionId, waiters] of this._sessionProgressWaiters) {
			this._sessionProgressWaiters.delete(sessionId);
			for (const resolve of waiters) resolve();
		}
	}

	/** Work arriving after the shutdown seal, e.g. from an abandoned operation, is refused. */
	private _assertNotSealed(sessionId: SessionId): void {
		if (this._shutdownSealed) throw new SessionLifecycleClosedError(sessionId, 'shutting_down');
	}

	private _assertSessionAdmissionOpen(sessionId: SessionId): void {
		this._assertNotSealed(sessionId);
		if (
			this._globalResetOwners > 0 ||
			this._globalQuarantined ||
			this._sessionBarriers.has(sessionId) ||
			this._quarantine.has(sessionId)
		) {
			throw new PersistenceSessionAdmissionClosedError(sessionId);
		}
	}

	private _observeFailure(
		generation: ActiveDrain,
		error: PersistenceDrainError | PersistenceWriteTimeoutError
	): void {
		this._logger.info('Persistence drain completed with failures', {
			failed: error instanceof PersistenceDrainError ? error.failures.length : 0,
			selected: generation.selectedTokens.size,
		});
		this._eventEmitter?.emit('persistenceError', { operation: 'flushBuffer', error });
	}
}
