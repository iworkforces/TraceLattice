/**
 * Deterministic session cleanup candidate policy and periodic timer.
 *
 * @module SessionManager
 */

import type { SessionId } from '../contracts/ids.js';
import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';

/** Minimal session facts needed by capacity and TTL policy. */
export interface SessionLike {
	readonly lastAccessedAt: number;
	readonly owner?: string;
	readonly provenance?: 'restored';
}

/** Determines whether a candidate can be removed at this instant. */
export type SessionEligibility<S extends SessionLike> = (
	sessionId: SessionId,
	session: S
) => boolean;

/** Configuration options for {@link SessionManager}. */
export interface SessionManagerConfig {
	readonly sessionTtlMs: number;
	readonly cleanupIntervalMs: number;
	readonly getMaxSessions: () => number;
	readonly maxSessionsPerOwner?: number;
	readonly logger?: Logger;
}

type Candidate<S extends SessionLike> = {
	readonly sessionId: SessionId;
	readonly session: S;
	readonly insertionOrder: number;
};

/**
 * Produces complete candidate sets but never mutates the caller-owned session map.
 *
 * @example
 * ```ts
 * const victims = manager.planProspectiveAdmission(sessions, owner, lifecycle.isIdle);
 * ```
 */
export class SessionManager<S extends SessionLike> {
	private readonly _sessionTtlMs: number;
	private readonly _cleanupIntervalMs: number;
	private readonly _getMaxSessions: () => number;
	private readonly _maxSessionsPerOwner: number;
	private readonly _logger: Logger;
	private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

	public constructor(config: SessionManagerConfig) {
		this._sessionTtlMs = config.sessionTtlMs;
		this._cleanupIntervalMs = config.cleanupIntervalMs;
		this._getMaxSessions = config.getMaxSessions;
		this._maxSessionsPerOwner = config.maxSessionsPerOwner ?? 50;
		this._logger = config.logger ?? new NullLogger();
	}

	/** @returns The periodic cleanup timer, when active. */
	public get timer(): ReturnType<typeof setInterval> | null {
		return this._cleanupTimer;
	}

	/**
	 * Starts periodic TTL candidate cleanup and observes every asynchronous rejection.
	 */
	public startCleanupTimer(
		sessions: Map<SessionId, S>,
		isEligible: SessionEligibility<S>,
		cleanup: (sessionIds: readonly SessionId[]) => Promise<void>
	): void {
		if (this._cleanupTimer !== null) return;
		this._cleanupTimer = setInterval(() => {
			const candidates = this.staleSessionCandidates(sessions, isEligible);
			if (candidates.length === 0) return;
			void Promise.resolve()
				.then(() => cleanup(candidates))
				.catch((error: unknown) => {
					this._logger.error('Session cleanup failed', { error });
				});
		}, this._cleanupIntervalMs);
		if (typeof this._cleanupTimer === 'object' && 'unref' in this._cleanupTimer) {
			this._cleanupTimer.unref();
		}
	}

	/** Stops the periodic cleanup timer. */
	public stopCleanupTimer(): void {
		if (this._cleanupTimer === null) return;
		clearInterval(this._cleanupTimer);
		this._cleanupTimer = null;
	}

	/**
	 * Plans the complete victim union required before admitting one prospective session.
	 *
	 * Owner quota need is selected first. Those victims also satisfy global need, then
	 * oldest globally eligible alternatives fill any remainder. `undefined` means no
	 * complete eligible set exists; the input map is never modified.
	 */
	public planProspectiveAdmission(
		sessions: ReadonlyMap<SessionId, S>,
		owner: string | undefined,
		isEligible: SessionEligibility<S>
	): readonly SessionId[] | undefined {
		const live = this._orderedLiveCandidates(sessions);
		const selected: Candidate<S>[] = [];
		if (owner !== undefined) {
			const ownerCount = live.filter((candidate) => candidate.session.owner === owner).length;
			const ownerNeed = Math.max(0, ownerCount + 1 - this._maxSessionsPerOwner);
			selected.push(
				...live
					.filter(
						(candidate) =>
							candidate.session.owner === owner &&
							isEligible(candidate.sessionId, candidate.session)
					)
					.slice(0, ownerNeed)
			);
			if (selected.length < ownerNeed) return undefined;
		}

		const globalNeed = Math.max(0, live.length + 1 - this._getMaxSessions());
		const remainingNeed = Math.max(0, globalNeed - selected.length);
		const selectedIds = new Set(selected.map((candidate) => candidate.sessionId));
		const alternatives = live.filter(
			(candidate) =>
				!selectedIds.has(candidate.sessionId) && isEligible(candidate.sessionId, candidate.session)
		);
		if (alternatives.length < remainingNeed) return undefined;
		selected.push(...alternatives.slice(0, remainingNeed));
		return selected.map((candidate) => candidate.sessionId);
	}

	/** Returns stable oldest-first TTL candidates under the same eligibility rules. */
	public staleSessionCandidates(
		sessions: ReadonlyMap<SessionId, S>,
		isEligible: SessionEligibility<S>,
		now: number = Date.now()
	): readonly SessionId[] {
		return this._orderedLiveCandidates(sessions)
			.filter(
				(candidate) =>
					now - candidate.session.lastAccessedAt > this._sessionTtlMs &&
					isEligible(candidate.sessionId, candidate.session)
			)
			.map((candidate) => candidate.sessionId);
	}

	private _orderedLiveCandidates(sessions: ReadonlyMap<SessionId, S>): Candidate<S>[] {
		const candidates: Candidate<S>[] = [];
		let insertionOrder = 0;
		for (const [sessionId, session] of sessions) {
			if (session.provenance !== 'restored') {
				candidates.push({ sessionId, session, insertionOrder });
			}
			insertionOrder += 1;
		}
		return candidates.sort(
			(left, right) =>
				left.session.lastAccessedAt - right.session.lastAccessedAt ||
				left.insertionOrder - right.insertionOrder
		);
	}
}
