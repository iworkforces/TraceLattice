/**
 * Calibrator contracts — interfaces for confidence calibration.
 *
 * Defines the shape of calibration metrics, results, and the calibrator
 * service that maps raw model confidence to calibrated probabilities.
 *
 * @module contracts/calibrator
 */

import type { SessionId } from './ids.js';
import type { ThoughtType } from './reasoning-types.js';

/**
 * Aggregate calibration quality metrics for a session (or globally).
 *
 * @example
 * ```typescript
 * const m: CalibrationMetrics = calibrator.metrics('session-1');
 * console.log(m.brierScore, m.ece, m.sampleCount);
 * ```
 */
export interface CalibrationMetrics {
	/** Brier score across all samples (lower is better). `null` if no samples. */
	readonly brierScore: number | null;
	/** Expected Calibration Error (lower is better). `null` if no samples. */
	readonly ece: number | null;
	/** Number of (prediction, outcome) samples backing the metrics. */
	readonly sampleCount: number;
	/** Per-thought-type Brier score breakdown. `null` per bucket if empty. */
	readonly perTypeBrier: Record<ThoughtType, number | null>;
}

/**
 * Result of calibrating a single raw confidence value.
 *
 * @example
 * ```typescript
 * const r: CalibrationResult = calibrator.calibrate(0.9, 'hypothesis', 'session-1');
 * // r.calibrated may be lower than r.raw if the model is over-confident.
 * ```
 */
export interface CalibrationResult {
	/** Original raw confidence in `[0, 1]`. */
	readonly raw: number;
	/** Calibrated confidence in `[0, 1]`. */
	readonly calibrated: number;
	/** Temperature used in the calibration mapping (1.0 = identity). */
	readonly temperature: number;
	/** Weight applied to the prior when blending with the raw signal. */
	readonly priorWeight: number;
}

/**
 * Calibrator service contract — converts raw confidence into calibrated
 * probabilities and reports calibration quality.
 *
 * Implementations should be deterministic for the same `(raw, type, sessionId)`
 * triple given a fixed internal state.
 *
 * @example
 * ```typescript
 * const result = calibrator.calibrate(0.85, 'verification', 'session-1');
 * const stats  = calibrator.metrics('session-1');
 * calibrator.refit('session-1');
 * ```
 */
export interface ICalibrator {
	/** Whether calibration is enabled. When `false`, `calibrate()` returns `raw` unchanged. */
	readonly enabled: boolean;
	/**
	 * Map a raw confidence value to a calibrated value.
	 *
	 * @param rawConfidence - Raw confidence in `[0, 1]`.
	 * @param type - Thought type the confidence is associated with.
	 * @param sessionId - Session identifier for per-session calibration state.
	 * @returns The calibration result.
	 */
	calibrate(rawConfidence: number, type: ThoughtType, sessionId: SessionId): CalibrationResult;
	/**
	 * Get calibration metrics for a session, or aggregate metrics if `sessionId` is omitted.
	 *
	 * @param sessionId - Optional session id; omit for aggregate metrics.
	 * @returns Aggregate calibration metrics.
	 */
	metrics(sessionId?: SessionId): CalibrationMetrics;
	/**
	 * Refit the calibration model from accumulated samples.
	 *
	 * @param sessionId - Session id whose calibration model is refitted.
	 */
	refit(sessionId: SessionId): void;
	/**
	 * Remove the fitted temperature for one session.
	 *
	 * @param sessionId - Session identifier whose fitted temperature is removed.
	 */
	clearSession(sessionId: SessionId): void;
	/** Remove all fitted session temperatures. */
	clearAll(): void;
}
