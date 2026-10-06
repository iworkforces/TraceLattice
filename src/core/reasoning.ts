/**
 * Reasoning type definitions for advanced sequential thinking.
 *
 * Provides type-level constructs for classifying thoughts, computing confidence
 * signals from reasoning history, and aggregating session analytics.
 *
 * @module core/reasoning
 */

import type { CalibrationMetrics } from '../contracts/calibrator.js';
import type { PatternName, ThoughtType } from '../contracts/reasoning-types.js';
import type { GraphMetrics } from './graph/GraphView.js';

/** DAG topology plus derived measures of branching and explicit relations. */
export interface GraphSignals extends GraphMetrics {
	/** Mean out-degree over nodes with at least one outgoing edge. */
	readonly branching_factor: number;
	/** Share of edges with a kind other than sequence, in [0, 1]. */
	readonly relational_density: number;
}

/**
 * A detected reasoning pattern — surfaced as metadata or a warning.
 *
 * @example
 * ```typescript
 * const signal: PatternSignal = {
 *   pattern: 'hypothesis-without-verification',
 *   severity: 'warning',
 *   message: 'Hypothesis H1 has no matching verification thought.',
 *   thought_range: [3, 7],
 * };
 * ```
 */
export interface PatternSignal {
	/** Machine-readable pattern identifier. */
	/** Machine-readable pattern identifier. */
	pattern: PatternName;

	/** Severity: 'warning' surfaces as a hint, 'info' is metadata only. */
	severity: 'info' | 'warning';

	/** Human-readable description of the detected pattern. */
	message: string;

	/** Thought number range [start, end] where the pattern was detected. */
	thought_range: [number, number];
}

/**
 * Signals about reasoning quality computed from history.
 *
 * These metrics are derived from the thought chain and provide insight into
 * the depth, breadth, and completeness of the reasoning process.
 *
 * @example
 * ```typescript
 * const signals: ConfidenceSignals = {
 *   reasoning_depth: 5,
 *   revision_count: 1,
 *   branch_count: 2,
 *   thought_type_distribution: {
 *     regular: 3,
 *     hypothesis: 1,
 *     verification: 1,
 *     critique: 0,
 *     synthesis: 0,
 *     meta: 0,
 *   },
 *   has_hypothesis: true,
 *   has_verification: true,
 *   average_confidence: 0.85,
 *   structural_quality: 0.72,
 *   quality_components: {
 *     type_diversity: 0.65,
 *     verification_coverage: 1.0,
 *     depth_efficiency: 0.6,
 *     confidence_stability: 0.85,
 *   },
 * };
 * ```
 */
export interface ConfidenceSignals {
	/** Present only when an active graph with at least one edge is supplied. */
	readonly graph_signals?: GraphSignals;

	/** Length of thought chain to this point. */
	readonly reasoning_depth: number;

	/** How many revisions in this chain. */
	readonly revision_count: number;

	/** Active branches. */
	readonly branch_count: number;

	/** Distribution of thought types used. */
	readonly thought_type_distribution: Record<ThoughtType, number>;

	/** Whether any hypothesis exists in chain. */
	readonly has_hypothesis: boolean;

	/** Whether any verification exists. */
	readonly has_verification: boolean;

	/** Mean of explicit confidence values, null if none. */
	readonly average_confidence: number | null;

	/**
	 * Composite structural quality score (0-1).
	 * Geometric mean of quality_components with floor of 0.01 per component.
	 * Only present when history has ≥1 thought.
	 */
	readonly structural_quality?: number;

	/**
	 * Individual quality components that feed into structural_quality.
	 * Only present when structural_quality is present.
	 */
	readonly quality_components?: {
		/** Shannon entropy of thought_type distribution / log2(6), normalized 0-1. */
		readonly type_diversity: number;
		/** verified_hypotheses / total_hypotheses. 1.0 if no hypotheses exist. */
		readonly verification_coverage: number;
		/** max(chain_depth, branch_count + 1) / total_thoughts, clamped to [0, 1]. Branching is desirable. */
		readonly depth_efficiency: number;
		/** 1 - stddev(confidence values). Defaults to 0.5 if no confidence values. Null when fewer than 2 confidence values. */
		readonly confidence_stability: number | null;
	};

	/**
	 * Raw (unfloored) quality components before the 0.01 floor is applied.
	 * Only present when quality_components is present.
	 * Useful for debugging quality score calculations.
	 */
	readonly quality_components_raw?: {
		/** Shannon entropy / log2(6) — may be below 0.01 floor. */
		readonly type_diversity: number;
		/** verified / total hypotheses — may be below 0.01 floor. */
		readonly verification_coverage: number;
		/** depth / total — may be below 0.01 floor. */
		readonly depth_efficiency: number;
		/** 1 - stddev — may be below 0.01 floor. Null when fewer than 2 confidence values. */
		readonly confidence_stability: number | null;
	};

	/** Calibrated confidence score (post temperature scaling + prior shrinkage). Only present when features.calibration=true. */
	readonly calibrated_confidence?: number;

	/** Calibration quality metrics for the session. Only present when features.calibration=true. */
	readonly calibration_metrics?: CalibrationMetrics;
}

/**
 * Aggregated analytics about the reasoning session.
 *
 * Provides a comprehensive summary of the reasoning process including
 * thought counts, branch metrics, hypothesis tracking, and quality scores.
 *
 * @example
 * ```typescript
 * const stats: ReasoningStats = {
 *   total_thoughts: 12,
 *   total_branches: 3,
 *   total_revisions: 2,
 *   total_merges: 1,
 *   chain_depth: 8,
 *   thought_type_counts: {
 *     regular: 6,
 *     hypothesis: 2,
 *     verification: 2,
 *     critique: 1,
 *     synthesis: 1,
 *     meta: 0,
 *   },
 *   hypothesis_count: 2,
 *   verified_hypothesis_count: 1,
 *   unresolved_hypothesis_count: 1,
 *   average_quality_score: 0.78,
 *   average_confidence: 0.82,
 * };
 * ```
 */
export interface ReasoningStats {
	/** Total thoughts in session. */
	readonly total_thoughts: number;

	/** Total branches created. */
	readonly total_branches: number;

	/** Total revision operations. */
	readonly total_revisions: number;

	/** Total merge operations (DAG topology). */
	readonly total_merges: number;

	/** Longest sequential chain depth. */
	readonly chain_depth: number;

	/** Count of each thought type. */
	readonly thought_type_counts: Record<ThoughtType, number>;

	/** Hypotheses created. */
	readonly hypothesis_count: number;

	/** Hypotheses that have been verified. */
	readonly verified_hypothesis_count: number;

	/** Hypotheses without verification. */
	readonly unresolved_hypothesis_count: number;

	/** Average quality score across thoughts with scores, null if none. */
	readonly average_quality_score: number | null;

	/** Average confidence across thoughts with confidence, null if none. */
	readonly average_confidence: number | null;
}
