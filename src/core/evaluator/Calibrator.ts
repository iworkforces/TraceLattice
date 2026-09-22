/**
 * Confidence calibration for sequential thinking reasoning.
 *
 * Provides the {@link Calibrator} class — maps raw model confidence values
 * to calibrated probabilities using per-type empirical evidence blending and
 * grid-searched temperature scaling. Reports calibration quality through
 * Brier score and 10-bin Expected Calibration Error (ECE).
 *
 * Math summary:
 * - **Per-type evidence blend**: Raw confidence is the prior signal, weighted by
 *   `priorWeight = 10 / (10 + n)` where `n` is the type's outcome count. The
 *   remaining weight is applied to the observed per-type mean. An empty type
 *   defaults its mean to 0.5 but has zero empirical weight, so cold start returns raw.
 * - **Temperature scaling**: Grid search T ∈ {0.5, 0.75, 1.0, 1.25, 1.5, 2.0}
 *   minimizing negative log-likelihood (NLL) over per-type leave-one-out evidence blends.
 *   Exact ties retain T=1.0, then follow grid order. Requires at least 10 outcomes; below that
 *   threshold the evidence blend is returned unchanged.
 * - **Brier score**: `mean((predicted - actual)^2)` over stored raw outcomes.
 * - **ECE (10-bin)**: bucket predictions in 0.1 increments, compute weighted
 *   absolute deviation between raw bin mean confidence and bin accuracy.
 *
 * Stored outcomes and metrics remain raw. This transform does not guarantee factuality, better
 * metrics for every dataset, or monotonic per-example changes.
 *
 * @module core/evaluator/Calibrator
 */

import type {
	CalibrationMetrics,
	CalibrationResult,
	ICalibrator,
} from '../../contracts/calibrator.js';
import type { IOutcomeRecorder, VerificationOutcome } from '../../contracts/interfaces.js';
import type { ThoughtType } from '../../contracts/reasoning-types.js';
import type { SessionId } from '../../contracts/ids.js';
import {
	EPSILON,
	MIN_OUTCOMES_FOR_TEMPERATURE,
	applyTemperature,
	blendWithRawPrior,
	fitTemperature,
} from './calibration-math.js';
import { ALL_THOUGHT_TYPES } from './internals.js';

/** Number of bins used by ECE (10-bin → 0.1 increments). */
const ECE_BINS = 10;

/**
 * Build per-type empirical sums + counts from a list of outcomes.
 *
 * @param outcomes - Outcomes to aggregate.
 * @returns Map of thought type to `{ sum, count }`. Types with no outcomes
 *          are absent from the map.
 */
function aggregatePerType(
	outcomes: readonly VerificationOutcome[]
): Map<ThoughtType, { sum: number; count: number }> {
	const sums = new Map<ThoughtType, { sum: number; count: number }>();
	for (const o of outcomes) {
		const prev = sums.get(o.type) ?? { sum: 0, count: 0 };
		prev.sum += o.actual;
		prev.count += 1;
		sums.set(o.type, prev);
	}
	return sums;
}

function leaveOneOutBlendedOutcomes(
	outcomes: readonly VerificationOutcome[]
): VerificationOutcome[] {
	const perType = aggregatePerType(outcomes);
	return outcomes.map((outcome) => {
		const typeStats = perType.get(outcome.type) ?? { sum: outcome.actual, count: 1 };
		const sampleCount = typeStats.count - 1;
		if (sampleCount === 0) return { ...outcome };
		const empiricalMean = (typeStats.sum - outcome.actual) / sampleCount;
		const { blended } = blendWithRawPrior(outcome.predicted, empiricalMean, sampleCount);
		return { ...outcome, predicted: blended };
	});
}

/**
 * Compute the Brier score over a list of outcomes.
 *
 * @param outcomes - Outcomes to score.
 * @returns Mean squared error between predicted probability and actual label,
 *          or `null` if `outcomes` is empty.
 */
function brierScore(outcomes: readonly VerificationOutcome[]): number | null {
	if (outcomes.length === 0) return null;
	let sum = 0;
	for (const o of outcomes) {
		const diff = o.predicted - o.actual;
		sum += diff * diff;
	}
	return sum / outcomes.length;
}

/**
 * Compute 10-bin Expected Calibration Error.
 *
 * Buckets predictions in 0.1-wide bins, then sums weighted absolute
 * differences between bin mean confidence and bin accuracy.
 *
 * @param outcomes - Outcomes to evaluate.
 * @returns ECE in `[0, 1]`, or `null` if `outcomes` is empty.
 */
function expectedCalibrationError(outcomes: readonly VerificationOutcome[]): number | null {
	if (outcomes.length === 0) return null;
	const binConfSum = new Array<number>(ECE_BINS).fill(0);
	const binAccSum = new Array<number>(ECE_BINS).fill(0);
	const binCount = new Array<number>(ECE_BINS).fill(0);
	for (const o of outcomes) {
		const p = Math.min(1 - EPSILON, Math.max(0, o.predicted));
		const idx = Math.min(ECE_BINS - 1, Math.floor(p * ECE_BINS));
		binConfSum[idx] = (binConfSum[idx] ?? 0) + p;
		binAccSum[idx] = (binAccSum[idx] ?? 0) + o.actual;
		binCount[idx] = (binCount[idx] ?? 0) + 1;
	}
	const total = outcomes.length;
	let ece = 0;
	for (let i = 0; i < ECE_BINS; i++) {
		const n = binCount[i] ?? 0;
		if (n === 0) continue;
		const meanConf = (binConfSum[i] ?? 0) / n;
		const meanAcc = (binAccSum[i] ?? 0) / n;
		ece += (n / total) * Math.abs(meanConf - meanAcc);
	}
	return ece;
}

/**
 * Build the per-type Brier score breakdown for {@link CalibrationMetrics}.
 *
 * @param outcomes - Outcomes to bucket by type.
 * @returns Record keyed by every {@link ThoughtType}; `null` for types with
 *          no recorded outcomes.
 */
function perTypeBrier(
	outcomes: readonly VerificationOutcome[]
): Record<ThoughtType, number | null> {
	const buckets = new Map<string, VerificationOutcome[]>();
	for (const o of outcomes) {
		const list = buckets.get(o.type) ?? [];
		list.push(o);
		buckets.set(o.type, list);
	}
	const result = {} as Record<ThoughtType, number | null>;
	for (const t of ALL_THOUGHT_TYPES) {
		result[t] = brierScore(buckets.get(t) ?? []);
	}
	return result;
}

/** Empty CalibrationMetrics returned when calibration is disabled. */
function emptyMetrics(): CalibrationMetrics {
	const perType = {} as Record<ThoughtType, number | null>;
	for (const t of ALL_THOUGHT_TYPES) perType[t] = null;
	return {
		brierScore: null,
		ece: null,
		sampleCount: 0,
		perTypeBrier: perType,
	};
}

/**
 * Confidence calibration service.
 *
 * Stateless w.r.t. outcome storage (delegated to {@link IOutcomeRecorder}),
 * but maintains a small per-session temperature cache that is recomputed
 * via {@link Calibrator.refit}.
 *
 * @example
 * ```typescript
 * const calibrator = new Calibrator(outcomeRecorder, true);
 * const result = calibrator.calibrate(0.9, 'hypothesis', 'session-1');
 * console.log(result.calibrated, result.temperature, result.priorWeight);
 * ```
 */
export class Calibrator implements ICalibrator {
	public readonly enabled: boolean;
	private readonly _recorder: IOutcomeRecorder;
	private readonly _temperatures = new Map<SessionId, number>();

	constructor(outcomeRecorder: IOutcomeRecorder, enabled: boolean) {
		this._recorder = outcomeRecorder;
		this.enabled = enabled;
	}

	public calibrate(
		rawConfidence: number,
		type: ThoughtType,
		sessionId: SessionId
	): CalibrationResult {
		const raw = Math.min(1, Math.max(0, rawConfidence));
		if (!this.enabled) {
			return { raw, calibrated: raw, temperature: 1.0, priorWeight: 0 };
		}
		const outcomes = this._recorder.getOutcomes(sessionId);
		const perType = aggregatePerType(outcomes);
		const typeStats = perType.get(type);
		const n = typeStats?.count ?? 0;
		const observedMean = typeStats === undefined ? 0.5 : typeStats.sum / typeStats.count;
		const { blended, priorWeight } = blendWithRawPrior(raw, observedMean, n);
		const temperature = this._temperatures.get(sessionId) ?? 1.0;
		const calibrated =
			outcomes.length >= MIN_OUTCOMES_FOR_TEMPERATURE
				? applyTemperature(blended, temperature)
				: blended;
		return { raw, calibrated, temperature, priorWeight };
	}

	public metrics(sessionId?: SessionId): CalibrationMetrics {
		if (!this.enabled) return emptyMetrics();
		const outcomes =
			sessionId === undefined
				? this._recorder.getAllOutcomes()
				: this._recorder.getOutcomes(sessionId);
		return {
			brierScore: brierScore(outcomes),
			ece: expectedCalibrationError(outcomes),
			sampleCount: outcomes.length,
			perTypeBrier: perTypeBrier(outcomes),
		};
	}

	public refit(sessionId: SessionId): void {
		if (!this.enabled) return;
		const outcomes = this._recorder.getOutcomes(sessionId);
		this._temperatures.set(sessionId, fitTemperature(leaveOneOutBlendedOutcomes(outcomes)));
	}

	public clearSession(sessionId: SessionId): void {
		if (!this.enabled) return;
		this._temperatures.delete(sessionId);
	}

	public clearAll(): void {
		if (!this.enabled) return;
		this._temperatures.clear();
	}
}
