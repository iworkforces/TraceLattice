import { asBranchId, asSessionId, asThoughtId } from '../../../contracts/ids.js';
/**
 * Eval fixture scenarios — handcrafted thought sequences exercising
 * different reasoning trajectories (convergence, plateau, divergence, …).
 *
 * Consumed by `totVsSequential.eval.ts`. Each scenario describes the
 * minimal `ThoughtData` chain plus the expected ToT behavior under the
 * default {@link TreeOfThoughtStrategy} configuration.
 *
 * @module __tests__/eval/fixtures/scenarios
 */

import type { ThoughtData } from '../../../core/thought.js';

const EVAL_FIXTURE_SESSION = asSessionId('eval-fixture-session');

/**
 * Behavior expected of the Tree-of-Thought strategy on a given scenario.
 * Fields are intentionally optional — set only the predicates that matter.
 */
export interface ExpectedBehavior {
	readonly totShouldTerminate?: boolean;
	readonly totShouldBranch?: boolean;
}

/**
 * One eval case: a named thought sequence plus expected ToT outcome.
 *
 * The current thought is always the last entry in `thoughts`. When
 * `branchEdges` is provided, the harness will wire up `branch` edges
 * between the referenced thought ids in addition to the default
 * `sequence` edges (which connect consecutive thoughts).
 */
export interface EvalScenario {
	readonly name: string;
	readonly thoughts: readonly ThoughtData[];
	readonly expectedBehavior: ExpectedBehavior;
	/** Optional explicit branch edges as [fromId, toId] pairs. */
	readonly branchEdges?: ReadonlyArray<readonly [string, string]>;
}

/** Helper to build a thought with a stable id derived from the index. */
function t(
	idx: number,
	thought: string,
	confidence: number,
	overrides: Partial<ThoughtData> = {}
): ThoughtData {
	return {
		session_id: EVAL_FIXTURE_SESSION,
		id: asThoughtId(`t-${idx}`),
		thought,
		thought_number: idx,
		total_thoughts: 10,
		next_thought_needed: true,
		confidence,
		quality_score: 1.0,
		...overrides,
	};
}

/**
 * Build a chain of thoughts whose confidence values follow `confidences`.
 * Total length and thought_number are inferred from the array length.
 */
function chain(confidences: readonly number[]): ThoughtData[] {
	return confidences.map((c, i) =>
		t(i + 1, `step ${i + 1}`, c, { total_thoughts: confidences.length })
	);
}

/** The 10 canonical eval scenarios. */
export const scenarios: readonly EvalScenario[] = [
	{
		name: 'Linear Converge',
		thoughts: chain([0.3, 0.5, 0.7, 0.85, 0.95]),
		expectedBehavior: { totShouldTerminate: true },
	},
	{
		name: 'Plateau',
		thoughts: chain([0.3, 0.5, 0.5, 0.5, 0.5, 0.5]),
		expectedBehavior: { totShouldTerminate: true },
	},
	{
		name: 'Dead End',
		thoughts: chain([0.3, 0.15, 0.1, 0.1, 0.1]),
		expectedBehavior: { totShouldTerminate: true },
	},
	{
		// Two divergent leaves: one weak (0.4), one strong (0.8). Default beam
		// width is 3, so a 2-leaf frontier won't trigger 'branch' on its own.
		// Instead, the high-confidence leaf should drive termination.
		name: 'Branch Opportunity',
		thoughts: [
			t(1, 'root', 0.5, { total_thoughts: 4 }),
			t(2, 'branch-a step', 0.4, {
				total_thoughts: 4,
				branch_from_thought: 1,
				branch_id: asBranchId('a'),
			}),
			t(3, 'branch-b step', 0.8, {
				total_thoughts: 4,
				branch_from_thought: 1,
				branch_id: asBranchId('b'),
			}),
			t(4, 'branch-b deepen', 0.95, {
				total_thoughts: 4,
				branch_id: asBranchId('b'),
			}),
		],
		branchEdges: [
			['t-1', 't-2'],
			['t-1', 't-3'],
		],
		expectedBehavior: { totShouldTerminate: true },
	},
	{
		name: 'Fast Converge',
		thoughts: chain([0.9, 0.95]),
		expectedBehavior: { totShouldTerminate: true },
	},
	{
		// Slow steady climb — never plateaus, never crosses threshold.
		name: 'Slow Progress',
		thoughts: chain([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75]),
		expectedBehavior: { totShouldTerminate: false },
	},
	{
		name: 'Contradiction Recovery',
		thoughts: chain([0.7, 0.3, 0.4, 0.8, 0.95]),
		expectedBehavior: { totShouldTerminate: true },
	},
	{
		// Two parallel branches of 5 thoughts each, neither hitting threshold.
		// Builds a frontier wider than the default beam (3).
		name: 'Multi-Branch',
		thoughts: [
			t(1, 'root', 0.4, { total_thoughts: 10 }),
			t(2, 'a-1', 0.45, { total_thoughts: 10, branch_from_thought: 1, branch_id: asBranchId('a') }),
			t(3, 'a-2', 0.5, { total_thoughts: 10, branch_id: asBranchId('a') }),
			t(4, 'a-3', 0.55, { total_thoughts: 10, branch_id: asBranchId('a') }),
			t(5, 'a-4', 0.6, { total_thoughts: 10, branch_id: asBranchId('a') }),
			t(6, 'b-1', 0.4, { total_thoughts: 10, branch_from_thought: 1, branch_id: asBranchId('b') }),
			t(7, 'b-2', 0.5, { total_thoughts: 10, branch_id: asBranchId('b') }),
			t(8, 'b-3', 0.55, { total_thoughts: 10, branch_id: asBranchId('b') }),
			t(9, 'b-4', 0.6, { total_thoughts: 10, branch_id: asBranchId('b') }),
			t(10, 'b-5', 0.65, { total_thoughts: 10, branch_id: asBranchId('b') }),
		],
		branchEdges: [
			['t-1', 't-2'],
			['t-1', 't-6'],
		],
		expectedBehavior: { totShouldTerminate: false },
	},
	{
		name: 'Single Thought',
		thoughts: [t(1, 'lone thought', 0.5, { total_thoughts: 1 })],
		expectedBehavior: { totShouldTerminate: false },
	},
	{
		// Just the current thought; no prior history beyond it.
		// Both strategies should behave gracefully (no throw, no branch).
		name: 'Empty History',
		thoughts: [t(1, 'first', 0.5, { total_thoughts: 1 })],
		expectedBehavior: { totShouldTerminate: false },
	},
];
