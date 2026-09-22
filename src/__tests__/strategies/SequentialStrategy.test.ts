import { asSessionId } from '../../contracts/ids.js';
import { describe, it, expect } from 'vitest';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { buildActiveEvidenceProjection } from '../../core/reasoning/ActiveEvidenceProjection.js';
import { createTestThought } from '../helpers/factories.js';
import type { StrategyContext } from '../../contracts/strategy.js';
import type { ThoughtData } from '../../core/thought.js';
import type { ReasoningStats } from '../../core/reasoning.js';

import { asBranchId } from '../../contracts/ids.js';
function makeStats(): ReasoningStats {
	return {
		total_thoughts: 0,
		total_branches: 0,
		total_revisions: 0,
		total_merges: 0,
		chain_depth: 0,
		thought_type_counts: {
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
		},
		hypothesis_count: 0,
		verified_hypothesis_count: 0,
		unresolved_hypothesis_count: 0,
		average_quality_score: null,
		average_confidence: null,
	};
}

function makeContext(thought: ThoughtData): StrategyContext {
	return {
		sessionId: asSessionId('test-session'),
		evidence: buildActiveEvidenceProjection({
			sessionId: asSessionId('test-session'),
			history: [thought],
			branches: {},
			edgeStore: undefined,
		}),
		stats: makeStats(),
		currentThought: thought,
	};
}

describe('SequentialStrategy', () => {
	const strategy = new SequentialStrategy();

	describe('name', () => {
		it("is 'sequential'", () => {
			expect(strategy.name).toBe('sequential');
		});
	});

	describe('decide', () => {
		it('returns continue when next_thought_needed is true', () => {
			const ctx = makeContext(createTestThought({ next_thought_needed: true }));
			expect(strategy.decide(ctx)).toEqual({ action: 'continue' });
		});

		it('returns continue when next_thought_needed is undefined (default)', () => {
			// Force undefined explicitly (factory defaults to false).
			const thought: ThoughtData = {
				thought: 'no flag',
				thought_number: 1,
				total_thoughts: 1,
			} as ThoughtData;
			const ctx = makeContext(thought);
			expect(strategy.decide(ctx)).toEqual({ action: 'continue' });
		});

		it('returns terminate when next_thought_needed is false', () => {
			const ctx = makeContext(createTestThought({ next_thought_needed: false }));
			const decision = strategy.decide(ctx);
			expect(decision.action).toBe('terminate');
			if (decision.action === 'terminate') {
				expect(decision.reason).toBe('next_thought_needed=false');
			}
		});
	});

	describe('shouldBranch', () => {
		it('returns true when both branch_from_thought and branch_id present', () => {
			const ctx = makeContext(
				createTestThought({ branch_from_thought: 1, branch_id: asBranchId('alt-1') })
			);
			expect(strategy.shouldBranch(ctx)).toBe(true);
		});

		it('returns false when only branch_from_thought present', () => {
			const ctx = makeContext(createTestThought({ branch_from_thought: 1 }));
			expect(strategy.shouldBranch(ctx)).toBe(false);
		});

		it('returns false when only branch_id present', () => {
			const ctx = makeContext(createTestThought({ branch_id: asBranchId('alt-1') }));
			expect(strategy.shouldBranch(ctx)).toBe(false);
		});

		it('returns false when neither present', () => {
			const ctx = makeContext(createTestThought());
			expect(strategy.shouldBranch(ctx)).toBe(false);
		});
	});

	describe('shouldTerminate', () => {
		it('returns true when next_thought_needed is false', () => {
			const ctx = makeContext(createTestThought({ next_thought_needed: false }));
			expect(strategy.shouldTerminate(ctx)).toBe(true);
		});

		it('returns false when next_thought_needed is true', () => {
			const ctx = makeContext(createTestThought({ next_thought_needed: true }));
			expect(strategy.shouldTerminate(ctx)).toBe(false);
		});
	});

	describe('idempotency / purity', () => {
		it('1000 identical calls produce identical results', () => {
			const ctx = makeContext(
				createTestThought({
					next_thought_needed: true,
					branch_from_thought: 2,
					branch_id: asBranchId('b'),
				})
			);
			const baseline = {
				decision: strategy.decide(ctx),
				branch: strategy.shouldBranch(ctx),
				terminate: strategy.shouldTerminate(ctx),
			};
			for (let i = 0; i < 1000; i++) {
				expect(strategy.decide(ctx)).toEqual(baseline.decision);
				expect(strategy.shouldBranch(ctx)).toBe(baseline.branch);
				expect(strategy.shouldTerminate(ctx)).toBe(baseline.terminate);
			}
		});
	});
});
