import { asBranchId, asSessionId, asThoughtId } from '../../contracts/ids.js';
/**
 * Contract tests for the {@link ThoughtEvaluator} facade.
 *
 * These tests exercise the public facade over SignalComputer, Aggregator,
 * PatternDetector, and Calibrator.
 *
 * Tests intentionally exercise only the public {@link ThoughtEvaluator} API —
 * no imports from `core/evaluator/*` internals.
 *
 * @module __tests__/evaluator/EvaluatorContract
 */

import { describe, it, expect } from 'vitest';
import { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import {
	createTestThought,
	createHypothesisThought,
	createVerificationThought,
	createCritiqueThought,
	createSynthesisThought,
	createMetaThought,
} from '../helpers/factories.js';
import type { ThoughtData } from '../../core/thought.js';
import type { ThoughtType } from '../../contracts/reasoning-types.js';

// === Fixture builders =====================================================

interface Fixture {
	name: string;
	history: ThoughtData[];
	branches: Record<string, ThoughtData[]>;
}

function linearFixture(): Fixture {
	const history: ThoughtData[] = [];
	for (let i = 1; i <= 5; i++) {
		history.push(
			createTestThought({
				thought: `Step ${i}`,
				thought_number: i,
				total_thoughts: 5,
				thought_type: 'regular',
				confidence: 0.5 + i * 0.08, // 0.58, 0.66, 0.74, 0.82, 0.90
			})
		);
	}
	return { name: 'linear', history, branches: {} };
}

function branchingFixture(): Fixture {
	const main: ThoughtData[] = [
		createTestThought({ thought: 'Main 1', thought_number: 1, total_thoughts: 3, confidence: 0.7 }),
		createTestThought({
			thought: 'Main 2',
			thought_number: 2,
			total_thoughts: 3,
			confidence: 0.75,
		}),
		createTestThought({ thought: 'Main 3', thought_number: 3, total_thoughts: 3, confidence: 0.8 }),
	];
	const branchA: ThoughtData[] = [
		createTestThought({
			thought: 'Branch A.1',
			thought_number: 4,
			total_thoughts: 5,
			branch_from_thought: 2,
			branch_id: asBranchId('branch-a'),
			confidence: 0.65,
		}),
		createTestThought({
			thought: 'Branch A.2',
			thought_number: 5,
			total_thoughts: 5,
			branch_from_thought: 2,
			branch_id: asBranchId('branch-a'),
			confidence: 0.7,
		}),
	];
	const history = [...main, ...branchA];
	return { name: 'branching', history, branches: { 'branch-a': branchA } };
}

function hypothesisVerificationFixture(): Fixture {
	const history: ThoughtData[] = [
		createHypothesisThought({
			id: asThoughtId('hypothesis-verification-hypothesis'),
			thought_number: 1,
			total_thoughts: 3,
			confidence: 0.6,
			hypothesis_id: 'hyp-1',
		}),
		createVerificationThought({
			id: asThoughtId('hypothesis-verification-verifier'),
			thought_number: 2,
			total_thoughts: 3,
			confidence: 0.9,
			hypothesis_id: 'hyp-1',
			verification_target: 1,
		}),
		createSynthesisThought({
			thought_number: 3,
			total_thoughts: 3,
			confidence: 0.85,
		}),
	];
	return { name: 'hypothesis-verification', history, branches: {} };
}

function mixedTypesFixture(): Fixture {
	const history: ThoughtData[] = [
		createTestThought({
			thought_number: 1,
			total_thoughts: 6,
			thought_type: 'regular',
			confidence: 0.7,
		}),
		createHypothesisThought({
			id: asThoughtId('mixed-types-hypothesis'),
			thought_number: 2,
			total_thoughts: 6,
			hypothesis_id: 'hyp-1',
			confidence: 0.65,
		}),
		createVerificationThought({
			id: asThoughtId('mixed-types-verifier'),
			thought_number: 3,
			total_thoughts: 6,
			hypothesis_id: 'hyp-1',
			verification_target: 2,
			confidence: 0.88,
		}),
		createCritiqueThought({
			thought_number: 4,
			total_thoughts: 6,
			verification_target: 3,
			confidence: 0.72,
		}),
		createSynthesisThought({ thought_number: 5, total_thoughts: 6, confidence: 0.8 }),
		createMetaThought({ thought_number: 6, total_thoughts: 6, confidence: 0.78 }),
	];
	return { name: 'mixed-types', history, branches: {} };
}

function longSessionFixture(): Fixture {
	const history: ThoughtData[] = [];
	const types: ThoughtType[] = [
		'regular',
		'regular',
		'hypothesis',
		'regular',
		'verification',
		'regular',
		'critique',
		'regular',
		'hypothesis',
		'regular',
		'verification',
		'synthesis',
		'meta',
		'regular',
		'regular',
		'hypothesis',
	];
	for (let i = 0; i < types.length; i++) {
		const t = types[i]!;
		const conf = 0.5 + ((i * 17) % 50) / 100; // varied confidence in [0.50, 0.99]
		history.push(
			createTestThought({
				id: asThoughtId(`long-session-${i}`),
				thought: `Step ${i + 1} (${t})`,
				thought_number: i + 1,
				total_thoughts: types.length,
				thought_type: t,
				confidence: conf,
				...(t === 'hypothesis' ? { hypothesis_id: `hyp-${i}` } : {}),
				...(t === 'verification' && i > 0
					? { hypothesis_id: `hyp-${i - 2}`, verification_target: i - 1 }
					: {}),
			})
		);
	}
	return { name: 'long-session', history, branches: {} };
}

const fixtures: Fixture[] = [
	linearFixture(),
	branchingFixture(),
	hypothesisVerificationFixture(),
	mixedTypesFixture(),
	longSessionFixture(),
];

function createEvaluator(): ThoughtEvaluator {
	return new ThoughtEvaluator(new Calibrator(new OutcomeRecorder({ enabled: false }), false));
}

function confidenceContext(fixture: Fixture) {
	return {
		currentThought: fixture.history.at(-1) ?? createTestThought(),
		sessionId: asSessionId('evaluator-contract'),
	};
}

// === Tests ================================================================

describe('ThoughtEvaluator contract', () => {
	const evaluator = createEvaluator();

	describe('injected calibrator', () => {
		it('constructs a working evaluator with its current collaborator', () => {
			const ev = createEvaluator();
			const fx = linearFixture();
			expect(() =>
				ev.computeConfidenceSignals(fx.history, fx.branches, confidenceContext(fx))
			).not.toThrow();
			expect(() => ev.computeReasoningStats(fx.history, fx.branches)).not.toThrow();
			expect(() => ev.computePatternSignals(fx.history, fx.branches)).not.toThrow();
		});
	});

	describe('computeConfidenceSignals', () => {
		for (const fx of fixtures) {
			describe(`fixture: ${fx.name}`, () => {
				it('returns structural_quality as a number in [0,1]', () => {
					const signals = evaluator.computeConfidenceSignals(
						fx.history,
						fx.branches,
						confidenceContext(fx)
					);
					expect(typeof signals.structural_quality).toBe('number');
					expect(signals.structural_quality).toBeGreaterThanOrEqual(0);
					expect(signals.structural_quality).toBeLessThanOrEqual(1);
				});

				it('exposes all quality_components fields', () => {
					const signals = evaluator.computeConfidenceSignals(
						fx.history,
						fx.branches,
						confidenceContext(fx)
					);
					expect(signals.quality_components).toBeDefined();
					const c = signals.quality_components!;
					expect(typeof c.type_diversity).toBe('number');
					expect(typeof c.verification_coverage).toBe('number');
					expect(typeof c.depth_efficiency).toBe('number');
					expect(typeof c.confidence_stability).toBe('number');
					// Each component is bounded in (0, 1] (FLOOR=0.01 prevents 0).
					for (const v of Object.values(c)) {
						expect(v).toBeGreaterThan(0);
						expect(v).toBeLessThanOrEqual(1);
					}
				});

				it('is deterministic — same input → same output', () => {
					const a = evaluator.computeConfidenceSignals(
						fx.history,
						fx.branches,
						confidenceContext(fx)
					);
					const b = evaluator.computeConfidenceSignals(
						fx.history,
						fx.branches,
						confidenceContext(fx)
					);
					expect(b).toEqual(a);
				});

				it('reports reasoning_depth equal to history length', () => {
					const signals = evaluator.computeConfidenceSignals(
						fx.history,
						fx.branches,
						confidenceContext(fx)
					);
					expect(signals.reasoning_depth).toBe(fx.history.length);
				});
			});
		}
	});

	describe('computeReasoningStats', () => {
		for (const fx of fixtures) {
			describe(`fixture: ${fx.name}`, () => {
				it('total_thoughts matches history length', () => {
					const stats = evaluator.computeReasoningStats(fx.history, fx.branches);
					expect(stats.total_thoughts).toBe(fx.history.length);
				});

				it('thought_type_counts match manual counts', () => {
					const stats = evaluator.computeReasoningStats(fx.history, fx.branches);
					const expected: Record<ThoughtType, number> = {
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
					};
					for (const t of fx.history) {
						const type = (t.thought_type ?? 'regular') as ThoughtType;
						expected[type]++;
					}
					expect(stats.thought_type_counts).toEqual(expected);
				});

				it('hypothesis_count matches unique hypothesis_ids on hypothesis thoughts', () => {
					const stats = evaluator.computeReasoningStats(fx.history, fx.branches);
					const ids = new Set(
						fx.history
							.filter((t) => t.thought_type === 'hypothesis')
							.map((t) => t.hypothesis_id)
							.filter(Boolean)
					);
					expect(stats.hypothesis_count).toBe(ids.size);
				});

				it('total_branches matches branch keys', () => {
					const stats = evaluator.computeReasoningStats(fx.history, fx.branches);
					expect(stats.total_branches).toBe(Object.keys(fx.branches).length);
				});

				it('is deterministic — same input → same output', () => {
					const a = evaluator.computeReasoningStats(fx.history, fx.branches);
					const b = evaluator.computeReasoningStats(fx.history, fx.branches);
					expect(b).toEqual(a);
				});
			});
		}
	});

	describe('computePatternSignals', () => {
		for (const fx of fixtures) {
			describe(`fixture: ${fx.name}`, () => {
				it('returns an array of PatternSignal objects', () => {
					const signals = evaluator.computePatternSignals(fx.history, fx.branches);
					expect(Array.isArray(signals)).toBe(true);
					for (const s of signals) {
						expect(typeof s.pattern).toBe('string');
						expect(typeof s.message).toBe('string');
						expect(['info', 'warning']).toContain(s.severity);
						expect(Array.isArray(s.thought_range)).toBe(true);
						expect(s.thought_range.length).toBe(2);
					}
				});

				it('is deterministic — same input → same output', () => {
					const a = evaluator.computePatternSignals(fx.history, fx.branches);
					const b = evaluator.computePatternSignals(fx.history, fx.branches);
					expect(b).toEqual(a);
				});
			});
		}

		it('mixed-types fixture triggers ≥1 pattern signal', () => {
			const fx = mixedTypesFixture();
			const signals = evaluator.computePatternSignals(fx.history, fx.branches);
			expect(signals.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('disabled calibration', () => {
		it('does not add calibrated_confidence', () => {
			const ev = createEvaluator();
			for (const fx of fixtures) {
				const signals = ev.computeConfidenceSignals(fx.history, fx.branches, confidenceContext(fx));
				expect(signals.calibrated_confidence).toBeUndefined();
				expect(signals.calibration_metrics).toBeUndefined();
			}
		});

		it('also omits calibration fields for an empty history', () => {
			const ev = createEvaluator();
			const empty = { name: 'empty', history: [], branches: {} } satisfies Fixture;
			const signals = ev.computeConfidenceSignals([], {}, confidenceContext(empty));
			expect(signals.calibrated_confidence).toBeUndefined();
			expect(signals.calibration_metrics).toBeUndefined();
		});
	});
});
