/**
 * Core-local admission and exclusive lifecycle coordination.
 *
 * @module SessionLifecycleCoordinator
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { SessionId } from '../contracts/ids.js';
import { ServerStopTimeoutError } from '../errors.js';
import { SessionLifecycleClosedError } from './SessionErrors.js';

/** Global lifecycle phases owned by the coordinator. */
export type GlobalLifecyclePhase =
	'open' | 'resetting' | 'reset_failed' | 'shutting_down' | 'stopped' | 'shutdown_failed';

/** Per-session lifecycle phases owned by the coordinator. */
export type SessionLifecyclePhase =
	'open' | 'resetting' | 'reset_failed' | 'evicting' | 'eviction_failed';

/** Options for retrying a failed session eviction. */
export interface SessionEvictionOptions {
	readonly retryFailed: boolean;
}

/** What the shutdown wait observed before the shutdown operation runs. */
export interface ShutdownIdleOutcome {
	/** The idle bound elapsed before admitted work and the admission-closed callback settled. */
	readonly timedOut: boolean;
	/** The admission-closed callback's promise settled (true when there was no callback). */
	readonly admissionClosedSettled: boolean;
}

/** Options for one shutdown. Without `idleTimeoutMs` the idle wait is unbounded. */
export interface ShutdownOptions {
	/** One bound, in milliseconds, for the idle wait and the admission-closed callback together. */
	readonly idleTimeoutMs?: number | undefined;
	/** Started synchronously once admission closes; only its settlement is awaited. */
	readonly onAdmissionClosed?: (() => Promise<void>) | undefined;
}

/** Shutdown body run under the global exclusive context once the idle wait ends. */
export type ShutdownOperation = (idle: ShutdownIdleOutcome) => Promise<void>;

type ShutdownWait = ShutdownIdleOutcome & {
	readonly overrun: ServerStopTimeoutError | null;
};

const SETTLED_IDLE: ShutdownWait = { timedOut: false, admissionClosedSettled: true, overrun: null };
const SHUTDOWN_OVERRUN_MESSAGE = 'Shutdown overran its idle bound';

type SessionState = {
	phase: SessionLifecyclePhase;
	activeOperations: number;
};

type SessionExclusiveContext = {
	readonly kind: 'session_exclusive';
	readonly sessionId: SessionId;
};

type LifecycleContext =
	| { readonly kind: 'operation'; readonly sessionId: SessionId }
	| SessionExclusiveContext
	| { readonly kind: 'global_exclusive' };

type SessionExclusive = {
	readonly active: 'resetting' | 'evicting';
	readonly failed: 'reset_failed' | 'eviction_failed';
};

const RESET_EXCLUSIVE: SessionExclusive = { active: 'resetting', failed: 'reset_failed' };
const EVICTION_EXCLUSIVE: SessionExclusive = { active: 'evicting', failed: 'eviction_failed' };

/**
 * Linearizes operation admission before external session locking and owns lifecycle exclusives.
 *
 * @example
 * ```ts
 * const lifecycle = new SessionLifecycleCoordinator();
 * await lifecycle.runOperation(sessionId, () => sessionLock.withLock(sessionId, operation));
 * ```
 */
export class SessionLifecycleCoordinator {
	private readonly _sessions = new Map<SessionId, SessionState>();
	private readonly _context = new AsyncLocalStorage<LifecycleContext>();
	private readonly _sessionIdleWaiters = new Map<SessionId, Set<() => void>>();
	private readonly _globalIdleWaiters = new Set<() => void>();
	/** Asynchronous operation and session-exclusive contexts that have not released yet. */
	private readonly _liveContexts = new Set<LifecycleContext>();
	/** Contexts still live when a bounded shutdown overran; they may not mutate again. */
	private readonly _abandonedContexts = new WeakSet<LifecycleContext>();
	private _globalPhase: GlobalLifecyclePhase = 'open';
	private _activeOperations = 0;
	private _maintenanceOwners = 0;
	private _shutdownPromise: Promise<void> | null = null;

	/** @returns The current global lifecycle phase. */
	public get globalPhase(): GlobalLifecyclePhase {
		return this._globalPhase;
	}

	/** @returns Whether any session lifecycle exclusive is active. */
	public get hasMaintenance(): boolean {
		return this._maintenanceOwners > 0;
	}

	/** @returns The current phase for a session, defaulting to `open`. */
	public phaseFor(sessionId: SessionId): SessionLifecyclePhase {
		return this._sessions.get(sessionId)?.phase ?? 'open';
	}

	/** @returns Whether a session is open and has no admitted operation. */
	public isIdle(sessionId: SessionId): boolean {
		const state = this._sessions.get(sessionId);
		return state === undefined || (state.phase === 'open' && state.activeOperations === 0);
	}

	/** Admits an asynchronous operation synchronously and releases it in `finally`. */
	public runOperation<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		const admissionError = this._admissionError(sessionId);
		if (admissionError !== undefined) return Promise.reject(admissionError);
		this._admit(sessionId);
		const context: LifecycleContext = { kind: 'operation', sessionId };
		this._liveContexts.add(context);
		return this._context.run(context, async () => {
			try {
				return await operation();
			} finally {
				this._liveContexts.delete(context);
				this._release(sessionId);
			}
		});
	}

	/**
	 * Guards direct synchronous mutation, reusing a valid owning lifecycle context. A context
	 * abandoned by an overrun shutdown is refused before the mutation runs.
	 */
	public runMutation<T>(sessionId: SessionId, mutation: () => T): T {
		const abandonedError = this._abandonedError(sessionId);
		if (abandonedError !== undefined) throw abandonedError;
		if (this._contextOwnsSession(sessionId)) return mutation();
		const admissionError = this._admissionError(sessionId);
		if (admissionError !== undefined) throw admissionError;
		this._admit(sessionId);
		try {
			return this._context.run({ kind: 'operation', sessionId }, mutation);
		} finally {
			this._release(sessionId);
		}
	}

	/** Closes one session for reset and permits retry only from `reset_failed`. */
	public withSessionReset<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		return this._startSessionExclusive(sessionId, RESET_EXCLUSIVE, operation, true);
	}

	/** Closes one session for eviction, optionally retrying `eviction_failed`. */
	public withSessionEviction<T>(
		sessionId: SessionId,
		operation: () => Promise<T>,
		options: SessionEvictionOptions = { retryFailed: false }
	): Promise<T> {
		return this._startSessionExclusive(
			sessionId,
			EVICTION_EXCLUSIVE,
			operation,
			options.retryFailed
		);
	}

	/** Closes global admission for a reset and permits retry from `reset_failed`. */
	public withGlobalReset<T>(operation: () => Promise<T>): Promise<T> {
		const abandonedError = this._abandonedError(undefined);
		if (abandonedError !== undefined) return Promise.reject(abandonedError);
		const context = this._context.getStore();
		if (context !== undefined) return Promise.reject(this._globalUpgradeError('global reset'));
		if (this._globalPhase !== 'open' && this._globalPhase !== 'reset_failed') {
			return Promise.reject(new SessionLifecycleClosedError(undefined, this._globalPhase));
		}
		this._globalPhase = 'resetting';
		return this._runGlobalReset(operation);
	}

	/**
	 * Closes admission once and returns the same shutdown settlement to every caller.
	 *
	 * `onAdmissionClosed` starts synchronously once admission closes. The wait covers admitted
	 * operations, maintenance owners and that callback's settlement; `idleTimeoutMs` bounds all of
	 * them with one timer. When the bound elapses with work still admitted, every live context is
	 * abandoned, `operation` still runs, and the settlement rejects with an `AggregateError` whose
	 * first entry is `ServerStopTimeoutError('operations', …)`, followed by the failures of
	 * `operation`.
	 */
	public shutdown(operation: ShutdownOperation, options: ShutdownOptions = {}): Promise<void> {
		if (this._shutdownPromise !== null) return this._shutdownPromise;
		const context = this._context.getStore();
		if (context !== undefined) return Promise.reject(this._globalUpgradeError('shutdown'));
		if (this._globalPhase !== 'open' && this._globalPhase !== 'reset_failed') {
			return Promise.reject(new SessionLifecycleClosedError(undefined, this._globalPhase));
		}
		this._globalPhase = 'shutting_down';
		const admissionClosed = startAdmissionClosed(options.onAdmissionClosed);
		const settlement = this._runShutdown(operation, admissionClosed, options.idleTimeoutMs);
		this._shutdownPromise = settlement;
		return settlement;
	}

	/**
	 * Atomically claims and removes a complete already-idle candidate set.
	 *
	 * @returns `false` without invoking cleanup when any candidate is not idle.
	 */
	public tryEvictIdleSessions(
		sessionIds: readonly SessionId[],
		operation: (sessionIds: readonly SessionId[]) => void
	): boolean {
		if (this._globalPhase !== 'open' || sessionIds.some((sessionId) => !this.isIdle(sessionId))) {
			return false;
		}
		const uniqueIds = [...new Set(sessionIds)];
		for (const sessionId of uniqueIds) this._state(sessionId).phase = 'evicting';
		this._maintenanceOwners += 1;
		try {
			operation(uniqueIds);
			for (const sessionId of uniqueIds) this._sessions.delete(sessionId);
			return true;
		} catch (error) {
			for (const sessionId of uniqueIds) this._state(sessionId).phase = 'eviction_failed';
			throw error;
		} finally {
			this._maintenanceOwners -= 1;
			this._notifyGlobalIdle();
		}
	}

	private _startSessionExclusive<T>(
		sessionId: SessionId,
		exclusive: SessionExclusive,
		operation: () => Promise<T>,
		allowFailedRetry: boolean
	): Promise<T> {
		const abandonedError = this._abandonedError(sessionId);
		if (abandonedError !== undefined) return Promise.reject(abandonedError);
		const context = this._context.getStore();
		if (
			context?.kind === 'session_exclusive' &&
			context.sessionId === sessionId &&
			this.phaseFor(sessionId) === exclusive.active
		) {
			return operation();
		}
		if (context?.kind === 'operation') {
			return Promise.reject(
				this._upgradeError(exclusive.active === 'resetting' ? 'reset' : 'eviction', sessionId)
			);
		}
		if (context !== undefined && !this._contextOwnsSession(sessionId)) {
			return Promise.reject(
				this._globalUpgradeError(
					`session ${exclusive.active === 'resetting' ? 'reset' : 'eviction'}`
				)
			);
		}
		const state = this._state(sessionId);
		const retrying = state.phase === exclusive.failed && allowFailedRetry;
		if (this._globalPhase !== 'open') {
			return Promise.reject(new SessionLifecycleClosedError(sessionId, this._globalPhase));
		}
		if (state.phase !== 'open' && !retrying) {
			return Promise.reject(new SessionLifecycleClosedError(sessionId, state.phase));
		}
		state.phase = exclusive.active;
		this._maintenanceOwners += 1;
		const exclusiveContext: SessionExclusiveContext = { kind: 'session_exclusive', sessionId };
		this._liveContexts.add(exclusiveContext);
		return this._runSessionExclusive(exclusiveContext, exclusive, operation);
	}

	private async _runSessionExclusive<T>(
		context: SessionExclusiveContext,
		exclusive: SessionExclusive,
		operation: () => Promise<T>
	): Promise<T> {
		const { sessionId } = context;
		try {
			await this._waitSessionIdle(sessionId);
			const abandonedError = this._abandonedError(sessionId, context);
			if (abandonedError !== undefined) throw abandonedError;
			const result = await this._context.run(context, operation);
			this._sessions.delete(sessionId);
			return result;
		} catch (error) {
			this._state(sessionId).phase = exclusive.failed;
			throw error;
		} finally {
			this._liveContexts.delete(context);
			this._maintenanceOwners -= 1;
			this._notifyGlobalIdle();
		}
	}

	private async _runGlobalReset<T>(operation: () => Promise<T>): Promise<T> {
		try {
			await this._waitGlobalIdle();
			const result = await this._context.run({ kind: 'global_exclusive' }, operation);
			this._sessions.clear();
			this._globalPhase = 'open';
			return result;
		} catch (error) {
			this._globalPhase = 'reset_failed';
			throw error;
		}
	}

	private async _runShutdown(
		operation: ShutdownOperation,
		admissionClosed: Promise<void> | null,
		idleTimeoutMs: number | undefined
	): Promise<void> {
		let wait = SETTLED_IDLE;
		if (admissionClosed === null && idleTimeoutMs === undefined) await this._waitGlobalIdle();
		else wait = await this._waitShutdownIdle(admissionClosed, idleTimeoutMs);
		const idle: ShutdownIdleOutcome = {
			timedOut: wait.timedOut,
			admissionClosedSettled: wait.admissionClosedSettled,
		};
		try {
			await this._context.run({ kind: 'global_exclusive' }, () => operation(idle));
		} catch (error) {
			this._globalPhase = 'shutdown_failed';
			if (wait.overrun === null) throw error;
			const failures = error instanceof AggregateError ? error.errors : [error];
			throw new AggregateError([wait.overrun, ...failures], SHUTDOWN_OVERRUN_MESSAGE, {
				cause: error,
			});
		}
		if (wait.overrun !== null) {
			this._globalPhase = 'shutdown_failed';
			throw new AggregateError([wait.overrun], SHUTDOWN_OVERRUN_MESSAGE);
		}
		this._globalPhase = 'stopped';
	}

	private async _waitShutdownIdle(
		admissionClosed: Promise<void> | null,
		idleTimeoutMs: number | undefined
	): Promise<ShutdownWait> {
		if (idleTimeoutMs !== undefined)
			return this._waitShutdownIdleWithin(admissionClosed, idleTimeoutMs);
		await Promise.all([this._waitGlobalIdle(), admissionClosed]);
		return SETTLED_IDLE;
	}

	/**
	 * Waits for global idle and the admission-closed settlement under one timer. At the bound the
	 * idle waiter is withdrawn and, when work is still admitted, every live context is abandoned
	 * synchronously so that none of it mutates once the shutdown operation runs.
	 */
	private _waitShutdownIdleWithin(
		admissionClosed: Promise<void> | null,
		idleTimeoutMs: number
	): Promise<ShutdownWait> {
		const result = Promise.withResolvers<ShutdownWait>();
		const progress = { idle: false, admissionClosedSettled: admissionClosed === null };
		const finish = (wait: ShutdownWait): void => {
			clearTimeout(timer);
			this._globalIdleWaiters.delete(onIdle);
			result.resolve(wait);
		};
		const finishIfSettled = (): void => {
			if (progress.idle && progress.admissionClosedSettled) finish(SETTLED_IDLE);
		};
		const onIdle = (): void => {
			progress.idle = true;
			finishIfSettled();
		};
		const timer = setTimeout(() => {
			const overrun = this._abandonOverrun(idleTimeoutMs);
			finish({ timedOut: true, admissionClosedSettled: progress.admissionClosedSettled, overrun });
		}, idleTimeoutMs);
		this._addGlobalIdleWaiter(onIdle);
		void admissionClosed?.then(() => {
			progress.admissionClosedSettled = true;
			finishIfSettled();
		});
		return result.promise;
	}

	/** @returns The operations timeout after abandoning every live context, or null when idle. */
	private _abandonOverrun(idleTimeoutMs: number): ServerStopTimeoutError | null {
		const operations = this._activeOperations;
		const maintenance = this._maintenanceOwners;
		if (operations === 0 && maintenance === 0) return null;
		for (const context of this._liveContexts) this._abandonedContexts.add(context);
		return new ServerStopTimeoutError(
			'operations',
			idleTimeoutMs,
			operations + maintenance,
			`${operations} admitted operation(s), ${maintenance} maintenance owner(s)`
		);
	}

	private _state(sessionId: SessionId): SessionState {
		const state = this._sessions.get(sessionId) ?? { phase: 'open', activeOperations: 0 };
		this._sessions.set(sessionId, state);
		return state;
	}

	private _admissionError(sessionId: SessionId): SessionLifecycleClosedError | undefined {
		if (this._globalPhase !== 'open') {
			return new SessionLifecycleClosedError(sessionId, this._globalPhase);
		}
		const phase = this.phaseFor(sessionId);
		return phase === 'open' ? undefined : new SessionLifecycleClosedError(sessionId, phase);
	}

	private _admit(sessionId: SessionId): void {
		this._state(sessionId).activeOperations += 1;
		this._activeOperations += 1;
	}

	private _release(sessionId: SessionId): void {
		const state = this._state(sessionId);
		state.activeOperations -= 1;
		this._activeOperations -= 1;
		if (state.activeOperations === 0) {
			const waiters = this._sessionIdleWaiters.get(sessionId);
			this._sessionIdleWaiters.delete(sessionId);
			for (const resolve of waiters ?? []) resolve();
		}
		this._notifyGlobalIdle();
	}

	private _waitSessionIdle(sessionId: SessionId): Promise<void> {
		if (this._state(sessionId).activeOperations === 0) return Promise.resolve();
		const result = Promise.withResolvers<void>();
		const waiters = this._sessionIdleWaiters.get(sessionId) ?? new Set<() => void>();
		waiters.add(result.resolve);
		this._sessionIdleWaiters.set(sessionId, waiters);
		return result.promise;
	}

	private _waitGlobalIdle(): Promise<void> {
		if (this._activeOperations === 0 && this._maintenanceOwners === 0) return Promise.resolve();
		const result = Promise.withResolvers<void>();
		this._globalIdleWaiters.add(result.resolve);
		return result.promise;
	}

	private _addGlobalIdleWaiter(onIdle: () => void): void {
		if (this._activeOperations === 0 && this._maintenanceOwners === 0) onIdle();
		else this._globalIdleWaiters.add(onIdle);
	}

	private _notifyGlobalIdle(): void {
		if (this._activeOperations !== 0 || this._maintenanceOwners !== 0) return;
		for (const resolve of this._globalIdleWaiters) resolve();
		this._globalIdleWaiters.clear();
	}

	/** @returns The closed error for a context abandoned by an overrun shutdown, else undefined. */
	private _abandonedError(
		sessionId: SessionId | undefined,
		context: LifecycleContext | undefined = this._context.getStore()
	): SessionLifecycleClosedError | undefined {
		if (context === undefined || !this._abandonedContexts.has(context)) return undefined;
		if (this._globalPhase === 'open') return undefined;
		return new SessionLifecycleClosedError(sessionId, this._globalPhase);
	}

	private _contextOwnsSession(sessionId: SessionId): boolean {
		const context = this._context.getStore();
		return context?.kind === 'global_exclusive' || context?.sessionId === sessionId;
	}

	private _upgradeError(mode: string, sessionId: SessionId): TypeError {
		return new TypeError(
			`Cannot upgrade an admitted operation for session '${sessionId}' to ${mode}`
		);
	}

	private _globalUpgradeError(mode: string): TypeError {
		return new TypeError(`Cannot upgrade an active lifecycle context to ${mode}`);
	}
}

/**
 * Starts the admission-closed callback and returns a promise that settles with it and never
 * rejects; the caller keeps its own reference for the callback's outcome.
 */
function startAdmissionClosed(callback: (() => Promise<void>) | undefined): Promise<void> | null {
	if (callback === undefined) return null;
	return new Promise<void>((resolve) => resolve(callback())).then(
		() => undefined,
		() => undefined
	);
}
