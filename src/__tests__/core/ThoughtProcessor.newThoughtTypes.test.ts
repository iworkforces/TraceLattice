import { describe, it, expect } from 'vitest';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { MockHistoryManager, createMockToolRegistry } from '../helpers/factories.js';
import type { FeatureFlags } from '../../contracts/features.js';
import { asSessionId, asSuspensionToken } from '../../contracts/ids.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

function makeFeatures(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
	return {
		dagEdges: false,
		reasoningStrategy: 'sequential',
		calibration: false,
		compression: false,
		toolInterleave: false,
		newThoughtTypes: false,
		outcomeRecording: false,
		...overrides,
	};
}

function makeProcessor(features: FeatureFlags): ThoughtProcessor {
	return new ThoughtProcessor(
		new MockHistoryManager(),
		new ThoughtFormatter(),
		createDisabledThoughtEvaluator(),
		undefined,
		new SequentialStrategy(),
		undefined,
		new InMemorySuspensionStore(),
		createMockToolRegistry(['search', 'fetch', 'test-tool']),
		features
	);
}

describe('ThoughtProcessor — new thought type validation', () => {
	it('rejects tool_call when toolInterleave flag is OFF', async () => {
		const proc = makeProcessor(makeFeatures({ toolInterleave: false }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/Type 'tool_call' requires the toolInterleave feature flag/);
	});

	it('rejects tool_observation when toolInterleave flag is OFF', async () => {
		const proc = makeProcessor(makeFeatures({ toolInterleave: false }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'tool_observation',
			continuation_token: asSuspensionToken('tok'),
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(
			/Type 'tool_observation' requires the toolInterleave feature flag/
		);
	});

	it('rejects assumption when newThoughtTypes flag is OFF', async () => {
		const proc = makeProcessor(makeFeatures({ newThoughtTypes: false }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'assumption',
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/Type 'assumption' requires the newThoughtTypes feature flag/);
	});

	it('rejects decomposition when newThoughtTypes flag is OFF', async () => {
		const proc = makeProcessor(makeFeatures({ newThoughtTypes: false }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'decomposition',
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/Type 'decomposition' requires the newThoughtTypes feature flag/);
	});

	it('rejects backtrack when newThoughtTypes flag is OFF', async () => {
		const proc = makeProcessor(makeFeatures({ newThoughtTypes: false }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'backtrack',
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/Type 'backtrack' requires the newThoughtTypes feature flag/);
	});

	it('rejects tool_call without tool_name (InvalidToolCallError)', async () => {
		const proc = makeProcessor(makeFeatures({ toolInterleave: true }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 5,
			total_thoughts: 5,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'tool_call',
			tool_arguments: {},
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/tool_call thought 5 missing required tool_name/);
	});

	it('rejects tool_observation without continuation_token (ValidationError)', async () => {
		const proc = makeProcessor(makeFeatures({ toolInterleave: true }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 6,
			total_thoughts: 6,
			next_thought_needed: false,
			session_id: asSessionId('new-types'),
			thought_type: 'tool_observation',
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/tool_observation thought 6 missing continuation_token/);
	});

	it('rejects backtrack with backtrack_target greater than thought_number', async () => {
		const proc = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		const result = await proc.process({
			thought: 'x',
			thought_number: 3,
			total_thoughts: 5,
			next_thought_needed: true,
			session_id: asSessionId('new-types'),
			thought_type: 'backtrack',
			backtrack_target: 5,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/backtrack_target 5 must be <= thought_number 3/);
	});

	it('accepts backtrack with backtrack_target less than or equal to thought_number', async () => {
		const proc = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		// Seed history so backtrack_target=2 refers to an existing thought.
		await proc.process({
			thought: 'first',
			thought_number: 1,
			total_thoughts: 8,
			next_thought_needed: true,
			session_id: asSessionId('new-types'),
		});
		await proc.process({
			thought: 'second',
			thought_number: 2,
			total_thoughts: 8,
			next_thought_needed: true,
			session_id: asSessionId('new-types'),
		});
		const result = await proc.process({
			thought: 'going back',
			thought_number: 5,
			total_thoughts: 8,
			next_thought_needed: true,
			session_id: asSessionId('new-types'),
			thought_type: 'backtrack',
			backtrack_target: 2,
		});
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.thought_number).toBe(5);
	});
});
