import { asBranchId } from '../../contracts/ids.js';
/**
 * Integration tests for the auto-compression trigger in ThoughtProcessor.
 *
 * Verifies that when a reasoning strategy returns `action: 'terminate'` AND
 * the compression service is wired AND the current thought has a `branch_id`,
 * the processor invokes `CompressionService.compressBranch()` to produce a
 * Summary in the SummaryStore. Also verifies that compression failures never
 * break the thought pipeline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import type { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { CompressionService } from '../../core/compression/CompressionService.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { DehydrationPolicy } from '../../core/compression/DehydrationPolicy.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { NullLogger } from '../../logger/NullLogger.js';
import type {
	IReasoningStrategy,
	StrategyContext,
	StrategyDecision,
} from '../../contracts/strategy.js';
import { createTestThought } from '../helpers/factories.js';
import { asSessionId, asThoughtId, type EdgeId } from '../../contracts/ids.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

const COMPRESSION_SESSION = asSessionId('test-session');

class TerminateStrategy implements IReasoningStrategy {
	readonly name = 'terminate-always';
	decide(_ctx: StrategyContext): StrategyDecision {
		return { action: 'terminate', reason: 'forced for test' };
	}
	shouldBranch(_ctx: StrategyContext): boolean {
		return false;
	}
	shouldTerminate(_ctx: StrategyContext): boolean {
		return true;
	}
}

class ContinueStrategy implements IReasoningStrategy {
	readonly name = 'continue-always';
	decide(_ctx: StrategyContext): StrategyDecision {
		return { action: 'continue' };
	}
	shouldBranch(_ctx: StrategyContext): boolean {
		return false;
	}
	shouldTerminate(_ctx: StrategyContext): boolean {
		return false;
	}
}

interface Deps {
	history: HistoryManager;
	formatter: ThoughtFormatter;
	evaluator: ThoughtEvaluator;
	logger: NullLogger;
	edgeStore: EdgeStore;
	summaryStore: InMemorySummaryStore;
	compression: CompressionService;
}

function makeDeps(): Deps {
	const logger = new NullLogger();
	const edgeStore = new EdgeStore();
	const summaryStore = new InMemorySummaryStore();
	const history = new HistoryManager({ logger, edgeStore, dagEdges: true });
	const formatter = new ThoughtFormatter();
	const evaluator = createDisabledThoughtEvaluator();
	const compression = new CompressionService({
		historyManager: history,
		edgeStore,
		summaryStore,
		logger,
	});
	return { history, formatter, evaluator, logger, edgeStore, summaryStore, compression };
}

describe('Compression Auto-Trigger Integration', () => {
	let deps: Deps;

	beforeEach(() => {
		deps = makeDeps();
	});

	it('creates a Summary on terminate when compression is enabled and thought has branch_id', async () => {
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TerminateStrategy(),
			deps.compression
		);

		// Seed a thought to anchor the branch off of.
		await processor.process(
			createTestThought({
				thought: 'root thought one',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);

		// Branch thought — terminate strategy should trigger compression.
		const result = await processor.process(
			createTestThought({
				thought: 'branch terminal thought summary candidate',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-1'),
			})
		);

		expect(result.isError).toBeUndefined();

		const summaries = deps.summaryStore.forBranch(COMPRESSION_SESSION, asBranchId('alt-1'));
		expect(summaries.length).toBe(1);
		const summary = summaries[0];
		const branchThought = deps.history.getBranches(COMPRESSION_SESSION)[asBranchId('alt-1')]?.[0];
		if (summary === undefined || branchThought?.id === undefined) {
			throw new TypeError('Expected one identified branch thought and its summary');
		}
		expect(summary.branchId).toBe('alt-1');
		expect(summary.sessionId).toBe(COMPRESSION_SESSION);
		expect(summary.coveredIds).toEqual([branchThought.id]);
		expect(summary.coveredRange).toEqual([2, 2]);
	});

	it('does NOT compress when compression service is not wired (flag-off path)', async () => {
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TerminateStrategy()
			// no compressionService param
		);

		await processor.process(
			createTestThought({
				thought: 'root thought',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);
		await processor.process(
			createTestThought({
				thought: 'terminal branch thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-2'),
			})
		);

		expect(deps.summaryStore.size()).toBe(0);
	});

	it('does NOT compress on main chain (no branch_id) even when terminate fires', async () => {
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TerminateStrategy(),
			deps.compression
		);

		const result = await processor.process(
			createTestThought({
				thought: 'main chain terminal',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			})
		);

		expect(result.isError).toBeUndefined();
		expect(deps.summaryStore.size()).toBe(0);
	});

	it('does NOT compress when strategy decision is not terminate', async () => {
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new ContinueStrategy(),
			deps.compression
		);

		await processor.process(
			createTestThought({
				thought: 'root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);
		await processor.process(
			createTestThought({
				thought: 'branch but continuing',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-3'),
			})
		);

		expect(deps.summaryStore.size()).toBe(0);
	});

	it('pipeline still completes when compressionService.compressBranch throws', async () => {
		// Wrap compression service so compressBranch throws.
		const throwingCompression = {
			compressBranch: () => {
				throw new Error('boom from compression');
			},
		} as unknown as CompressionService;

		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TerminateStrategy(),
			throwingCompression
		);

		await processor.process(
			createTestThought({
				thought: 'root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);
		const result = await processor.process(
			createTestThought({
				thought: 'branch terminal',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-4'),
			})
		);

		// Pipeline completed successfully despite compression throwing.
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0]!.text) as {
			thought_number: number;
			next_thought_needed: boolean;
		};
		expect(parsed.thought_number).toBe(2);
		expect(parsed.next_thought_needed).toBe(false);
	});

	it('compresses a branch when ToT reaches its depth cap and compression is enabled', async () => {
		// Given
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TreeOfThoughtStrategy({
				depthCap: 1,
				terminationConfidence: 1,
				plateauWindow: 10,
			}),
			deps.compression
		);
		await processor.process(
			createTestThought({
				thought: 'depth root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				confidence: 0.1,
			})
		);

		// When
		const result = await processor.process(
			createTestThought({
				thought: 'depth branch terminal',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('depth-enabled'),
				confidence: 0.2,
			})
		);

		// Then
		const parsed = JSON.parse(result.content[0]!.text) as {
			readonly strategy_hint?: StrategyDecision;
		};
		expect(parsed.strategy_hint).toEqual({ action: 'terminate', reason: 'depth cap' });
		expect(
			deps.summaryStore.forBranch(COMPRESSION_SESSION, asBranchId('depth-enabled'))
		).toHaveLength(1);
	});

	it('does not compress a depth-capped branch when compression is disabled', async () => {
		// Given
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TreeOfThoughtStrategy({
				depthCap: 1,
				terminationConfidence: 1,
				plateauWindow: 10,
			})
		);
		await processor.process(
			createTestThought({
				thought: 'disabled depth root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);

		// When
		const result = await processor.process(
			createTestThought({
				thought: 'disabled depth branch',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('depth-disabled'),
			})
		);

		// Then
		const parsed = JSON.parse(result.content[0]!.text) as {
			readonly strategy_hint?: StrategyDecision;
		};
		expect(parsed.strategy_hint).toEqual({ action: 'terminate', reason: 'depth cap' });
		expect(deps.summaryStore.size()).toBe(0);
	});

	it('keeps ToT depth-cap auto-compression idempotent for the same branch root', async () => {
		// Given
		const branchId = asBranchId('depth-idempotent');
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TreeOfThoughtStrategy({
				depthCap: 1,
				terminationConfidence: 1,
				plateauWindow: 10,
			}),
			deps.compression
		);
		await processor.process(
			createTestThought({
				thought: 'idempotent root',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);
		await processor.process(
			createTestThought({
				thought: 'idempotent branch one',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: branchId,
			})
		);
		const firstSummary = deps.summaryStore.forBranch(COMPRESSION_SESSION, branchId)[0];

		// When
		await processor.process(
			createTestThought({
				thought: 'idempotent branch two',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: true,
				branch_from_thought: 2,
				branch_id: branchId,
			})
		);

		// Then
		const summaries = deps.summaryStore.forBranch(COMPRESSION_SESSION, branchId);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.id).toBe(firstSummary?.id);
	});

	it('contains compression failure after a ToT depth-cap termination', async () => {
		// Given
		const compressBranch = vi.spyOn(deps.compression, 'compressBranch').mockImplementation(() => {
			throw new Error('depth compression failure');
		});
		const processor = new ThoughtProcessor(
			deps.history,
			deps.formatter,
			deps.evaluator,
			deps.logger,
			new TreeOfThoughtStrategy({
				depthCap: 1,
				terminationConfidence: 1,
				plateauWindow: 10,
			}),
			deps.compression
		);
		await processor.process(
			createTestThought({
				thought: 'failure root',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);

		// When
		const result = await processor.process(
			createTestThought({
				thought: 'failure branch',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('depth-failure'),
			})
		);

		// Then
		const parsed = JSON.parse(result.content[0]!.text) as {
			readonly thought_number: number;
			readonly strategy_hint?: StrategyDecision;
		};
		expect(compressBranch).toHaveBeenCalledOnce();
		expect(result.isError).toBeUndefined();
		expect(parsed.thought_number).toBe(2);
		expect(parsed.strategy_hint).toEqual({ action: 'terminate', reason: 'depth cap' });
	});
});

describe('Compression → Dehydration Roundtrip', () => {
	it('CompressionService output feeds DehydrationPolicy.apply to collapse cold thoughts into SummaryRef', async () => {
		const logger = new NullLogger();
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = new HistoryManager({ logger, edgeStore, dagEdges: true });
		const compression = new CompressionService({
			historyManager: history,
			edgeStore,
			summaryStore,
			logger,
		});

		// Build 8 thoughts on branch 'b1' with explicit ids and DAG edges.
		const sessionId = COMPRESSION_SESSION;
		for (let i = 1; i <= 8; i++) {
			await history.addThought(
				createTestThought({
					id: `t-${i}`,
					thought: `cold thought ${i}`,
					thought_number: i,
					total_thoughts: 8,
					next_thought_needed: i < 8,
					branch_id: asBranchId('b1'),
					confidence: 0.6,
				})
			);
		}
		// Wire chronological edges so descendants() walks t-1 → t-2 → ... → t-8.
		for (let i = 1; i < 8; i++) {
			edgeStore.addEdge({
				id: `e-${i}` as EdgeId,
				from: asThoughtId(`t-${i}`),
				to: asThoughtId(`t-${i + 1}`),
				kind: 'sequence',
				sessionId,
				createdAt: Date.now() + i,
			});
		}

		// Compress: produces a Summary covering thoughts 1..8.
		const summary = compression.compressBranch(sessionId, asBranchId('b1'), asThoughtId('t-1'));
		expect(summary.coveredRange).toEqual([1, 8]);
		expect(summary.coveredIds).toEqual(['t-1', 't-2', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8']);

		// Now apply DehydrationPolicy with keepLastK=3 → cold prefix (1..5) collapses.
		const policy = new DehydrationPolicy(summaryStore);
		const hydrated = policy.apply(history.getHistory(sessionId), sessionId, {
			keepLastK: 3,
		});

		// Expected: 1 SummaryRef (covering 1..5 via dedup) + 3 hot thoughts.
		expect(hydrated.length).toBe(4);
		const ref = hydrated[0] as {
			kind: 'summary';
			summaryId: string;
			coveredRange: readonly [number, number];
		};
		expect(ref.kind).toBe('summary');
		expect(ref.summaryId).toBe(summary.id);
		expect(ref.coveredRange).toEqual([1, 8]);

		// Hot suffix: thoughts 6, 7, 8 verbatim.
		for (let i = 1; i <= 3; i++) {
			const entry = hydrated[i] as { thought_number?: number };
			expect(entry.thought_number).toBe(5 + i);
		}
	});
});
