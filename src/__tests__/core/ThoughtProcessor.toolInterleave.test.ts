import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { MockHistoryManager, createMockToolRegistry } from '../helpers/factories.js';
import type { FeatureFlags } from '../../contracts/features.js';
import { asSessionId, asThoughtId, type SuspensionToken } from '../../contracts/ids.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

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
	store: InMemorySuspensionStore,
	features: FeatureFlags = makeFeatures()
): { processor: ThoughtProcessor; history: MockHistoryManager } {
	const history = new MockHistoryManager();
	const processor = new ThoughtProcessor(
		history,
		new ThoughtFormatter(),
		createDisabledThoughtEvaluator(),
		undefined,
		new SequentialStrategy(),
		undefined,
		store,
		createMockToolRegistry(['echo', 'test-tool', 'sleep', 'sum', 'add', 'search', 'fetch']),
		features
	);
	return { processor, history };
}

describe('ThoughtProcessor — tool interleave', () => {
	let store: InMemorySuspensionStore;

	beforeEach(() => {
		store = new InMemorySuspensionStore();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('tool_call returns a suspended envelope with continuation_token and tool metadata', async () => {
		const { processor } = makeProcessor(store);
		const result = await processor.process({
			thought: 'invoke search',
			thought_number: 1,
			total_thoughts: 3,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: { q: 'hello' },
		});
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.status).toBe('suspended');
		expect(typeof payload.continuation_token).toBe('string');
		expect(payload.tool_name).toBe('search');
		expect(payload.tool_arguments).toEqual({ q: 'hello' });
		expect(typeof payload.expires_at).toBe('number');
		expect(payload.thought_number).toBe(1);
		expect(payload.total_thoughts).toBe(3);
	});

	it('tool_call suspend envelope omits confidence_signals and reasoning_stats', async () => {
		const { processor } = makeProcessor(store);
		const result = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.confidence_signals).toBeUndefined();
		expect(payload.reasoning_stats).toBeUndefined();
	});

	it('tool_call persists the originating thought to history before suspending', async () => {
		const { processor, history } = makeProcessor(store);
		await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const items = history.getHistory(asSessionId('tool-interleave'));
		expect(items).toHaveLength(1);
		expect(items[0]!.thought_type).toBe('tool_call');
		expect(items[0]!.tool_name).toBe('search');
	});

	it('tool_observation resumes via continuation_token and runs the normal pipeline', async () => {
		const { processor, history } = makeProcessor(store);
		const callResult = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const token = JSON.parse(callResult.content[0]!.text).continuation_token as SuspensionToken;

		const obsResult = await processor.process({
			thought: 'tool returned X',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});
		expect(obsResult.isError).toBeFalsy();
		const payload = JSON.parse(obsResult.content[0]!.text);
		// Normal pipeline shape — has confidence_signals + reasoning_stats.
		expect(payload.thought_number).toBe(2);
		expect(payload.confidence_signals).toBeDefined();
		expect(payload.reasoning_stats).toBeDefined();
		// Observation persisted to history.
		const items = history.getHistory(asSessionId('tool-interleave'));
		expect(items).toHaveLength(2);
		expect(items[1]!.thought_type).toBe('tool_observation');
	});

	it('tool_observation does not expose transient numeric resume metadata', async () => {
		const { processor, history } = makeProcessor(store);
		const callResult = await processor.process({
			thought: 'invoke',
			thought_number: 7,
			total_thoughts: 8,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const token = JSON.parse(callResult.content[0]!.text).continuation_token as SuspensionToken;

		await processor.process({
			thought: 'observed',
			thought_number: 8,
			total_thoughts: 8,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});

		const obs = history.getHistory(asSessionId('tool-interleave'))[1];
		expect('_resumedFrom' in (obs ?? {})).toBe(false);
	});

	it('tool_observation with an unknown token returns SuspensionNotFoundError', async () => {
		const { processor } = makeProcessor(store);
		const result = await processor.process({
			thought: 'observed',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: 'definitely-not-a-real-token' as SuspensionToken,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.status).toBe('failed');
		expect(payload.error).toMatch(/Suspension token not found/);
	});

	it('tool_observation expires at equality, removes the token, and then reports it missing', async () => {
		vi.useFakeTimers({ now: new Date('2026-09-15T00:00:00.000Z') });
		const expired = store.suspend({
			sessionId: asSessionId('tool-interleave'),
			toolCallThoughtNumber: 1,
			toolCallThoughtId: asThoughtId('expired-call'),
			toolName: 'search',
			toolArguments: {},
			ttlMs: 100,
			expiresAt: 0,
		});
		vi.setSystemTime(expired.expiresAt);
		const { processor, history } = makeProcessor(store);
		const result = await processor.process({
			thought: 'observed',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: expired.token,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/Suspension token expired/);
		expect(history.getHistory(asSessionId('tool-interleave'))).toHaveLength(0);
		expect(store.size()).toBe(0);

		const next = await processor.process({
			thought: 'observed again',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: expired.token,
		});
		expect(JSON.parse(next.content[0]!.text).error).toMatch(/Suspension token not found/);
	});

	it('retains a valid token when history admission fails and admits exactly once on retry', async () => {
		const { processor, history } = makeProcessor(store);
		const callResult = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const token = JSON.parse(callResult.content[0]!.text).continuation_token as SuspensionToken;
		const originalAddThought = history.addThought.bind(history);
		const sentinel = new TypeError('controlled history admission failure');
		vi.spyOn(history, 'addThought').mockImplementationOnce(() => {
			throw sentinel;
		});

		const failed = await processor.process({
			thought: 'first observation',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});

		expect(failed.isError).toBe(true);
		expect(JSON.parse(failed.content[0]!.text).error).toBe(sentinel.message);
		expect(store.peek(token)).not.toBeNull();
		expect(history.getHistory(asSessionId('tool-interleave'))).toHaveLength(1);

		vi.mocked(history.addThought).mockImplementation(originalAddThought);
		const retried = await processor.process({
			thought: 'retry observation',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});
		expect(retried.isError).toBeUndefined();
		expect(
			history
				.getHistory(asSessionId('tool-interleave'))
				.filter((thought) => thought.thought_type === 'tool_observation')
		).toHaveLength(1);
		expect(store.size()).toBe(0);
	});

	it('admits one observation when two rightful attempts present the same token concurrently', async () => {
		const { processor, history } = makeProcessor(store);
		const callResult = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const token = JSON.parse(callResult.content[0]!.text).continuation_token as SuspensionToken;
		const observation = (thought: string) =>
			processor.process({
				thought,
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: asSessionId('tool-interleave'),
				thought_type: 'tool_observation',
				continuation_token: token,
			});

		const results = await Promise.all([observation('first'), observation('second')]);
		const payloads = results.map((result) => JSON.parse(result.content[0]!.text));

		expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
		expect(payloads.filter((payload) => payload.code === 'SUSPENSION_NOT_FOUND')).toHaveLength(1);
		expect(
			history
				.getHistory(asSessionId('tool-interleave'))
				.filter((thought) => thought.thought_type === 'tool_observation')
		).toHaveLength(1);
		expect(store.size()).toBe(0);
	});

	it('does not restore a consumed token when formatting fails after successful admission', async () => {
		const { processor, history } = makeProcessor(store);
		const callResult = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const token = JSON.parse(callResult.content[0]!.text).continuation_token as SuspensionToken;
		const sentinel = new TypeError('controlled formatting failure');
		vi.spyOn(ThoughtFormatter.prototype, 'formatThought').mockImplementationOnce(() => {
			throw sentinel;
		});

		const failed = await processor.process({
			thought: 'admitted before formatting',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});

		expect(failed.isError).toBe(true);
		expect(JSON.parse(failed.content[0]!.text).error).toBe(sentinel.message);
		expect(history.getHistory(asSessionId('tool-interleave'))).toHaveLength(2);
		expect(store.size()).toBe(0);

		const replay = await processor.process({
			thought: 'must not replay',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});
		expect(JSON.parse(replay.content[0]!.text).code).toBe('SUSPENSION_NOT_FOUND');
		expect(history.getHistory(asSessionId('tool-interleave'))).toHaveLength(2);
	});

	it('tool_call suspend single-uses the token (resume after consume returns NotFound)', async () => {
		const { processor } = makeProcessor(store);
		const callResult = await processor.process({
			thought: 'invoke',
			thought_number: 1,
			total_thoughts: 3,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const token = JSON.parse(callResult.content[0]!.text).continuation_token as SuspensionToken;

		// First observation succeeds.
		const ok = await processor.process({
			thought: 'first observation',
			thought_number: 2,
			total_thoughts: 3,
			next_thought_needed: true,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});
		expect(ok.isError).toBeFalsy();

		// Second observation with same token should fail.
		const dup = await processor.process({
			thought: 'duplicate observation',
			thought_number: 3,
			total_thoughts: 3,
			next_thought_needed: false,
			session_id: asSessionId('tool-interleave'),
			thought_type: 'tool_observation',
			continuation_token: token,
		});
		expect(dup.isError).toBe(true);
		const payload = JSON.parse(dup.content[0]!.text);
		expect(payload.error).toMatch(/Suspension token not found/);
	});

	describe('full multi-cycle and session isolation', () => {
		it('handles a full 4-thought call→obs→call→obs cycle in one session', async () => {
			const { processor, history } = makeProcessor(store);

			// First tool_call
			const call1 = await processor.process({
				thought: 'invoke first',
				thought_number: 1,
				total_thoughts: 4,
				next_thought_needed: true,
				session_id: asSessionId('tool-interleave-cycle'),
				thought_type: 'tool_call',
				tool_name: 'search',
				tool_arguments: { q: 'first' },
			});
			const token1 = JSON.parse(call1.content[0]!.text).continuation_token as SuspensionToken;

			// First observation
			const obs1 = await processor.process({
				thought: 'first observation',
				thought_number: 2,
				total_thoughts: 4,
				next_thought_needed: true,
				session_id: asSessionId('tool-interleave-cycle'),
				thought_type: 'tool_observation',
				continuation_token: token1,
			});
			expect(obs1.isError).toBeFalsy();

			// Second tool_call
			const call2 = await processor.process({
				thought: 'invoke second',
				thought_number: 3,
				total_thoughts: 4,
				next_thought_needed: true,
				session_id: asSessionId('tool-interleave-cycle'),
				thought_type: 'tool_call',
				tool_name: 'fetch',
				tool_arguments: { url: 'http://x' },
			});
			const token2 = JSON.parse(call2.content[0]!.text).continuation_token as SuspensionToken;
			expect(token2).not.toBe(token1);

			// Second observation
			const obs2 = await processor.process({
				thought: 'second observation',
				thought_number: 4,
				total_thoughts: 4,
				next_thought_needed: false,
				session_id: asSessionId('tool-interleave-cycle'),
				thought_type: 'tool_observation',
				continuation_token: token2,
			});
			expect(obs2.isError).toBeFalsy();

			// Verify all 4 thoughts persisted in correct order with correct types
			const items = history.getHistory(asSessionId('tool-interleave-cycle'));
			expect(items).toHaveLength(4);
			expect(items.map((t) => t.thought_type)).toEqual([
				'tool_call',
				'tool_observation',
				'tool_call',
				'tool_observation',
			]);
			expect('_resumedFrom' in (items[1] ?? {})).toBe(false);
			expect('_resumedFrom' in (items[3] ?? {})).toBe(false);
			// Both suspensions were consumed (single-use)
			expect(store.size()).toBe(0);
		});

		it('issues distinct tokens per session and tags suspend envelope with session_id', async () => {
			const { processor } = makeProcessor(store);

			const callA = await processor.process({
				thought: 'A invokes',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				thought_type: 'tool_call',
				tool_name: 'search',
				tool_arguments: { q: 'A' },
				session_id: asSessionId('session-A'),
			});
			const callB = await processor.process({
				thought: 'B invokes',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				thought_type: 'tool_call',
				tool_name: 'search',
				tool_arguments: { q: 'B' },
				session_id: asSessionId('session-B'),
			});

			const payloadA = JSON.parse(callA.content[0]!.text);
			const payloadB = JSON.parse(callB.content[0]!.text);
			expect(payloadA.session_id).toBe('session-A');
			expect(payloadB.session_id).toBe('session-B');
			expect(payloadA.continuation_token).not.toBe(payloadB.continuation_token);
			// Two suspensions live independently
			expect(store.size()).toBe(2);

			// Each token still resolvable individually via peek; sessionId metadata preserved
			const peekA = store.peek(payloadA.continuation_token);
			const peekB = store.peek(payloadB.continuation_token);
			expect(peekA?.sessionId).toBe('session-A');
			expect(peekB?.sessionId).toBe('session-B');
		});
	});
});
