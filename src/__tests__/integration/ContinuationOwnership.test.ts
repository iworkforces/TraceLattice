import { afterEach, describe, expect, it } from 'vitest';

import type { FeatureFlags } from '../../contracts/features.js';
import {
	asSessionId,
	asSuspensionToken,
	type SessionId,
	type SuspensionToken,
} from '../../contracts/ids.js';
import { runWithContext } from '../../context/RequestContext.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { SessionLock } from '../../core/SessionLock.js';
import { SessionLifecycleCoordinator } from '../../core/SessionLifecycleCoordinator.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor, type CallToolResult } from '../../core/ThoughtProcessor.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { ERROR_CODES } from '../../errors.js';
import { createMockToolRegistry } from '../helpers/factories.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

const SESSION_A = asSessionId('session-a');
const SESSION_B = asSessionId('session-b');
const FEATURES: FeatureFlags = {
	dagEdges: false,
	reasoningStrategy: 'sequential',
	calibration: false,
	compression: false,
	toolInterleave: true,
	newThoughtTypes: false,
	outcomeRecording: false,
};

type Harness = {
	readonly history: HistoryManager;
	readonly lock: SessionLock;
	readonly lifecycle: SessionLifecycleCoordinator;
	readonly processor: ThoughtProcessor;
	readonly store: InMemorySuspensionStore;
};

const liveHarnesses = new Set<Harness>();

function createHarness(): Harness {
	const lock = new SessionLock();
	const lifecycle = new SessionLifecycleCoordinator();
	const history = new HistoryManager({ sessionLock: lock, lifecycleCoordinator: lifecycle });
	const store = new InMemorySuspensionStore();
	const processor = new ThoughtProcessor(
		history,
		new ThoughtFormatter(),
		createDisabledThoughtEvaluator(),
		undefined,
		new SequentialStrategy(),
		undefined,
		store,
		createMockToolRegistry(['search']),
		FEATURES,
		lock,
		undefined,
		lifecycle
	);
	const harness = { history, lock, lifecycle, processor, store };
	liveHarnesses.add(harness);
	return harness;
}

function payload(result: CallToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? '{}');
}

async function suspend(
	processor: ThoughtProcessor,
	sessionId: SessionId,
	owner?: string
): Promise<SuspensionToken> {
	const invoke = () =>
		processor.process({
			thought: `${sessionId} invokes search`,
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: sessionId,
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
	const result =
		owner === undefined
			? await invoke()
			: await runWithContext({ requestId: `${owner}-call`, owner }, invoke);
	const token = payload(result)['continuation_token'];
	if (typeof token !== 'string')
		throw new TypeError('tool call did not return a continuation token');
	return asSuspensionToken(token);
}

function observe(
	processor: ThoughtProcessor,
	sessionId: SessionId,
	token: SuspensionToken,
	thought: string,
	owner?: string
): Promise<CallToolResult> {
	const invoke = () =>
		processor.process({
			thought,
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: sessionId,
			thought_type: 'tool_observation',
			continuation_token: token,
		});
	return owner === undefined
		? invoke()
		: runWithContext({ requestId: `${owner}-observation`, owner }, invoke);
}

afterEach(async () => {
	for (const harness of liveHarnesses) {
		harness.store.stop();
		await harness.history.shutdown();
	}
	liveHarnesses.clear();
});

describe('continuation session and owner admission', () => {
	it('rejects a token under another canonical session without mutation and preserves rightful retry', async () => {
		const { history, processor, store } = createHarness();
		const token = await suspend(processor, SESSION_A, 'alice');

		const attack = await observe(processor, SESSION_B, token, 'cross-session attack', 'alice');

		expect(payload(attack)).toMatchObject({
			code: ERROR_CODES.SUSPENSION_NOT_FOUND,
			status: 'failed',
		});
		expect(history.inspectSession(SESSION_B).history).toEqual([]);
		expect(store.peek(token)?.sessionId).toBe(SESSION_A);

		const rightful = await observe(processor, SESSION_A, token, 'rightful result', 'alice');
		expect(rightful.isError).toBeUndefined();
		const historyA = history.inspectSession(SESSION_A).history;
		expect(historyA).toHaveLength(2);
		expect('_resumedFrom' in (historyA[1] ?? {})).toBe(false);
		expect(store.size()).toBe(0);
	});

	it('rejects a wrong owner before token mutation and preserves rightful retry', async () => {
		const { history, processor, store } = createHarness();
		const token = await suspend(processor, SESSION_A, 'alice');

		const attack = await observe(processor, SESSION_A, token, 'wrong owner result', 'bob');

		expect(payload(attack)).toMatchObject({
			code: ERROR_CODES.SESSION_ACCESS_DENIED,
			status: 'failed',
		});
		expect(history.inspectSession(SESSION_A).history).toHaveLength(1);
		expect(store.peek(token)?.sessionId).toBe(SESSION_A);

		const rightful = await observe(processor, SESSION_A, token, 'rightful result', 'alice');
		expect(rightful.isError).toBeUndefined();
		expect(history.inspectSession(SESSION_A).history).toHaveLength(2);
		expect(store.size()).toBe(0);
	});
});

describe('continuation and reset ordering', () => {
	it('lets reset clear A before a queued A observation while B remains unchanged', async () => {
		const { history, lifecycle, processor, store } = createHarness();
		const token = await suspend(processor, SESSION_A);
		await processor.process({
			thought: 'B remains',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_B,
		});

		const reset = processor.resetSession(SESSION_A);
		expect(lifecycle.phaseFor(SESSION_A)).toBe('resetting');
		const observation = observe(processor, SESSION_A, token, 'queued after reset');
		await reset;
		const rejected = await observation;

		expect(payload(rejected)).toMatchObject({ code: ERROR_CODES.SESSION_LIFECYCLE_CLOSED });
		expect(history.inspectSession(SESSION_A).history).toEqual([]);
		expect(history.inspectSession(SESSION_B).history.map((thought) => thought.thought)).toEqual([
			'B remains',
		]);
		expect(store.size(SESSION_A)).toBe(0);
	});

	it('may admit an A observation first, then reset removes its history and token without touching B', async () => {
		const { history, lock, processor, store } = createHarness();
		const token = await suspend(processor, SESSION_A);
		await processor.process({
			thought: 'B remains',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_B,
		});

		const observation = observe(processor, SESSION_A, token, 'admitted before reset');
		expect(lock.isActive(SESSION_A)).toBe(true);
		const reset = processor.resetSession(SESSION_A);
		const admitted = await observation;
		await reset;

		expect(admitted.isError).toBeUndefined();
		expect(history.inspectSession(SESSION_A).history).toEqual([]);
		expect(history.inspectSession(SESSION_B).history.map((thought) => thought.thought)).toEqual([
			'B remains',
		]);
		expect(store.size(SESSION_A)).toBe(0);
	});
});
