/**
 * Confidence signal computation for sequential thinking.
 *
 * Provides {@link SignalComputer} — a pure stateless service that computes
 * {@link ConfidenceSignals} (including the composite `structural_quality`
 * score and its components) from thought history and branch data.
 *
 * Extracted from `ThoughtEvaluator` as part of the evaluator decomposition.
 * All methods are pure: no side effects, no I/O, no internal state.
 *
 * @module core/evaluator/SignalComputer
 */

import type { ThoughtType } from '../../contracts/reasoning-types.js';
import type { ConfidenceSignals } from '../reasoning.js';
import type { ThoughtData } from '../thought.js';
import { ALL_THOUGHT_TYPES, _computeChainDepth, _countByType } from './internals.js';
import type { VerificationLinks } from './VerificationLinks.js';

/** Floor value applied to each quality component to prevent geometric mean collapse. */
const FLOOR = 0.01;

/**
 * Round a numeric value to a fixed number of decimal places to mitigate
 * IEEE 754 floating-point accumulation errors (e.g. 0.9 + 0.8 averaging to
 * 0.8500000000000001 instead of 0.85).
 */
function roundToPrecision(value: number, decimals: number = 10): number {
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}

/** Result of {@link SignalComputer.computeStructuralQuality}. */
interface StructuralQualityResult {
	score: number;
	components: {
		type_diversity: number;
		verification_coverage: number;
		depth_efficiency: number;
		confidence_stability: number | null;
	};
	raw_components: {
		type_diversity: number;
		verification_coverage: number;
		depth_efficiency: number;
		confidence_stability: number | null;
	};
}

/**
 * Stateless service that computes {@link ConfidenceSignals} from thought history.
 *
 * @remarks
 * Pure computation — no side effects, no I/O, no internal state.
 * Safe to register as singleton or transient in DI.
 */
export class SignalComputer {
	/**
	 * Structural quality weight configuration.
	 *
	 * Weights reflect the relative importance of each quality dimension:
	 * - type_diversity (0.3): Shannon entropy of thought types — rewards reasoning that uses
	 *   multiple cognitive modes (hypothesis, verification, critique, synthesis) rather than
	 *   monotonic sequences. Based on information theory: higher entropy = more information.
	 *
	 * - verification_coverage (0.3): Ratio of verified to total hypotheses — rewards scientific
	 *   rigor. Hypotheses without verification are speculation; verification grounds reasoning.
	 *   Equal weight with diversity because unverified reasoning is a common failure mode.
	 *
	 * - depth_efficiency (0.2): Ratio of structural depth to total thoughts — rewards efficient
	 *   reasoning. Deep chains (many revisions/branches) are good; but only if proportionally
	 *   dense. Padding with low-value thoughts penalizes this metric.
	 *
	 * - confidence_stability (0.2): Low variance in self-assessed confidence — rewards calibrated
	 *   reasoning. Wildly fluctuating confidence suggests uncertainty about the approach.
	 *   Lower weight because confidence values are LLM self-reports (inherently noisy).
	 *
	 * Design rationale:
	 * - Diversity + Verification (0.6) > Depth + Stability (0.4): Structural properties of the
	 *   reasoning DAG are more important than behavioral signals.
	 * - All weights are positive (no dimension is penalizing).
	 * - Weights sum to 1.0 for normalized scoring.
	 * - When confidence_stability is unavailable (n<2), remaining weights redistribute
	 *   proportionally: td→0.375, vc→0.375, de→0.25 (preserving relative ratios).
	 */
	private static readonly QUALITY_WEIGHTS = {
		typeDiversity: 0.3,
		verificationCoverage: 0.3,
		depthEfficiency: 0.2,
		confidenceStability: 0.2,
	} as const;

	/**
	 * Redistributed weights when confidence_stability is excluded (n<2).
	 * Preserves relative ratios of remaining components (sum = 1.0).
	 */
	private static readonly QUALITY_WEIGHTS_NO_CS = {
		typeDiversity: 0.375,
		verificationCoverage: 0.375,
		depthEfficiency: 0.25,
	} as const;

	/**
	 * Compute confidence signals from history context.
	 *
	 * @param history - All thoughts in the current session
	 * @param branches - Map of branch IDs to their thought arrays
	 * @returns Computed confidence signals reflecting reasoning quality
	 */
	public computeConfidenceSignals(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>,
		links: VerificationLinks
	): ConfidenceSignals {
		const typeDistribution = _countByType(history);
		const allConfidences = history
			.map((t) => t.confidence)
			.filter((c): c is number => c !== undefined);

		// Compute structural quality components
		const structuralResult = this.computeStructuralQuality(
			history,
			branches,
			typeDistribution,
			allConfidences,
			links
		);

		return {
			reasoning_depth: history.length,
			revision_count: history.filter((t) => t.is_revision).length,
			branch_count: Object.keys(branches).length,
			thought_type_distribution: typeDistribution,
			has_hypothesis: history.some((t) => t.thought_type === 'hypothesis'),
			has_verification: history.some((t) => t.thought_type === 'verification'),
			average_confidence:
				allConfidences.length > 0
					? roundToPrecision(allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length)
					: null,
			...(structuralResult !== null && {
				structural_quality: structuralResult.score,
				quality_components: structuralResult.components,
				quality_components_raw: structuralResult.raw_components,
			}),
		};
	}

	/**
	 * Compute the composite structural quality score and its components.
	 *
	 * Algorithm (all components floored at {@link FLOOR} = 0.01):
	 * - `type_diversity` = Shannon entropy of thought_type distribution / log2(6)
	 * - `verification_coverage` = verified_hypotheses / max(total_hypotheses, 1) (1.0 if none)
	 * - `depth_efficiency` = max(chain_depth, branch_count + 1) / total_thoughts, clamped to 1.0
	 * - `confidence_stability` = 1 - stddev(confidences), default 0.5 when empty, null when single value
	 * - `structural_quality` = td^0.3 * vc^0.3 * de^0.2 * cs^0.2 (weighted geometric mean)
	 *
	 * Note: When confidence_stability is null (fewer than 2 confidence values), it is
	 * excluded from the geometric mean and the remaining weights are redistributed
	 * proportionally (td→0.375, vc→0.375, de→0.25).
	 *
	 * @returns Score + components, or `null` when history is empty
	 */
	public computeStructuralQuality(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>,
		typeDistribution: Record<ThoughtType, number>,
		confidences: number[],
		links: VerificationLinks
	): StructuralQualityResult | null {
		if (history.length === 0) return null;

		// 1. type_diversity: Shannon entropy / log2(6)
		const total = history.length;
		let entropy = 0;
		for (const type of ALL_THOUGHT_TYPES) {
			const count = typeDistribution[type];
			if (count > 0) {
				const pk = count / total;
				entropy -= pk * Math.log2(pk);
			}
		}
		const rawTypeDiversity = entropy / Math.log2(6);
		const typeDiversity = Math.max(rawTypeDiversity, FLOOR);

		// 2. verification_coverage: verified / total hypotheses (1.0 if none)
		const rawVerificationCoverage =
			links.hypotheses.length === 0 ? 1.0 : links.verifiedHypothesisCount / links.hypotheses.length;
		const verificationCoverage = Math.max(rawVerificationCoverage, FLOOR);

		// 3. depth_efficiency: max(chain_depth, branch_count + 1) / total_thoughts, clamped to 1.0
		// NOTE (Metis H3): Branching is desirable — treat branches as depth-equivalent.
		const chainDepth = _computeChainDepth(history);
		const branchCount = Object.keys(branches).length;
		const effectiveDepth = Math.max(chainDepth, branchCount + 1);
		const rawDepthEfficiency = Math.min(effectiveDepth / total, 1.0);
		const depthEfficiency = Math.max(rawDepthEfficiency, FLOOR);

		// 4. confidence_stability: 1 - stddev(confidences), default 0.5
		const confidenceStability = this.computeConfidenceStability(confidences);
		const rawConfidenceStability = this.computeRawConfidenceStability(confidences);

		const components: StructuralQualityResult['components'] = {
			type_diversity: typeDiversity,
			verification_coverage: verificationCoverage,
			depth_efficiency: depthEfficiency,
			confidence_stability: confidenceStability,
		};

		const rawComponents: StructuralQualityResult['raw_components'] = {
			type_diversity: rawTypeDiversity,
			verification_coverage: rawVerificationCoverage,
			depth_efficiency: rawDepthEfficiency,
			confidence_stability: rawConfidenceStability,
		};

		// Weighted geometric mean: td^0.3 * vc^0.3 * de^0.2 * cs^0.2
		// When confidence_stability is null (n<2), exclude it from the geomean
		// and redistribute its weight proportionally to remaining components
		// (normalized td=0.375, vc=0.375, de=0.25)
		let score: number;
		if (confidenceStability !== null) {
			const w = SignalComputer.QUALITY_WEIGHTS;
			score =
				Math.pow(typeDiversity, w.typeDiversity) *
				Math.pow(verificationCoverage, w.verificationCoverage) *
				Math.pow(depthEfficiency, w.depthEfficiency) *
				Math.pow(confidenceStability, w.confidenceStability);
		} else {
			const w3 = SignalComputer.QUALITY_WEIGHTS_NO_CS;
			score =
				Math.pow(typeDiversity, w3.typeDiversity) *
				Math.pow(verificationCoverage, w3.verificationCoverage) *
				Math.pow(depthEfficiency, w3.depthEfficiency);
		}

		return { score, components, raw_components: rawComponents };
	}

	/**
	 * Compute confidence stability: 1 - stddev(confidences).
	 *
	 * - Empty input → 0.5 (neutral default)
	 * - Single value → null (insufficient data, excluded from structural quality)
	 * - Otherwise → max(1 - stddev, FLOOR)
	 */
	public computeConfidenceStability(confidences: number[]): number | null {
		if (confidences.length === 0) return 0.5;
		if (confidences.length === 1) return null;

		const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
		const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
		const stddev = Math.sqrt(variance);
		return Math.max(1 - stddev, FLOOR);
	}

	/**
	 * Compute raw (unfloored) confidence stability: 1 - stddev(confidences).
	 *
	 * - Empty input → 0.5 (neutral default)
	 * - Single value → null (insufficient data)
	 * - Otherwise → 1 - stddev (may be below FLOOR)
	 */
	public computeRawConfidenceStability(confidences: number[]): number | null {
		if (confidences.length === 0) return 0.5;
		if (confidences.length === 1) return null;

		const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
		const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
		const stddev = Math.sqrt(variance);
		return 1 - stddev;
	}
}
