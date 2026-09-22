/**
 * TreeOfThoughtStrategy tests — covers default config, decide() ordering,
 * shouldBranch / shouldTerminate predicates, edge cases (empty frontier,
 * empty history), and purity (deterministic / non-mutating).
 *
 * @module __tests__/strategies/TreeOfThoughtStrategy.test
 */

import { describe, it, expect } from 'vitest';
import {
	TreeOfThoughtStrategy,
	type TotConfig,
} from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { buildActiveEvidenceProjection } from '../../core/reasoning/ActiveEvidenceProjection.js';
import { createTestThought } from '../helpers/factories.js';
import type { StrategyContext } from '../../contracts/strategy.js';
import type { ThoughtData } from '../../core/thought.js';
import type { ReasoningStats } from '../../core/reasoning.js';
import type { EdgeKind } from '../../core/graph/Edge.js';
import { asSessionId, asThoughtId, type EdgeId, type SessionId } from '../../contracts/ids.js';

const SID: SessionId = asSessionId('tot-session');

function makeStats(chainDepth = 0): ReasoningStats {
	return {
		total_thoughts: 0,
		total_branches: 0,
		total_revisions: 0,
		total_merges: 0,
		chain_depth: chainDepth,
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

let edgeSeq = 0;
function addEdge(store: EdgeStore, from: string, to: string, kind: EdgeKind = 'sequence'): void {
	store.addEdge({
		id: `e-${++edgeSeq}` as EdgeId,
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind,
		sessionId: SID,
		createdAt: edgeSeq,
	});
}

interface CtxOpts {
	readonly history: readonly ThoughtData[];
	readonly current: ThoughtData;
	readonly edges?: ReadonlyArray<readonly [string, string, EdgeKind?]>;
	readonly stats?: ReasoningStats;
}

function makeCtx(opts: CtxOpts): StrategyContext {
	const store = new EdgeStore();
	for (const [from, to, kind] of opts.edges ?? []) addEdge(store, from, to, kind);
	return {
		sessionId: SID,
		evidence: buildActiveEvidenceProjection({
			sessionId: SID,
			history: opts.history,
			branches: {},
			edgeStore: store,
		}),
		stats: opts.stats ?? makeStats(),
		currentThought: opts.current,
	};
}

/** Helper: thought with id + score-shaping fields set for predictable scoring. */
function tot(id: string, number: number, confidence: number, quality: number = 1): ThoughtData {
	return createTestThought({
		id,
		thought_number: number,
		confidence,
		quality_score: quality,
		next_thought_needed: true,
	});
}

describe('TreeOfThoughtStrategy', () => {
	describe('name', () => {
		it("is 'tot'", () => {
			expect(new TreeOfThoughtStrategy().name).toBe('tot');
		});
	});

	describe('config', () => {
		it('preserves omitted defaults and thresholds above one', () => {
			// Given
			const root = tot('root', 0, 0.1);
			const leaf = tot('leaf', 1, 1);
			const ctx = makeCtx({ history: [root, leaf], current: leaf, edges: [['root', 'leaf']] });
			const omitted = new TreeOfThoughtStrategy();
			const aboveOne = new TreeOfThoughtStrategy({ terminationConfidence: 1.25 });

			// When
			const omittedDecision = omitted.decide(ctx);

			// Then
			expect(omittedDecision).toEqual({ action: 'terminate', reason: 'confidence threshold' });
			expect(aboveOne.decide(ctx)).toEqual({ action: 'continue', nextHint: 'explore frontier' });
			expect(Object.getOwnPropertyNames(aboveOne)).toEqual(['name']);
		});

		it.each([
			['beamWidth', { beamWidth: Number.NaN }, 'beamWidth must be a finite positive integer'],
			[
				'beamWidth',
				{ beamWidth: Number.POSITIVE_INFINITY },
				'beamWidth must be a finite positive integer',
			],
			[
				'beamWidth',
				{ beamWidth: Number.NEGATIVE_INFINITY },
				'beamWidth must be a finite positive integer',
			],
			['beamWidth', { beamWidth: -1 }, 'beamWidth must be a finite positive integer'],
			['beamWidth', { beamWidth: 0 }, 'beamWidth must be a finite positive integer'],
			['beamWidth', { beamWidth: 1.5 }, 'beamWidth must be a finite positive integer'],
			['depthCap', { depthCap: Number.NaN }, 'depthCap must be a finite nonnegative integer'],
			[
				'depthCap',
				{ depthCap: Number.POSITIVE_INFINITY },
				'depthCap must be a finite nonnegative integer',
			],
			[
				'depthCap',
				{ depthCap: Number.NEGATIVE_INFINITY },
				'depthCap must be a finite nonnegative integer',
			],
			['depthCap', { depthCap: -1 }, 'depthCap must be a finite nonnegative integer'],
			['depthCap', { depthCap: 1.5 }, 'depthCap must be a finite nonnegative integer'],
			[
				'plateauWindow',
				{ plateauWindow: Number.NaN },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauWindow',
				{ plateauWindow: Number.POSITIVE_INFINITY },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauWindow',
				{ plateauWindow: Number.NEGATIVE_INFINITY },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauWindow',
				{ plateauWindow: -1 },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauWindow',
				{ plateauWindow: 0 },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauWindow',
				{ plateauWindow: 1 },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauWindow',
				{ plateauWindow: 2.5 },
				'plateauWindow must be a finite integer of at least 2',
			],
			[
				'plateauEpsilon',
				{ plateauEpsilon: Number.NaN },
				'plateauEpsilon must be a finite nonnegative number',
			],
			[
				'plateauEpsilon',
				{ plateauEpsilon: Number.POSITIVE_INFINITY },
				'plateauEpsilon must be a finite nonnegative number',
			],
			[
				'plateauEpsilon',
				{ plateauEpsilon: Number.NEGATIVE_INFINITY },
				'plateauEpsilon must be a finite nonnegative number',
			],
			[
				'plateauEpsilon',
				{ plateauEpsilon: -0.01 },
				'plateauEpsilon must be a finite nonnegative number',
			],
			[
				'terminationConfidence',
				{ terminationConfidence: Number.NaN },
				'terminationConfidence must be a finite nonnegative number',
			],
			[
				'terminationConfidence',
				{ terminationConfidence: Number.POSITIVE_INFINITY },
				'terminationConfidence must be a finite nonnegative number',
			],
			[
				'terminationConfidence',
				{ terminationConfidence: Number.NEGATIVE_INFINITY },
				'terminationConfidence must be a finite nonnegative number',
			],
			[
				'terminationConfidence',
				{ terminationConfidence: -0.01 },
				'terminationConfidence must be a finite nonnegative number',
			],
		] satisfies ReadonlyArray<readonly [string, TotConfig, string]>)(
			'rejects invalid %s configuration',
			(_field, config, message) => {
				// Given
				const construct = (): TreeOfThoughtStrategy => new TreeOfThoughtStrategy(config);

				// When / Then
				expect(construct).toThrowError(new TypeError(message));
			}
		);

		it.each([
			{ beamWidth: 1 },
			{ depthCap: 0 },
			{ plateauWindow: 2 },
			{ plateauEpsilon: 0 },
			{ terminationConfidence: 0 },
			{ terminationConfidence: 1.25 },
		] satisfies readonly TotConfig[])('accepts numeric boundary configuration %o', (config) => {
			// Given / When / Then
			expect(() => new TreeOfThoughtStrategy(config)).not.toThrow();
		});

		it('treats explicit undefined configuration as omitted defaults', () => {
			// Given
			const root = tot('root', 0, 0.1);
			const leaf = tot('leaf', 1, 1);
			const ctx = makeCtx({ history: [root, leaf], current: leaf, edges: [['root', 'leaf']] });
			const omitted = new TreeOfThoughtStrategy();
			const explicitUndefined = new TreeOfThoughtStrategy({
				beamWidth: undefined,
				depthCap: undefined,
				plateauWindow: undefined,
				plateauEpsilon: undefined,
				terminationConfidence: undefined,
			});

			// When / Then
			expect(explicitUndefined.decide(ctx)).toEqual(omitted.decide(ctx));
			expect(Object.getOwnPropertyNames(explicitUndefined)).toEqual(['name']);
		});

		it('applies default config when none provided', () => {
			// 5 leaves > default beamWidth (3) → branch when current outside beam
			const t1 = tot('t1', 1, 0.1);
			const t2 = tot('t2', 2, 0.2);
			const t3 = tot('t3', 3, 0.3);
			const t4 = tot('t4', 4, 0.4);
			const t5 = tot('t5', 5, 0.5);
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({
				history: [root, t1, t2, t3, t4, t5],
				current: t1,
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
					['root', 't4'],
					['root', 't5'],
				],
			});
			expect(new TreeOfThoughtStrategy().decide(ctx).action).toBe('branch');
		});

		it('applies custom config overrides', () => {
			// With beamWidth=10, frontier of 5 is no longer "wider than beam"
			const root = tot('root', 0, 0.05);
			const t1 = tot('t1', 1, 0.1);
			const ctx = makeCtx({
				history: [root, t1, tot('t2', 2, 0.2), tot('t3', 3, 0.3)],
				current: t1,
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
				],
			});
			const strategy = new TreeOfThoughtStrategy({ beamWidth: 10 });
			expect(strategy.decide(ctx).action).toBe('continue');
		});
	});

	describe('depth cap', () => {
		it('terminates at the default cap of eight', () => {
			// Given
			const history = Array.from({ length: 9 }, (_unused, index) =>
				tot(`t${index}`, index + 1, index / 20)
			);
			const edges = Array.from(
				{ length: 8 },
				(_unused, index) => [`t${index}`, `t${index + 1}`] as const
			);
			const current = history[8];
			if (current === undefined) throw new TypeError('Expected current thought');
			const ctx = makeCtx({ history, current, edges });

			// When
			const decision = new TreeOfThoughtStrategy().decide(ctx);

			// Then
			expect(decision).toEqual({ action: 'terminate', reason: 'depth cap' });
		});

		it('terminates a root when depthCap is zero', () => {
			// Given
			const root = tot('root', 1, 0.1);
			const child = tot('child', 2, 0.2);
			const ctx = makeCtx({ history: [root, child], current: root, edges: [['root', 'child']] });

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 0 }).decide(ctx);

			// Then
			expect(decision).toEqual({ action: 'terminate', reason: 'depth cap' });
		});

		it('terminates beyond the configured cap', () => {
			// Given
			const root = tot('root', 1, 0.1);
			const a = tot('a', 2, 0.2);
			const b = tot('b', 3, 0.3);
			const current = tot('current', 4, 0.4);
			const ctx = makeCtx({
				history: [root, a, b, current],
				current,
				edges: [
					['root', 'a'],
					['a', 'b'],
					['b', 'current'],
				],
			});

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 2 }).decide(ctx);

			// Then
			expect(decision).toEqual({ action: 'terminate', reason: 'depth cap' });
		});

		it('gives depth termination precedence over confidence and plateau', () => {
			// Given
			const root = tot('root', 1, 0.95);
			const current = tot('current', 2, 0.95);
			const ctx = makeCtx({ history: [root, current], current, edges: [['root', 'current']] });

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 1, plateauWindow: 2 }).decide(ctx);

			// Then
			expect(decision).toEqual({ action: 'terminate', reason: 'depth cap' });
		});

		it('keeps decide and predicates in agreement at the cap', () => {
			// Given
			const root = tot('root', 1, 0.05);
			const current = tot('current', 2, 0.1);
			const ctx = makeCtx({
				history: [root, current, tot('a', 3, 0.2), tot('b', 4, 0.3)],
				current,
				edges: [
					['root', 'current'],
					['root', 'a'],
					['root', 'b'],
				],
			});
			const strategy = new TreeOfThoughtStrategy({ depthCap: 1, beamWidth: 1 });

			// When
			const decision = strategy.decide(ctx);
			const shouldTerminate = strategy.shouldTerminate(ctx);
			const shouldBranch = strategy.shouldBranch(ctx);

			// Then
			expect(decision).toEqual({ action: 'terminate', reason: 'depth cap' });
			expect(shouldTerminate).toBe(true);
			expect(shouldBranch).toBe(false);
		});

		it('does not substitute a high reasoning_stats.chain_depth for graph depth', () => {
			// Given
			const root = tot('root', 1, 0.1);
			const current = tot('current', 2, 0.2);
			const ctx = makeCtx({
				history: [root, current],
				current,
				edges: [['root', 'current']],
				stats: makeStats(99),
			});

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 8 }).decide(ctx);

			// Then
			expect(decision).toEqual({ action: 'continue', nextHint: 'explore frontier' });
		});

		it.each([
			['missing graph', undefined],
			['empty graph', new EdgeStore()],
		] as const)('does not invent depth termination for a %s', (_label, edgeStore) => {
			// Given
			const current = tot('current', 1, 0.1);
			const ctx: StrategyContext = {
				...makeCtx({ history: [current], current }),
				evidence: buildActiveEvidenceProjection({
					sessionId: SID,
					history: [current],
					branches: {},
					edgeStore,
				}),
			};

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 0 }).decide(ctx);

			// Then
			expect(decision.action).toBe('continue');
		});

		it('does not terminate a current thought unreachable from every root', () => {
			// Given
			const root = tot('root', 1, 0.1);
			const leaf = tot('leaf', 2, 0.2);
			const current = tot('current', 3, 0.3);
			const ctx = makeCtx({ history: [root, leaf, current], current, edges: [['root', 'leaf']] });

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 0 }).decide(ctx);

			// Then
			expect(decision.action).toBe('continue');
		});

		it('does not mutate context while deciding at the cap', () => {
			// Given
			const root = tot('root', 1, 0.1);
			const current = tot('current', 2, 0.2);
			const history = [root, current];
			const ctx = makeCtx({ history, current, edges: [['root', 'current']] });
			const historySnapshot = structuredClone(history);
			const statsSnapshot = structuredClone(ctx.stats);

			// When
			const decision = new TreeOfThoughtStrategy({ depthCap: 1 }).decide(ctx);

			// Then
			expect(decision).toEqual({ action: 'terminate', reason: 'depth cap' });
			expect(history).toEqual(historySnapshot);
			expect(ctx.stats).toEqual(statsSnapshot);
		});
	});

	describe('decide', () => {
		it('returns continue when history is empty (no frontier)', () => {
			const current = tot('c', 1, 0.1);
			const ctx = makeCtx({ history: [], current });
			expect(new TreeOfThoughtStrategy().decide(ctx)).toEqual({
				action: 'continue',
				nextHint: 'explore frontier',
			});
		});

		it('returns continue with single-thought history (no edges → empty frontier)', () => {
			const current = tot('only', 1, 0.1);
			const ctx = makeCtx({ history: [current], current });
			expect(new TreeOfThoughtStrategy().decide(ctx).action).toBe('continue');
		});

		it('returns continue when frontier (leaves) is empty', () => {
			const current = tot('c', 1, 0.1);
			const ctx = makeCtx({ history: [current], current, edges: [] });
			expect(new TreeOfThoughtStrategy().decide(ctx).action).toBe('continue');
		});

		it('terminates with reason "confidence threshold" when leaf score >= terminationConfidence', () => {
			const root = tot('root', 1, 0.1);
			const high = tot('high', 2, 0.95, 1); // score = 0.95
			const ctx = makeCtx({
				history: [root, high],
				current: high,
				edges: [['root', 'high']],
			});
			const decision = new TreeOfThoughtStrategy().decide(ctx);
			expect(decision).toEqual({ action: 'terminate', reason: 'confidence threshold' });
		});

		it('terminates with reason "plateau" when recent scores are flat', () => {
			// All thoughts score 0.5; window=3 → plateau
			const root = tot('root', 1, 0.5);
			const a = tot('a', 2, 0.5);
			const b = tot('b', 3, 0.5);
			const c = tot('c', 4, 0.5);
			const ctx = makeCtx({
				history: [root, a, b, c],
				current: c,
				edges: [['root', 'a']], // 'a' is leaf, scored 0.5 — no termination by confidence
			});
			const decision = new TreeOfThoughtStrategy().decide(ctx);
			expect(decision).toEqual({ action: 'terminate', reason: 'plateau' });
		});

		it('confidence termination takes precedence over plateau', () => {
			// All scores high → both could fire; confidence threshold checked first.
			const root = tot('root', 1, 0.95);
			const a = tot('a', 2, 0.95);
			const b = tot('b', 3, 0.95);
			const ctx = makeCtx({
				history: [root, a, b],
				current: b,
				edges: [['root', 'a']],
			});
			const decision = new TreeOfThoughtStrategy().decide(ctx);
			if (decision.action === 'terminate') {
				expect(decision.reason).toBe('confidence threshold');
			} else {
				throw new Error('expected terminate');
			}
		});

		it('returns branch when frontier > beamWidth and current is outside the beam', () => {
			// 5 leaves with scores 0.1..0.5. beamWidth=3 keeps top-3 (t3,t4,t5).
			// Current = t1 (lowest score) → outside beam → branch.
			const root = tot('root', 0, 0.05);
			const t1 = tot('t1', 1, 0.1);
			const ctx = makeCtx({
				history: [
					root,
					t1,
					tot('t2', 2, 0.2),
					tot('t3', 3, 0.3),
					tot('t4', 4, 0.4),
					tot('t5', 5, 0.5),
				],
				current: t1,
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
					['root', 't4'],
					['root', 't5'],
				],
			});
			const decision = new TreeOfThoughtStrategy().decide(ctx);
			expect(decision.action).toBe('branch');
			if (decision.action === 'branch') {
				expect(decision.branchId).toBe('tot-1');
				expect(decision.fromThought).toBe(1);
			}
		});

		it('returns continue when current is inside the beam', () => {
			// Same setup but current = t5 (top-scoring) → inside beam → continue.
			const root = tot('root', 0, 0.05);
			const t5 = tot('t5', 5, 0.5);
			const ctx = makeCtx({
				history: [
					root,
					tot('t1', 1, 0.1),
					tot('t2', 2, 0.2),
					tot('t3', 3, 0.3),
					tot('t4', 4, 0.4),
					t5,
				],
				current: t5,
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
					['root', 't4'],
					['root', 't5'],
				],
			});
			expect(new TreeOfThoughtStrategy().decide(ctx).action).toBe('continue');
		});

		it('returns continue when frontier <= beamWidth (no branching pressure)', () => {
			const root = tot('root', 0, 0.05);
			const a = tot('a', 1, 0.2);
			const ctx = makeCtx({
				history: [root, a, tot('b', 2, 0.3)],
				current: a,
				edges: [
					['root', 'a'],
					['root', 'b'],
				],
			});
			expect(new TreeOfThoughtStrategy().decide(ctx).action).toBe('continue');
		});
	});

	describe('shouldBranch', () => {
		it('returns true when frontier > beamWidth', () => {
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({
				history: [root, tot('t1', 1, 0.1), tot('t2', 2, 0.2), tot('t3', 3, 0.3), tot('t4', 4, 0.4)],
				current: root,
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
					['root', 't4'],
				],
			});
			expect(new TreeOfThoughtStrategy().shouldBranch(ctx)).toBe(true);
		});

		it('returns false when frontier <= beamWidth', () => {
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({
				history: [root, tot('a', 1, 0.1)],
				current: root,
				edges: [['root', 'a']],
			});
			expect(new TreeOfThoughtStrategy().shouldBranch(ctx)).toBe(false);
		});

		it('returns false when frontier is empty', () => {
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({ history: [root], current: root });
			expect(new TreeOfThoughtStrategy().shouldBranch(ctx)).toBe(false);
		});
	});

	describe('shouldTerminate', () => {
		it('returns true when best frontier score >= terminationConfidence', () => {
			const root = tot('root', 1, 0.1);
			const high = tot('high', 2, 0.95);
			const ctx = makeCtx({
				history: [root, high],
				current: high,
				edges: [['root', 'high']],
			});
			expect(new TreeOfThoughtStrategy().shouldTerminate(ctx)).toBe(true);
		});

		it('returns true when plateau detected', () => {
			const root = tot('root', 1, 0.5);
			const ctx = makeCtx({
				history: [root, tot('a', 2, 0.5), tot('b', 3, 0.5), tot('c', 4, 0.5)],
				current: tot('c', 4, 0.5),
				edges: [['root', 'a']],
			});
			expect(new TreeOfThoughtStrategy().shouldTerminate(ctx)).toBe(true);
		});

		it('returns false when neither condition holds', () => {
			const root = tot('root', 1, 0.1);
			const ctx = makeCtx({
				history: [root, tot('a', 2, 0.3)],
				current: tot('a', 2, 0.3),
				edges: [['root', 'a']],
			});
			expect(new TreeOfThoughtStrategy().shouldTerminate(ctx)).toBe(false);
		});
	});

	describe('purity', () => {
		it('1000 identical decide() calls return deeply-equal results', () => {
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({
				history: [
					root,
					tot('t1', 1, 0.1),
					tot('t2', 2, 0.2),
					tot('t3', 3, 0.3),
					tot('t4', 4, 0.4),
					tot('t5', 5, 0.5),
				],
				current: tot('t1', 1, 0.1),
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
					['root', 't4'],
					['root', 't5'],
				],
			});
			const strategy = new TreeOfThoughtStrategy();
			const baseline = strategy.decide(ctx);
			for (let i = 0; i < 1000; i++) {
				expect(strategy.decide(ctx)).toEqual(baseline);
				expect(strategy.shouldBranch(ctx)).toBe(strategy.shouldBranch(ctx));
				expect(strategy.shouldTerminate(ctx)).toBe(strategy.shouldTerminate(ctx));
			}
		});

		it('decide() does not mutate the input context', () => {
			const root = tot('root', 1, 0.1);
			const a = tot('a', 2, 0.3);
			const history = [root, a];
			const ctx = makeCtx({ history, current: a, edges: [['root', 'a']] });
			const snapshotHistory = JSON.parse(JSON.stringify(history));
			const snapshotCurrent = JSON.parse(JSON.stringify(a));
			const snapshotStats = JSON.parse(JSON.stringify(ctx.stats));
			const strategy = new TreeOfThoughtStrategy();
			strategy.decide(ctx);
			strategy.shouldBranch(ctx);
			strategy.shouldTerminate(ctx);
			expect(history).toEqual(snapshotHistory);
			expect(ctx.currentThought).toEqual(snapshotCurrent);
			expect(ctx.stats).toEqual(snapshotStats);
		});

		it('has no own mutable instance fields beyond `name`', () => {
			const strategy = new TreeOfThoughtStrategy({ beamWidth: 5 });
			const ownProps = Object.getOwnPropertyNames(strategy).filter((p) => p !== 'name');
			expect(ownProps).toEqual([]);
		});

		it('configOf falls back to DEFAULTS when called with a foreign `this`', () => {
			const strategy = new TreeOfThoughtStrategy({ beamWidth: 99 });
			// Borrow shouldBranch with a non-registered `this` → WeakMap miss → DEFAULTS (beamWidth=3)
			const foreignThis = { name: 'tot' as const };
			const t1 = tot('t1', 1, 0.1);
			const t2 = tot('t2', 2, 0.2);
			const t3 = tot('t3', 3, 0.3);
			const t4 = tot('t4', 4, 0.4);
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({
				history: [root, t1, t2, t3, t4],
				current: t1,
				edges: [
					['root', 't1'],
					['root', 't2'],
					['root', 't3'],
					['root', 't4'],
				],
			});
			// 4 leaves > DEFAULTS.beamWidth (3) → true; with beamWidth=99 it would be false.
			expect(strategy.shouldBranch.call(foreignThis as never, ctx)).toBe(true);
		});

		it('thoughtKey uses thought_number when id is absent', () => {
			// Thought without id → thoughtKey falls back to String(thought_number)
			const noId = createTestThought({
				thought_number: 42,
				confidence: 0.1,
				quality_score: 1,
				next_thought_needed: true,
			});
			const other1 = tot('o1', 1, 0.1);
			const other2 = tot('o2', 2, 0.2);
			const other3 = tot('o3', 3, 0.3);
			const other4 = tot('o4', 4, 0.4);
			const root = tot('root', 0, 0.05);
			const ctx = makeCtx({
				history: [root, noId, other1, other2, other3, other4],
				current: noId,
				edges: [
					['root', '42'],
					['root', 'o1'],
					['root', 'o2'],
					['root', 'o3'],
					['root', 'o4'],
				],
			});
			// 5 leaves > beamWidth(3); current 'noId' has lowest score → outside beam → branch
			const decision = new TreeOfThoughtStrategy().decide(ctx);
			expect(decision.action).toBe('branch');
			if (decision.action === 'branch') {
				expect(decision.fromThought).toBe(42);
				expect(decision.branchId).toBe('tot-42');
			}
		});
	});

	describe('active evidence projection', () => {
		it('matches an active-only fixture when a high-score leaf is retracted and preserves audit inputs', () => {
			const root = tot('root', 1, 0.1);
			const high = tot('high', 2, 1);
			const low = tot('low', 3, 0.1);
			const retractedHistory = [root, { ...high, retracted: true }, low];
			const activeOnlyHistory = [root, low];
			const retracted = makeCtx({
				history: retractedHistory,
				current: low,
				edges: [
					['root', 'high'],
					['root', 'low'],
				],
			});
			const activeOnly = makeCtx({
				history: activeOnlyHistory,
				current: low,
				edges: [['root', 'low']],
			});
			const before = structuredClone(retracted);
			const strategy = new TreeOfThoughtStrategy({ plateauWindow: 10 });

			expect(strategy.decide(retracted)).toEqual(strategy.decide(activeOnly));
			expect(strategy.shouldBranch(retracted)).toBe(strategy.shouldBranch(activeOnly));
			expect(strategy.shouldTerminate(retracted)).toBe(strategy.shouldTerminate(activeOnly));
			expect(retracted).toEqual(before);
		});

		it('uses retraction-filtered main order for plateau equivalence', () => {
			const root = tot('root', 1, 0.2);
			const removed = tot('removed', 2, 0.2);
			const current = tot('current', 3, 0.6);
			const strategy = new TreeOfThoughtStrategy({
				terminationConfidence: 1.1,
				plateauWindow: 2,
				plateauEpsilon: 0.02,
			});
			const retracted = makeCtx({
				history: [root, { ...removed, retracted: true }, current],
				current,
				edges: [
					['root', 'removed'],
					['root', 'current'],
				],
			});
			const activeOnly = makeCtx({
				history: [root, current],
				current,
				edges: [['root', 'current']],
			});

			expect(strategy.decide(retracted)).toEqual(strategy.decide(activeOnly));
			expect(strategy.shouldTerminate(retracted)).toBe(strategy.shouldTerminate(activeOnly));
		});

		it('scores an active branch-only leaf in all three decision methods', () => {
			const store = new EdgeStore();
			addEdge(store, 'root', 'branch-leaf');
			const root = tot('root', 1, 0.1);
			const branchLeaf = tot('branch-leaf', 2, 0.95);
			const context: StrategyContext = {
				sessionId: SID,
				evidence: buildActiveEvidenceProjection({
					sessionId: SID,
					history: [root],
					branches: { alt: [branchLeaf] },
					edgeStore: store,
				}),
				stats: makeStats(),
				currentThought: branchLeaf,
			};
			const strategy = new TreeOfThoughtStrategy({ plateauWindow: 10 });

			expect(strategy.decide(context)).toEqual({
				action: 'terminate',
				reason: 'confidence threshold',
			});
			expect(strategy.shouldTerminate(context)).toBe(true);
			expect(strategy.shouldBranch(context)).toBe(false);
		});

		it('does not retain depth through a retracted interior node', () => {
			const root = tot('root', 1, 0.1);
			const interior = tot('interior', 2, 0.1);
			const current = tot('current', 3, 0.1);
			const context = makeCtx({
				history: [root, { ...interior, retracted: true }, current],
				current,
				edges: [
					['root', 'interior'],
					['interior', 'current'],
				],
			});
			const strategy = new TreeOfThoughtStrategy({
				depthCap: 1,
				terminationConfidence: 1.1,
				plateauWindow: 10,
			});

			expect(strategy.decide(context).action).toBe('continue');
			expect(strategy.shouldTerminate(context)).toBe(false);
			expect(strategy.shouldBranch(context)).toBe(false);
		});
	});

	describe('newThoughtTypes integration with beam selection', () => {
		it('decomposition (weight 1.2) outranks regular when scoring frontier', () => {
			// All 4 leaves have confidence=0.5, quality=1.
			// Scores: decomposition = 0.5 * 1 * 1.2 = 0.6
			//          regular       = 0.5 * 1 * 1.0 = 0.5
			//          assumption    = 0.5 * 1 * 0.5 = 0.25
			// beamWidth=3 keeps top-3: decomposition + 2 regulars. assumption is OUT.
			const root = tot('root', 0, 0.05);
			const decomp = createTestThought({
				id: 'd',
				thought_number: 1,
				confidence: 0.5,
				quality_score: 1,
				thought_type: 'decomposition',
				next_thought_needed: true,
			});
			const reg1 = tot('r1', 2, 0.5, 1);
			const reg2 = tot('r2', 3, 0.5, 1);
			const assume = createTestThought({
				id: 'a',
				thought_number: 4,
				confidence: 0.5,
				quality_score: 1,
				thought_type: 'assumption',
				next_thought_needed: true,
			});
			const ctx = makeCtx({
				history: [root, decomp, reg1, reg2, assume],
				current: assume, // assumption is lowest-scored → outside beam
				edges: [
					['root', 'd'],
					['root', 'r1'],
					['root', 'r2'],
					['root', 'a'],
				],
			});
			const decision = new TreeOfThoughtStrategy().decide(ctx);
			expect(decision.action).toBe('branch');
			if (decision.action === 'branch') {
				expect(decision.fromThought).toBe(4);
			}
		});

		it('decomposition stays inside beam when current; weight boost keeps it ranked', () => {
			// Same 4 leaves, but current = decomposition (highest-weighted) → inside beam → continue.
			const root = tot('root', 0, 0.05);
			const decomp = createTestThought({
				id: 'd',
				thought_number: 1,
				confidence: 0.5,
				quality_score: 1,
				thought_type: 'decomposition',
				next_thought_needed: true,
			});
			const reg1 = tot('r1', 2, 0.5, 1);
			const reg2 = tot('r2', 3, 0.5, 1);
			const assume = createTestThought({
				id: 'a',
				thought_number: 4,
				confidence: 0.5,
				quality_score: 1,
				thought_type: 'assumption',
				next_thought_needed: true,
			});
			const ctx = makeCtx({
				history: [root, decomp, reg1, reg2, assume],
				current: decomp,
				edges: [
					['root', 'd'],
					['root', 'r1'],
					['root', 'r2'],
					['root', 'a'],
				],
			});
			expect(new TreeOfThoughtStrategy().decide(ctx).action).toBe('continue');
		});
	});
});
