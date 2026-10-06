import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLAGS } from '../../contracts/features.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import type { ThoughtData } from '../../core/thought.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';
import { createTestSessionId, createTestThought } from '../helpers/factories.js';

const sessionId = createTestSessionId('processor-graph');
const managers: HistoryManager[] = [];

function createProcessor(dagEdges = true) {
	const edgeStore = new EdgeStore();
	const manager = new HistoryManager({ edgeStore, dagEdges });
	managers.push(manager);
	const processor = new ThoughtProcessor(
		manager,
		new ThoughtFormatter(),
		createDisabledThoughtEvaluator(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ ...DEFAULT_FLAGS, dagEdges }
	);
	return { processor, edgeStore };
}

function thought(thoughtNumber: number, overrides: Partial<ThoughtData> = {}): ThoughtData {
	return createTestThought({
		session_id: sessionId,
		thought_number: thoughtNumber,
		total_thoughts: 10,
		next_thought_needed: true,
		...overrides,
	});
}

async function process(processor: ThoughtProcessor, input: ThoughtData) {
	const response = await processor.process(input);
	expect(response.isError).not.toBe(true);
	const content = response.content[0];
	if (content?.type !== 'text') throw new Error('Expected a text response');
	return JSON.parse(content.text);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.shutdown();
});

describe('ThoughtProcessor graph enrichment', () => {
	it('omits graph enrichment when the first thought has no edges', async () => {
		const { processor } = createProcessor();
		const response = await process(processor, thought(1));
		expect(response).not.toHaveProperty('graph_context');
		expect(response.confidence_signals).not.toHaveProperty('graph_signals');
	});

	it('includes sequence neighbours and analytics when a second thought is admitted', async () => {
		const { processor } = createProcessor();
		await process(processor, thought(1));
		const response = await process(processor, thought(2));
		expect(response.graph_context).toMatchObject({
			inbound: [{ thought_number: 1, kind: 'sequence' }],
			root_distance: 1,
			ancestor_count: 1,
		});
		expect(response.confidence_signals.graph_signals.edge_count).toBe(1);
	});

	it('omits graph enrichment when DAG emission is disabled', async () => {
		const { processor } = createProcessor(false);
		await process(processor, thought(1));
		const response = await process(processor, thought(2));
		expect(response).not.toHaveProperty('graph_context');
		expect(response.confidence_signals).not.toHaveProperty('graph_signals');
	});

	it('prioritizes the dependency warning when a synthesis source is refuted', async () => {
		const { processor } = createProcessor();
		await process(processor, thought(1, { thought_type: 'hypothesis', confidence: 0.8 }));
		await process(processor, thought(2, { thought_type: 'synthesis', synthesis_sources: [1] }));
		const response = await process(
			processor,
			thought(3, {
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 0,
			})
		);
		expect(response.reasoning_hints[0]).toBe(
			'Thought(s) 2 build on hypothesis at thought 1, which was refuted at thought 3 - revise or backtrack them'
		);
	});

	it('warns when a critique remains unaddressed after three subsequent thoughts', async () => {
		const { processor } = createProcessor();
		await process(processor, thought(1));
		await process(processor, thought(2, { thought_type: 'critique', verification_target: 1 }));
		await process(processor, thought(3));
		await process(processor, thought(4));
		const response = await process(processor, thought(5));
		expect(response.reasoning_hints).toContain(
			'Critique at thought 2 of thought 1 has not been addressed by a revision or verification within 3 thoughts'
		);
	});

	it('includes an outbound verifies edge when a verification targets a hypothesis', async () => {
		const { processor } = createProcessor();
		await process(processor, thought(1, { thought_type: 'hypothesis', confidence: 0.8 }));
		const response = await process(
			processor,
			thought(2, { thought_type: 'verification', verification_target: 1 })
		);
		expect(response.graph_context.outbound).toContainEqual({
			thought_number: 1,
			kind: 'verifies',
		});
	});

	it('omits strategy and graph enrichment but succeeds when projection construction fails', async () => {
		const { processor, edgeStore } = createProcessor();
		await process(processor, thought(1));
		vi.spyOn(edgeStore, 'edgesForSession').mockImplementation(() => {
			throw new Error('Projection read failed');
		});
		const response = await process(processor, thought(2));
		expect(response).not.toHaveProperty('strategy_hint');
		expect(response).not.toHaveProperty('graph_context');
		expect(response.confidence_signals).not.toHaveProperty('graph_signals');
	});

	it('reads the active graph only once for evaluation, strategy and response', async () => {
		const { processor, edgeStore } = createProcessor();
		await process(processor, thought(1));
		const reads = vi.spyOn(edgeStore, 'edgesForSession');
		const response = await process(processor, thought(2));
		expect(reads).toHaveBeenCalledTimes(1);
		expect(response).toHaveProperty('strategy_hint');
		expect(response).toHaveProperty('graph_context');
		expect(response.confidence_signals).toHaveProperty('graph_signals');
	});
});
