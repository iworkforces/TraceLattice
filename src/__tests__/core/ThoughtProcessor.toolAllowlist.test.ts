import { describe, it, expect, beforeEach } from 'vitest';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { MockHistoryManager, createMockToolRegistry } from '../helpers/factories.js';
import type { FeatureFlags } from '../../contracts/features.js';
import type { IToolRegistry } from '../../contracts/interfaces.js';
import { ERROR_CODES } from '../../errors.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';
import { asSessionId } from '../../contracts/ids.js';

function makeFeatures(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
	return {
		dagEdges: false,
		reasoningStrategy: 'sequential',
		calibration: false,
		compression: false,
		toolInterleave: true,
		newThoughtTypes: false,
		outcomeRecording: false,
		...overrides,
	};
}

function makeProcessor(
	opts: {
		store?: InMemorySuspensionStore;
		registry?: IToolRegistry;
		features?: FeatureFlags;
	} = {}
): ThoughtProcessor {
	const history = new MockHistoryManager();
	return new ThoughtProcessor(
		history,
		new ThoughtFormatter(),
		createDisabledThoughtEvaluator(),
		undefined,
		new SequentialStrategy(),
		undefined,
		opts.store ?? new InMemorySuspensionStore(),
		opts.registry,
		opts.features ?? makeFeatures()
	);
}

describe('ThoughtProcessor — tool allowlist (WU-1.2)', () => {
	let store: InMemorySuspensionStore;

	beforeEach(() => {
		store = new InMemorySuspensionStore();
	});

	it('rejects tool_call with UNKNOWN_TOOL when registry is missing (fail closed)', async () => {
		const processor = makeProcessor({ store, registry: undefined });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-allowlist'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: { q: 'x' },
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.code).toBe(ERROR_CODES.UNKNOWN_TOOL);
	});

	it('rejects tool_call when tool name is not in the registry allowlist', async () => {
		const registry = createMockToolRegistry(['search', 'fetch']);
		const processor = makeProcessor({ store, registry });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-allowlist'),
			thought_type: 'tool_call',
			tool_name: 'rm-rf',
			tool_arguments: {},
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.code).toBe(ERROR_CODES.UNKNOWN_TOOL);
		expect(payload.message).toContain('rm-rf');
	});

	it('accepts tool_call when tool name is in the registry allowlist', async () => {
		const registry = createMockToolRegistry(['search', 'fetch']);
		const processor = makeProcessor({ store, registry });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-allowlist'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: { q: 'x' },
		});
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.status).toBe('suspended');
		expect(payload.tool_name).toBe('search');
	});

	it('UnknownToolError carries the offending tool name', async () => {
		const registry = createMockToolRegistry(['search']);
		const processor = makeProcessor({ store, registry });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-allowlist'),
			thought_type: 'tool_call',
			tool_name: 'evil',
			tool_arguments: {},
		});
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.code).toBe('UNKNOWN_TOOL');
		expect(payload.message).toMatch(/evil/);
	});
});

describe('ThoughtProcessor — tool_arguments shape enforcement (WU-1.3)', () => {
	const registry = createMockToolRegistry(['search']);

	it('rejects tool_arguments with constructor key (forbidden)', async () => {
		const processor = makeProcessor({ registry });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-arguments'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: { constructor: 'evil' } as Record<string, unknown>,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.code).toBe(ERROR_CODES.VALIDATION_ERROR);
		expect(payload.message).toMatch(/tool_arguments/);
		expect(payload.message).toMatch(/forbidden key 'constructor'/);
	});

	it('rejects tool_arguments exceeding max serialized size', async () => {
		const processor = makeProcessor({ registry });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-arguments'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: { blob: 'x'.repeat(20_000) },
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.code).toBe(ERROR_CODES.VALIDATION_ERROR);
		expect(payload.message).toMatch(/max serialized size/);
	});

	it('rejects tool_arguments with deeply nested objects', async () => {
		const processor = makeProcessor({ registry });
		let deep: Record<string, unknown> = { leaf: 1 };
		for (let i = 0; i < 15; i++) deep = { x: deep };
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-arguments'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: deep,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.code).toBe(ERROR_CODES.VALIDATION_ERROR);
		expect(payload.message).toMatch(/max depth/);
	});

	it('accepts well-formed tool_arguments', async () => {
		const processor = makeProcessor({ registry });
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-arguments'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: { q: 'hello', opts: { limit: 10 } },
		});
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.status).toBe('suspended');
	});
});
