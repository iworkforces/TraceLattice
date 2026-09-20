import { asBranchId, asSessionId } from '../../contracts/ids.js';
/**
 * End-to-end integration tests for the Strategy layer.
 *
 * Tests the full Strategy integration from {@link ThoughtProcessor} through
 * the MCP response shape. Covers default strategy wiring, terminal vs. ongoing
 * thought hint emission, branch handling, multi-thought sequences, backward
 * compatible response shape, and graceful degradation when a strategy throws.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import type { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import type {
	IReasoningStrategy,
	StrategyContext,
	StrategyDecision,
} from '../../contracts/strategy.js';
import { MockHistoryManager, createTestThought } from '../helpers/factories.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

const STRATEGY_SESSION = asSessionId('test-session');

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

describe('Strategy Integration (ThoughtProcessor + SequentialStrategy)', () => {
	let history: MockHistoryManager;
	let formatter: ThoughtFormatter;
	let evaluator: ThoughtEvaluator;
	let logger: NullLogger;

	beforeEach(() => {
		history = new MockHistoryManager();
		formatter = new ThoughtFormatter();
		evaluator = createDisabledThoughtEvaluator();
		logger = new NullLogger();
	});

	it('emits strategy_hint with action=continue for ongoing thoughts', async () => {
		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		const result = await processor.process(
			createTestThought({
				thought: 'Still thinking',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);

		const parsed = parseResponse(result.content[0]!.text);
		expect(parsed.strategy_hint).toEqual({ action: 'continue' });
		expect(parsed.next_thought_needed).toBe(true);
	});

	it('emits strategy_hint with action=terminate for terminal thoughts', async () => {
		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		const result = await processor.process(
			createTestThought({
				thought: 'Final answer',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			})
		);

		const parsed = parseResponse(result.content[0]!.text);
		expect(parsed).toHaveProperty('strategy_hint');
		expect(parsed.strategy_hint?.action).toBe('terminate');
	});

	it('terminal strategy_hint includes a non-empty reason field', async () => {
		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		const result = await processor.process(
			createTestThought({
				thought: 'Done',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			})
		);

		const parsed = parseResponse(result.content[0]!.text);
		const hint = parsed.strategy_hint;
		expect(hint).toBeDefined();
		if (hint && hint.action === 'terminate') {
			expect(typeof hint.reason).toBe('string');
			expect(hint.reason.length).toBeGreaterThan(0);
		} else {
			throw new Error('expected terminate decision');
		}
	});

	it('defaults to SequentialStrategy when 5th constructor arg is omitted', async () => {
		// 4-arg construction — strategy parameter omitted
		const processor = new ThoughtProcessor(history, formatter, evaluator, logger);

		const ongoing = await processor.process(
			createTestThought({
				thought: 'mid-stream',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);
		const terminal = await processor.process(
			createTestThought({
				thought: 'last',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
			})
		);

		const ongoingParsed = parseResponse(ongoing.content[0]!.text);
		const terminalParsed = parseResponse(terminal.content[0]!.text);

		expect(ongoingParsed.strategy_hint).toEqual({ action: 'continue' });
		expect(terminalParsed.strategy_hint?.action).toBe('terminate');
	});

	it('emits a continue hint for branch thoughts when SequentialStrategy delegates', async () => {
		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		// Seed a base thought first so branch_from_thought=1 is valid.
		await processor.process(
			createTestThought({
				thought: 'base',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);

		const branchResult = await processor.process(
			createTestThought({
				thought: 'branch off',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-1'),
			})
		);

		const parsed = parseResponse(branchResult.content[0]!.text);
		// SequentialStrategy.decide() returns 'continue' regardless of branch_id.
		expect(parsed.strategy_hint).toEqual({ action: 'continue' });
	});

	it('emits strategy_hint for each successful decision in a multi-thought sequence', async () => {
		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		const r1 = await processor.process(
			createTestThought({
				thought: 'one',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);
		const r2 = await processor.process(
			createTestThought({
				thought: 'two',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);
		const r3 = await processor.process(
			createTestThought({
				thought: 'three',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
			})
		);

		const p1 = parseResponse(r1.content[0]!.text);
		const p2 = parseResponse(r2.content[0]!.text);
		const p3 = parseResponse(r3.content[0]!.text);

		expect(p1.strategy_hint).toEqual({ action: 'continue' });
		expect(p2.strategy_hint).toEqual({ action: 'continue' });
		expect(p3.strategy_hint?.action).toBe('terminate');
	});

	it('preserves the canonical response shape for ongoing thoughts', async () => {
		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new SequentialStrategy()
		);

		const result = await processor.process(
			createTestThought({
				thought: 'shape check',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			})
		);

		const parsed = parseResponse(result.content[0]!.text);

		// Required canonical keys must remain.
		expect(parsed).toHaveProperty('thought_number', 1);
		expect(parsed).toHaveProperty('total_thoughts', 2);
		expect(parsed).toHaveProperty('next_thought_needed', true);
		expect(parsed).toHaveProperty('thought_history_length', 1);
		expect(parsed).toHaveProperty('confidence_signals');
		expect(parsed).toHaveProperty('reasoning_stats');

		expect(parsed.strategy_hint).toEqual({ action: 'continue' });
		expect(parsed).not.toHaveProperty('warnings');
	});

	it('gracefully degrades when the strategy throws (no crash, response still returned)', async () => {
		class ThrowingStrategy implements IReasoningStrategy {
			readonly name = 'throwing';
			decide(_ctx: StrategyContext): StrategyDecision {
				throw new Error('boom from strategy');
			}
			shouldBranch(_ctx: StrategyContext): boolean {
				return false;
			}
			shouldTerminate(_ctx: StrategyContext): boolean {
				return false;
			}
		}

		const processor = new ThoughtProcessor(
			history,
			formatter,
			evaluator,
			logger,
			new ThrowingStrategy()
		);

		const result = await processor.process(
			createTestThought({
				thought: 'terminal but strategy throws',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			})
		);

		expect(result.isError).toBeUndefined();
		const parsed = parseResponse(result.content[0]!.text);
		expect(parsed).not.toHaveProperty('strategy_hint');
		expect(parsed.thought_number).toBe(1);
		expect(parsed.next_thought_needed).toBe(false);
		// History was still updated despite strategy failure.
		expect(history.getHistoryLength(STRATEGY_SESSION)).toBe(1);
	});
});
