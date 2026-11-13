/**
 * Per-session admission quarantines kept by the persistence buffer.
 *
 * @module PersistenceQuarantine
 */

import type { SessionId } from '../contracts/ids.js';

/**
 * The quarantine a failed reset leaves and the one a failed eviction leaves. A successful reset
 * lifts both, a successful eviction lifts only its own, and background drain recovery lifts
 * neither. A session in both counts as reset-quarantined: only another reset recovers it.
 */
export class PersistenceQuarantine {
	private readonly _resetFailed = new Set<SessionId>();
	private readonly _evictionFailed = new Set<SessionId>();

	/** @returns Whether either quarantine closes admission for `sessionId`. */
	public has(sessionId: SessionId): boolean {
		return this._resetFailed.has(sessionId) || this._evictionFailed.has(sessionId);
	}

	public hasResetFailure(sessionId: SessionId): boolean {
		return this._resetFailed.has(sessionId);
	}

	public addResetFailure(sessionId: SessionId): void {
		this._resetFailed.add(sessionId);
	}

	public addEvictionFailure(sessionId: SessionId): void {
		this._evictionFailed.add(sessionId);
	}

	public liftEvictionFailure(sessionId: SessionId): void {
		this._evictionFailed.delete(sessionId);
	}

	/** Lifts both quarantines of one session after its reset succeeded. */
	public lift(sessionId: SessionId): void {
		this._resetFailed.delete(sessionId);
		this._evictionFailed.delete(sessionId);
	}

	public liftAll(): void {
		this._resetFailed.clear();
		this._evictionFailed.clear();
	}

	/** @returns Sessions quarantined by a failed reset, whether or not an eviction also failed. */
	public get resetFailedCount(): number {
		return this._resetFailed.size;
	}

	/** @returns Sessions whose failed eviction awaits a retry, excluding reset-quarantined ones. */
	public get evictionRetryCount(): number {
		let count = 0;
		for (const sessionId of this._evictionFailed) {
			if (!this._resetFailed.has(sessionId)) count += 1;
		}
		return count;
	}
}
