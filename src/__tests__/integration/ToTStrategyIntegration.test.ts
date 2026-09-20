import { asBranchId, asEdgeId, asSessionId, asThoughtId } from '../../contracts/ids.js';
/**
 * End-to-end integration tests for the {@link TreeOfThoughtStrategy}.
 *
 * Drives the strategy through the full {@link ThoughtProcessor} pipeline
 * with a real {@link HistoryManager} + {@link EdgeStore} + {@link MemoryPersistence}
 * so that `ctx.graph.leaves(sessionId)` reflects the actual DAG built from
 * processed thoughts.
 *
 * Scenarios covered:
 *   a. Single thought  → continue hint (frontier empty)
 *   b. High-confidence frontier → terminate with reason 'confidence threshold'
 *   c. Wide frontier (branches) → branch hint emitted when current is outside beam
 *   d. Flag-off (SequentialStrategy) → continue hint for ongoing thoughts
 *   e. Plateau across low-score thoughts → terminate with reason 'plateau'
 *   f. Strategy throws → graceful degradation: response intact, no strategy_hint
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import type { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { generateUlid } from '../../core/ids.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import type {
	IReasoningStrategy,
	StrategyContext,
	StrategyDecision,
} from '../../contracts/strategy.js';
import { createTestThought } from '../helpers/factories.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

const TOT_SESSION = asSessionId('test-session');

interface ParsedResponse {
	thought_number: number;
	total_thoughts: number;
	next_thought_needed: boolean;
	thought_history_length: number;
	confidence_signals: unknown;
	reasoning_stats: unknown;
	strategy_hint?: StrategyDecision;
	[key: string]: unknown;
}

function parseResponse(text: string): ParsedResponse {
	return JSON.parse(text) as ParsedResponse;
}

function makeManager(maxHistorySize = 1000): { manager: HistoryManager; edgeStore: EdgeStore } {
	const edgeStore = new EdgeStore();
	const manager = new HistoryManager({
		edgeStore,
		dagEdges: true,
		maxHistorySize,
		persistence: new MemoryPersistence(),
		persistenceFlushInterval: 60_000,
		persistenceBufferSize: 1000,
	});
	return { manager, edgeStore };
}

const TOT_CONFIG = {
	beamWidth: 3,
	depthCap: 8,
	terminationConfidence: 0.85,
	plateauWindow: 3,
	plateauEpsilon: 0.02,
} as const;

describe('TreeOfThoughtStrategy Integration (ThoughtProcessor + ToT + DAG)', () => {
	let manager: HistoryManager;
	let formatter: ThoughtFormatter;
	let evaluator: ThoughtEvaluator;
	let logger: NullLogger;
	let edgeStore: EdgeStore;

	beforeEach(() => {
		const built = makeManager();
		manager = built.manager;
		edgeStore = built.edgeStore;
		formatter = new ThoughtFormatter();
		evaluator = createDisabledThoughtEvaluator();
		logger = new NullLogger();
	});

	it('emits a depth-cap termination strategy_hint from the processor', async () => {
		// Given
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy({ ...TOT_CONFIG, depthCap: 2, plateauWindow: 10 })
		);
		for (let number = 1; number < 3; number++) {
			await processor.process(
				createTestThought({
					id: `depth-${number}`,
					thought: `depth ${number}`,
					thought_number: number,
					total_thoughts: 3,
					next_thought_needed: true,
					confidence: number / 10,
				})
			);
		}

		// When
		const result = await processor.process(
			createTestThought({
				id: 'depth-3',
				thought: 'depth 3',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.3,
			})
		);

		// Then
		expect(parseResponse(result.content[0]!.text).strategy_hint).toEqual({
			action: 'terminate',
			reason: 'depth cap',
		});
	});

	it('measures depth from the retained root after history pruning', async () => {
		// Given
		await manager.shutdown();
		const retained = makeManager(2);
		manager = retained.manager;
		edgeStore = retained.edgeStore;
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy({ ...TOT_CONFIG, depthCap: 1, plateauWindow: 10 })
		);
		for (let number = 1; number < 3; number++) {
			await processor.process(
				createTestThought({
					id: `pruned-${number}`,
					thought: `pruned ${number}`,
					thought_number: number,
					total_thoughts: 3,
					next_thought_needed: true,
					confidence: number / 10,
				})
			);
		}

		// When
		const result = await processor.process(
			createTestThought({
				id: 'pruned-3',
				thought: 'pruned 3',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.3,
			})
		);

		// Then
		expect(manager.getHistory(TOT_SESSION).map((thought) => thought.thought_number)).toEqual([
			2, 3,
		]);
		expect(parseResponse(result.content[0]!.text).strategy_hint).toEqual({
			action: 'terminate',
			reason: 'depth cap',
		});
	});

	it('terminates at the cap when the root-reachable graph contains a cycle', async () => {
		// Given
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy({ ...TOT_CONFIG, depthCap: 3, plateauWindow: 10 })
		);
		for (const [id, number] of [
			['cycle-root', 1],
			['cycle-a', 2],
			['cycle-b', 3],
		] as const) {
			await processor.process(
				createTestThought({
					id,
					thought: id,
					thought_number: number,
					total_thoughts: 4,
					next_thought_needed: true,
					confidence: number / 10,
				})
			);
		}
		edgeStore.addEdge({
			id: asEdgeId('cycle-back-edge'),
			from: asThoughtId('cycle-b'),
			to: asThoughtId('cycle-a'),
			kind: 'revises',
			sessionId: TOT_SESSION,
			createdAt: 10,
		});

		// When
		const result = await processor.process(
			createTestThought({
				id: 'cycle-current',
				thought: 'cycle current',
				thought_number: 4,
				total_thoughts: 4,
				next_thought_needed: true,
				confidence: 0.4,
			})
		);

		// Then
		expect(parseResponse(result.content[0]!.text).strategy_hint).toEqual({
			action: 'terminate',
			reason: 'depth cap',
		});
	});

	it('keeps depth-cap decisions isolated between sessions', async () => {
		// Given
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy({ ...TOT_CONFIG, depthCap: 1, plateauWindow: 10 })
		);
		await processor.process(
			createTestThought({
				id: 'shared-root',
				thought: 'session A root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: 'depth-A',
			})
		);
		const sessionB = await processor.process(
			createTestThought({
				id: 'shared-root',
				thought: 'session B root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: 'depth-B',
			})
		);

		// When
		const sessionA = await processor.process(
			createTestThought({
				id: 'shared-current',
				thought: 'session A current',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: 'depth-A',
			})
		);

		// Then
		expect(parseResponse(sessionA.content[0]!.text).strategy_hint).toEqual({
			action: 'terminate',
			reason: 'depth cap',
		});
		expect(parseResponse(sessionB.content[0]!.text).strategy_hint?.action).toBe('continue');
	});

	afterEach(async () => {
		await manager.shutdown();
	});

	// ---- Scenario (a) -----------------------------------------------------
	it('emits a continue strategy_hint for a single thought with an empty frontier', async () => {
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy(TOT_CONFIG)
		);

		const result = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'lone thought',
				thought_number: 1,
				total_thoughts: 5,
				next_thought_needed: true,
			})
		);

		const parsed = parseResponse(result.content[0]!.text);
		// Single thought → no edges yet → graph.leaves() === [] → action=continue.
		expect(parsed.strategy_hint).toEqual({ action: 'continue', nextHint: 'explore frontier' });
		expect(parsed.thought_number).toBe(1);
		expect(parsed.next_thought_needed).toBe(true);
	});

	// ---- Scenario (b) -----------------------------------------------------
	it('terminates with reason "confidence threshold" when frontier score ≥ 0.85', async () => {
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy(TOT_CONFIG)
		);

		// Seed a base thought so we have an edge → leaf is the second thought.
		await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'base',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);

		// Second thought becomes the unique leaf and scores 0.95 * 0.95 = 0.9025 ≥ 0.85.
		const high = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'high-confidence frontier',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.95,
				quality_score: 0.95,
			})
		);

		const parsed = parseResponse(high.content[0]!.text);
		expect(parsed).toHaveProperty('strategy_hint');
		const hint = parsed.strategy_hint;
		expect(hint?.action).toBe('terminate');
		if (hint && hint.action === 'terminate') {
			expect(hint.reason).toBe('confidence threshold');
		} else {
			throw new Error('expected terminate decision');
		}
	});

	// ---- Scenario (c) -----------------------------------------------------
	it('emits a branch hint when frontier exceeds beam width and current is outside beam', async () => {
		// Use beamWidth=1 so creating ≥2 leaves trips the branch path.
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy({ ...TOT_CONFIG, beamWidth: 1 })
		);

		// Base thought.
		await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'root',
				thought_number: 1,
				total_thoughts: 5,
				next_thought_needed: true,
				confidence: 0.9,
				quality_score: 0.5, // score 0.45 — below 0.85 threshold
			})
		);

		// Branch A off thought 1 (high score → wins beam).
		await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'branch A',
				thought_number: 2,
				total_thoughts: 5,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-A'),
				confidence: 0.8,
				quality_score: 0.5, // score 0.40
			})
		);

		// Branch B off thought 1 — low score, current outside beam (beamWidth=1).
		const branchB = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'branch B',
				thought_number: 3,
				total_thoughts: 5,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-B'),
				confidence: 0.1,
				quality_score: 0.1, // score 0.01 — outside beam
			})
		);

		const parsed = parseResponse(branchB.content[0]!.text);
		expect(parsed).toHaveProperty('strategy_hint');
		const hint = parsed.strategy_hint;
		expect(hint?.action).toBe('branch');
		if (hint && hint.action === 'branch') {
			expect(hint.fromThought).toBe(3);
			expect(typeof hint.branchId).toBe('string');
			expect(hint.branchId.length).toBeGreaterThan(0);
		} else {
			throw new Error('expected branch decision');
		}
	});

	// ---- Scenario (d) -----------------------------------------------------
	it('with SequentialStrategy (flag-off equivalent) emits continue hints for ongoing thoughts', async () => {
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		const r1 = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'one',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.99,
				quality_score: 0.99,
			})
		);
		const r2 = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'two',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.99,
				quality_score: 0.99,
			})
		);

		// SequentialStrategy never terminates while next_thought_needed=true,
		// regardless of frontier scores that would have tripped ToT termination.
		expect(parseResponse(r1.content[0]!.text).strategy_hint).toEqual({ action: 'continue' });
		expect(parseResponse(r2.content[0]!.text).strategy_hint).toEqual({ action: 'continue' });
	});

	// ---- Scenario (e) -----------------------------------------------------
	it('terminates with reason "plateau" when recent scores show no upward trend', async () => {
		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new TreeOfThoughtStrategy(TOT_CONFIG)
		);

		// 3 consecutive thoughts with identical low scores: 0.3 * 0.3 = 0.09 each.
		// range == 0 < epsilon (0.02) and trend == 0 → detectPlateau = true.
		// Scores are well below the 0.85 confidence threshold so termination is
		// driven purely by plateau detection.
		await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'flat 1',
				thought_number: 1,
				total_thoughts: 5,
				next_thought_needed: true,
				confidence: 0.3,
				quality_score: 0.3,
			})
		);
		await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'flat 2',
				thought_number: 2,
				total_thoughts: 5,
				next_thought_needed: true,
				confidence: 0.3,
				quality_score: 0.3,
			})
		);
		const last = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'flat 3',
				thought_number: 3,
				total_thoughts: 5,
				next_thought_needed: true,
				confidence: 0.3,
				quality_score: 0.3,
			})
		);

		const parsed = parseResponse(last.content[0]!.text);
		expect(parsed).toHaveProperty('strategy_hint');
		const hint = parsed.strategy_hint;
		expect(hint?.action).toBe('terminate');
		if (hint && hint.action === 'terminate') {
			expect(hint.reason).toBe('plateau');
		} else {
			throw new Error('expected terminate decision (plateau)');
		}
	});

	// ---- Scenario (f) -----------------------------------------------------
	it('gracefully degrades when the strategy throws — no crash, no strategy_hint', async () => {
		class ThrowingTotStrategy implements IReasoningStrategy {
			readonly name = 'tot-throwing';
			decide(_ctx: StrategyContext): StrategyDecision {
				throw new Error('boom from ToT');
			}
			shouldBranch(_ctx: StrategyContext): boolean {
				return false;
			}
			shouldTerminate(_ctx: StrategyContext): boolean {
				return false;
			}
		}

		const processor = new ThoughtProcessor(
			manager,
			formatter,
			evaluator,
			logger,
			new ThrowingTotStrategy()
		);

		const result = await processor.process(
			createTestThought({
				id: generateUlid(),
				thought: 'will throw inside strategy',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				confidence: 0.95,
				quality_score: 0.95,
			})
		);

		expect(result.isError).toBeUndefined();
		const parsed = parseResponse(result.content[0]!.text);
		expect(parsed).not.toHaveProperty('strategy_hint');
		expect(parsed.thought_number).toBe(1);
		expect(parsed.next_thought_needed).toBe(false);
		// History was still updated despite strategy failure.
		expect(manager.getHistoryLength(TOT_SESSION)).toBe(1);
	});
});
