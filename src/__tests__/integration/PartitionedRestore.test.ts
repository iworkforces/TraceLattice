import { afterEach, describe, expect, it } from 'vitest';
import type {
	PersistedBranchRecord,
	PersistedSessionRecord,
	PersistenceBackend,
	PersistenceRestoreRead,
} from '../../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asSummaryId,
	asThoughtId,
	type BranchId,
	type SessionId,
} from '../../contracts/ids.js';
import { runWithContext } from '../../context/RequestContext.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { SessionLock } from '../../core/SessionLock.js';
import { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import type { Summary } from '../../core/compression/Summary.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import type { Edge } from '../../core/graph/Edge.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import type { ThoughtData } from '../../core/thought.js';
import { SessionAccessDeniedError } from '../../core/SessionErrors.js';
import { PersistenceUnavailableError } from '../../errors.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { SqlitePersistence } from '../../persistence/SqlitePersistence.js';
import { createTestThought } from '../helpers/factories.js';
import { StatefulSqliteDatabase } from '../helpers/StatefulSqliteDatabase.js';

const managers = new Set<HistoryManager>();
const TEST_SESSION_ID = asSessionId('restore-session');

function thought(
	sessionId: SessionId,
	number: number,
	overrides: Partial<ThoughtData> = {}
): ThoughtData {
	return createTestThought({
		id: `${sessionId}-thought-${number}`,
		session_id: sessionId,
		thought_number: number,
		thought: `${sessionId}-${number}`,
		available_mcp_tools: undefined,
		available_skills: undefined,
		...overrides,
	});
}

function edge(sessionId: SessionId, id: string): Edge {
	return {
		id: asEdgeId(id),
		from: asThoughtId(`${id}-from`),
		to: asThoughtId(`${id}-to`),
		kind: 'sequence',
		sessionId,
		createdAt: 1,
	};
}

function summary(sessionId: SessionId, id: string, branchId?: BranchId): Summary {
	return {
		id: asSummaryId(id),
		sessionId,
		...(branchId === undefined ? {} : { branchId }),
		rootThoughtId: asThoughtId(`${id}-root`),
		coveredIds: [asThoughtId(`${id}-root`)],
		coveredRange: [1, 1],
		topics: ['restore'],
		aggregateConfidence: 0.8,
		createdAt: 1,
	};
}

function manager(
	persistence: PersistenceBackend,
	options: {
		readonly edgeStore?: EdgeStore;
		readonly summaryStore?: InMemorySummaryStore;
		readonly maxHistorySize?: number;
		readonly maxBranchSize?: number;
		readonly maxBranches?: number;
	} = {}
): HistoryManager {
	const value = new HistoryManager({
		persistence,
		persistenceFlushInterval: 60_000,
		...options,
	});
	managers.add(value);
	return value;
}

function sessionRecord(
	sessionId: SessionId,
	overrides: Partial<PersistedSessionRecord> = {}
): PersistedSessionRecord {
	return { sessionId, history: [], branches: [], edges: [], summaries: [], ...overrides };
}

function branchRecord(
	sessionId: SessionId,
	name: string,
	firstNumber: number
): PersistedBranchRecord {
	const branchId = asBranchId(name);
	return { branchId, thoughts: [thought(sessionId, firstNumber, { branch_id: branchId })] };
}

class RecordingPersistence extends MemoryPersistence {
	readonly calls: string[] = [];

	override async healthy(): Promise<boolean> {
		this.calls.push('healthy');
		return await super.healthy();
	}

	override async loadAllSessionsForRestore(): Promise<PersistenceRestoreRead> {
		this.calls.push('restore-read');
		return await super.loadAllSessionsForRestore();
	}

	override async listSessions(): Promise<SessionId[]> {
		this.calls.push('listSessions');
		return await super.listSessions();
	}

	override async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		this.calls.push(`history:${sessionId}`);
		return await super.loadHistoryForSession(sessionId);
	}

	override async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		this.calls.push(`branches:${sessionId}`);
		return await super.listBranchesForSession(sessionId);
	}

	override async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		this.calls.push(`branch:${sessionId}:${branchId}`);
		return await super.loadBranchForSession(sessionId, branchId);
	}

	override async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		this.calls.push(`edges:${sessionId}`);
		return await super.loadEdges(sessionId);
	}

	override async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		this.calls.push(`summaries:${sessionId}`);
		return await super.loadSummaries(sessionId);
	}

	override async saveThoughtForSession(sessionId: SessionId, value: ThoughtData): Promise<void> {
		this.calls.push(`save-thought:${sessionId}`);
		await super.saveThoughtForSession(sessionId, value);
	}

	override async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		values: readonly ThoughtData[]
	): Promise<void> {
		this.calls.push(`save-branch:${sessionId}:${branchId}`);
		await super.saveBranchForSession(sessionId, branchId, values);
	}

	override async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		this.calls.push(`delete-branch:${sessionId}:${branchId}`);
		await super.deleteBranchForSession(sessionId, branchId);
	}

	override async saveEdges(sessionId: SessionId, values: readonly Edge[]): Promise<void> {
		this.calls.push(`save-edges:${sessionId}`);
		await super.saveEdges(sessionId, values);
	}

	override async saveSummaries(sessionId: SessionId, values: readonly Summary[]): Promise<void> {
		this.calls.push(`save-summaries:${sessionId}`);
		await super.saveSummaries(sessionId, values);
	}

	override async clearAll(): Promise<void> {
		this.calls.push('clearAll');
		await super.clearAll();
	}

	override async clearSession(sessionId: SessionId): Promise<void> {
		this.calls.push(`clear:${sessionId}`);
		await super.clearSession(sessionId);
	}
}

class StubbedRestorePersistence extends MemoryPersistence {
	readonly read: () => Promise<PersistenceRestoreRead>;
	reads = 0;

	constructor(read: () => Promise<PersistenceRestoreRead>) {
		super();
		this.read = read;
	}

	override async loadAllSessionsForRestore(): Promise<PersistenceRestoreRead> {
		this.reads += 1;
		return await this.read();
	}
}

function stubbed(sessions: readonly PersistedSessionRecord[]): StubbedRestorePersistence {
	return new StubbedRestorePersistence(async () => ({ sessions }));
}

class UnhealthyPersistence extends RecordingPersistence {
	override async healthy(): Promise<boolean> {
		this.calls.push('healthy');
		return false;
	}
}

class FailedResetPersistence extends MemoryPersistence {
	override async clearSession(sessionId: SessionId): Promise<void> {
		throw new Error(`clear failed for ${sessionId}`);
	}

	override async clearAll(): Promise<void> {
		throw new Error('clear all failed');
	}
}

afterEach(async () => {
	for (const value of managers) await value.shutdown();
	managers.clear();
});

describe('Task 10 partitioned startup restore', () => {
	it('restores verification thoughts without replaying outcomes or duplicate indexes', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('verification-restore');
		await persistence.saveThoughtForSession(
			sessionId,
			thought(sessionId, 1, { confidence: 0.99, thought_type: 'hypothesis' })
		);
		await persistence.saveThoughtForSession(
			sessionId,
			thought(sessionId, 2, {
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 0,
			})
		);
		const history = manager(persistence);
		const recorder = new OutcomeRecorder({ enabled: true });
		const calibrator = new Calibrator(recorder, true);
		const processor = new ThoughtProcessor(
			history,
			new ThoughtFormatter(),
			new ThoughtEvaluator(calibrator),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new SessionLock(),
			recorder,
			undefined,
			calibrator
		);

		await history.loadFromPersistence();

		expect(history.getHistory(sessionId)).toHaveLength(2);
		expect(recorder.getOutcomes(sessionId)).toEqual([]);
		expect(calibrator.metrics(sessionId).sampleCount).toBe(0);
		expect(calibrator.calibrate(0.9, 'hypothesis', sessionId).temperature).toBe(1);

		const admitted = await processor.process({
			thought: 'fresh explicit label',
			thought_number: 3,
			total_thoughts: 3,
			next_thought_needed: false,
			session_id: sessionId,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: 1,
		});

		expect(admitted.isError).toBeUndefined();
		expect(recorder.getOutcomes(sessionId)).toEqual([
			expect.objectContaining({
				thoughtId: asThoughtId('verification-restore-thought-1'),
				sessionId,
				type: 'hypothesis',
				actual: 1,
				predicted: 0.99,
			}),
		]);
	});

	it('T10-R01/R02/R03 restores the authoritative named namespace union', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const edgeOnly = asSessionId('edge-only');
		const summaryOnly = asSessionId('summary-only');
		const shared = asBranchId('shared');
		const empty = asBranchId('empty');
		await persistence.saveThoughtForSession(TEST_SESSION_ID, thought(TEST_SESSION_ID, 1));
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		await persistence.saveThoughtForSession(sessionB, thought(sessionB, 1));
		await persistence.saveBranchForSession(sessionA, shared, [
			thought(sessionA, 2, { branch_id: shared }),
		]);
		await persistence.saveBranchForSession(sessionB, shared, [
			thought(sessionB, 2, { branch_id: shared }),
		]);
		await persistence.saveBranchForSession(sessionA, empty, []);
		await persistence.saveEdges(edgeOnly, [edge(edgeOnly, 'edge-only-id')]);
		await persistence.saveSummaries(summaryOnly, [summary(summaryOnly, 'summary-only-id')]);
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getSessionIds().sort()).toEqual([
			'A',
			'B',
			'edge-only',
			'restore-session',
			'summary-only',
		]);
		expect(history.getHistory(TEST_SESSION_ID)).toHaveLength(1);
		expect(history.getHistory(sessionA)).toHaveLength(1);
		expect(history.getHistory(sessionB)).toHaveLength(1);
		expect(history.getBranch(shared, sessionA)?.[0]?.session_id).toBe(sessionA);
		expect(history.getBranch(shared, sessionB)?.[0]?.session_id).toBe(sessionB);
		expect(history.getBranch(empty, sessionA)).toEqual([]);
		expect(edgeStore.edgesForSession(edgeOnly)).toEqual([]);
		expect(summaryStore.forSession(summaryOnly)).toHaveLength(1);
	});

	it('T10-R04 reads the restore snapshot once and never calls durable mutation APIs', async () => {
		// Given
		const persistence = new RecordingPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		persistence.calls.length = 0;
		const history = manager(persistence);

		// When
		await history.loadFromPersistence();

		// Then
		expect(persistence.calls).toEqual(['healthy', 'restore-read']);
	});

	it.each([
		{ sessions: 0, branches: 0 },
		{ sessions: 1, branches: 0 },
		{ sessions: 3, branches: 4 },
		{ sessions: 6, branches: 2 },
	])(
		'T10-R12 issues exactly one restore read for $sessions sessions with $branches branches each',
		async ({ sessions, branches }) => {
			// Given
			const persistence = new RecordingPersistence();
			const edgeStore = new EdgeStore();
			const summaryStore = new InMemorySummaryStore();
			const sessionIds = Array.from({ length: sessions }, (_, index) => asSessionId(`s${index}`));
			for (const sessionId of sessionIds) {
				await persistence.saveThoughtForSession(sessionId, thought(sessionId, 1));
				for (let index = 0; index < branches; index += 1) {
					const record = branchRecord(sessionId, `b${index}`, 10 + index);
					await persistence.saveBranchForSession(sessionId, record.branchId, record.thoughts);
				}
				await persistence.saveEdges(sessionId, [edge(sessionId, `${sessionId}-edge`)]);
				await persistence.saveSummaries(sessionId, [summary(sessionId, `${sessionId}-summary`)]);
			}
			persistence.calls.length = 0;
			const history = manager(persistence, { edgeStore, summaryStore });

			// When
			await history.loadFromPersistence();

			// Then
			expect(persistence.calls).toEqual(['healthy', 'restore-read']);
			expect(history.getSessionIds().sort()).toEqual(sessionIds.map(String).sort());
			for (const sessionId of sessionIds) {
				expect(history.getBranchIds(sessionId)).toHaveLength(branches);
				expect(summaryStore.forSession(sessionId)).toHaveLength(1);
			}
		}
	);

	it('T10-R13 does not read the snapshot when the backend reports unhealthy', async () => {
		// Given
		const persistence = new UnhealthyPersistence();
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toBeInstanceOf(PersistenceUnavailableError);
		expect(persistence.calls).toEqual(['healthy']);
	});

	it('T10-R05 derives tool and skill context before applying history and branch retention', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		const first = thought(sessionA, 1, { available_mcp_tools: ['tool-from-full-history'] });
		const second = thought(sessionA, 2, { available_skills: ['skill-from-full-history'] });
		const third = thought(sessionA, 3);
		await persistence.saveThoughtForSession(sessionA, first);
		await persistence.saveThoughtForSession(sessionA, second);
		await persistence.saveThoughtForSession(sessionA, third);
		for (const [branchName, firstNumber] of [
			['a', 4],
			['z', 6],
		] as const) {
			const branchId = asBranchId(branchName);
			await persistence.saveBranchForSession(sessionA, branchId, [
				thought(sessionA, firstNumber, { branch_id: branchId }),
				thought(sessionA, firstNumber + 1, { branch_id: branchId }),
			]);
		}
		const history = manager(persistence, { maxHistorySize: 1, maxBranchSize: 1, maxBranches: 1 });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getHistory(sessionA).map((entry) => entry.thought_number)).toEqual([3]);
		expect(history.getAvailableMcpTools(sessionA)).toEqual(['tool-from-full-history']);
		expect(history.getAvailableSkills(sessionA)).toEqual(['skill-from-full-history']);
		expect(history.getBranchIds(sessionA)).toEqual([asBranchId('z')]);
		expect(
			history.getBranch(asBranchId('z'), sessionA)?.map((entry) => entry.thought_number)
		).toEqual([7]);
		expect(await persistence.loadHistoryForSession(sessionA)).toEqual([first, second, third]);
		expect(await persistence.loadBranchForSession(sessionA, asBranchId('a'))).toHaveLength(2);
	});

	it('restores exact zero branches and prunes their edges without mutating persistence', async () => {
		const persistence = new RecordingPersistence();
		const sessionA = asSessionId('zero-restore');
		const branchId = asBranchId('stale');
		const branchThought = thought(sessionA, 2, { branch_id: branchId });
		await persistence.saveBranchForSession(sessionA, branchId, [branchThought]);
		await persistence.saveEdges(sessionA, [
			{
				id: asEdgeId('stale-edge'),
				from: asThoughtId('missing-root'),
				to: branchThought.id ?? asThoughtId('missing-branch'),
				kind: 'branch',
				sessionId: sessionA,
				createdAt: 1,
			},
		]);
		persistence.calls.length = 0;
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { maxBranches: 0, edgeStore });

		await history.loadFromPersistence();

		expect(history.getBranchIds(sessionA)).toEqual([]);
		expect(edgeStore.edgesForSession(sessionA)).toEqual([]);
		expect(await persistence.loadBranchForSession(sessionA, branchId)).toEqual([branchThought]);
		expect(persistence.calls.filter((call) => call.startsWith('save-'))).toEqual([]);
		expect(persistence.calls.filter((call) => call.startsWith('delete-'))).toEqual([]);
	});

	it('reconciles every excluded durable branch at the next accepted mutation', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('stale-resurrection');
		const branchA = asBranchId('a');
		const branchB = asBranchId('b');
		const replacement = asBranchId('A');
		await persistence.saveBranchForSession(sessionId, branchA, [
			thought(sessionId, 1, { branch_id: branchA }),
		]);
		await persistence.saveBranchForSession(sessionId, branchB, [
			thought(sessionId, 2, { branch_id: branchB }),
		]);
		const history = manager(persistence, { maxBranches: 1 });
		await history.loadFromPersistence();
		expect(history.getBranchIds(sessionId)).toEqual([branchB]);

		// When
		history.addThought(
			thought(sessionId, 3, {
				branch_from_thought: 2,
				branch_id: replacement,
			})
		);
		await history._flushBuffer();

		// Then
		expect(await persistence.listBranchesForSession(sessionId)).toEqual([replacement]);
		const restarted = manager(persistence, { maxBranches: 1 });
		await restarted.loadFromPersistence();
		expect(restarted.getBranchIds(sessionId)).toEqual([replacement]);
	});

	it('reconciles excluded durable branches at an explicit drain after read-only restore', async () => {
		// Given
		const persistence = new RecordingPersistence();
		const sessionId = asSessionId('read-only-drain');
		const branchA = asBranchId('a');
		const branchB = asBranchId('b');
		await persistence.saveBranchForSession(sessionId, branchA, [
			thought(sessionId, 1, { branch_id: branchA }),
		]);
		await persistence.saveBranchForSession(sessionId, branchB, [
			thought(sessionId, 2, { branch_id: branchB }),
		]);
		persistence.calls.length = 0;
		const history = manager(persistence, { maxBranches: 1 });
		await history.loadFromPersistence();
		expect(
			persistence.calls.filter(
				(call) => call.startsWith('save-branch:') || call.startsWith('delete-branch:')
			)
		).toEqual([]);

		// When
		await history.drainSession(sessionId);

		// Then
		expect(
			persistence.calls.filter(
				(call) => call.startsWith('save-branch:') || call.startsWith('delete-branch:')
			)
		).toEqual([`save-branch:${sessionId}:${branchB}`, `delete-branch:${sessionId}:${branchA}`]);
		expect(await persistence.listBranchesForSession(sessionId)).toEqual([branchB]);
	});

	it('preserves a retained empty snapshot while deleting an excluded nonempty branch', async () => {
		// Given
		const persistence = new RecordingPersistence();
		const sessionId = asSessionId('retained-empty');
		const excluded = asBranchId('a');
		const retained = asBranchId('b');
		await persistence.saveBranchForSession(sessionId, excluded, [
			thought(sessionId, 1, { branch_id: excluded }),
		]);
		await persistence.saveBranchForSession(sessionId, retained, []);
		persistence.calls.length = 0;
		const history = manager(persistence, { maxBranches: 1 });
		await history.loadFromPersistence();

		// When
		await history.drainSession(sessionId);

		// Then
		expect(
			persistence.calls.filter(
				(call) => call.startsWith('save-branch:') || call.startsWith('delete-branch:')
			)
		).toEqual([`save-branch:${sessionId}:${retained}`, `delete-branch:${sessionId}:${excluded}`]);
		expect(await persistence.loadBranchForSession(sessionId, retained)).toEqual([]);
		expect(await persistence.loadBranchForSession(sessionId, excluded)).toBeUndefined();
	});

	it('drops a restored edge with a missing source without mutating persistence', async () => {
		// Given
		const persistence = new RecordingPersistence();
		const sessionA = asSessionId('missing-source');
		const targetId = asThoughtId('retained-target');
		const danglingEdge: Edge = {
			id: asEdgeId('missing-source-edge'),
			from: asThoughtId('missing-source-id'),
			to: targetId,
			kind: 'sequence',
			sessionId: sessionA,
			createdAt: 1,
		};
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1, { id: targetId }));
		await persistence.saveEdges(sessionA, [danglingEdge]);
		persistence.calls.length = 0;
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { edgeStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(edgeStore.edgesForSession(sessionA)).toEqual([]);
		expect(await persistence.loadEdges(sessionA)).toEqual([danglingEdge]);
		expect(
			persistence.calls.filter(
				(call) => call.startsWith('save-') || call.startsWith('delete-') || call.startsWith('clear')
			)
		).toEqual([]);
	});

	it('drops a restored edge with a missing target', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('missing-target');
		const sourceId = asThoughtId('retained-source');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1, { id: sourceId }));
		await persistence.saveEdges(sessionA, [
			{
				id: asEdgeId('missing-target-edge'),
				from: sourceId,
				to: asThoughtId('missing-target-id'),
				kind: 'sequence',
				sessionId: sessionA,
				createdAt: 1,
			},
		]);
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { edgeStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(edgeStore.edgesForSession(sessionA)).toEqual([]);
	});

	it('restores a branch edge only when its target is a retained branch thought', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('branch-target');
		const branchId = asBranchId('retained-branch');
		const sourceId = asThoughtId('branch-source');
		const mainTargetId = asThoughtId('main-only-target');
		const branchTargetId = asThoughtId('branch-target-id');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1, { id: sourceId }));
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 2, { id: mainTargetId }));
		await persistence.saveBranchForSession(sessionA, branchId, [
			thought(sessionA, 3, { id: branchTargetId, branch_id: branchId }),
		]);
		const mainTargetEdge: Edge = {
			id: asEdgeId('main-target-branch-edge'),
			from: sourceId,
			to: mainTargetId,
			kind: 'branch',
			sessionId: sessionA,
			createdAt: 1,
		};
		const branchTargetEdge: Edge = {
			id: asEdgeId('branch-target-branch-edge'),
			from: sourceId,
			to: branchTargetId,
			kind: 'branch',
			sessionId: sessionA,
			createdAt: 2,
		};
		await persistence.saveEdges(sessionA, [mainTargetEdge, branchTargetEdge]);
		const edgeStore = new EdgeStore();
		const history = manager(persistence, { edgeStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(edgeStore.edgesForSession(sessionA)).toEqual([branchTargetEdge]);
	});

	it('T10-R06 rejects cross-partition thought scope without mutating the input or live state', async () => {
		// Given
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const misplaced = thought(sessionB, 1);
		const crossPartition = stubbed([sessionRecord(sessionA, { history: [misplaced] })]);
		const before = structuredClone(misplaced);
		const history = manager(crossPartition);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_SCOPE_MISMATCH',
		});
		expect(misplaced).toEqual(before);
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-R07 rejects a missing nested thought session before mutation', async () => {
		// Given
		const thoughtWithoutSession = thought(TEST_SESSION_ID, 1);
		Reflect.deleteProperty(thoughtWithoutSession, 'session_id');
		const persistence = stubbed([
			sessionRecord(TEST_SESSION_ID, { history: [thoughtWithoutSession] }),
		]);
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-R08 rejects a missing thought id in a named partition before mutation', async () => {
		// Given
		const sessionA = asSessionId('A');
		const namedWithoutId = thought(sessionA, 1);
		Reflect.deleteProperty(namedWithoutId, 'id');
		const persistence = stubbed([sessionRecord(sessionA, { history: [namedWithoutId] })]);
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-R09 stages every partition before atomically replacing any live state', async () => {
		// Given
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const persistence = stubbed([
			sessionRecord(TEST_SESSION_ID, { history: [thought(TEST_SESSION_ID, 1)] }),
			sessionRecord(sessionA, { history: [thought(sessionA, 1)] }),
			sessionRecord(sessionB, { history: [thought(sessionA, 2)] }),
		]);
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });
		const liveThought = thought(TEST_SESSION_ID, 99);
		const liveEdge = edge(TEST_SESSION_ID, 'live-edge');
		const liveSummary = summary(TEST_SESSION_ID, 'live-summary');
		history.addThought(liveThought);
		edgeStore.addEdge(liveEdge);
		summaryStore.add(liveSummary);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_SCOPE_MISMATCH',
		});
		expect(persistence.reads).toBe(1);
		expect(history.getHistory(TEST_SESSION_ID)).toEqual([liveThought]);
		expect(history.getSessionIds()).toEqual([TEST_SESSION_ID]);
		expect(edgeStore.edgesForSession(TEST_SESSION_ID)).toEqual([liveEdge]);
		expect(summaryStore.forSession(TEST_SESSION_ID)).toEqual([liveSummary]);
	});

	it('T10-R14 leaves live state untouched when the restore read rejects', async () => {
		// Given
		const persistence = new StubbedRestorePersistence(async () => {
			throw new Error('restore read failed');
		});
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });
		const liveThought = thought(TEST_SESSION_ID, 99);
		const liveEdge = edge(TEST_SESSION_ID, 'live-edge');
		const liveSummary = summary(TEST_SESSION_ID, 'live-summary');
		history.addThought(liveThought);
		edgeStore.addEdge(liveEdge);
		summaryStore.add(liveSummary);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toThrow('restore read failed');
		expect(persistence.reads).toBe(1);
		expect(history.getHistory(TEST_SESSION_ID)).toEqual([liveThought]);
		expect(edgeStore.edgesForSession(TEST_SESSION_ID)).toEqual([liveEdge]);
		expect(summaryStore.forSession(TEST_SESSION_ID)).toEqual([liveSummary]);
	});

	it('T10-R11 rejects malformed listed session identities before live mutation', async () => {
		// Given
		const malformed = sessionRecord(TEST_SESSION_ID);
		Reflect.set(malformed, 'sessionId', 'bad/session');
		const persistence = stubbed([malformed]);
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(history.getSessionIds()).toEqual([]);
	});

	it('rejects a retired listed session identity before replacing live state', async () => {
		// Given
		const liveSession = asSessionId('live-session');
		const liveThought = thought(liveSession, 1);
		const retired = sessionRecord(liveSession);
		Reflect.set(retired, 'sessionId', '__global__');
		const persistence = stubbed([retired]);
		const history = manager(persistence);
		history.addThought(liveThought);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(history.getHistory(liveSession)).toEqual([liveThought]);
	});

	it('rejects a retired nested thought session before replacing live state', async () => {
		// Given
		const restoredSession = asSessionId('restored-session');
		const liveSession = asSessionId('live-session');
		const liveThought = thought(liveSession, 1);
		const retiredThought = thought(restoredSession, 1);
		Reflect.set(retiredThought, 'session_id', '__global__');
		const persistence = stubbed([sessionRecord(restoredSession, { history: [retiredThought] })]);
		const history = manager(persistence);
		history.addThought(liveThought);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(history.getHistory(liveSession)).toEqual([liveThought]);
	});

	it('T10-I01 rejects duplicate and invalid branch records before mutation', async () => {
		// Given
		const sessionA = asSessionId('A');
		const invalidBranch = branchRecord(sessionA, 'valid', 2);
		Reflect.set(invalidBranch, 'branchId', 'bad/branch');
		const duplicateBranches = stubbed([
			sessionRecord(sessionA, {
				history: [thought(sessionA, 1)],
				branches: [branchRecord(sessionA, 'dup', 2), branchRecord(sessionA, 'dup', 3)],
			}),
		]);
		const invalidBranches = stubbed([
			sessionRecord(sessionA, { history: [thought(sessionA, 1)], branches: [invalidBranch] }),
		]);

		// When / Then
		for (const persistence of [duplicateBranches, invalidBranches]) {
			const history = manager(persistence);
			await expect(history.loadFromPersistence()).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
			expect(history.getSessionIds()).toEqual([]);
		}
	});

	it('T10-I07 rejects duplicate session records instead of silently merging them', async () => {
		// Given
		const sessionA = asSessionId('A');
		const liveThought = thought(TEST_SESSION_ID, 99);
		const persistence = stubbed([
			sessionRecord(sessionA, { history: [thought(sessionA, 1)] }),
			sessionRecord(sessionA, { history: [thought(sessionA, 2)] }),
		]);
		const history = manager(persistence);
		history.addThought(liveThought);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
		expect(history.getHistory(TEST_SESSION_ID)).toEqual([liveThought]);
		expect(history.getSessionIds()).toEqual([TEST_SESSION_ID]);
	});

	it('T10-I08 retains the highest branch ids even when a backend delivers branches unsorted', async () => {
		// Given
		const sessionA = asSessionId('A');
		const persistence = stubbed([
			sessionRecord(sessionA, {
				history: [thought(sessionA, 1)],
				branches: [
					branchRecord(sessionA, 'z', 4),
					branchRecord(sessionA, 'a', 2),
					branchRecord(sessionA, 'm', 3),
				],
			}),
		]);
		const history = manager(persistence, { maxBranches: 2 });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getBranchIds(sessionA).sort()).toEqual([asBranchId('m'), asBranchId('z')]);
	});

	it('T10-I02 restores same summary ids across sessions and rejects duplicates within one', async () => {
		// Given
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const valid = new MemoryPersistence();
		await valid.saveSummaries(sessionA, [summary(sessionA, 'same-id')]);
		await valid.saveSummaries(sessionB, [summary(sessionB, 'same-id')]);
		const summaryStore = new InMemorySummaryStore();
		const validHistory = manager(valid, { summaryStore });
		const duplicateSummary = summary(sessionA, 'duplicate-id');
		const invalid = stubbed([
			sessionRecord(sessionA, { summaries: [duplicateSummary, duplicateSummary] }),
		]);
		const invalidHistory = manager(invalid, { summaryStore: new InMemorySummaryStore() });

		// When
		await validHistory.loadFromPersistence();

		// Then
		expect(summaryStore.forSession(sessionA)).toHaveLength(1);
		expect(summaryStore.forSession(sessionB)).toHaveLength(1);
		await expect(invalidHistory.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
	});

	it.each([
		{
			name: 'a branch thought from another session',
			code: 'PERSISTENCE_SCOPE_MISMATCH',
			record: (): PersistedSessionRecord => {
				const other = asSessionId('B');
				return sessionRecord(asSessionId('A'), {
					branches: [
						{
							branchId: asBranchId('x'),
							thoughts: [thought(other, 1, { branch_id: asBranchId('x') })],
						},
					],
				});
			},
		},
		{
			name: 'an edge from another session',
			code: 'PERSISTENCE_SCOPE_MISMATCH',
			record: (): PersistedSessionRecord =>
				sessionRecord(asSessionId('A'), { edges: [edge(asSessionId('B'), 'foreign-edge')] }),
		},
		{
			name: 'a summary from another session',
			code: 'PERSISTENCE_SCOPE_MISMATCH',
			record: (): PersistedSessionRecord =>
				sessionRecord(asSessionId('A'), { summaries: [summary(asSessionId('B'), 'foreign')] }),
		},
		{
			name: 'duplicate edge ids',
			code: 'PERSISTENCE_COMPATIBILITY',
			record: (): PersistedSessionRecord => {
				const duplicate = edge(asSessionId('A'), 'duplicate-edge');
				return sessionRecord(asSessionId('A'), { edges: [duplicate, duplicate] });
			},
		},
	])('T10-I09 rejects $name in a staged session record', async ({ code, record }) => {
		// Given
		const persistence = stubbed([record()]);
		const history = manager(persistence);

		// When / Then
		await expect(history.loadFromPersistence()).rejects.toMatchObject({ code });
		expect(history.getSessionIds()).toEqual([]);
	});

	it('T10-I03 reopens a File snapshot without changing bytes during restore retention', async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task10-file-'));
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const branchId = asBranchId('shared');
		try {
			const seed = await FilePersistence.create({ dataDir: root });
			for (const number of [1, 2, 3]) {
				await seed.saveThoughtForSession(sessionA, thought(sessionA, number));
			}
			await seed.saveThoughtForSession(
				sessionB,
				thought(sessionB, 1, { id: asThoughtId('file-edge-from') })
			);
			await seed.saveBranchForSession(sessionB, branchId, [
				thought(sessionB, 2, {
					id: asThoughtId('file-edge-to'),
					branch_id: branchId,
				}),
			]);
			await seed.saveBranchForSession(sessionA, branchId, [
				thought(sessionA, 4, { branch_id: branchId }),
				thought(sessionA, 5, { branch_id: branchId }),
			]);
			await seed.saveEdges(sessionB, [edge(sessionB, 'file-edge')]);
			await seed.saveSummaries(sessionA, [summary(sessionA, 'file-summary', branchId)]);
			await seed.close();
			const snapshotPath = join(root, 'snapshot.json');
			const before = await readFile(snapshotPath);
			const reopened = await FilePersistence.create({ dataDir: root });
			const edgeStore = new EdgeStore();
			const summaryStore = new InMemorySummaryStore();
			const history = manager(reopened, {
				edgeStore,
				summaryStore,
				maxHistorySize: 1,
				maxBranchSize: 1,
			});

			// When
			await history.loadFromPersistence();

			// Then
			expect(history.getHistory(sessionA).map((value) => value.thought_number)).toEqual([3]);
			expect(history.getBranch(branchId, sessionA)?.map((value) => value.thought_number)).toEqual([
				5,
			]);
			expect(edgeStore.edgesForSession(sessionB)).toHaveLength(1);
			expect(summaryStore.forSession(sessionA)).toHaveLength(1);
			expect(await readFile(snapshotPath)).toEqual(before);
			await reopened.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('T10-I04 rejects corrupt File input without changing its bytes', async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task10-corrupt-'));
		try {
			const snapshotPath = join(root, 'snapshot.json');
			const corrupt = Buffer.from('{"version":2,"thoughts":[');
			await writeFile(snapshotPath, corrupt);

			// When / Then
			await expect(FilePersistence.create({ dataDir: root })).rejects.toMatchObject({
				code: 'PERSISTENCE_CORRUPTION',
			});
			expect(await readFile(snapshotPath)).toEqual(corrupt);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('T10-I05 restores structural SQLite partitions without mutating the database', async () => {
		// Given
		const database = new StatefulSqliteDatabase();
		const persistence = SqlitePersistence.createWithDatabase(database);
		const sessionA = asSessionId('A');
		const sessionB = asSessionId('B');
		const branchId = asBranchId('shared');
		await persistence.saveThoughtForSession(
			sessionA,
			thought(sessionA, 1, { id: asThoughtId('sqlite-edge-from') })
		);
		await persistence.saveThoughtForSession(sessionB, thought(sessionB, 1));
		await persistence.saveBranchForSession(sessionA, branchId, [
			thought(sessionA, 2, {
				id: asThoughtId('sqlite-edge-to'),
				branch_id: branchId,
			}),
		]);
		await persistence.saveBranchForSession(sessionB, branchId, [
			thought(sessionB, 2, { branch_id: branchId }),
		]);
		await persistence.saveEdges(sessionA, [edge(sessionA, 'sqlite-edge')]);
		await persistence.saveSummaries(sessionB, [summary(sessionB, 'sqlite-summary')]);
		const before = database.snapshot();
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, { edgeStore, summaryStore });

		// When
		await history.loadFromPersistence();

		// Then
		expect(history.getHistory(sessionA)).toHaveLength(1);
		expect(history.getHistory(sessionB)).toHaveLength(1);
		expect(history.getBranch(branchId, sessionA)).toHaveLength(1);
		expect(history.getBranch(branchId, sessionB)).toHaveLength(1);
		expect(edgeStore.edgesForSession(sessionA)).toHaveLength(1);
		expect(summaryStore.forSession(sessionB)).toHaveLength(1);
		expect(database.snapshot()).toEqual(before);
		await persistence.close();
	});

	it('T10-O01/O02 ownerless access can mutate restored data without removing provenance', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When
		history.addThought(thought(sessionA, 2));

		// Then
		expect(history.getHistory(sessionA)).toHaveLength(2);
		expect(() =>
			runWithContext({ requestId: 'owner-read', owner: 'network-owner' }, () =>
				history.getHistory(sessionA)
			)
		).toThrow(SessionAccessDeniedError);
	});

	it('T10-O03 rejects owner-aware reads, writes, registration, and reset on restored data', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When / Then
		await runWithContext({ requestId: 'owner-actions', owner: 'network-owner' }, async () => {
			expect(() => history.getHistory(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getHistoryLength(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getBranches(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getBranchIds(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.branchExists(sessionA, asBranchId('new'))).toThrow(
				SessionAccessDeniedError
			);
			expect(() => history.getAvailableMcpTools(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getAvailableSkills(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.getBranch(asBranchId('new'), sessionA)).toThrow(
				SessionAccessDeniedError
			);
			expect(() => history.inspectSession(sessionA)).toThrow(SessionAccessDeniedError);
			expect(() => history.addThought(thought(sessionA, 2))).toThrow(SessionAccessDeniedError);
			expect(() => history.registerBranch(sessionA, asBranchId('new'))).toThrow(
				SessionAccessDeniedError
			);
			await expect(history.resetSession(sessionA)).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});
		expect(history.getHistory(sessionA)).toHaveLength(1);
	});

	it('T10-O04 rejects owner-aware named, edge-only, and summary-only restored namespaces', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const edgeOnly = asSessionId('edge-only');
		const summaryOnly = asSessionId('summary-only');
		await persistence.saveThoughtForSession(TEST_SESSION_ID, thought(TEST_SESSION_ID, 1));
		await persistence.saveEdges(edgeOnly, [edge(edgeOnly, 'edge-id')]);
		await persistence.saveSummaries(summaryOnly, [summary(summaryOnly, 'summary-id')]);
		const edgeStore = new EdgeStore();
		const summaryStore = new InMemorySummaryStore();
		const history = manager(persistence, {
			edgeStore,
			summaryStore,
		});
		await history.loadFromPersistence();

		// When / Then
		await runWithContext({ requestId: 'owner-edge', owner: 'network-owner' }, async () => {
			expect(() => history.getHistory(TEST_SESSION_ID)).toThrow(SessionAccessDeniedError);
			expect(() => history.getHistory(edgeOnly)).toThrow(SessionAccessDeniedError);
			expect(() => history.getHistory(summaryOnly)).toThrow(SessionAccessDeniedError);
			await expect(history.resetSession(TEST_SESSION_ID)).rejects.toBeInstanceOf(
				SessionAccessDeniedError
			);
			await expect(history.resetSession(edgeOnly)).rejects.toBeInstanceOf(SessionAccessDeniedError);
			await expect(history.resetSession(summaryOnly)).rejects.toBeInstanceOf(
				SessionAccessDeniedError
			);
		});
		expect(history.getHistory(TEST_SESSION_ID)).toHaveLength(1);
		expect(edgeStore.edgesForSession(edgeOnly)).toEqual([]);
		expect(summaryStore.forSession(summaryOnly)).toHaveLength(1);
	});

	it('T10-O05 successful ownerless reset removes restored provenance', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When
		await history.resetSession(sessionA);

		// Then
		runWithContext({ requestId: 'owner-after-reset', owner: 'network-owner' }, () => {
			expect(history.getHistory(sessionA)).toEqual([]);
		});
	});

	it('T10-O06 failed ownerless reset preserves restored provenance', async () => {
		// Given
		const persistence = new FailedResetPersistence();
		const sessionA = asSessionId('A');
		await persistence.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const history = manager(persistence);
		await history.loadFromPersistence();

		// When
		await expect(history.resetSession(sessionA)).rejects.toThrow('clear failed for A');

		// Then
		expect(() =>
			runWithContext({ requestId: 'owner-after-failure', owner: 'network-owner' }, () =>
				history.getHistory(sessionA)
			)
		).toThrow(SessionAccessDeniedError);
		expect(history.getHistory(sessionA)).toHaveLength(1);
	});

	it('T10-O07 resetAll removes restored provenance only after durable success', async () => {
		// Given
		const sessionA = asSessionId('A');
		const successful = new MemoryPersistence();
		await successful.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const resetHistory = manager(successful);
		await resetHistory.loadFromPersistence();
		const failing = new FailedResetPersistence();
		await failing.saveThoughtForSession(sessionA, thought(sessionA, 1));
		const failedHistory = manager(failing);
		await failedHistory.loadFromPersistence();

		// When
		await resetHistory.resetAll();
		await expect(failedHistory.resetAll()).rejects.toThrow('clear all failed');

		// Then
		runWithContext({ requestId: 'owner-reset-all', owner: 'network-owner' }, () => {
			expect(resetHistory.getHistory(sessionA)).toEqual([]);
			expect(() => failedHistory.getHistory(sessionA)).toThrow(SessionAccessDeniedError);
		});
	});
});
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
