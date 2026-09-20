/**
 * Per-session async lock to prevent concurrent state mutations.
 *
 * Uses chained promises: each lock acquisition waits for the previous
 * holder's promise to resolve. The lock map entry is purged after release
 * (when no waiters chained on top), preventing unbounded memory growth.
 *
 * Different sessions are fully independent: locks for distinct session
 * ids never block each other.
 *
 * @module session-lock
 */

import type { ISessionLock } from '../contracts/interfaces.js';
import type { SessionId } from '../contracts/ids.js';
import { LockTimeoutError } from './SessionErrors.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

/**
 * In-memory implementation of {@link ISessionLock}.
 *
 * Maintains a `Map<string, Promise<void>>` where each value is the tail
 * of the lock chain for that session. New acquisitions chain onto the
 * tail and replace it; once they release, the entry is purged unless a
 * later acquisition chained on top.
 *
 * Lock chain integrity is preserved across timeouts and `fn` errors: a
 * waiter's slot is only released after the previous holder actually
 * finishes, even if the waiter aborted via {@link LockTimeoutError}.
 *
 * @example
 * ```typescript
 * const lock = new SessionLock();
 * await lock.withLock('session-a', async () => {
 *   // critical section — concurrent calls for 'session-a' wait
 * });
 * ```
 */
export class SessionLock implements ISessionLock {
	private readonly _locks = new Map<SessionId, Promise<void>>();

	/**
	 * Number of currently held lock chains. Useful for diagnostics
	 * and leak assertions in tests.
	 */
	public get size(): number {
		return this._locks.size;
	}

	/** Returns whether a session currently has a holder or queued operation. */
	public isActive(sessionId: SessionId): boolean {
		return this._locks.has(sessionId);
	}

	/**
	 * Execute `fn` while holding the lock for the given session.
	 *
	 * Concurrent calls for the same session are serialized. Calls for
	 * different sessions run in parallel. The lock is always released
	 * (via `finally`) even if `fn` throws.
	 *
	 * @param sessionId - Session to lock.
	 * @param fn - Critical section to run while holding the lock.
	 * @param timeoutMs - Maximum time to wait for the lock (default 5000ms).
	 * @throws {LockTimeoutError} When the lock cannot be acquired within `timeoutMs`.
	 */
	public async withLock<T>(
		sessionId: SessionId,
		fn: () => Promise<T>,
		timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
	): Promise<T> {
		const previous = this._locks.get(sessionId) ?? Promise.resolve();

		// `next` is the tail this acquirer publishes to the chain. It only
		// resolves after `previous` settles, guaranteeing serialization even
		// when the current acquirer times out before holding the lock.
		const release = Promise.withResolvers<void>();
		const next = previous.then(
			() => release.promise,
			() => release.promise
		);
		this._locks.set(sessionId, next);
		// Identity protects a later acquisition from an earlier tail's cleanup.
		void next.then(() => {
			if (this._locks.get(sessionId) === next) {
				this._locks.delete(sessionId);
			}
		});

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				timeoutId = setTimeout(() => reject(new LockTimeoutError(sessionId, timeoutMs)), timeoutMs);
				previous.then(
					() => resolve(),
					() => resolve() // previous holder's failure must not poison the chain
				);
			});
			return await fn();
		} finally {
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
			}
			release.resolve();
		}
	}
}
