/**
 * Internal evaluation harness — compares {@link TreeOfThoughtStrategy} against
 * {@link SequentialStrategy} on a fixed set of curated reasoning trajectories.
 *
 * This is **not** a unit test of either strategy. It is a behavioral diff
 * tool: for each scenario it records the action chosen by ToT vs Sequential,
 * checks ToT against the scenario's expected behavior, and prints a JSON
 * report line per scenario. A final aggregate report is printed at the end.
 *
 * The suite is gated by the `RUN_EVAL` environment variable so it never runs
 * in CI by default. Invoke locally with `RUN_EVAL=1 npm test`.
 *
 * @module __tests__/eval/totVsSequential.eval
 */

import { describe, it } from 'vitest';

import type { StrategyContext, StrategyDecision } from '../../contracts/strategy.js';
import { buildActiveEvidenceProjection } from '../../core/reasoning/ActiveEvidenceProjection.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import type { Edge, EdgeKind } from '../../core/graph/Edge.js';
import { generateUlid } from '../../core/ids.js';
import { asSessionId, asThoughtId, type EdgeId, type SessionId } from '../../contracts/ids.js';
import type { ReasoningStats } from '../../core/reasoning.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';

import { scenarios, type EvalScenario, type ExpectedBehavior } from './fixtures/scenarios.js';

const SESSION_ID: SessionId = asSessionId('eval-session');

/** Minimal {@link ReasoningStats} stub — analytics aren't exercised by the strategies. */
function emptyStats(): ReasoningStats {
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

/** Build a single edge with a fresh ulid and `Date.now()` timestamp. */
function makeEdge(from: string, to: string, kind: EdgeKind): Edge {
	return {
		id: generateUlid() as EdgeId,
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind,
		sessionId: SESSION_ID,
		createdAt: Date.now(),
	};
}

/**
 * Construct an isolated EdgeStore + GraphView for a scenario.
 *
 * Default `sequence` edges are created between consecutive thoughts within
 * the same branch (or unbranched mainline). `branchEdges` from the scenario
 * are added as `branch` kind so `GraphView.leaves()` reflects the topology.
 */
function buildContext(scenario: EvalScenario): StrategyContext {
	const store = new EdgeStore();

	if (scenario.thoughts.length > 1) {
		// Sequence edges: link consecutive thoughts that share the same branch_id
		// (treating undefined branch_id as "mainline"). Cross-branch transitions
		// are intentionally skipped — those are expressed via `branchEdges`.
		for (let i = 1; i < scenario.thoughts.length; i++) {
			const prev = scenario.thoughts[i - 1]!;
			const curr = scenario.thoughts[i]!;
			if (prev.branch_id === curr.branch_id && prev.id && curr.id) {
				store.addEdge(makeEdge(prev.id, curr.id, 'sequence'));
			}
		}
	}

	for (const [from, to] of scenario.branchEdges ?? []) {
		store.addEdge(makeEdge(from, to, 'branch'));
	}

	const last = scenario.thoughts[scenario.thoughts.length - 1]!;
	return {
		sessionId: SESSION_ID,
		evidence: buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history: scenario.thoughts,
			branches: {},
			edgeStore: store,
		}),
		stats: emptyStats(),
		currentThought: last,
	};
}

/** Decision report row recorded for each scenario. */
interface ScenarioReport {
	scenario: string;
	tot: { action: string; reason?: string };
	seq: { action: string; reason?: string };
	expected: ExpectedBehavior;
	pass: boolean;
}

/** Extract optional `reason` field from a decision (present on most variants). */
function reasonOf(d: StrategyDecision): string | undefined {
	return 'reason' in d ? d.reason : undefined;
}

/**
 * Check the ToT decision against the scenario's expected behavior.
 *
 * - When `totShouldTerminate` is set, the action must match (`terminate` ⇔ true).
 * - When `totShouldBranch` is set, the action must match (`branch` ⇔ true).
 * - When neither is set, the scenario passes unconditionally (descriptive only).
 */
function evaluateResult(expected: ExpectedBehavior, decision: StrategyDecision): boolean {
	if (expected.totShouldTerminate !== undefined) {
		const terminated = decision.action === 'terminate';
		if (terminated !== expected.totShouldTerminate) return false;
	}
	if (expected.totShouldBranch !== undefined) {
		const branched = decision.action === 'branch';
		if (branched !== expected.totShouldBranch) return false;
	}
	return true;
}

describe.skipIf(!process.env.RUN_EVAL)('ToT vs Sequential Eval', () => {
	const totStrategy = new TreeOfThoughtStrategy();
	const seqStrategy = new SequentialStrategy();
	const reports: ScenarioReport[] = [];

	for (const scenario of scenarios) {
		it(scenario.name, () => {
			const ctx = buildContext(scenario);
			const totDecision = totStrategy.decide(ctx);
			const seqDecision = seqStrategy.decide(ctx);

			const report: ScenarioReport = {
				scenario: scenario.name,
				tot: { action: totDecision.action, reason: reasonOf(totDecision) },
				seq: { action: seqDecision.action, reason: reasonOf(seqDecision) },
				expected: scenario.expectedBehavior,
				pass: evaluateResult(scenario.expectedBehavior, totDecision),
			};
			reports.push(report);
			// One JSON line per scenario for downstream tooling.

			console.log(JSON.stringify(report));
		});
	}

	it('summary', () => {
		const total = reports.length;
		const passed = reports.filter((r) => r.pass).length;
		const summary = {
			summary: 'tot-vs-sequential',
			total,
			passed,
			failed: total - passed,
			pass_rate: total === 0 ? 0 : passed / total,
		};

		console.log(JSON.stringify(summary));
	});
});
