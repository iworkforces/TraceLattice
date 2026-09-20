import { describe, expect, it } from 'vitest';

import { asBranchId, asSessionId, asThoughtId, type SuspensionToken } from '../../contracts/ids.js';
import type { FeatureFlags } from '../../contracts/features.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import type { EdgeKind } from '../../core/graph/Edge.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import type { ThoughtData } from '../../core/thought.js';
import { createMockToolRegistry, createTestThought } from '../helpers/factories.js';

const FEATURES: FeatureFlags = {
	dagEdges: true,
	reasoningStrategy: 'sequential',
	calibration: false,
	compression: false,
	toolInterleave: true,
	newThoughtTypes: true,
	outcomeRecording: false,
};

const SESSION_ID = asSessionId('test-session');

type SameNumberRelationCase = {
	readonly name: string;
	readonly expectedKind: EdgeKind;
	readonly fields: Partial<ThoughtData>;
	readonly currentToTarget: boolean;
};

const SAME_NUMBER_RELATIONS: readonly SameNumberRelationCase[] = [
	{
		name: 'verification',
		expectedKind: 'verifies',
		fields: { thought_type: 'verification', verification_target: 7 },
		currentToTarget: true,
	},
	{
		name: 'critique',
		expectedKind: 'critiques',
		fields: { thought_type: 'critique', verification_target: 7 },
		currentToTarget: true,
	},
	{
		name: 'revision',
		expectedKind: 'revises',
		fields: { revises_thought: 7 },
		currentToTarget: true,
	},
	{
		name: 'branch',
		expectedKind: 'branch',
		fields: { branch_from_thought: 7, branch_id: asBranchId('same-number-branch') },
		currentToTarget: false,
	},
	{
		name: 'merge',
		expectedKind: 'merge',
		fields: { merge_from_thoughts: [7, 7] },
		currentToTarget: false,
	},
	{
		name: 'synthesis',
		expectedKind: 'derives_from',
		fields: { thought_type: 'synthesis', synthesis_sources: [7, 7] },
		currentToTarget: false,
	},
];

function resolve(manager: HistoryManager, sessionId: string, thoughtNumber: number) {
	const referenceManager = manager as unknown as {
		resolveThoughtReference: (
			sessionId: ReturnType<typeof asSessionId>,
			thoughtNumber: number
		) => {
			kind: 'missing' | 'unique' | 'ambiguous';
			thoughtId?: ReturnType<typeof asThoughtId>;
			thoughtIds?: readonly ReturnType<typeof asThoughtId>[];
		};
	};
	return referenceManager.resolveThoughtReference(asSessionId(sessionId), thoughtNumber);
}

function makeProcessor(manager: HistoryManager, store?: InMemorySuspensionStore): ThoughtProcessor {
	return new ThoughtProcessor(
		manager,
		new ThoughtFormatter(),
		new ThoughtEvaluator(new Calibrator(new OutcomeRecorder({ enabled: false }), false)),
		undefined,
		new SequentialStrategy(),
		undefined,
		store,
		createMockToolRegistry(['search']),
		FEATURES
	);
}

function payload(
	result: Awaited<ReturnType<ThoughtProcessor['process']>>
): Record<string, unknown> {
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('retained thought reference resolution', () => {
	it('resolves a branch-only non-contiguous thought after main-history trim', () => {
		const manager = new HistoryManager({ maxHistorySize: 1, maxBranchSize: 5 });
		manager.addThought(
			createTestThought({
				id: 'branch-only',
				thought_number: 7,
				branch_from_thought: 7,
				branch_id: asBranchId('kept'),
			})
		);
		manager.addThought(createTestThought({ id: 'latest', thought_number: 20 }));

		expect(resolve(manager, SESSION_ID, 7)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('branch-only'),
		});
	});

	it('deduplicates main and branch copies with the same stable id', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({
				id: 'copied',
				thought_number: 4,
				branch_from_thought: 4,
				branch_id: asBranchId('copy'),
			})
		);

		expect(resolve(manager, SESSION_ID, 4)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('copied'),
		});
	});

	it('returns sorted frozen stable ids when distinct retained thoughts reuse a number', () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'z-id', thought_number: 3 }));
		manager.addThought(createTestThought({ id: 'a-id', thought_number: 3, retracted: true }));

		const resolution = resolve(manager, SESSION_ID, 3);
		expect(resolution).toEqual({
			kind: 'ambiguous',
			thoughtIds: [asThoughtId('a-id'), asThoughtId('z-id')],
		});
		if (resolution.kind === 'ambiguous') expect(Object.isFrozen(resolution.thoughtIds)).toBe(true);
	});

	it('isolates equal thought numbers by session and resets only the requested session', async () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'a', thought_number: 2, session_id: 'A' }));
		manager.addThought(createTestThought({ id: 'b', thought_number: 2, session_id: 'B' }));
		await manager.resetSession('A');

		expect(resolve(manager, 'A', 2)).toEqual({ kind: 'missing' });
		expect(resolve(manager, 'B', 2)).toEqual({ kind: 'unique', thoughtId: asThoughtId('b') });
	});
});

describe('retained-reference policy', () => {
	it('keeps a unique non-contiguous optional scalar reference', async () => {
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({ edgeStore });
		manager.addThought(createTestThought({ id: 'target-10', thought_number: 10 }));
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'verify retained ten',
			thought_number: 11,
			total_thoughts: 11,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: 10,
		});

		expect(result.isError).toBeUndefined();
		expect(payload(result).warnings).toBeUndefined();
		expect(manager.getHistory(SESSION_ID).at(-1)?.verification_target).toBe(10);
		expect(edgeStore.edgesForSession(SESSION_ID).at(-1)?.to).toBe('target-10');
	});

	it('drops a missing optional scalar with the existing dangling prefix', async () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'ten', thought_number: 10 }));
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'missing one',
			thought_number: 11,
			total_thoughts: 11,
			next_thought_needed: false,
			verification_target: 1,
		});

		expect(payload(result).warnings).toEqual([
			'Dropped dangling verification_target: 1 (history has 1 thoughts)',
		]);
		expect(manager.getHistory(SESSION_ID).at(-1)?.verification_target).toBeUndefined();
	});

	it('drops an ambiguous optional scalar without emitting a relational edge', async () => {
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({ edgeStore });
		manager.addThought(createTestThought({ id: 'first', thought_number: 1 }));
		manager.addThought(createTestThought({ id: 'second', thought_number: 1 }));
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'ambiguous verification',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: 1,
		});

		expect(payload(result).warnings).toEqual([
			'Dropped ambiguous verification_target: 1 (history has 2 thoughts)',
		]);
		expect(
			edgeStore.edgesForSession(SESSION_ID).filter((edge) => edge.kind === 'verifies')
		).toHaveLength(0);
	});

	it('filters missing and ambiguous array entries while retaining order and duplicates', async () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'one-a', thought_number: 1 }));
		manager.addThought(createTestThought({ id: 'one-b', thought_number: 1 }));
		manager.addThought(createTestThought({ id: 'seven', thought_number: 7 }));
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'mixed references',
			thought_number: 8,
			total_thoughts: 8,
			next_thought_needed: false,
			synthesis_sources: [7, 1, 5, 7],
		});

		expect(manager.getHistory(SESSION_ID).at(-1)?.synthesis_sources).toEqual([7, 7]);
		expect(payload(result).warnings).toEqual([
			'Filtered dangling synthesis_sources: [5] (history has 3 thoughts)',
			'Filtered ambiguous synthesis_sources: [1] (history has 3 thoughts)',
		]);
	});

	it('applies optional warning policy during reset before replacement', async () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'old', thought_number: 1, session_id: 'reset-me' }));
		const result = await makeProcessor(manager).process({
			thought: 'replacement',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('reset-me'),
			reset_state: true,
			verification_target: 1,
		});

		expect(result.isError).toBeUndefined();
		expect(payload(result).warnings).toEqual([
			'Dropped dangling verification_target: 1 (history has 0 thoughts)',
		]);
		expect(resolve(manager, 'reset-me', 1)).toEqual({ kind: 'missing' });
		expect(resolve(manager, 'reset-me', 2).kind).toBe('unique');
	});

	it.each([
		{ name: 'missing target field', target: undefined },
		{ name: 'missing target thought', target: 99 },
	])('rejects a result-bearing verification with a $name before admission', async ({ target }) => {
		const manager = new HistoryManager();
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'strict verification',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: target,
			verification_result: 1,
		});

		expect(result.isError).toBe(true);
		expect(payload(result)).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(manager.getHistory(SESSION_ID)).toHaveLength(0);
	});

	it('rejects an ambiguous result target before admission', async () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'first', thought_number: 1, confidence: 0.7 }));
		manager.addThought(createTestThought({ id: 'second', thought_number: 1, confidence: 0.8 }));

		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'ambiguous strict verification',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 0,
		});

		expect(payload(result)).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(manager.getHistory(SESSION_ID)).toHaveLength(2);
	});

	it.each([
		{
			name: 'retracted',
			target: createTestThought({ id: 'target', retracted: true, confidence: 0.8 }),
		},
		{ name: 'confidence-less', target: createTestThought({ id: 'target' }) },
	])('rejects a $name result target before admission', async ({ target }) => {
		const manager = new HistoryManager();
		manager.addThought(target);

		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'invalid target state',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 1,
		});

		expect(payload(result)).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(manager.getHistory(SESSION_ID)).toHaveLength(1);
	});

	it('does not resolve a result target from another session', async () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({ id: 'other-target', session_id: 'other', confidence: 0.8 })
		);

		const result = await makeProcessor(manager).process({
			thought: 'cross-session verification',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('current'),
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 1,
		});

		expect(payload(result)).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(manager.getHistory(asSessionId('current'))).toHaveLength(0);
	});

	it('accepts one stable target copied between main history and a branch', async () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({
				id: 'copied-target',
				thought_number: 1,
				confidence: 0.8,
				branch_from_thought: 1,
				branch_id: asBranchId('copy'),
			})
		);

		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'stable identity verification',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 1,
		});

		expect(result.isError).toBeUndefined();
		expect(manager.getHistory(SESSION_ID)).toHaveLength(2);
	});

	it('validates reset result targets against the empty replacement scope before reset', async () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({ id: 'retained', session_id: 'reset-result', confidence: 0.8 })
		);

		const result = await makeProcessor(manager).process({
			thought: 'invalid reset verification',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: asSessionId('reset-result'),
			reset_state: true,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 1,
		});

		expect(payload(result)).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(manager.getHistory(asSessionId('reset-result'))).toEqual([
			expect.objectContaining({ id: asThoughtId('retained') }),
		]);
	});

	it('rejects ambiguous backtrack before mutating history or targets', async () => {
		const manager = new HistoryManager();
		manager.addThought(createTestThought({ id: 'one-a', thought_number: 1 }));
		manager.addThought(createTestThought({ id: 'one-b', thought_number: 1 }));
		const before = manager
			.getHistory(SESSION_ID)
			.map((thought) => ({ id: thought.id, retracted: thought.retracted }));
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'ambiguous backtrack',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			thought_type: 'backtrack',
			backtrack_target: 1,
		});

		expect(payload(result).code).toBe('INVALID_BACKTRACK');
		expect(
			manager
				.getHistory(SESSION_ID)
				.map((thought) => ({ id: thought.id, retracted: thought.retracted }))
		).toEqual(before);
	});
});

describe('stable edge endpoints', () => {
	it.each(SAME_NUMBER_RELATIONS)(
		'keeps the pre-admission target for same-number $name edges',
		async ({ name, expectedKind, fields, currentToTarget }) => {
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore });
			const sessionId = asSessionId(`same-number-${name}`);
			manager.addThought(
				createTestThought({ id: `${name}-old`, thought_number: 7, session_id: sessionId })
			);
			const oldId = manager.getHistory(sessionId)[0]!.id;

			const result = await makeProcessor(manager).process({
				thought: `same-number ${name}`,
				thought_number: 7,
				total_thoughts: 7,
				next_thought_needed: false,
				session_id: sessionId,
				...fields,
			});

			const currentId = manager.getHistory(sessionId).at(-1)!.id;
			const edges = edgeStore.edgesForSession(sessionId);
			const relationEdges = edges.filter((edge) => edge.kind === expectedKind);
			expect(payload(result).warnings).toBeUndefined();
			expect(relationEdges).toEqual([
				expect.objectContaining(
					currentToTarget ? { from: currentId, to: oldId } : { from: oldId, to: currentId }
				),
			]);
			expect(edges.filter((edge) => edge.kind === 'sequence')).toHaveLength(0);
		}
	);

	it('uses the pre-admission target for a same-number backtrack', async () => {
		const manager = new HistoryManager();
		const sessionId = asSessionId('same-number-backtrack');
		manager.addThought(
			createTestThought({ id: 'backtrack-old', thought_number: 7, session_id: sessionId })
		);

		const result = await makeProcessor(manager).process({
			thought: 'same-number backtrack',
			thought_number: 7,
			total_thoughts: 7,
			next_thought_needed: false,
			session_id: sessionId,
			thought_type: 'backtrack',
			backtrack_target: 7,
		});

		expect(result.isError).toBeUndefined();
		expect(manager.getHistory(sessionId)[0]).toEqual(
			expect.objectContaining({ id: asThoughtId('backtrack-old'), retracted: true })
		);
		expect(manager.getHistory(sessionId)[1]?.retracted).not.toBe(true);
	});

	it('drops an optional current self-reference without emitting a relation', async () => {
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({ edgeStore });
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'optional current self-reference',
			thought_number: 7,
			total_thoughts: 7,
			next_thought_needed: false,
			thought_type: 'verification',
			verification_target: 7,
		});

		expect(payload(result).warnings).toEqual([
			'Dropped dangling verification_target: 7 (history has 0 thoughts)',
		]);
		expect(manager.getHistory(SESSION_ID)[0]?.verification_target).toBeUndefined();
		expect(edgeStore.edgesForSession(SESSION_ID)).toHaveLength(0);
	});

	it('rejects a required current self-reference without admitting it', async () => {
		const manager = new HistoryManager();
		const result = await makeProcessor(manager).process({
			session_id: SESSION_ID,
			thought: 'required current self-reference',
			thought_number: 7,
			total_thoughts: 7,
			next_thought_needed: false,
			thought_type: 'backtrack',
			backtrack_target: 7,
		});

		expect(payload(result).code).toBe('INVALID_BACKTRACK');
		expect(manager.getHistory(SESSION_ID)).toHaveLength(0);
	});

	it('deduplicates identical merge edges produced by duplicate numeric array values', () => {
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({ edgeStore });
		manager.addThought(createTestThought({ id: 'source', thought_number: 4 }));
		manager.addThought(
			createTestThought({ id: 'merge', thought_number: 5, merge_from_thoughts: [4, 4, 4] })
		);

		expect(edgeStore.edgesForSession(SESSION_ID).filter((edge) => edge.kind === 'merge')).toEqual([
			expect.objectContaining({ from: asThoughtId('source'), to: asThoughtId('merge') }),
		]);
	});

	it('prunes a resumed observation edge when the original tool call is no longer retained', async () => {
		const edgeStore = new EdgeStore();
		const store = new InMemorySuspensionStore();
		const manager = new HistoryManager({ edgeStore, maxHistorySize: 1 });
		const processor = makeProcessor(manager, store);
		const call = await processor.process({
			session_id: SESSION_ID,
			thought: 'call search',
			thought_number: 9,
			total_thoughts: 10,
			next_thought_needed: true,
			thought_type: 'tool_call',
			tool_name: 'search',
			tool_arguments: {},
		});
		const suspended = store.peek(payload(call).continuation_token as string) as
			({ readonly toolCallThoughtId?: ReturnType<typeof asThoughtId> } & object) | null;
		const originalId = suspended?.toolCallThoughtId;
		manager.addThought(createTestThought({ id: 'reused-nine', thought_number: 9 }));

		const observation = await processor.process({
			session_id: SESSION_ID,
			thought: 'search returned',
			thought_number: 10,
			total_thoughts: 10,
			next_thought_needed: false,
			thought_type: 'tool_observation',
			continuation_token: payload(call).continuation_token as SuspensionToken,
		});

		expect(observation.isError).toBeUndefined();
		expect(originalId).toBeDefined();
		expect(
			edgeStore.edgesForSession(SESSION_ID).filter((edge) => edge.kind === 'tool_invocation')
		).toEqual([]);
	});
});
