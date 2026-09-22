import { afterEach, describe, expect, it } from 'vitest';
import { safeParse } from 'valibot';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import { normalizeInput } from '../../core/InputNormalizer.js';
import type { ThoughtData } from '../../core/thought.js';
import { createServer } from '../../lib.js';
import { SequentialThinkingSchema } from '../../schema.js';
import { ServerConfig } from '../../ServerConfig.js';

type Server = Awaited<ReturnType<typeof createServer>>;

const servers = new Set<Server>();

function baseInput(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		thought: 'Test thought',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		session_id: 'thought-id-test',
		...overrides,
	};
}

async function server(): Promise<Server> {
	const value = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			persistenceFlushInterval: 60_000,
		}),
	});
	servers.add(value);
	return value;
}

afterEach(async () => {
	for (const value of servers) await value.stop();
	servers.clear();
});

describe('thought identity admission', () => {
	it('admits distinct ids within a session and permits cross-session reuse', async () => {
		const subject = await server();
		const sessionA = asSessionId('identity-a');
		const sessionB = asSessionId('identity-b');

		const results = await Promise.all([
			subject.processThought({
				id: 'shared-id',
				thought: 'first in A',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: sessionA,
			}),
			subject.processThought({
				id: 'distinct-id',
				thought: 'second in A',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: sessionA,
			}),
			subject.processThought({
				id: 'shared-id',
				thought: 'first in B',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: sessionB,
			}),
		]);

		expect(results.every((result) => result.isError !== true)).toBe(true);
		expect(subject.history.getHistory(sessionA).map((thought) => thought.id)).toEqual([
			'shared-id',
			'distinct-id',
		]);
		expect(subject.history.getHistory(sessionB).map((thought) => thought.id)).toEqual([
			'shared-id',
		]);
	});

	it('rejects duplicate id before mutation', async () => {
		const subject = await server();
		const sessionId = asSessionId('atomic-duplicate');
		await subject.processThought({
			id: 'target-id',
			thought: 'target',
			thought_number: 1,
			total_thoughts: 3,
			next_thought_needed: true,
			session_id: sessionId,
			confidence: 0.8,
		});
		await subject.processThought({
			id: 'duplicate-id',
			thought: 'original owner',
			thought_number: 2,
			total_thoughts: 3,
			next_thought_needed: true,
			session_id: sessionId,
		});
		const container = subject.getContainer();
		const metrics = container.resolve('Metrics');
		const edgeStore = container.resolve('EdgeStore');
		const outcomeRecorder = container.resolve('outcomeRecorder');
		const before = {
			session: subject.history.inspectSession(sessionId),
			metric: metrics.get('thought_requests_total', {}),
			outcomes: outcomeRecorder.getOutcomes(sessionId),
			edges: edgeStore.edgesForSession(sessionId),
			queueLength: subject.history.getWriteBufferLength(),
		};

		const duplicate = await subject.processThought({
			id: 'duplicate-id',
			thought: 'must not mutate',
			thought_number: 3,
			total_thoughts: 3,
			next_thought_needed: false,
			session_id: sessionId,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 1,
			register_branch_id: 'must-not-exist',
		});

		expect(duplicate.isError).toBe(true);
		expect(JSON.parse(duplicate.content[0]?.text ?? '{}')).toMatchObject({
			code: 'VALIDATION_ERROR',
		});
		expect(subject.history.inspectSession(sessionId)).toEqual(before.session);
		expect(metrics.get('thought_requests_total', {})).toBe(before.metric);
		expect(outcomeRecorder.getOutcomes(sessionId)).toEqual(before.outcomes);
		expect(edgeStore.edgesForSession(sessionId)).toEqual(before.edges);
		expect(subject.history.getWriteBufferLength()).toBe(before.queueLength);
	});

	it('duplicate observation preserves suspension', async () => {
		const subject = await server();
		const sessionId = asSessionId('duplicate-observation');
		subject.tools.add({ name: 'search', description: 'search', inputSchema: {} });
		const call = await subject.processThought({
			id: 'tool-call-id',
			thought: 'call tool',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: sessionId,
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const callPayload = JSON.parse(call.content[0]?.text ?? '{}');
		const token = callPayload.continuation_token;
		const suspensionStore = subject.getContainer().resolve('suspensionStore');
		const before = {
			history: subject.history.inspectSession(sessionId),
			queueLength: subject.history.getWriteBufferLength(),
			suspension: suspensionStore.peek(token),
		};

		const duplicate = await subject.processThought({
			id: 'tool-call-id',
			thought: 'duplicate observation',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: sessionId,
			thought_type: 'tool_observation',
			continuation_token: token,
		});

		expect(duplicate.isError).toBe(true);
		expect(JSON.parse(duplicate.content[0]?.text ?? '{}')).toMatchObject({
			code: 'VALIDATION_ERROR',
		});
		expect(subject.history.inspectSession(sessionId)).toEqual(before.history);
		expect(subject.history.getWriteBufferLength()).toBe(before.queueLength);
		expect(suspensionStore.peek(token)).toEqual(before.suspension);
	});

	it('admits at most one concurrent caller with the same session identity', async () => {
		const subject = await server();
		for (let iteration = 0; iteration < 50; iteration += 1) {
			const sessionId = asSessionId(`concurrent-identity-${iteration}`);
			const candidate = (thought: string) =>
				subject.processThought({
					id: 'concurrent-id',
					thought,
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: sessionId,
				});

			const results = await Promise.all([candidate('first'), candidate('second')]);

			expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
			expect(results.filter((result) => result.isError === true)).toHaveLength(1);
			expect(subject.history.getHistory(sessionId)).toHaveLength(1);
		}
	});

	it('permits identity reuse after a session reset', async () => {
		const subject = await server();
		const sessionId = asSessionId('reset-identity');
		const input = {
			id: 'reusable-id',
			thought: 'before reset',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: sessionId,
		};
		await subject.processThought(input);
		await subject.history._flushBuffer();

		await subject.resetSession(sessionId);
		const replacement = await subject.processThought({ ...input, thought: 'after reset' });
		await subject.history._flushBuffer();

		expect(replacement.isError).toBeUndefined();
		expect(subject.history.getHistory(sessionId).map((thought) => thought.thought)).toEqual([
			'after reset',
		]);
	});

	it('T2-DURABLE-REUSE rejects a retained file identity after close and reopen', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-durable-reuse-'));
		const config = () =>
			new ServerConfig({
				maxHistorySize: 1,
				persistence: {
					enabled: true,
					backend: 'file',
					options: { dataDir, maxHistorySize: 2 },
				},
				persistenceFlushInterval: 60_000,
			});
		try {
			const initial = await createServer({
				autoDiscover: false,
				loadFromPersistence: false,
				config: config(),
			});
			await initial.processThought({
				id: 'durable-reuse',
				thought: 'durable owner',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: 'durable-file',
			});
			await initial.processThought({
				id: 'newer',
				thought: 'newer live thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: 'durable-file',
			});
			await initial.stop();

			const reopened = await createServer({
				autoDiscover: false,
				loadFromPersistence: true,
				config: config(),
			});
			servers.add(reopened);

			const duplicate = await reopened.processThought({
				id: 'durable-reuse',
				thought: 'must be rejected',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
				session_id: 'durable-file',
			});

			expect(duplicate.isError).toBe(true);
			expect(JSON.parse(duplicate.content[0]?.text ?? '{}')).toMatchObject({
				code: 'VALIDATION_ERROR',
			});
			expect(reopened.history.getHistory('durable-file').map((thought) => thought.id)).toEqual([
				'newer',
			]);
		} finally {
			for (const value of servers) await value.stop();
			servers.clear();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('does not confuse generated identity from an identical duplicate replay', async () => {
		const subject = await server();
		const sessionId = asSessionId('identity-errors');
		const input = {
			id: 'replay-id',
			thought: 'original',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: sessionId,
		};
		await subject.processThought(input);

		const generated = await subject.processThought({ ...input, id: '' });
		const replay = await subject.processThought(input);
		const replayPayload = JSON.parse(replay.content[0]?.text ?? '{}');

		expect(generated.isError).toBeUndefined();
		expect(replayPayload.code).toBe('VALIDATION_ERROR');
		expect(subject.history.getHistory(sessionId).map((thought) => thought.id)).toEqual([
			'replay-id',
			expect.stringMatching(/.+/),
		]);
	});
});

describe('ThoughtData.id', () => {
	it('accepts an optional id field on ThoughtData', () => {
		const thought: ThoughtData = {
			thought: 'Test',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('thought-id-test'),
			id: asThoughtId('01h2k3m400a1b2c3d4e5f6a7b8'),
		};
		expect(thought.id).toBe('01h2k3m400a1b2c3d4e5f6a7b8');
	});

	it('allows ThoughtData without an id field', () => {
		const thought: ThoughtData = {
			thought: 'Test',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('thought-id-test'),
		};
		expect(thought.id).toBeUndefined();
	});

	it('auto-generates id when not provided', () => {
		const normalized = normalizeInput(baseInput()) as ThoughtData;
		expect(normalized.id).toBeDefined();
		expect(typeof normalized.id).toBe('string');
		expect(normalized.id?.length).toBeGreaterThan(0);
	});

	it('preserves a provided id', () => {
		const provided = '01h2k3m400a1b2c3d4e5f6a7b8';
		const normalized = normalizeInput(baseInput({ id: provided })) as ThoughtData;
		expect(normalized.id).toBe(provided);
	});

	it('generates unique ids across 1000 normalizations', () => {
		const ids = new Set<string>();
		for (let index = 0; index < 1000; index += 1) {
			const normalized = normalizeInput(baseInput()) as ThoughtData;
			if (normalized.id !== undefined) ids.add(normalized.id);
		}
		expect(ids.size).toBe(1000);
	});

	it.each([{ id: '' }, { id: 123 }])('regenerates invalid normalizer input $id', (invalid) => {
		const normalized = normalizeInput(baseInput(invalid)) as ThoughtData;
		expect(typeof normalized.id).toBe('string');
		expect(normalized.id?.length).toBeGreaterThan(0);
	});

	it('accepts a valid id string in the public schema', () => {
		const result = safeParse(
			SequentialThinkingSchema,
			baseInput({ id: '01h2k3m400a1b2c3d4e5f6a7b8' })
		);
		expect(result.success).toBe(true);
	});

	it('accepts public schema input without an id', () => {
		expect(safeParse(SequentialThinkingSchema, baseInput()).success).toBe(true);
	});

	it.each(['', 'a'.repeat(31)])('rejects invalid public schema id %j', (id) => {
		expect(safeParse(SequentialThinkingSchema, baseInput({ id })).success).toBe(false);
	});

	it('normalizes an id without changing non-id fields', () => {
		const normalized = normalizeInput(
			baseInput({
				thought: 'Original thought',
				thought_number: 5,
				total_thoughts: 10,
				next_thought_needed: true,
			})
		) as ThoughtData;
		expect(normalized.thought).toBe('Original thought');
		expect(normalized.thought_number).toBe(5);
		expect(normalized.total_thoughts).toBe(10);
		expect(normalized.next_thought_needed).toBe(true);
		expect(normalized.id).toBeDefined();
	});
});
