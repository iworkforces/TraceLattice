import { describe, it, expect, vi } from 'vitest';
import { safeParse } from 'valibot';
import { ThoughtEvaluator } from '../core/ThoughtEvaluator.js';
import { ThoughtProcessor } from '../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../core/ThoughtFormatter.js';
import { normalizeInput } from '../core/InputNormalizer.js';
import { SequentialThinkingSchema } from '../schema.js';
import { MockHistoryManager } from './helpers/factories.js';
import { createTestThought } from './helpers/factories.js';
import type { ThoughtData } from '../core/thought.js';

import type { CalibrationMetrics, ICalibrator } from '../contracts/calibrator.js';
import { asBranchId, asSessionId, type SessionId } from '../contracts/ids.js';
import type { ThoughtType } from '../contracts/reasoning-types.js';

const EMPTY_CALIBRATION_METRICS: CalibrationMetrics = {
	brierScore: null,
	ece: null,
	sampleCount: 0,
	perTypeBrier: {
		regular: null,
		hypothesis: null,
		verification: null,
		critique: null,
		synthesis: null,
		meta: null,
		tool_call: null,
		tool_observation: null,
		assumption: null,
		decomposition: null,
		backtrack: null,
	},
};

const EVALUATOR_SESSION = asSessionId('evaluator-session');

function createRecordingCalibrator(enabled = true) {
	return {
		enabled,
		calibrate: vi.fn((raw: number, _type: ThoughtType, _sessionId: SessionId) => ({
			raw,
			calibrated: raw / 2,
			temperature: 1,
			priorWeight: 0,
		})),
		metrics: vi.fn((_sessionId?: SessionId) => EMPTY_CALIBRATION_METRICS),
		refit: vi.fn((_sessionId?: SessionId) => undefined),
		clearSession: vi.fn((_sessionId: SessionId) => undefined),
		clearAll: vi.fn(() => undefined),
	} satisfies ICalibrator;
}

function confidenceContext(history: ThoughtData[]) {
	return {
		currentThought: history.at(-1) ?? createTestThought(),
		sessionId: EVALUATOR_SESSION,
	};
}

describe('ThoughtEvaluator', () => {
	const evaluator = new ThoughtEvaluator(createRecordingCalibrator(false));

	// Helper to build history quickly
	function makeThought(overrides?: Partial<ThoughtData>): ThoughtData {
		return createTestThought(overrides);
	}

	describe('computeConfidenceSignals', () => {
		it('calibrates the explicit current branch thought in the canonical session', () => {
			const calibrator = createRecordingCalibrator();
			const calibratedEvaluator = new ThoughtEvaluator(calibrator);
			const sessionId = asSessionId('branch-session');
			const history = [makeThought({ confidence: 0.2, session_id: sessionId })];
			const currentThought = makeThought({
				confidence: 0.9,
				thought_type: 'verification',
				branch_id: asBranchId('branch'),
			});

			const signals = calibratedEvaluator.computeConfidenceSignals(
				history,
				{},
				{
					currentThought,
					sessionId,
				}
			);

			expect(calibrator.calibrate).toHaveBeenCalledWith(0.9, 'verification', sessionId);
			expect(calibrator.metrics).toHaveBeenCalledWith(sessionId);
			expect(signals.calibrated_confidence).toBe(0.45);
		});

		it('uses the explicit canonical global session context', () => {
			const calibrator = createRecordingCalibrator();
			const calibratedEvaluator = new ThoughtEvaluator(calibrator);
			const history = [makeThought({ confidence: 0.8 })];

			calibratedEvaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			expect(calibrator.calibrate).toHaveBeenCalledWith(0.8, 'regular', EVALUATOR_SESSION);
			expect(calibrator.metrics).toHaveBeenCalledWith(EVALUATOR_SESSION);
		});

		it('omits calibration fields when the explicit current thought has no confidence', () => {
			const calibrator = createRecordingCalibrator();
			const calibratedEvaluator = new ThoughtEvaluator(calibrator);

			const signals = calibratedEvaluator.computeConfidenceSignals(
				[makeThought({ confidence: 0.8 })],
				{},
				{ currentThought: makeThought(), sessionId: asSessionId('current') }
			);

			expect(calibrator.calibrate).not.toHaveBeenCalled();
			expect(calibrator.metrics).not.toHaveBeenCalled();
			expect(signals.calibrated_confidence).toBeUndefined();
			expect(signals.calibration_metrics).toBeUndefined();
		});

		it('returns zeros/nulls for empty history', () => {
			const signals = evaluator.computeConfidenceSignals([], {}, confidenceContext([]));

			expect(signals.reasoning_depth).toBe(0);
			expect(signals.revision_count).toBe(0);
			expect(signals.branch_count).toBe(0);
			expect(signals.has_hypothesis).toBe(false);
			expect(signals.has_verification).toBe(false);
			expect(signals.average_confidence).toBeNull();
			expect(signals.thought_type_distribution).toEqual({
				regular: 0,
				hypothesis: 0,
				verification: 0,
				critique: 0,
				synthesis: 0,
				meta: 0,
				tool_call: 0,
				tool_observation: 0,
				assumption: 0,
				decomposition: 0,
				backtrack: 0,
			});
		});

		it('returns correct values for single thought', () => {
			const thought = makeThought({ thought_number: 1 });
			const signals = evaluator.computeConfidenceSignals(
				[thought],
				{},
				confidenceContext([thought])
			);

			expect(signals.reasoning_depth).toBe(1);
			expect(signals.revision_count).toBe(0);
			expect(signals.branch_count).toBe(0);
		});

		it('counts mixed thought types correctly', () => {
			const history = [
				makeThought({ thought_type: 'regular' }),
				makeThought({ thought_type: 'hypothesis' }),
				makeThought({ thought_type: 'verification' }),
				makeThought({ thought_type: 'critique' }),
				makeThought({ thought_type: 'hypothesis' }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			expect(signals.thought_type_distribution.regular).toBe(1);
			expect(signals.thought_type_distribution.hypothesis).toBe(2);
			expect(signals.thought_type_distribution.verification).toBe(1);
			expect(signals.thought_type_distribution.critique).toBe(1);
			expect(signals.thought_type_distribution.synthesis).toBe(0);
			expect(signals.thought_type_distribution.meta).toBe(0);
			expect(signals.has_hypothesis).toBe(true);
			expect(signals.has_verification).toBe(true);
		});

		it('computes average confidence correctly', () => {
			const history = [
				makeThought({ confidence: 0.8 }),
				makeThought({ confidence: 0.6 }),
				makeThought({}), // no confidence
				makeThought({ confidence: 1.0 }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			expect(signals.average_confidence).toBeCloseTo(0.8, 5);
		});

		it('counts revisions correctly', () => {
			const history = [
				makeThought({}),
				makeThought({ is_revision: true, revises_thought: 1 }),
				makeThought({}),
				makeThought({ is_revision: true, revises_thought: 3 }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			expect(signals.revision_count).toBe(2);
		});

		it('counts branches correctly', () => {
			const branches = {
				'branch-a': [makeThought({ branch_id: asBranchId('branch-a') })],
				'branch-b': [makeThought({ branch_id: asBranchId('branch-b') })],
				'branch-c': [makeThought({ branch_id: asBranchId('branch-c') })],
			};
			const signals = evaluator.computeConfidenceSignals([], branches, confidenceContext([]));

			expect(signals.branch_count).toBe(3);
		});

		it('defaults thoughts without thought_type to regular', () => {
			const history = [
				makeThought({}), // no thought_type → defaults to regular
				makeThought({}),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			expect(signals.thought_type_distribution.regular).toBe(2);
		});
		describe('floating-point precision (regression — bug #1)', () => {
			it('rounds average_confidence (0.9 + 0.8) / 2 = 0.85', () => {
				const history = [makeThought({ confidence: 0.9 }), makeThought({ confidence: 0.8 })];
				const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
				expect(signals.average_confidence).toBe(0.85);
			});

			it('rounds average_confidence (0.7 + 0.7) / 2 = 0.7', () => {
				const history = [makeThought({ confidence: 0.7 }), makeThought({ confidence: 0.7 })];
				const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
				expect(signals.average_confidence).toBe(0.7);
			});

			it('rounds average_confidence for 3-value avg', () => {
				const history = [
					makeThought({ confidence: 0.9 }),
					makeThought({ confidence: 0.8 }),
					makeThought({ confidence: 0.75 }),
				];
				const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
				expect(signals.average_confidence).toBe(0.8166666667);
			});
		});
	});

	describe('computeReasoningStats', () => {
		it('returns zeros/nulls for empty history', () => {
			const stats = evaluator.computeReasoningStats([], {});

			expect(stats.total_thoughts).toBe(0);
			expect(stats.total_branches).toBe(0);
			expect(stats.total_revisions).toBe(0);
			expect(stats.total_merges).toBe(0);
			expect(stats.chain_depth).toBe(0);
			expect(stats.hypothesis_count).toBe(0);
			expect(stats.verified_hypothesis_count).toBe(0);
			expect(stats.unresolved_hypothesis_count).toBe(0);
			expect(stats.average_quality_score).toBeNull();
			expect(stats.average_confidence).toBeNull();
			expect(stats.thought_type_counts).toEqual({
				regular: 0,
				hypothesis: 0,
				verification: 0,
				critique: 0,
				synthesis: 0,
				meta: 0,
				tool_call: 0,
				tool_observation: 0,
				assumption: 0,
				decomposition: 0,
				backtrack: 0,
			});
		});

		it('counts total thoughts correctly', () => {
			const history = [makeThought(), makeThought(), makeThought()];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.total_thoughts).toBe(3);
		});

		it('computes average quality score', () => {
			const history = [
				makeThought({ quality_score: 0.7 }),
				makeThought({ quality_score: 0.9 }),
				makeThought({}), // no score
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.average_quality_score).toBeCloseTo(0.8, 5);
		});

		it('computes average confidence', () => {
			const history = [
				makeThought({ confidence: 0.5 }),
				makeThought({ confidence: 0.7 }),
				makeThought({ confidence: 0.9 }),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.average_confidence).toBeCloseTo(0.7, 5);
		});

		it('counts revisions', () => {
			const history = [
				makeThought({}),
				makeThought({ is_revision: true }),
				makeThought({}),
				makeThought({ is_revision: true }),
				makeThought({ is_revision: true }),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.total_revisions).toBe(3);
		});

		it('counts merge operations from merge_from_thoughts', () => {
			const history = [
				makeThought({}),
				makeThought({ merge_from_thoughts: [1, 2] }),
				makeThought({}),
				makeThought({ merge_branch_ids: ['a', 'b'].map(asBranchId) }),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.total_merges).toBe(2);
		});

		it('tracks hypothesis + verification chain correctly', () => {
			const history = [
				makeThought({
					thought_type: 'hypothesis',
					hypothesis_id: 'hyp-1',
				}),
				makeThought({
					thought_type: 'hypothesis',
					hypothesis_id: 'hyp-2',
				}),
				makeThought({
					thought_type: 'verification',
					hypothesis_id: 'hyp-1',
				}),
				makeThought({
					thought_type: 'regular',
				}),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.hypothesis_count).toBe(2);
			expect(stats.verified_hypothesis_count).toBe(1);
			expect(stats.unresolved_hypothesis_count).toBe(1);
		});

		it('counts branches from branches map', () => {
			const branches = {
				alpha: [makeThought()],
				beta: [makeThought()],
			};
			const stats = evaluator.computeReasoningStats([makeThought()], branches);

			expect(stats.total_branches).toBe(2);
		});

		it('computes chain depth for contiguous sequence', () => {
			// 5 thoughts, none branching → chain depth = 5
			const history = [
				makeThought({ thought_number: 1 }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3 }),
				makeThought({ thought_number: 4 }),
				makeThought({ thought_number: 5 }),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.chain_depth).toBe(5);
		});

		it('computes chain depth with branching interruptions', () => {
			// 6 thoughts: 3 contiguous, 1 branch, 2 contiguous → max depth = 3
			const history = [
				makeThought({ thought_number: 1 }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3 }),
				makeThought({ thought_number: 4, branch_from_thought: 2 }),
				makeThought({ thought_number: 5 }),
				makeThought({ thought_number: 6 }),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.chain_depth).toBe(3);
		});

		it('counts thought types correctly in stats', () => {
			const history = [
				makeThought({ thought_type: 'meta' }),
				makeThought({ thought_type: 'synthesis' }),
				makeThought({ thought_type: 'meta' }),
			];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.thought_type_counts.meta).toBe(2);
			expect(stats.thought_type_counts.synthesis).toBe(1);
			expect(stats.thought_type_counts.regular).toBe(0);
		});

		it('defaults thoughts without thought_type to regular in stats', () => {
			const history = [makeThought({}), makeThought({})];
			const stats = evaluator.computeReasoningStats(history, {});

			expect(stats.thought_type_counts.regular).toBe(2);
		});
		describe('floating-point precision (regression — bug #1)', () => {
			it('rounds average_confidence (0.9 + 0.8) / 2 = 0.85', () => {
				const history = [makeThought({ confidence: 0.9 }), makeThought({ confidence: 0.8 })];
				const stats = evaluator.computeReasoningStats(history, {});
				expect(stats.average_confidence).toBe(0.85);
			});

			it('rounds average_quality_score when present', () => {
				const history = [makeThought({ quality_score: 0.9 }), makeThought({ quality_score: 0.8 })];
				const stats = evaluator.computeReasoningStats(history, {});
				expect(stats.average_quality_score).toBe(0.85);
			});

			it('rounds average_confidence for 3-value avg', () => {
				const history = [
					makeThought({ confidence: 0.9 }),
					makeThought({ confidence: 0.8 }),
					makeThought({ confidence: 0.75 }),
				];
				const stats = evaluator.computeReasoningStats(history, {});
				expect(stats.average_confidence).toBe(0.8166666667);
			});
		});
	});

	describe('computePatternSignals', () => {
		it('returns empty array for empty history', () => {
			expect(evaluator.computePatternSignals([], {})).toEqual([]);
		});

		it('returns empty array for single thought', () => {
			const history = [makeThought({ thought_number: 1, thought: 'test' })];
			expect(evaluator.computePatternSignals(history, {})).toEqual([]);
		});

		// consecutive_without_verification
		it('detects 3+ consecutive regular thoughts without verification', () => {
			const history = [
				makeThought({ thought_number: 1 }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'consecutive_without_verification');
			expect(match).toBeDefined();
			expect(match!.severity).toBe('warning');
			expect(match!.thought_range).toEqual([1, 3]);
		});

		it('does not fire when verification exists in the run', () => {
			const history = [
				makeThought({ thought_number: 1 }),
				makeThought({ thought_number: 2, thought_type: 'verification' }),
				makeThought({ thought_number: 3 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'consecutive_without_verification')).toBeUndefined();
		});

		it('treats undefined thought_type as regular', () => {
			const history = [
				makeThought({ thought_number: 1 }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'consecutive_without_verification');
			expect(match).toBeDefined();
		});

		// unverified_hypothesis
		it('detects hypothesis without verification within 3 thoughts', () => {
			const history = [
				makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3 }),
				makeThought({ thought_number: 4 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'unverified_hypothesis');
			expect(match).toBeDefined();
			expect(match!.severity).toBe('warning');
		});

		it('does not fire when verification exists within 3 thoughts', () => {
			const history = [
				makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 2, thought_type: 'verification' }),
				makeThought({ thought_number: 3 }),
				makeThought({ thought_number: 4 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'unverified_hypothesis')).toBeUndefined();
		});

		it('does not fire when fewer than 3 subsequent thoughts exist', () => {
			const history = [
				makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 2 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'unverified_hypothesis')).toBeUndefined();
		});

		// no_alternatives_explored
		it('detects 5+ thoughts with no critique and no branches', () => {
			const history = Array.from({ length: 5 }, (_, i) => makeThought({ thought_number: i + 1 }));
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'no_alternatives_explored');
			expect(match).toBeDefined();
			expect(match!.severity).toBe('warning');
		});

		it('does not fire when critique exists', () => {
			const history = [
				makeThought({ thought_number: 1 }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3 }),
				makeThought({ thought_number: 4, thought_type: 'critique' }),
				makeThought({ thought_number: 5 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'no_alternatives_explored')).toBeUndefined();
		});

		it('does not fire when branches exist', () => {
			const history = Array.from({ length: 5 }, (_, i) => makeThought({ thought_number: i + 1 }));
			const signals = evaluator.computePatternSignals(history, {
				'branch-a': [makeThought({ thought_number: 1 })],
			});
			expect(signals.find((s) => s.pattern === 'no_alternatives_explored')).toBeUndefined();
		});

		// monotonic_type
		it('detects 4+ consecutive same thought_type', () => {
			const history = [
				makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 2, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 3, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 4, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 5, thought_type: 'hypothesis' }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'monotonic_type');
			expect(match).toBeDefined();
			expect(match!.severity).toBe('warning');
		});

		it('does not fire for 3 consecutive same type', () => {
			const history = [
				makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 2, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 3, thought_type: 'hypothesis' }),
				makeThought({ thought_number: 4, thought_type: 'verification' }),
				makeThought({ thought_number: 5 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'monotonic_type')).toBeUndefined();
		});

		// confidence_drift
		it('detects 3+ consecutive decreasing confidence values', () => {
			const history = [
				makeThought({ thought_number: 1, confidence: 0.9 }),
				makeThought({ thought_number: 2, confidence: 0.7 }),
				makeThought({ thought_number: 3, confidence: 0.5 }),
				makeThought({ thought_number: 4 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'confidence_drift');
			expect(match).toBeDefined();
			expect(match!.severity).toBe('warning');
		});

		it('does not fire when confidence increases', () => {
			const history = [
				makeThought({ thought_number: 1, confidence: 0.5 }),
				makeThought({ thought_number: 2, confidence: 0.7 }),
				makeThought({ thought_number: 3, confidence: 0.9 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'confidence_drift')).toBeUndefined();
		});

		it('ignores thoughts without confidence values', () => {
			const history = [
				makeThought({ thought_number: 1, confidence: 0.9 }),
				makeThought({ thought_number: 2 }),
				makeThought({ thought_number: 3, confidence: 0.5 }),
			];
			const signals = evaluator.computePatternSignals(history, {});
			expect(signals.find((s) => s.pattern === 'confidence_drift')).toBeUndefined();
		});

		// healthy_verification
		it('detects hypothesis followed by verification within 3 thoughts', () => {
			const history = [
				makeThought({
					thought_number: 1,
					thought_type: 'hypothesis',
					hypothesis_id: 'hyp-1',
				}),
				makeThought({ thought_number: 2 }),
				makeThought({
					thought_number: 3,
					thought_type: 'verification',
					hypothesis_id: 'hyp-1',
				}),
			];
			const signals = evaluator.computePatternSignals(history, {});
			const match = signals.find((s) => s.pattern === 'healthy_verification');
			expect(match).toBeDefined();
			expect(match!.severity).toBe('info');
		});
	});

	describe('structural_quality', () => {
		it('is undefined for empty history', () => {
			const signals = evaluator.computeConfidenceSignals([], {}, confidenceContext([]));
			expect(signals.structural_quality).toBeUndefined();
			expect(signals.quality_components).toBeUndefined();
		});

		it('computes type_diversity using Shannon entropy', () => {
			const history = [
				makeThought({ thought_type: 'regular' }),
				makeThought({ thought_type: 'hypothesis' }),
				makeThought({ thought_type: 'verification' }),
				makeThought({ thought_type: 'critique' }),
				makeThought({ thought_type: 'synthesis' }),
				makeThought({ thought_type: 'meta' }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.structural_quality).toBeDefined();
			expect(signals.quality_components!.type_diversity).toBeCloseTo(1.0, 2);
		});

		it('returns type_diversity near 0 for all-same-type history', () => {
			const history = [makeThought({}), makeThought({})];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.type_diversity).toBeGreaterThanOrEqual(0.01);
			expect(signals.quality_components!.type_diversity).toBeLessThanOrEqual(0.1);
		});

		it('returns verification_coverage 1.0 when no hypotheses', () => {
			const history = [makeThought({ thought_type: 'regular' })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.verification_coverage).toBe(1.0);
		});

		it('returns verification_coverage based on verified/total hypotheses', () => {
			const history = [
				makeThought({ thought_type: 'hypothesis', hypothesis_id: 'h1' }),
				makeThought({ thought_type: 'hypothesis', hypothesis_id: 'h2' }),
				makeThought({ thought_type: 'verification', hypothesis_id: 'h1' }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.verification_coverage).toBeCloseTo(0.5, 2);
		});

		it('computes depth_efficiency with branching bonus', () => {
			const history = [makeThought({}), makeThought({})];
			const branches = { b1: [makeThought({})] };
			const signals = evaluator.computeConfidenceSignals(
				history,
				branches,
				confidenceContext(history)
			);
			expect(signals.quality_components!.depth_efficiency).toBeGreaterThan(0);
		});

		it('returns confidence_stability 0.5 when no confidence values', () => {
			const history = [makeThought({}), makeThought({})];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.confidence_stability).toBe(0.5);
		});

		it('computes confidence_stability from stddev', () => {
			const history = [makeThought({ confidence: 1.0 }), makeThought({ confidence: 0.0 })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.confidence_stability).toBeCloseTo(0.5, 2);
		});

		it('computes weighted geometric mean correctly', () => {
			const history = [
				makeThought({ thought_type: 'regular' }),
				makeThought({ thought_type: 'hypothesis' }),
				makeThought({ thought_type: 'verification' }),
				makeThought({ thought_type: 'critique' }),
				makeThought({ thought_type: 'synthesis' }),
				makeThought({ thought_type: 'meta' }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.structural_quality).toBeGreaterThan(0);
			expect(signals.structural_quality).toBeLessThanOrEqual(1.0);
		});

		it('floors components at 0.01 to prevent geometric mean collapse', () => {
			const history = [makeThought({}), makeThought({})];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.type_diversity).toBeGreaterThanOrEqual(0.01);
			expect(signals.structural_quality).toBeGreaterThan(0);
		});

		it('returns confidence_stability null for single thought with confidence', () => {
			const history = [makeThought({ confidence: 0.2 })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.confidence_stability).toBeNull();
		});

		it('returns confidence_stability ~1.0 for two equal confidences', () => {
			const history = [makeThought({ confidence: 0.8 }), makeThought({ confidence: 0.8 })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.confidence_stability).toBeCloseTo(1.0, 5);
		});

		it('returns lower confidence_stability for divergent confidences', () => {
			const history = [makeThought({ confidence: 0.2 }), makeThought({ confidence: 0.9 })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components!.confidence_stability).toBeLessThan(0.7);
		});

		it('uses 3-component geometric mean when confidence_stability is null', () => {
			// Single thought with confidence → cs is null → redistributed weights
			const history = [makeThought({ confidence: 0.2, thought_type: 'regular' })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			const c = signals.quality_components!;
			expect(c.confidence_stability).toBeNull();

			// Manually compute expected 3-component score: td^0.375 * vc^0.375 * de^0.25
			const expected =
				Math.pow(c.type_diversity, 0.375) *
				Math.pow(c.verification_coverage, 0.375) *
				Math.pow(c.depth_efficiency, 0.25);
			expect(signals.structural_quality).toBeCloseTo(expected, 10);
		});

		it('uses 4-component geometric mean when confidence_stability is present', () => {
			const history = [
				makeThought({ confidence: 0.8, thought_type: 'regular' }),
				makeThought({ confidence: 0.8, thought_type: 'hypothesis' }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));

			const c = signals.quality_components!;
			expect(c.confidence_stability).not.toBeNull();

			const expected =
				Math.pow(c.type_diversity, 0.3) *
				Math.pow(c.verification_coverage, 0.3) *
				Math.pow(c.depth_efficiency, 0.2) *
				Math.pow(c.confidence_stability as number, 0.2);
			expect(signals.structural_quality).toBeCloseTo(expected, 10);
		});
	});

	describe('quality_components_raw', () => {
		it('is undefined for empty history', () => {
			const signals = evaluator.computeConfidenceSignals([], {}, confidenceContext([]));
			expect(signals.quality_components_raw).toBeUndefined();
		});

		it('exposes raw type_diversity below the 0.01 floor for all-same-type history', () => {
			const history = [makeThought({}), makeThought({})];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			// Shannon entropy is 0 for all-same-type → raw should be 0 (below floor)
			expect(signals.quality_components_raw!.type_diversity).toBe(0);
			// Floored value is at the floor
			expect(signals.quality_components!.type_diversity).toBeCloseTo(0.01, 5);
		});

		it('exposes raw verification_coverage that may differ from floored', () => {
			const history = [
				makeThought({ thought_type: 'hypothesis', hypothesis_id: 'h1' }),
				makeThought({ thought_type: 'hypothesis', hypothesis_id: 'h2' }),
				makeThought({ thought_type: 'verification', hypothesis_id: 'h1' }),
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components_raw!.verification_coverage).toBeCloseTo(0.5, 10);
			expect(signals.quality_components!.verification_coverage).toBeCloseTo(0.5, 10);
		});

		it('exposes raw depth_efficiency without flooring', () => {
			const history = [makeThought({}), makeThought({})];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components_raw!.depth_efficiency).toBeGreaterThan(0);
			expect(signals.quality_components_raw!.depth_efficiency).toBeLessThanOrEqual(1.0);
		});

		it('returns null raw confidence_stability when fewer than 2 confidence values', () => {
			const history = [makeThought({ confidence: 0.5 })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			expect(signals.quality_components_raw!.confidence_stability).toBeNull();
		});

		it('exposes raw confidence_stability as 1 - stddev (no floor)', () => {
			const history = [makeThought({ confidence: 0.0 }), makeThought({ confidence: 1.0 })];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			// stddev = 0.5 → raw = 0.5; floored is also 0.5
			expect(signals.quality_components_raw!.confidence_stability).toBeCloseTo(0.5, 10);
		});
	});
});

describe('ThoughtEvaluator — uncovered branches (lines 347-351)', () => {
	const evaluator = new ThoughtEvaluator(createRecordingCalibrator(false));

	function makeThought(overrides?: Partial<ThoughtData>): ThoughtData {
		return createTestThought(overrides);
	}

	describe('confidence drift — mid-run non-decreasing reset (else branch)', () => {
		it('should detect confidence_drift when 3+ decreasing run is broken by non-decreasing value', () => {
			// Build a run of 3+ strictly decreasing confidences, then a non-decreasing one.
			// This hits the else branch at line 345-361 where runLength >= 3.
			const history = [
				makeThought({ thought_number: 1, confidence: 0.9 }),
				makeThought({ thought_number: 2, confidence: 0.7 }),
				makeThought({ thought_number: 3, confidence: 0.5 }),
				makeThought({ thought_number: 4, confidence: 0.8 }), // non-decreasing → breaks run
			];
			const signals = evaluator.computeConfidenceSignals(history, {}, confidenceContext(history));
			const patterns = evaluator.computePatternSignals(history, {});
			const driftPatterns = patterns.filter((p) => p.pattern === 'confidence_drift');
			expect(driftPatterns.length).toBeGreaterThanOrEqual(1);
			expect(driftPatterns[0]!.severity).toBe('warning');
			expect(driftPatterns[0]!.thought_range).toEqual([1, 3]);
			expect(signals).toBeDefined();
		});

		it('should not detect confidence_drift when run of only 2 is broken', () => {
			// Run of 2 strictly decreasing, then non-decreasing → no signal
			const history = [
				makeThought({ thought_number: 1, confidence: 0.9 }),
				makeThought({ thought_number: 2, confidence: 0.7 }),
				makeThought({ thought_number: 3, confidence: 0.8 }), // non-decreasing, run was only 2
			];
			const patterns = evaluator.computePatternSignals(history, {});
			const driftPatterns = patterns.filter((p) => p.pattern === 'confidence_drift');
			expect(driftPatterns).toHaveLength(0);
		});

		it('should detect confidence_drift when 4-run is broken at the end by equal value', () => {
			const history = [
				makeThought({ thought_number: 1, confidence: 1.0 }),
				makeThought({ thought_number: 2, confidence: 0.8 }),
				makeThought({ thought_number: 3, confidence: 0.6 }),
				makeThought({ thought_number: 4, confidence: 0.4 }),
				makeThought({ thought_number: 5, confidence: 0.4 }), // equal → non-decreasing, breaks run
			];
			const patterns = evaluator.computePatternSignals(history, {});
			const driftPatterns = patterns.filter((p) => p.pattern === 'confidence_drift');
			expect(driftPatterns.length).toBeGreaterThanOrEqual(1);
			expect(driftPatterns[0]!.thought_range).toEqual([1, 4]);
		});
	});
});

// =============================================================================
// Investigation: Bugs #2 & #3 — previous_steps data degradation
// Hypothesis: server preserves previous_steps as-is; degradation is caller-side.
// =============================================================================

const FULL_TOOL = {
	tool_name: 'read_file',
	confidence: 0.92,
	rationale: 'Need to inspect the source to understand the bug',
	priority: 1,
	alternatives: ['grep', 'glob'],
	suggested_inputs: { path: '/tmp/foo.ts' },
};

const FULL_STEP = {
	step_description: 'Inspect source for the reported degradation',
	recommended_tools: [
		FULL_TOOL,
		{
			tool_name: 'lsp_diagnostics',
			confidence: 0.7,
			rationale: 'Verify no type errors after edit',
			priority: 2,
			alternatives: [],
		},
	],
	expected_outcome: 'Identify exact pass-through point',
	next_step_conditions: ['if no loss → caller bug', 'if loss → server bug'],
};

describe('Bugs #2 & #3 — schema validation (valibot direct)', () => {
	it('PartialToolRecommendationSchema preserves all fields when present (Bug #2)', () => {
		const input = {
			thought: 't',
			session_id: EVALUATOR_SESSION,
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			previous_steps: [FULL_STEP],
		};
		const result = safeParse(SequentialThinkingSchema, input);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const tool = result.output.previous_steps![0]!.recommended_tools![0]!;
		expect(tool.confidence).toBe(0.92);
		expect(tool.rationale).toBe('Need to inspect the source to understand the bug');
		expect(tool.priority).toBe(1);
		expect(tool.alternatives).toEqual(['grep', 'glob']);
		expect(tool.suggested_inputs).toEqual({ path: '/tmp/foo.ts' });
	});

	it('preserves all tools in recommended_tools array (Bug #3 — no drops)', () => {
		const input = {
			thought: 't',
			session_id: EVALUATOR_SESSION,
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			previous_steps: [FULL_STEP],
		};
		const result = safeParse(SequentialThinkingSchema, input);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const tools = result.output.previous_steps![0]!.recommended_tools!;
		expect(tools).toHaveLength(2);
		expect(tools.map((t) => t.tool_name)).toEqual(['read_file', 'lsp_diagnostics']);
	});

	it('partial fields receive defaults (expected lenient behavior, not a bug)', () => {
		const input = {
			thought: 't',
			session_id: EVALUATOR_SESSION,
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			previous_steps: [
				{
					step_description: 'partial step',
					recommended_tools: [{ tool_name: 'minimal_tool' }],
				},
			],
		};
		const result = safeParse(SequentialThinkingSchema, input);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const tool = result.output.previous_steps![0]!.recommended_tools![0]!;
		expect(tool.tool_name).toBe('minimal_tool');
		// Schema is lenient (no v.fallback); defaults applied later by InputNormalizer.
		expect(tool.confidence).toBeUndefined();
		expect(tool.rationale).toBeUndefined();
		expect(tool.priority).toBeUndefined();
	});
});

describe('Bugs #2 & #3 — InputNormalizer (only place defaults are applied)', () => {
	it('does not overwrite present fields in previous_steps recommendations', () => {
		const normalized = normalizeInput({
			thought: 't',
			session_id: EVALUATOR_SESSION,
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			previous_steps: [FULL_STEP],
		});
		const tool = (
			normalized.previous_steps as Array<{
				recommended_tools: Array<{
					tool_name: string;
					confidence: number;
					rationale: string;
					priority: number;
					alternatives?: string[];
					suggested_inputs?: Record<string, unknown>;
				}>;
			}>
		)[0]!.recommended_tools[0]!;
		expect(tool.confidence).toBe(0.92);
		expect(tool.rationale).toBe('Need to inspect the source to understand the bug');
		expect(tool.priority).toBe(1);
		expect(tool.alternatives).toEqual(['grep', 'glob']);
		expect(tool.suggested_inputs).toEqual({ path: '/tmp/foo.ts' });
	});
});

describe('Bugs #2 & #3 — ThoughtProcessor.process() end-to-end round-trip', () => {
	it('echoes previous_steps with all fields intact (server is stateless pass-through)', async () => {
		const processor = new ThoughtProcessor(
			new MockHistoryManager(),
			new ThoughtFormatter(),
			new ThoughtEvaluator(createRecordingCalibrator(false))
		);
		const result = await processor.process({
			session_id: EVALUATOR_SESSION,
			thought: 't',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			thought_type: 'regular',
			previous_steps: [FULL_STEP],
		});
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.previous_steps).toBeDefined();
		expect(payload.previous_steps).toHaveLength(1);
		const tools = payload.previous_steps[0].recommended_tools;
		expect(tools).toHaveLength(2);
		expect(tools[0].tool_name).toBe('read_file');
		expect(tools[0].confidence).toBe(0.92);
		expect(tools[0].rationale).toBe('Need to inspect the source to understand the bug');
		expect(tools[0].priority).toBe(1);
		expect(tools[0].alternatives).toEqual(['grep', 'glob']);
		expect(tools[0].suggested_inputs).toEqual({ path: '/tmp/foo.ts' });
		expect(tools[1].tool_name).toBe('lsp_diagnostics');
		expect(tools[1].confidence).toBe(0.7);
	});
});

describe('Pattern hints surfacing — bugs #4 & #5', () => {
	const evaluator = new ThoughtEvaluator(createRecordingCalibrator(false));

	function makeThought(overrides?: Partial<ThoughtData>): ThoughtData {
		return createTestThought(overrides);
	}

	it('monotonic_type fires as warning when 4+ consecutive same-type thoughts exist (history >= 5)', () => {
		const history = [
			makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
			makeThought({ thought_number: 2, thought_type: 'regular' }),
			makeThought({ thought_number: 3, thought_type: 'regular' }),
			makeThought({ thought_number: 4, thought_type: 'regular' }),
			makeThought({ thought_number: 5, thought_type: 'regular' }),
		];
		const patterns = evaluator.computePatternSignals(history, {});
		const match = patterns.find((p) => p.pattern === 'monotonic_type');
		expect(match).toBeDefined();
		expect(match!.severity).toBe('warning');
	});

	it('no_alternatives_explored fires as warning when 5+ regular thoughts have no critique/branch', () => {
		const history = Array.from({ length: 5 }, (_, i) =>
			makeThought({ thought_number: i + 1, thought_type: 'regular' })
		);
		const patterns = evaluator.computePatternSignals(history, {});
		const match = patterns.find((p) => p.pattern === 'no_alternatives_explored');
		expect(match).toBeDefined();
		expect(match!.severity).toBe('warning');
	});

	it('monotonic_type does NOT fire with only 3 consecutive same-type thoughts (threshold is 4)', () => {
		const history = [
			makeThought({ thought_number: 1, thought_type: 'hypothesis' }),
			makeThought({ thought_number: 2, thought_type: 'regular' }),
			makeThought({ thought_number: 3, thought_type: 'regular' }),
			makeThought({ thought_number: 4, thought_type: 'regular' }),
			makeThought({ thought_number: 5, thought_type: 'verification' }),
		];
		const patterns = evaluator.computePatternSignals(history, {});
		expect(patterns.find((p) => p.pattern === 'monotonic_type')).toBeUndefined();
	});

	it('monotonic_type and no_alternatives_explored coexist with consecutive_without_verification', () => {
		const history = Array.from({ length: 5 }, (_, i) =>
			makeThought({ thought_number: i + 1, thought_type: 'regular' })
		);
		const patterns = evaluator.computePatternSignals(history, {});
		const warnings = patterns.filter((p) => p.severity === 'warning');
		const names = new Set(warnings.map((w) => w.pattern));
		expect(names.has('monotonic_type')).toBe(true);
		expect(names.has('no_alternatives_explored')).toBe(true);
		expect(names.has('consecutive_without_verification')).toBe(true);
	});
});
