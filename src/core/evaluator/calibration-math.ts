import type { VerificationOutcome } from '../../contracts/interfaces.js';

/** Candidate temperatures evaluated during grid search refit. */
export const TEMPERATURE_GRID: readonly number[] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/** Minimum outcomes required before temperature scaling is applied. */
export const MIN_OUTCOMES_FOR_TEMPERATURE = 10;

/** Small epsilon to keep log() finite when probabilities approach 0 or 1. */
export const EPSILON = 1e-9;

const RAW_SIGNAL_PRIOR_STRENGTH = 10;

export interface RawPriorBlend {
	readonly blended: number;
	readonly priorWeight: number;
}

/**
 * Blend a raw confidence prior with the empirical mean for its thought type.
 *
 * The raw-signal weight is `10 / (10 + sampleCount)`, so an empty evidence set
 * returns the raw confidence exactly and empirical influence grows with evidence.
 */
export function blendWithRawPrior(
	rawConfidence: number,
	empiricalMean: number,
	sampleCount: number
): RawPriorBlend {
	const priorWeight = RAW_SIGNAL_PRIOR_STRENGTH / (RAW_SIGNAL_PRIOR_STRENGTH + sampleCount);
	return {
		blended: priorWeight * rawConfidence + (1 - priorWeight) * empiricalMean,
		priorWeight,
	};
}

/**
 * Apply temperature scaling to a probability `p`.
 *
 * Uses the standard logit re-scaling:
 * `sigmoid(logit(p) / T)`. T=1 is the identity.
 *
 * @param p - Probability in `[0, 1]`.
 * @param temperature - Temperature scalar (must be > 0).
 * @returns Scaled probability in `[0, 1]`.
 */
export function applyTemperature(p: number, temperature: number): number {
	if (temperature === 1) return p;
	const clamped = Math.min(1 - EPSILON, Math.max(EPSILON, p));
	const logit = Math.log(clamped / (1 - clamped));
	const scaled = logit / temperature;
	return 1 / (1 + Math.exp(-scaled));
}

/**
 * Compute negative log-likelihood for a candidate temperature.
 *
 * @param outcomes - Prediction/label samples to score.
 * @param temperature - Temperature to evaluate.
 * @returns Mean NLL across outcomes (lower is better). Returns `Infinity` if
 *          `outcomes` is empty.
 */
export function negativeLogLikelihood(
	outcomes: readonly VerificationOutcome[],
	temperature: number
): number {
	if (outcomes.length === 0) return Number.POSITIVE_INFINITY;
	let total = 0;
	for (const o of outcomes) {
		const p = applyTemperature(o.predicted, temperature);
		const clamped = Math.min(1 - EPSILON, Math.max(EPSILON, p));
		total += -(o.actual * Math.log(clamped) + (1 - o.actual) * Math.log(1 - clamped));
	}
	return total / outcomes.length;
}

/**
 * Grid-search the temperature minimizing NLL.
 *
 * Falls back to T=1.0 when there are fewer than {@link MIN_OUTCOMES_FOR_TEMPERATURE}
 * outcomes available.
 *
 * @param outcomes - Outcomes to fit against.
 * @returns Best temperature from {@link TEMPERATURE_GRID}.
 */
export function fitTemperature(outcomes: readonly VerificationOutcome[]): number {
	if (outcomes.length < MIN_OUTCOMES_FOR_TEMPERATURE) return 1.0;
	let best = 1.0;
	let bestLoss = negativeLogLikelihood(outcomes, best);
	for (const t of TEMPERATURE_GRID) {
		const loss = negativeLogLikelihood(outcomes, t);
		if (loss < bestLoss) {
			bestLoss = loss;
			best = t;
		}
	}
	return best;
}
