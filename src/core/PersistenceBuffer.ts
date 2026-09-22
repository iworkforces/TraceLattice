/**
 * Joinable coordinator for attributable persistence work.
 *
 * @module PersistenceBuffer
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import type { PersistenceWork, PersistenceWorkToken } from '../contracts/persistence-work.js';
import {
	PersistenceDrainError,
	PersistenceSessionAdmissionClosedError,
	PersistenceSessionBarrierReentrancyError,
} from './PersistenceBufferErrors.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { assertNever } from '../utils.js';
import type { Summary } from './compression/Summary.js';
import type { DurableIdentitySession } from './DurableThoughtIdentityIndex.js';
import type { Edge } from './graph/Edge.js';
import { PersistenceWorkQueue, type PersistenceSelectionMode } from './PersistenceWorkQueue.js';
import { PersistenceWriter, type PersistenceDelay } from './PersistenceWriter.js';
import type { ThoughtData } from './thought.js';

/** Event emitter contract for persistence error events. */
export interface PersistenceEventEmitter {
	emit(event: 'persistenceError', payload: { operation: string; error: Error }): boolean;
}

/** Observable persistence state relevant to safe in-memory session eviction. */
export type SessionEvictionState = 'quiescent' | 'pending' | 'failed' | 'barrier';

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
	readonly durableHistorySize?: number;
	readonly persistBranches?: boolean;
}

type ActiveDrain = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
	readonly selectedTokens: Set<PersistenceWorkToken>;
	mode: PersistenceSelectionMode;
	backgroundObserved: boolean;
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
	private readonly _queue: PersistenceWorkQueue;
	private readonly _writer: PersistenceWriter;
	private _eventEmitter: PersistenceEventEmitter | null;
	private readonly _logger: Logger;

	private _flushTimer: ReturnType<typeof setInterval> | null = null;
	private _activeDrain: ActiveDrain | null = null;
	private readonly _sessionBarriers = new Map<SessionId, SessionBarrierState>();
	private readonly _sessionBarrierOwnership = new AsyncLocalStorage<ReadonlySet<SessionId>>();
	private readonly _sessionProgressWaiters = new Map<SessionId, Set<() => void>>();
	private readonly _quarantinedSessions = new Set<SessionId>();
	private readonly _evictionQuarantinedSessions = new Set<SessionId>();
	private _globalResetTail: Promise<void> = Promise.resolve();
	private _globalResetOwners = 0;
	private _globalQuarantined = false;

	/**
	 * Creates a persistence-drain coordinator.
	 *
	 * @param config - Persistence dependencies, trigger thresholds, and retry policy.
	 */
	public constructor(config: PersistenceBufferConfig) {
		this._queue = new PersistenceWorkQueue(config.durableHistorySize, config.persistBranches);
		this._bufferSize = config.bufferSize;
		this._flushInterval = config.flushInterval;
		this._eventEmitter = config.eventEmitter ?? null;
		this._logger = config.logger ?? new NullLogger();
		this._writer = new PersistenceWriter({
			persistence: config.persistence,
			maxRetries: config.maxRetries,
			delay: config.delay,
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
	 * @param sessionId - Session that owns the accepted thought.
	 * @param thought - Thought to persist.
	 */
	public bufferThought(sessionId: SessionId, thought: ThoughtData): void {
		this._assertSessionAdmissionOpen(sessionId);
		if (this._queue.pendingThoughtCount >= this._bufferSize && this.isFlushing) {
			this._logger.info('Write buffer full and flush in progress, applying backpressure', {
				bufferSize: this._queue.pendingThoughtCount,
				maxSize: this._bufferSize,
			});
		}

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
			if (!(reason instanceof PersistenceDrainError)) throw reason;
			const failures = reason.failures.filter((failure) => failure.sessionId === sessionId);
			if (failures.length > 0) throw new PersistenceDrainError(failures);
		});
	}

	/** Returns queue-derived persistence state for safe session eviction planning. */
	public sessionEvictionState(sessionId: SessionId): SessionEvictionState {
		if (this._globalResetOwners > 0 || this._sessionBarriers.has(sessionId)) return 'barrier';
		if (
			this._globalQuarantined ||
			this._queue.hasSessionTerminalFailure(sessionId) ||
			this._quarantinedSessions.has(sessionId) ||
			this._evictionQuarantinedSessions.has(sessionId)
		) {
			return 'failed';
		}
		return this._queue.hasSessionWork(sessionId) ? 'pending' : 'quiescent';
	}

	/**
	 * Drains accepted session work before ordinary in-memory eviction cleanup.
	 *
	 * Unlike reset barriers, this operation never clears durable state or discards
	 * accepted work. Failure retains admission quarantine until a later explicit
	 * invocation successfully drains and completes cleanup.
	 */
	public withSessionEvictionBarrier<T>(
		sessionId: SessionId,
		operation: () => Promise<T>
	): Promise<T> {
		if (
			this._globalResetOwners > 0 ||
			this._globalQuarantined ||
			this._quarantinedSessions.has(sessionId)
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
				await this._awaitSessionQuiescence(sessionId);
				const value = await this._sessionBarrierOwnership.run(operationOwnership, operation);
				this._queue.forgetQuiescentSession(sessionId);
				this._evictionQuarantinedSessions.delete(sessionId);
				return value;
			} catch (error) {
				this._evictionQuarantinedSessions.add(sessionId);
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
				const value = await this._sessionBarrierOwnership.run(operationOwnership, operation);
				this._queue.discardSession(sessionId);
				this._quarantinedSessions.delete(sessionId);
				this._evictionQuarantinedSessions.delete(sessionId);
				return value;
			} catch (error) {
				this._quarantinedSessions.add(sessionId);
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
				const value = await operation();
				this._queue.discardAll();
				this._quarantinedSessions.clear();
				this._evictionQuarantinedSessions.clear();
				this._globalQuarantined = false;
				return value;
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

	private _joinOrStart(mode: PersistenceSelectionMode): ActiveDrain {
		const active = this._activeDrain;
		if (active !== null) {
			if (mode === 'explicit') active.mode = mode;
			return active;
		}

		let resolveGeneration = (): void => undefined;
		let rejectGeneration = (_reason: unknown): void => undefined;
		const promise = new Promise<void>((resolve, reject) => {
			resolveGeneration = resolve;
			rejectGeneration = reject;
		});
		const generation: ActiveDrain = {
			promise,
			resolve: resolveGeneration,
			reject: rejectGeneration,
			selectedTokens: new Set<PersistenceWorkToken>(),
			mode,
			backgroundObserved: false,
			inFlightWork: null,
			settlement: null,
		};
		this._activeDrain = generation;
		void this._runDrain(generation).catch((fault: unknown) => {
			this._closeGeneration(generation, { kind: 'fault', fault });
		});
		return generation;
	}

	private _triggerBackgroundDrain(): void {
		const generation = this._joinOrStart('background');
		if (generation.backgroundObserved) return;
		generation.backgroundObserved = true;
		void generation.promise.catch(() => undefined);
	}

	private async _runDrain(generation: ActiveDrain): Promise<void> {
		while (true) {
			const work = this._queue.nextEligibleWork(generation.selectedTokens, generation.mode);
			if (work === undefined) {
				this._closeGeneration(generation, { kind: 'result' });
				return;
			}

			generation.inFlightWork = work;
			const result = await this._writer.write(work);
			if (result === true) this._queue.acknowledgeSuccess(work);
			else this._queue.acknowledgeFailure(work, result);
			generation.inFlightWork = null;
			this._notifySessionProgress();
		}
	}

	private _closeGeneration(generation: ActiveDrain, termination: DrainTermination): void {
		if (this._activeDrain !== generation) return;
		let settlement: DrainSettlement;
		switch (termination.kind) {
			case 'result': {
				const result = this._queue.generationResult(generation.selectedTokens);
				settlement =
					result.failures.length === 0
						? { kind: 'resolved' }
						: { kind: 'rejected', reason: new PersistenceDrainError(result.failures) };
				break;
			}
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
				if (settlement.reason instanceof PersistenceDrainError) {
					this._observeFailure(generation, settlement.reason);
				}
				return;
			default:
				assertNever(settlement);
		}
	}

	private async _awaitSessionQuiescence(sessionId: SessionId): Promise<void> {
		const generation = this._joinOrStart('explicit');
		void generation.promise.catch(() => undefined);
		while (true) {
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

		const failures = this._queue.currentFailures(generation.selectedTokens, sessionId);
		return failures.length === 0
			? { kind: 'resolved' }
			: { kind: 'rejected', reason: new PersistenceDrainError(failures) };
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

	private _assertSessionAdmissionOpen(sessionId: SessionId): void {
		if (
			this._globalResetOwners > 0 ||
			this._globalQuarantined ||
			this._sessionBarriers.has(sessionId) ||
			this._quarantinedSessions.has(sessionId) ||
			this._evictionQuarantinedSessions.has(sessionId)
		) {
			throw new PersistenceSessionAdmissionClosedError(sessionId);
		}
	}

	private _observeFailure(generation: ActiveDrain, error: PersistenceDrainError): void {
		this._logger.info('Persistence drain completed with failures', {
			failed: error.failures.length,
			selected: generation.selectedTokens.size,
		});
		this._eventEmitter?.emit('persistenceError', { operation: 'flushBuffer', error });
	}
}
