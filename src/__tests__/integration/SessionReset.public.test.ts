import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asThoughtId,
	type SessionId,
} from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { SessionLock } from '../../core/SessionLock.js';
import { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import type { Summary } from '../../core/compression/Summary.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import type { Edge } from '../../core/graph/Edge.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { ERROR_CODES } from '../../errors.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';

function testEdge(sessionId: SessionId): Edge {
	return {
		id: asEdgeId('edge-orphan'),
		from: asThoughtId('from-orphan'),
		to: asThoughtId('to-orphan'),
		kind: 'sequence',
		sessionId,
		createdAt: 1,
	};
}

function testSummary(sessionId: SessionId): Summary {
	return {
		id: 'summary-orphan',
		sessionId,
		rootThoughtId: asThoughtId('root-orphan'),
		coveredIds: [asThoughtId('covered-orphan')],
		coveredRange: [1, 1],
		topics: ['reset'],
		aggregateConfidence: 0.8,
		createdAt: 1,
	};
}

describe('public reset surface', () => {
	it('rejects malformed explicit identity before mutation and preserves caller input', async () => {
		const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
		try {
			await server.processThought({
				thought: 'primary keep',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'primary',
			});
			await server.processThought({
				thought: 'A keep',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'A',
			});
			const input = {
				thought: 'must fail',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: '',
				reset_state: true,
				register_branch_id: 'must-not-register',
				tool_arguments: { nested: { values: ['unchanged'] } },
			};
			const before = structuredClone(input);

			const result = await server.processThought(input);

			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
				code: ERROR_CODES.VALIDATION_ERROR,
				status: 'failed',
			});
			expect(input).toEqual(before);
			expect(server.history.getHistory('primary').map((thought) => thought.thought)).toEqual([
				'primary keep',
			]);
			expect(server.history.getHistory('A').map((thought) => thought.thought)).toEqual(['A keep']);
			expect(server.history.branchExists('A', asBranchId('must-not-register'))).toBe(false);
		} finally {
			await server.stop();
		}
	});

	it('keeps one named-session reset distinct from resetAll', async () => {
		const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
		try {
			await server.processThought({
				thought: 'primary old',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'primary',
			});
			await server.processThought({
				thought: 'named keep',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'named',
			});
			await server.processThought({
				thought: 'primary fresh',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'primary',
				reset_state: true,
			});
			expect(server.history.getHistory('primary').map((thought) => thought.thought)).toEqual([
				'primary fresh',
			]);
			expect(server.history.getHistory('named').map((thought) => thought.thought)).toEqual([
				'named keep',
			]);

			await server.resetAll();
			expect(server.history.getHistory('primary')).toEqual([]);
			expect(server.history.getHistory('named')).toEqual([]);
		} finally {
			await server.stop();
		}
	});

	it('resetAll clears auxiliary namespaces that are not materialized in history', async () => {
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const suspensionStore = new InMemorySuspensionStore();
		const outcomeRecorder = new OutcomeRecorder({ enabled: true });
		const calibrator = new Calibrator(outcomeRecorder, true);
		const history = new HistoryManager({ edgeStore, summaryStore });
		const processor = new ThoughtProcessor(
			history,
			new ThoughtFormatter(),
			new ThoughtEvaluator(calibrator),
			undefined,
			undefined,
			undefined,
			suspensionStore,
			undefined,
			undefined,
			new SessionLock(),
			outcomeRecorder,
			undefined,
			calibrator
		);
		const orphanEdgeSession = asSessionId('edge-only-session');
		const orphanAuxiliarySession = asSessionId('evicted-session');
		edgeStore.addEdge(testEdge(orphanEdgeSession));
		summaryStore.add(testSummary(orphanEdgeSession));
		suspensionStore.suspend({
			sessionId: orphanAuxiliarySession,
			toolCallThoughtNumber: 1,
			toolCallThoughtId: asThoughtId('public-reset-call'),
			toolName: 'tool',
			toolArguments: {},
			expiresAt: 0,
		});
		outcomeRecorder.recordVerification({
			thoughtId: asThoughtId('orphan'),
			sessionId: orphanAuxiliarySession,
			predicted: 0.8,
			actual: 1,
			type: 'verification',
		});
		expect(history.getSessionIds()).toEqual([]);

		await processor.resetAll();

		expect(edgeStore.size()).toBe(0);
		expect(summaryStore.size()).toBe(0);
		expect(suspensionStore.size()).toBe(0);
		expect(outcomeRecorder.getAllOutcomes()).toEqual([]);
		await history.shutdown();
	});
});

describe.each(['memory', 'file'] as const)(
	'public quarantine registration with %s persistence',
	(backend) => {
		it('rejects branch registration without mutating live state until explicit reset recovers', async () => {
			const dataDir =
				backend === 'file'
					? await mkdtemp(join(tmpdir(), 'tracelattice-task9-registration-'))
					: undefined;
			const config = new ServerConfig({
				persistence: {
					enabled: true,
					backend,
					options: { dataDir, persistBranches: true },
				},
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60_000,
				persistenceMaxRetries: 0,
			});
			const server = await createServer({
				autoDiscover: false,
				loadFromPersistence: false,
				config,
			});
			const persistence = server.getContainer().resolve('Persistence');
			if (persistence === null) throw new Error(`${backend} persistence is unavailable`);
			const sessionId = asSessionId('quarantined-registration');
			const originalClearSession = persistence.clearSession.bind(persistence);
			let failDeletion = true;
			persistence.clearSession = async (candidateSessionId) => {
				if (failDeletion && candidateSessionId === sessionId) {
					throw new Error(`controlled ${backend} deletion failure`);
				}
				await originalClearSession(candidateSessionId);
			};

			try {
				await server.processThought({
					thought: 'durable seed',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: sessionId,
				});
				await server.history._flushBuffer();
				const failedReset = await server.processThought({
					thought: 'must not enter',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					session_id: sessionId,
					reset_state: true,
				});
				expect(failedReset.isError).toBe(true);
				const afterFailure = server.history.inspectSession(sessionId);
				const input = {
					thought: 'blocked public registration',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					session_id: sessionId,
					register_branch_id: 'must-not-register',
				};
				const inputBefore = structuredClone(input);

				const rejected = await server.processThought(input);

				expect(rejected.isError).toBe(true);
				expect(JSON.parse(rejected.content[0]?.text ?? '{}')).toMatchObject({
					code: ERROR_CODES.SESSION_LIFECYCLE_CLOSED,
				});
				expect(server.history.inspectSession(sessionId)).toEqual(afterFailure);
				expect(afterFailure.branchIds).toEqual([]);
				expect(input).toEqual(inputBefore);

				failDeletion = false;
				const recovered = await server.processThought({
					...input,
					thought: 'recovered replacement',
					reset_state: true,
					register_branch_id: 'recovered',
				});
				expect(recovered.isError).toBeUndefined();
				expect(server.history.inspectSession(sessionId).branchIds).toEqual([
					asBranchId('recovered'),
				]);
			} finally {
				await server.stop();
				if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
			}
		});
	}
);
