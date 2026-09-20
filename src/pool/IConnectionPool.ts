/**
 * Interface for the connection pool managing concurrent user sessions.
 *
 * This module provides the `IConnectionPool` interface which defines the
 * contract for connection pool implementations. This allows for decoupling
 * and testability for multi-user transports.
 *
 * @module IConnectionPool
 */

import type { InferInput } from 'valibot';
import type { SessionId } from '../contracts/ids.js';
import type { SequentialThinkingSchema } from '../schema.js';
import type { IDisposable } from '../types/disposable.js';

export type SessionThoughtInput = InferInput<typeof SequentialThinkingSchema>;

/**
 * Represents a content block in a process result.
 */
export type ContentBlock = { type: 'text'; text: string };

export interface ProcessResult {
	content: ContentBlock[];
	isError?: boolean;
}

export interface SessionServer {
	processThought(input: SessionThoughtInput): Promise<ProcessResult>;
	stop(): void | Promise<void>;
}

export interface SessionInfo {
	id: SessionId;
	server: SessionServer;
	createdAt: number;
	lastActivityAt: number;
	isActive: boolean;
}

/**
 * Result of running callback-scoped work against a pooled session.
 */
export type SessionRunResult<T> =
	| { readonly status: 'completed'; readonly value: T }
	| { readonly status: 'inactive' }
	| { readonly status: 'missing' };

/**
 * Statistics describing the current state of the connection pool.
 */
export interface ConnectionPoolStats {
	totalSessions: number;
	activeSessions: number;
	maxSessions: number;
	cleanupEnabled: boolean;
	sessionTimeout: number;
}

/**
 * Interface for the connection pool.
 *
 * This interface defines the contract for managing multiple concurrent
 * user sessions, each with its own isolated server instance. Supports
 * dependency injection and mocking for testing purposes.
 *
 * @example
 * ```typescript
 * class MockPool implements IConnectionPool {
 *   async createSession(): Promise<string> { return 'mock'; }
 *   // ...
 * }
 * ```
 */
export interface IConnectionPool extends IDisposable {
	/**
	 * Create a new session.
	 *
	 * @returns The new session ID
	 * @throws PoolTerminatedError if the pool has been terminated
	 * @throws MaxSessionsReachedError if the maximum number of sessions is reached
	 */
	createSession(): Promise<SessionId>;

	/**
	 * Process a thought in the specified session.
	 *
	 * @param poolSessionId - The pool slot ID, distinct from `input.session_id`
	 * @param input - The thought data to process
	 * @returns The processing result
	 * @throws SessionNotFoundError if the session does not exist
	 */
	process(poolSessionId: SessionId, input: SessionThoughtInput): Promise<ProcessResult>;

	/**
	 * Run an operation while atomically holding an active session open.
	 *
	 * @param sessionId - The session ID
	 * @param operation - Callback that receives the admitted child server
	 * @returns The callback value or an explicit unavailable status
	 */
	runWithSession<T>(
		sessionId: SessionId,
		operation: (session: SessionServer) => Promise<T>
	): Promise<SessionRunResult<T>>;

	/**
	 * Close a session and release its resources.
	 *
	 * @param sessionId - The session ID to close
	 * @throws SessionNotFoundError if the session does not exist
	 */
	closeSession(sessionId: SessionId): Promise<void>;

	/**
	 * Get information about a session.
	 *
	 * @param sessionId - The session ID
	 * @returns Session info, or undefined if not found
	 */
	getSessionInfo(sessionId: SessionId): SessionInfo | undefined;

	/**
	 * Get all active sessions.
	 *
	 * @returns Array of session information for currently active sessions
	 */
	getActiveSessions(): SessionInfo[];

	/**
	 * Get connection pool statistics.
	 *
	 * @returns A snapshot of the pool's statistics
	 */
	getStats(): ConnectionPoolStats;

	/**
	 * Dispose of the connection pool, releasing all resources.
	 * Implements the {@link IDisposable} interface.
	 */
	dispose(): Promise<void>;

	/**
	 * Check if the connection pool is active (not terminated).
	 *
	 * @returns true if the pool is still running
	 */
	isRunning(): boolean;
}
