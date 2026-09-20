/**
 * Records verification outcomes for confidence calibration.
 *
 * No-op implementation when feature flag is disabled.
 * Stores outcomes per-session in memory for later calibration use.
 *
 * @module core/reasoning/OutcomeRecorder
 */

import type { IOutcomeRecorder, VerificationOutcome } from '../../contracts/interfaces.js';
import type { SessionId, ThoughtId } from '../../contracts/ids.js';
import { ValidationError } from '../../errors.js';

/**
 * Configuration for OutcomeRecorder.
 */
export interface OutcomeRecorderConfig {
	/** Whether outcome recording is enabled. */
	enabled: boolean;
}

/**
 * Records verification outcomes for confidence calibration.
 *
 * When disabled (default), all methods are no-ops and return empty arrays.
 * When enabled, outcomes are stored in memory per-session.
 *
 * @example
 * ```typescript
 * const recorder = new OutcomeRecorder({ enabled: true });
 * recorder.recordVerification({
 *   thoughtId: 't1',
 *   sessionId: 'session-a',
 *   predicted: 0.8,
 *   actual: 1,
 *   type: 'verification',
 * });
 * const outcomes = recorder.getOutcomes('session-a');
 * ```
 */
export class OutcomeRecorder implements IOutcomeRecorder {
	private readonly _outcomes: Map<SessionId, Map<ThoughtId, VerificationOutcome>> = new Map();
	private readonly _enabled: boolean;

	/**
	 * Whether outcome recording is currently enabled.
	 */
	public get enabled(): boolean {
		return this._enabled;
	}

	/**
	 * Create a new OutcomeRecorder.
	 *
	 * @param config - Recorder configuration
	 */
	constructor(config: OutcomeRecorderConfig) {
		this._enabled = config.enabled;
	}

	/**
	 * Assert that a target is available for one outcome label.
	 *
	 * @param sessionId - Canonical session namespace
	 * @param thoughtId - Stable target identity
	 * @throws {ValidationError} When the target was already labeled
	 */
	assertCanRecord(sessionId: SessionId, thoughtId: ThoughtId): void {
		if (!this._enabled) return;
		if (this._outcomes.get(sessionId)?.has(thoughtId)) {
			throw new ValidationError(
				'verification_result',
				'The verification target already has a recorded result'
			);
		}
	}

	/**
	 * Record a verification outcome.
	 *
	 * No-op when outcome recording is disabled.
	 *
	 * @param outcome - The outcome data (recordedAt is auto-set)
	 */
	recordVerification(outcome: Omit<VerificationOutcome, 'recordedAt'>): void {
		if (!this._enabled) return;
		this.assertCanRecord(outcome.sessionId, outcome.thoughtId);

		const full: VerificationOutcome = {
			...outcome,
			recordedAt: Date.now(),
		};

		const sessionOutcomes = this._outcomes.get(outcome.sessionId) ?? new Map();
		sessionOutcomes.set(outcome.thoughtId, full);
		this._outcomes.set(outcome.sessionId, sessionOutcomes);
	}

	/**
	 * Get all recorded outcomes for a session.
	 *
	 * @param sessionId - The session id to query
	 * @returns Array of outcomes (empty when disabled or no data)
	 */
	getOutcomes(sessionId: SessionId): VerificationOutcome[] {
		if (!this._enabled) return [];
		return [...(this._outcomes.get(sessionId)?.values() ?? [])].map((outcome) => ({ ...outcome }));
	}

	/**
	 * Get outcomes across all sessions.
	 *
	 * @returns Flat array of all outcomes (empty when disabled)
	 */
	getAllOutcomes(): VerificationOutcome[] {
		if (!this._enabled) return [];
		const all: VerificationOutcome[] = [];
		for (const outcomes of this._outcomes.values()) {
			for (const outcome of outcomes.values()) all.push({ ...outcome });
		}
		return all;
	}

	/**
	 * Clear outcomes for a specific session.
	 *
	 * @param sessionId - The session id to clear
	 */
	clearOutcomes(sessionId: SessionId): void {
		this._outcomes.delete(sessionId);
	}

	clearAllOutcomes(): void {
		this._outcomes.clear();
	}
}
