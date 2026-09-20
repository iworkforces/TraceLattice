/**
 * Connection Pool for managing concurrent user sessions.
 *
 * This module provides session management for multi-user scenarios,
 * allowing multiple concurrent clients to each have isolated state.
 *
 * @example
 * ```typescript
 * const pool = new ConnectionPool({
 *   maxSessions: 100,
 *   sessionTimeout: 300000 // 5 minutes
 * });
 *
 * const sessionId = await pool.createSession();
 * await pool.process(sessionId, thought);
 * await pool.closeSession(sessionId);
 * ```
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { MaxSessionsReachedError, PoolTerminatedError } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { asSessionId, type SessionId } from '../contracts/ids.js';
import { assertNever } from '../utils.js';
import { SessionNotActiveError, SessionNotFoundError } from './PoolErrors.js';
import type {
	ConnectionPoolStats,
	IConnectionPool,
	ProcessResult,
	SessionInfo,
	SessionRunResult,
	SessionServer,
	SessionThoughtInput,
} from './IConnectionPool.js';

export interface SessionOptions {
	/**
	 * Maximum number of concurrent sessions
	 * @default 100
	 */
	maxSessions?: number;

	/**
	 * Logger instance
	 */
	logger?: Logger;

	serverFactory?: () => Promise<SessionServer>;

	/**
	 * Session timeout in milliseconds
	 * @default 300000 (5 minutes)
	 */
	sessionTimeout?: number;

	/**
	 * Whether to enable automatic session cleanup
	 * @default true
	 */
	autoCleanup?: boolean;

	/**
	 * Cleanup interval in milliseconds
	 * @default 60000 (1 minute)
	 */
	cleanupInterval?: number;
}

/**
 * Represents a user session with its own server instance.
 */
export class Session {
	private _server: SessionServer;
	private _id: SessionId;
	private _createdAt: number;
	private _lastActivityAt: number;
	private _isActiveValue: boolean;
	private _timeout: number;
	private _cleanupTimer: NodeJS.Timeout | null = null;
	private _logger: Logger;
	private _closePromise: Promise<void> | null = null;
	private _activeOperationCount = 0;
	private _operationDrain: PromiseWithResolvers<void> | null = null;
	private readonly _onTimeout: ((sessionId: SessionId) => void) | null;

	constructor(
		id: SessionId,
		server: SessionServer,
		timeout: number,
		logger: Logger,
		onTimeout: ((sessionId: SessionId) => void) | null = null
	) {
		this._server = server;
		this._id = id;
		this._createdAt = Date.now();
		this._lastActivityAt = this._createdAt;
		this._isActiveValue = true;
		this._timeout = timeout;
		this._logger = logger;
		this._onTimeout = onTimeout;

		// Start session timeout timer
		this._startTimeout();
	}

	/**
	 * Check if the session is active.
	 */
	get isActive(): boolean {
		return this._isActiveValue;
	}

	/**
	 * Process a thought through this session's server instance.
	 */
	async process(input: SessionThoughtInput): Promise<ProcessResult> {
		if (!this.isActive) {
			throw new SessionNotActiveError(this._id);
		}

		// Update last activity
		this._lastActivityAt = Date.now();

		// Reset timeout timer
		this._resetTimeout();

		// Process the thought
		return this._server.processThought(input);
	}

	processAdmitted(input: SessionThoughtInput): Promise<ProcessResult> {
		this._lastActivityAt = Date.now();
		if (this.isActive) this._resetTimeout();
		return this._server.processThought(input);
	}

	runWhileActive<T>(operation: (session: Session) => Promise<T>): Promise<SessionRunResult<T>> {
		if (!this.isActive) return Promise.resolve({ status: 'inactive' });
		this._activeOperationCount++;
		return (async () => {
			try {
				return { status: 'completed', value: await operation(this) };
			} finally {
				this._activeOperationCount--;
				if (this._activeOperationCount === 0) this._operationDrain?.resolve();
			}
		})();
	}

	/**
	 * Get session information.
	 */
	getInfo(): SessionInfo {
		return {
			id: this._id,
			server: this._server,
			createdAt: this._createdAt,
			lastActivityAt: this._lastActivityAt,
			isActive: this.isActive,
		};
	}

	/**
	 * Check if the session has timed out.
	 */
	isTimedOut(): boolean {
		return Date.now() - this._lastActivityAt > this._timeout;
	}

	/**
	 * Close the session and stop the server.
	 */
	close(): Promise<void> {
		if (this._closePromise) {
			return this._closePromise;
		}

		const completion = Promise.withResolvers<void>();
		this._closePromise = completion.promise;
		void completion.promise.then(undefined, () => {
			if (this._closePromise === completion.promise) this._closePromise = null;
		});
		this._isActiveValue = false;

		// Stop timeout timer
		if (this._cleanupTimer) {
			clearTimeout(this._cleanupTimer);
			this._cleanupTimer = null;
		}

		if (this._activeOperationCount === 0) {
			this._stopServer(completion);
		} else {
			this._operationDrain = Promise.withResolvers<void>();
			void this._operationDrain.promise.then(() => this._stopServer(completion));
		}

		return completion.promise;
	}

	private _stopServer(completion: PromiseWithResolvers<void>): void {
		try {
			Promise.resolve(this._server.stop()).then(completion.resolve, completion.reject);
		} catch (error) {
			completion.reject(
				error instanceof Error ? error : new AggregateError([error], 'Session stop failed')
			);
		}
	}

	/**
	 * Start the session timeout timer.
	 */
	private _startTimeout(): void {
		if (this._cleanupTimer) {
			clearTimeout(this._cleanupTimer);
		}

		this._cleanupTimer = setTimeout(() => {
			if (this.isTimedOut()) {
				this._logger.warn(`Session ${this._id} timed out, closing`);
				if (this._onTimeout) {
					this._onTimeout(this._id);
				} else {
					this.close().catch((err) => {
						this._logger.error(`Error closing timed out session ${this._id}:`, err);
					});
				}
			}
		}, this._timeout);
	}

	/**
	 * Reset the timeout timer after activity.
	 */
	private _resetTimeout(): void {
		this._startTimeout();
	}
}

interface TerminationGeneration {
	readonly attempts: Map<SessionId, Promise<void>>;
	readonly completion: PromiseWithResolvers<void>;
}

/**
 * ConnectionPool manages multiple concurrent user sessions.
 *
 * Each session has its own server instance with isolated state,
 * allowing multiple users to interact with the system simultaneously.
 */
export class ConnectionPool implements IConnectionPool {
	private _sessions: Map<SessionId, Session> = new Map();
	private readonly _ownedSessions = new Map<SessionId, Session>();
	private readonly _closingSessions = new Map<SessionId, Promise<void>>();
	private _createSessionLock: Promise<void> | null = null;
	private _maxSessions: number;
	private _sessionTimeout: number;
	private _autoCleanup: boolean;
	private _cleanupInterval: number;
	private _cleanupTimerId: ReturnType<typeof setInterval> | null = null;
	private _terminated: boolean = false;
	private _logger: Logger;
	private _serverFactory: (() => Promise<SessionServer>) | null;
	private _terminationGeneration: TerminationGeneration | null = null;
	private readonly _admissionContext = new AsyncLocalStorage<{
		readonly sessionId: SessionId;
		readonly session: Session;
		open: boolean;
	}>();

	constructor(options: SessionOptions = {}) {
		this._maxSessions = options.maxSessions ?? 100;
		this._sessionTimeout = options.sessionTimeout ?? 300000; // 5 minutes
		this._autoCleanup = options.autoCleanup ?? true;
		this._cleanupInterval = options.cleanupInterval ?? 60000; // 1 minute
		this._serverFactory = options.serverFactory ?? null;
		this._logger = options.logger ?? this._createNoopLogger();

		if (this._autoCleanup) {
			this._startCleanup();
		}
	}

	/**
	 * Create a no-op logger when none is provided.
	 */
	private _createNoopLogger(): Logger {
		return {
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
			debug: (): void => {},
			setLevel: (): void => {},
			getLevel: (): 'info' => 'info',
		};
	}

	/**
	 * Create a new session.
	 *
	 * @returns The session ID
	 * @throws Error if max sessions reached
	 */
	async createSession(): Promise<SessionId> {
		while (this._createSessionLock) {
			await this._createSessionLock;
		}

		if (this._terminated) {
			throw new PoolTerminatedError();
		}

		if (this._ownedSessions.size >= this._maxSessions) {
			throw new MaxSessionsReachedError(this._maxSessions);
		}

		if (!this._serverFactory) {
			throw new Error('ConnectionPool requires a serverFactory option to create sessions');
		}

		let resolveLock!: () => void;
		this._createSessionLock = new Promise<void>((resolve) => {
			resolveLock = resolve;
		});

		try {
			// Generate unique session ID
			const sessionId = asSessionId(
				`session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
			);
			if (this._ownedSessions.has(sessionId)) {
				throw new Error(`Session ID collision: ${sessionId}`);
			}

			// Create a new server instance for this session
			const server = await this._serverFactory();
			const session = new Session(
				sessionId,
				server,
				this._sessionTimeout,
				this._logger,
				(timedOutSessionId) => this._handleSessionTimeout(timedOutSessionId)
			);
			this._ownedSessions.set(sessionId, session);
			if (this._terminated) {
				const generation = this._terminationGeneration;
				if (generation) {
					await this._coordinateCleanup(sessionId, generation);
				} else {
					await this._coordinateCleanup(sessionId);
				}
				throw new PoolTerminatedError();
			}

			this._sessions.set(sessionId, session);

			this._logger.info(
				`Created session ${sessionId} (${this._sessions.size}/${this._maxSessions} active sessions)`
			);
			return sessionId;
		} finally {
			resolveLock();
			this._createSessionLock = null;
		}
	}

	/**
	 * Process a thought in the specified session.
	 *
	 * @param poolSessionId - The pool slot ID, distinct from `input.session_id`
	 * @param input - The thought data to process
	 * @returns Promise with the processing result
	 * @throws Error if session not found
	 */
	async process(poolSessionId: SessionId, input: SessionThoughtInput): Promise<ProcessResult> {
		const result = await this._runWithSession(poolSessionId, (session) =>
			session.processAdmitted(input)
		);
		switch (result.status) {
			case 'completed':
				return result.value;
			case 'inactive':
				throw new SessionNotActiveError(poolSessionId);
			case 'missing':
				throw new SessionNotFoundError(poolSessionId);
			default:
				return assertNever(result);
		}
	}

	runWithSession<T>(
		sessionId: SessionId,
		operation: (session: SessionServer) => Promise<T>
	): Promise<SessionRunResult<T>> {
		return this._runWithSession(sessionId, (session) => operation(session.getInfo().server));
	}

	private _runWithSession<T>(
		sessionId: SessionId,
		operation: (session: Session) => Promise<T>
	): Promise<SessionRunResult<T>> {
		const activeFrame = this._admissionContext.getStore();
		if (activeFrame?.open === true && activeFrame.sessionId === sessionId) {
			return (async () => ({ status: 'completed', value: await operation(activeFrame.session) }))();
		}

		const session = this._sessions.get(sessionId);
		if (!session) {
			return Promise.resolve(
				this._ownedSessions.has(sessionId) ? { status: 'inactive' } : { status: 'missing' }
			);
		}

		return session.runWhileActive((capturedSession) => {
			const frame = { sessionId, session: capturedSession, open: true };
			return this._admissionContext.run(frame, async () => {
				try {
					return await operation(capturedSession);
				} finally {
					frame.open = false;
				}
			});
		});
	}

	/**
	 * Close a session and release resources.
	 *
	 * @param sessionId - The session ID to close
	 * @throws Error if session not found
	 */
	closeSession(sessionId: SessionId): Promise<void> {
		if (!this._ownedSessions.has(sessionId)) {
			return Promise.reject(new SessionNotFoundError(sessionId));
		}

		const generation = this._terminationGeneration;
		return generation
			? this._coordinateCleanup(sessionId, generation)
			: this._coordinateCleanup(sessionId);
	}

	private _coordinateCleanup(
		sessionId: SessionId,
		generation?: TerminationGeneration
	): Promise<void> {
		const generationAttempt = generation?.attempts.get(sessionId);
		if (generationAttempt) return generationAttempt;

		const session = this._ownedSessions.get(sessionId);
		if (!session) return Promise.reject(new SessionNotFoundError(sessionId));

		this._sessions.delete(sessionId);
		const currentAttempt = this._closingSessions.get(sessionId);
		const attempt = currentAttempt ?? session.close();
		if (!currentAttempt) this._closingSessions.set(sessionId, attempt);
		generation?.attempts.set(sessionId, attempt);

		if (!currentAttempt)
			void attempt.then(
				() => {
					if (this._closingSessions.get(sessionId) === attempt) {
						this._closingSessions.delete(sessionId);
					}
					if (this._ownedSessions.get(sessionId) === session) {
						this._ownedSessions.delete(sessionId);
					}
					this._logger.info(
						`Closed session ${sessionId} (${this._sessions.size}/${this._maxSessions} active sessions)`
					);
				},
				() => {
					if (this._closingSessions.get(sessionId) === attempt) {
						this._closingSessions.delete(sessionId);
					}
				}
			);
		return attempt;
	}

	private _handleSessionTimeout(sessionId: SessionId): void {
		const generation = this._terminationGeneration;
		const attempt = generation
			? this._coordinateCleanup(sessionId, generation)
			: this._coordinateCleanup(sessionId);
		void attempt.catch((err) => {
			this._logger.error(`Error closing timed out session ${sessionId}:`, err);
		});
	}

	/**
	 * Get information about a session.
	 *
	 * @param sessionId - The session ID
	 * @returns Session info or undefined if not found
	 */
	getSessionInfo(sessionId: SessionId): SessionInfo | undefined {
		return this._sessions.get(sessionId)?.getInfo();
	}

	/**
	 * Get all active sessions.
	 *
	 * @returns Array of session information
	 */
	getActiveSessions(): SessionInfo[] {
		return Array.from(this._sessions.values())
			.filter((s) => s.isActive)
			.map((s) => s.getInfo());
	}

	/**
	 * Get connection pool statistics.
	 */
	getStats(): ConnectionPoolStats {
		const activeSessions = this.getActiveSessions();

		return {
			totalSessions: this._sessions.size,
			activeSessions: activeSessions.length,
			maxSessions: this._maxSessions,
			cleanupEnabled: this._autoCleanup,
			sessionTimeout: this._sessionTimeout,
		};
	}

	/**
	 * Start the automatic cleanup timer.
	 */
	private _startCleanup(): void {
		if (this._cleanupTimerId !== null) {
			clearInterval(this._cleanupTimerId);
		}

		this._cleanupTimerId = setInterval(() => {
			this._cleanupTimedOutSessions();
		}, this._cleanupInterval);
	}

	/**
	 * Remove timed-out sessions.
	 */
	private _cleanupTimedOutSessions(): void {
		let cleaned = 0;

		for (const [sessionId, session] of this._ownedSessions.entries()) {
			if (session.isTimedOut()) {
				this._coordinateCleanup(sessionId).catch((err) => {
					this._logger.error(`Error closing timed out session ${sessionId}:`, err);
				});
				cleaned++;
			}
		}

		if (cleaned > 0) {
			this._logger.info(
				`Cleaned ${cleaned} timed-out sessions (${this._sessions.size}/${this._maxSessions} active sessions)`
			);
		}
	}

	dispose(): Promise<void> {
		if (this._terminationGeneration) {
			return this._terminationGeneration.completion.promise;
		}

		const completion = Promise.withResolvers<void>();
		const generation: TerminationGeneration = { attempts: new Map(), completion };
		this._terminationGeneration = generation;
		this._terminated = true;

		// Stop cleanup timer
		if (this._cleanupTimerId !== null) {
			clearInterval(this._cleanupTimerId);
			this._cleanupTimerId = null;
		}

		const pendingCreate = this._createSessionLock;
		for (const sessionId of this._ownedSessions.keys()) {
			this._coordinateCleanup(sessionId, generation);
		}

		void this._completeTerminationGeneration(generation, pendingCreate);

		return completion.promise;
	}

	private async _completeTerminationGeneration(
		generation: TerminationGeneration,
		pendingCreate: Promise<void> | null
	): Promise<void> {
		if (pendingCreate) await pendingCreate;
		const outcomes = await Promise.allSettled(generation.attempts.values());
		const failures = outcomes
			.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
			.map((outcome) => outcome.reason);
		if (failures.length > 0) {
			if (this._terminationGeneration === generation) this._terminationGeneration = null;
			generation.completion.reject(
				new AggregateError(failures, 'ConnectionPool termination failed')
			);
			return;
		}
		this._logger.info('ConnectionPool terminated');
		generation.completion.resolve();
	}

	/**
	 * Check if the connection pool is active.
	 */
	isRunning(): boolean {
		return !this._terminated;
	}
}

/**
 * Create a connection pool with the given options.
 *
 * @param options - Connection pool configuration
 * @returns A configured connection pool
 *
 * @example
 * ```typescript
 * const pool = createConnectionPool({
 *   maxSessions: 50,
 *   sessionTimeout: 300000
 * });
 * ```
 */
export function createConnectionPool(options?: SessionOptions): ConnectionPool {
	return new ConnectionPool(options);
}
