import { asBranchId, asSessionId, asThoughtId } from '../../contracts/ids.js';
/**
 * Strategy Contract Tests — enforces purity constraints on all
 * {@link IReasoningStrategy} implementations (Oracle review concern C2).
 *
 * Every strategy MUST be:
 *   - Idempotent: repeated `decide()` calls with identical context produce
 *     deeply-equal output.
 *   - Stateless: instances hold no own mutable fields (only the readonly
 *     `name` discriminator is allowed).
 *   - Deterministic: separate instances yield identical decisions for the
 *     same context.
 *   - Side-effect free: `decide()` must not mutate the input
 *     {@link StrategyContext}.
 *
 * @module __tests__/strategies/StrategyContract.test
 */

import { describe, it, expect } from 'vitest';
import type { IReasoningStrategy, StrategyContext } from '../../contracts/strategy.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { buildActiveEvidenceProjection } from '../../core/reasoning/ActiveEvidenceProjection.js';
import { createTestEdgeId, createTestThought } from '../helpers/factories.js';
import type { ThoughtData } from '../../core/thought.js';
import type { ReasoningStats } from '../../core/reasoning.js';

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
		sessionId: asSessionId('contract-session'),
		evidence: buildActiveEvidenceProjection({
			sessionId: asSessionId('contract-session'),
			history: [thought],
			branches: {},
			edgeStore: undefined,
		}),
		stats: makeStats(),
		currentThought: thought,
	};
}

/**
 * Registry of all strategy implementations to validate against the contract.
 * Add new strategies here so they are automatically swept by every test below.
 */
const strategyFactories: ReadonlyArray<{
	readonly name: string;
	readonly create: () => IReasoningStrategy;
}> = [
	{ name: 'SequentialStrategy', create: () => new SequentialStrategy() },
	{ name: 'TreeOfThoughtStrategy', create: () => new TreeOfThoughtStrategy() },
];

describe('IReasoningStrategy contract (purity guarantees)', () => {
	for (const { name, create } of strategyFactories) {
		describe(name, () => {
			it('idempotency: 1000 decide() calls with identical context return deeply-equal output', () => {
				const strategy = create();
				const ctx = makeContext(createTestThought({ next_thought_needed: true }));

				const first = strategy.decide(ctx);
				for (let i = 0; i < 1000; i++) {
					const next = strategy.decide(ctx);
					expect(next).toEqual(first);
				}
			});

			it('idempotency holds for terminate decisions too', () => {
				const strategy = create();
				const ctx = makeContext(createTestThought({ next_thought_needed: false }));

				const first = strategy.decide(ctx);
				for (let i = 0; i < 1000; i++) {
					expect(strategy.decide(ctx)).toEqual(first);
				}
			});

			it('no instance-owned mutable fields (only readonly `name` permitted)', () => {
				const strategy = create();
				const ownProps = Object.getOwnPropertyNames(strategy).filter((p) => p !== 'name');
				expect(ownProps).toEqual([]);
			});

			it('`name` is a stable string identifier (used for DI lookup / metrics)', () => {
				const a = create();
				const b = create();
				expect(typeof a.name).toBe('string');
				expect(a.name.length).toBeGreaterThan(0);
				expect(a.name).toBe(b.name);
			});

			it('determinism: two separate instances produce identical decisions', () => {
				const a = create();
				const b = create();
				const cases: ThoughtData[] = [
					createTestThought({ next_thought_needed: true }),
					createTestThought({ next_thought_needed: false }),
					createTestThought({
						next_thought_needed: true,
						branch_from_thought: 1,
						branch_id: asBranchId('alt'),
					}),
				];
				for (const t of cases) {
					const ctx = makeContext(t);
					expect(a.decide(ctx)).toEqual(b.decide(ctx));
					expect(a.shouldBranch(ctx)).toBe(b.shouldBranch(ctx));
					expect(a.shouldTerminate(ctx)).toBe(b.shouldTerminate(ctx));
				}
			});

			it('no side effects: decide() does not mutate the input StrategyContext', () => {
				const strategy = create();
				const thought = createTestThought({ next_thought_needed: true });
				const ctx = makeContext(thought);

				const snapshot = {
					sessionId: ctx.sessionId,
					mainHistoryLength: ctx.evidence.mainHistory.length,
					mainHistoryRef: ctx.evidence.mainHistory,
					graphRef: ctx.evidence.graph,
					statsRef: ctx.stats,
					statsClone: JSON.parse(JSON.stringify(ctx.stats)) as ReasoningStats,
					currentThoughtRef: ctx.currentThought,
					currentThoughtClone: JSON.parse(JSON.stringify(ctx.currentThought)) as ThoughtData,
				};

				strategy.decide(ctx);
				strategy.shouldBranch(ctx);
				strategy.shouldTerminate(ctx);

				expect(ctx.sessionId).toBe(snapshot.sessionId);
				expect(ctx.evidence.mainHistory).toBe(snapshot.mainHistoryRef);
				expect(ctx.evidence.mainHistory.length).toBe(snapshot.mainHistoryLength);
				expect(ctx.evidence.graph).toBe(snapshot.graphRef);
				expect(ctx.stats).toBe(snapshot.statsRef);
				expect(ctx.stats).toEqual(snapshot.statsClone);
				expect(ctx.currentThought).toBe(snapshot.currentThoughtRef);
				expect(ctx.currentThought).toEqual(snapshot.currentThoughtClone);
			});

			it('no side effects across many calls and varied thoughts', () => {
				const strategy = create();
				const thoughts: ThoughtData[] = [
					createTestThought({ next_thought_needed: true }),
					createTestThought({ next_thought_needed: false }),
					createTestThought({
						next_thought_needed: true,
						branch_from_thought: 2,
						branch_id: asBranchId('b1'),
					}),
				];
				for (const t of thoughts) {
					const ctx = makeContext(t);
					const before = JSON.parse(JSON.stringify(t)) as ThoughtData;
					for (let i = 0; i < 50; i++) {
						strategy.decide(ctx);
						strategy.shouldBranch(ctx);
						strategy.shouldTerminate(ctx);
					}
					expect(t).toEqual(before);
				}
			});
		});
	}

	it('keeps ToT depth-cap decisions deterministic, consistent, and side-effect free', () => {
		// Given
		const root = createTestThought({
			id: 'depth-root',
			thought_number: 1,
			next_thought_needed: true,
			confidence: 0.1,
		});
		const current = createTestThought({
			id: 'depth-current',
			thought_number: 2,
			next_thought_needed: true,
			confidence: 0.2,
		});
		const store = new EdgeStore();
		store.addEdge({
			id: createTestEdgeId('depth-edge'),
			from: asThoughtId('depth-root'),
			to: asThoughtId('depth-current'),
			kind: 'sequence',
			sessionId: asSessionId('contract-depth-session'),
			createdAt: 1,
		});
		const context: StrategyContext = {
			sessionId: asSessionId('contract-depth-session'),
			evidence: buildActiveEvidenceProjection({
				sessionId: asSessionId('contract-depth-session'),
				history: [root, current],
				branches: {},
				edgeStore: store,
			}),
			stats: makeStats(),
			currentThought: current,
		};
		const snapshot = structuredClone({
			history: context.evidence.mainHistory,
			stats: context.stats,
		});
		const first = new TreeOfThoughtStrategy({ depthCap: 1 });
		const second = new TreeOfThoughtStrategy({ depthCap: 1 });

		// When
		const decisions = Array.from({ length: 100 }, () => first.decide(context));

		// Then
		for (const decision of decisions) expect(decision).toEqual(decisions[0]);
		expect(decisions[0]).toEqual({ action: 'terminate', reason: 'depth cap' });
		expect(second.decide(context)).toEqual(decisions[0]);
		expect(first.shouldTerminate(context)).toBe(true);
		expect(first.shouldBranch(context)).toBe(false);
		expect({ history: context.evidence.mainHistory, stats: context.stats }).toEqual(snapshot);
	});
});
