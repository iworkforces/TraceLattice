import { describe, expect, it } from 'vitest';

import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asThoughtId,
	type BranchId,
	type SessionId,
	type ThoughtId,
} from '../../contracts/ids.js';
import { runWithContext } from '../../context/RequestContext.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { SessionLock } from '../../core/SessionLock.js';
import { SessionLifecycleCoordinator } from '../../core/SessionLifecycleCoordinator.js';
import { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import type { ThoughtData } from '../../core/thought.js';
import { ERROR_CODES } from '../../errors.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { Edge } from '../../core/graph/Edge.js';
import { stageBacktrackPersistence } from '../../persistence/BacktrackPersistence.js';

const SESSION_A = asSessionId('session-a');
const SESSION_B = asSessionId('session-b');

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	const result = Promise.withResolvers<void>();
	return { promise: result.promise, resolve: result.resolve };
}

class ControlledPersistence implements PersistenceBackend {
	readonly events: string[] = [];
	readonly histories = new Map<SessionId, ThoughtData[]>();
	readonly branches = new Map<SessionId, Map<BranchId, ThoughtData[]>>();
	readonly edges = new Map<SessionId, readonly Edge[]>();
	readonly summaries = new Map<SessionId, readonly Summary[]>();
	blockNextA: Promise<void> | undefined;
	blockClearA: Promise<void> | undefined;
	blockClearAll: Promise<void> | undefined;
	failClearA = false;

	async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		this.events.push(`save:start:${sessionId}:${thought.thought}`);
		if (sessionId === SESSION_A && this.blockNextA !== undefined) {
			const blocker = this.blockNextA;
			this.blockNextA = undefined;
			await blocker;
		}
		const history = this.histories.get(sessionId) ?? [];
		history.push(structuredClone(thought));
		this.histories.set(sessionId, history);
		this.events.push(`save:end:${sessionId}:${thought.thought}`);
	}

	async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		const branches = this.branches.get(sessionId) ?? new Map();
		const staged = stageBacktrackPersistence(
			sessionId,
			this.histories.get(sessionId) ?? [],
			[...branches].map(([branchId, thoughts]) => ({ branchId, thoughts })),
			thought,
			targetThoughtId,
			0
		);
		this.histories.set(sessionId, [...staged.history]);
		this.branches.set(
			sessionId,
			new Map(staged.branches.map((branch) => [branch.branchId, [...branch.thoughts]]))
		);
	}

	async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		return structuredClone(this.histories.get(sessionId) ?? []);
	}

	async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		const sessions = this.branches.get(sessionId) ?? new Map<BranchId, ThoughtData[]>();
		sessions.set(branchId, structuredClone([...thoughts]));
		this.branches.set(sessionId, sessions);
	}

	async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		const branches = this.branches.get(sessionId);
		branches?.delete(branchId);
		if (branches?.size === 0) this.branches.delete(sessionId);
	}

	async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		const branch = this.branches.get(sessionId)?.get(branchId);
		return branch === undefined ? undefined : structuredClone(branch);
	}

	async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		return Array.from(this.branches.get(sessionId)?.keys() ?? []);
	}

	async listSessions(): Promise<SessionId[]> {
		return Array.from(new Set([...this.histories.keys(), ...this.branches.keys()]));
	}

	async clearAll(): Promise<void> {
		this.events.push('clear:all');
		if (this.blockClearAll !== undefined) await this.blockClearAll;
		this.histories.clear();
		this.branches.clear();
		this.edges.clear();
		this.summaries.clear();
	}

	async clearSession(sessionId: SessionId): Promise<void> {
		this.events.push(`clear:start:${sessionId}`);
		if (sessionId === SESSION_A && this.failClearA) {
			this.events.push(`clear:failed:${sessionId}`);
			throw new Error('controlled scoped deletion failure');
		}
		if (sessionId === SESSION_A && this.blockClearA !== undefined) await this.blockClearA;
		this.histories.delete(sessionId);
		this.branches.delete(sessionId);
		this.edges.delete(sessionId);
		this.summaries.delete(sessionId);
		this.events.push(`clear:end:${sessionId}`);
	}

	async healthy(): Promise<boolean> {
		return true;
	}

	async close(): Promise<void> {}

	async saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		this.edges.set(sessionId, structuredClone(edges));
	}

	async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		return structuredClone([...(this.edges.get(sessionId) ?? [])]);
	}

	async saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void> {
		this.summaries.set(sessionId, structuredClone(summaries));
	}

	async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		return structuredClone([...(this.summaries.get(sessionId) ?? [])]);
	}
}

function createHarness(persistence: ControlledPersistence): {
	readonly history: HistoryManager;
	readonly processor: ThoughtProcessor;
	readonly edgeStore: EdgeStore;
	readonly summaryStore: InMemorySummaryStore;
	readonly suspensionStore: InMemorySuspensionStore;
	readonly outcomeRecorder: OutcomeRecorder;
	readonly calibrator: Calibrator;
} {
	const edgeStore = new EdgeStore();
	const summaryStore = new InMemorySummaryStore();
	const suspensionStore = new InMemorySuspensionStore();
	const outcomeRecorder = new OutcomeRecorder({ enabled: true });
	const calibrator = new Calibrator(outcomeRecorder, true);
	const lifecycle = new SessionLifecycleCoordinator();
	const history = new HistoryManager({
		persistence,
		edgeStore,
		summaryStore,
		persistenceBufferSize: 100,
		persistenceFlushInterval: 60000,
		persistenceMaxRetries: 0,
		lifecycleCoordinator: lifecycle,
	});
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
		lifecycle,
		calibrator
	);
	return {
		history,
		processor,
		edgeStore,
		summaryStore,
		suspensionStore,
		outcomeRecorder,
		calibrator,
	};
}

function testEdge(sessionId: SessionId, suffix: string): Edge {
	return {
		id: asEdgeId(`edge-${suffix}`),
		from: asThoughtId(`from-${suffix}`),
		to: asThoughtId(`to-${suffix}`),
		kind: 'sequence',
		sessionId,
		createdAt: 1,
	};
}

function testSummary(sessionId: SessionId, suffix: string): Summary {
	return {
		id: `summary-${suffix}`,
		sessionId,
		rootThoughtId: asThoughtId(`root-${suffix}`),
		coveredIds: [asThoughtId(`covered-${suffix}`)],
		coveredRange: [1, 1],
		topics: ['reset'],
		aggregateConfidence: 0.8,
		createdAt: 1,
	};
}

describe('ordered scoped session reset', () => {
	it('validates schema and new-type invariants before reset and registration', async () => {
		const persistence = new ControlledPersistence();
		const { history, processor, edgeStore, summaryStore, suspensionStore, outcomeRecorder } =
			createHarness(persistence);
		await processor.process({
			thought: 'old A',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: SESSION_A,
		});
		await history._flushBuffer();
		edgeStore.addEdge(testEdge(SESSION_A, 'invalid-a'));
		summaryStore.add(testSummary(SESSION_A, 'invalid-a'));
		suspensionStore.suspend({
			sessionId: SESSION_A,
			toolCallThoughtNumber: 1,
			toolCallThoughtId: asThoughtId('reset-call-1'),
			toolName: 'tool',
			toolArguments: {},
			expiresAt: 0,
		});
		outcomeRecorder.recordVerification({
			thoughtId: asThoughtId('invalid-a'),
			sessionId: SESSION_A,
			predicted: 0.7,
			actual: 1,
			type: 'verification',
		});
		const input = {
			thought: 'invalid backtrack',
			thought_number: 0,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_A,
			thought_type: 'backtrack',
			backtrack_target: 99,
			reset_state: true,
			register_branch_id: 'future',
		};
		const before = structuredClone(input);

		const result = await processor.process(input as unknown as ThoughtData);

		expect(result.isError).toBe(true);
		expect(history.getHistory(SESSION_A).map((thought) => thought.thought)).toEqual(['old A']);
		expect(await persistence.loadHistoryForSession(SESSION_A)).toHaveLength(1);
		expect(history.branchExists(SESSION_A, asBranchId('future'))).toBe(false);
		expect(edgeStore.size(SESSION_A)).toBe(1);
		expect(summaryStore.size(SESSION_A)).toBe(1);
		expect(suspensionStore.size(SESSION_A)).toBe(1);
		expect(outcomeRecorder.getOutcomes(SESSION_A)).toHaveLength(1);
		expect(input).toEqual(before);
		await history.shutdown();
	});

	it('waits for an old blocked A write, keeps B usable, deletes A, then persists one replacement', async () => {
		const persistence = new ControlledPersistence();
		const blocker = deferred();
		persistence.blockNextA = blocker.promise;
		const { history, processor, edgeStore, summaryStore, suspensionStore, outcomeRecorder } =
			createHarness(persistence);
		await processor.process({
			thought: 'A old',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: SESSION_A,
		});
		history.registerBranch(SESSION_A, asBranchId('old-branch'));
		edgeStore.addEdge(testEdge(SESSION_A, 'old-a'));
		edgeStore.addEdge(testEdge(SESSION_B, 'keep-b'));
		summaryStore.add(testSummary(SESSION_A, 'old-a'));
		summaryStore.add(testSummary(SESSION_B, 'keep-b'));
		suspensionStore.suspend({
			sessionId: SESSION_A,
			toolCallThoughtNumber: 1,
			toolCallThoughtId: asThoughtId('reset-call-2'),
			toolName: 'tool',
			toolArguments: {},
			expiresAt: 0,
		});
		outcomeRecorder.recordVerification({
			thoughtId: asThoughtId('old-a'),
			sessionId: SESSION_A,
			predicted: 0.8,
			actual: 1,
			type: 'verification',
		});
		persistence.edges.set(SESSION_A, [testEdge(SESSION_A, 'durable-old-a')]);
		persistence.edges.set(SESSION_B, [testEdge(SESSION_B, 'durable-keep-b')]);
		persistence.summaries.set(SESSION_A, [testSummary(SESSION_A, 'durable-old-a')]);
		persistence.summaries.set(SESSION_B, [testSummary(SESSION_B, 'durable-keep-b')]);
		const oldDrain = history._flushBuffer();
		await Promise.resolve();
		const resetInput = {
			thought: 'A replacement',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_A,
			reset_state: true,
			register_branch_id: 'new-branch',
		};
		const resetBefore = structuredClone(resetInput);
		let resetSettled = false;
		const reset = processor.process(resetInput as unknown as ThoughtData).then((value) => {
			resetSettled = true;
			return value;
		});
		await Promise.resolve();

		const bResult = await processor.process({
			thought: 'B survives',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_B,
		});
		expect(bResult.isError).toBeUndefined();
		expect(resetSettled).toBe(false);

		blocker.resolve();
		await oldDrain;
		const resetResult = await reset;
		expect(resetResult.isError).toBeUndefined();
		await history._flushBuffer();

		expect(history.getHistory(SESSION_A).map((thought) => thought.thought)).toEqual([
			'A replacement',
		]);
		expect(history.getBranchIds(SESSION_A)).toContain('new-branch');
		expect(history.getBranchIds(SESSION_A)).not.toContain('old-branch');
		expect(history.getHistory(SESSION_B).map((thought) => thought.thought)).toEqual(['B survives']);
		expect(edgeStore.size(SESSION_A)).toBe(0);
		expect(edgeStore.size(SESSION_B)).toBe(0);
		expect(summaryStore.size(SESSION_A)).toBe(0);
		expect(summaryStore.size(SESSION_B)).toBe(1);
		expect(suspensionStore.size(SESSION_A)).toBe(0);
		expect(outcomeRecorder.getOutcomes(SESSION_A)).toEqual([]);
		expect(persistence.edges.has(SESSION_A)).toBe(false);
		expect(persistence.edges.get(SESSION_B)).toEqual([]);
		expect(persistence.summaries.has(SESSION_A)).toBe(false);
		expect(persistence.summaries.has(SESSION_B)).toBe(true);
		expect(
			(await persistence.loadHistoryForSession(SESSION_A)).map((thought) => thought.thought)
		).toEqual(['A replacement']);
		expect(
			(await persistence.loadHistoryForSession(SESSION_B)).map((thought) => thought.thought)
		).toEqual(['B survives']);
		expect(persistence.events.indexOf('save:end:session-a:A old')).toBeLessThan(
			persistence.events.indexOf('clear:start:session-a')
		);
		expect(resetInput).toEqual(resetBefore);
		await history.shutdown();
	});

	it('quarantines A after scoped deletion failure and permits explicit successful recovery only', async () => {
		const persistence = new ControlledPersistence();
		const { history, processor, suspensionStore, outcomeRecorder, calibrator } =
			createHarness(persistence);
		await processor.process({
			thought: 'A stale',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: SESSION_A,
		});
		await history._flushBuffer();
		suspensionStore.suspend({
			sessionId: SESSION_A,
			toolCallThoughtNumber: 1,
			toolCallThoughtId: asThoughtId('reset-call-3'),
			toolName: 'tool',
			toolArguments: {},
			expiresAt: 0,
		});
		outcomeRecorder.recordVerification({
			thoughtId: asThoughtId('a-old'),
			sessionId: SESSION_A,
			predicted: 0.99,
			actual: 0,
			type: 'verification',
		});
		for (let index = 1; index < 10; index++) {
			outcomeRecorder.recordVerification({
				thoughtId: asThoughtId(`a-old-${index}`),
				sessionId: SESSION_A,
				predicted: 0.99,
				actual: 0,
				type: 'verification',
			});
		}
		calibrator.refit(SESSION_A);
		expect(calibrator.calibrate(0.9, 'verification', SESSION_A).temperature).toBeGreaterThan(1);
		persistence.failClearA = true;
		const failed = await processor.process({
			thought: 'must not enter',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_A,
			reset_state: true,
			register_branch_id: 'not-yet',
		} as unknown as ThoughtData);

		expect(failed.isError).toBe(true);
		expect(history.getHistory(SESSION_A).map((thought) => thought.thought)).toEqual(['A stale']);
		expect(history.branchExists(SESSION_A, asBranchId('not-yet'))).toBe(false);
		expect(suspensionStore.size(SESSION_A)).toBe(1);
		expect(outcomeRecorder.getOutcomes(SESSION_A)).toHaveLength(10);
		expect(() => outcomeRecorder.assertCanRecord(SESSION_A, asThoughtId('a-old'))).toThrow();
		expect(calibrator.calibrate(0.9, 'verification', SESSION_A).temperature).toBeGreaterThan(1);
		const quarantinedSnapshot = history.inspectSession(SESSION_A);

		expect(() => history.registerBranch(SESSION_A, asBranchId('direct-blocked'))).toThrow(
			expect.objectContaining({ code: ERROR_CODES.SESSION_LIFECYCLE_CLOSED })
		);
		expect(history.inspectSession(SESSION_A)).toEqual(quarantinedSnapshot);

		const normal = await processor.process({
			thought: 'blocked normal mutation',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: SESSION_A,
			register_branch_id: 'public-blocked',
		});
		expect(normal.isError).toBe(true);
		expect(JSON.parse(normal.content[0]?.text ?? '{}')).toMatchObject({
			code: ERROR_CODES.SESSION_LIFECYCLE_CLOSED,
		});
		expect(history.getHistory(SESSION_A).map((thought) => thought.thought)).toEqual(['A stale']);
		expect(history.inspectSession(SESSION_A)).toEqual(quarantinedSnapshot);

		persistence.failClearA = false;
		const recovered = await processor.process({
			thought: 'recovered fresh',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_A,
			reset_state: true,
			register_branch_id: 'recovered-branch',
		} as unknown as ThoughtData);
		expect(recovered.isError).toBeUndefined();
		await history._flushBuffer();
		expect(history.getHistory(SESSION_A).map((thought) => thought.thought)).toEqual([
			'recovered fresh',
		]);
		expect(suspensionStore.size(SESSION_A)).toBe(0);
		expect(outcomeRecorder.getOutcomes(SESSION_A)).toEqual([]);
		expect(() => outcomeRecorder.assertCanRecord(SESSION_A, asThoughtId('a-old'))).not.toThrow();
		expect(calibrator.metrics(SESSION_A).sampleCount).toBe(0);
		expect(calibrator.calibrate(0.9, 'verification', SESSION_A).temperature).toBe(1);
		expect(
			(await persistence.loadHistoryForSession(SESSION_A)).map((thought) => thought.thought)
		).toEqual(['recovered fresh']);
		await history.shutdown();
	});

	it('rejects branch registration while a scoped reset barrier owns the session', async () => {
		const persistence = new ControlledPersistence();
		const { history } = createHarness(persistence);
		history.addThought({
			thought: 'A retained until reset',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_A,
		});
		await history._flushBuffer();
		const clearGate = deferred();
		persistence.blockClearA = clearGate.promise;
		const before = history.inspectSession(SESSION_A);

		const reset = history.resetSession(SESSION_A);
		expect(() => history.registerBranch(SESSION_A, asBranchId('barrier-blocked'))).toThrow(
			expect.objectContaining({ code: ERROR_CODES.SESSION_LIFECYCLE_CLOSED })
		);
		expect(history.inspectSession(SESSION_A)).toEqual(before);
		clearGate.resolve();
		await reset;
		expect(() => history.registerBranch(SESSION_A, asBranchId('after-reset'))).not.toThrow();
		await history.shutdown();
	});

	it('rejects branch registration while a global reset barrier owns admission', async () => {
		const persistence = new ControlledPersistence();
		const { history } = createHarness(persistence);
		history.addThought({
			thought: 'B retained until reset',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: SESSION_B,
		});
		await history._flushBuffer();
		const clearGate = deferred();
		persistence.blockClearAll = clearGate.promise;
		const before = history.inspectSession(SESSION_B);

		const reset = history.resetAll();
		expect(() => history.registerBranch(SESSION_B, asBranchId('global-barrier-blocked'))).toThrow(
			expect.objectContaining({ code: ERROR_CODES.SESSION_LIFECYCLE_CLOSED })
		);
		expect(history.inspectSession(SESSION_B)).toEqual(before);
		clearGate.resolve();
		await reset;
		expect(() => history.registerBranch(SESSION_B, asBranchId('after-global-reset'))).not.toThrow();
		await history.shutdown();
	});

	it('wrong-owner reset fails before the durable barrier and leaves rightful owner state usable', async () => {
		const persistence = new ControlledPersistence();
		const { history } = createHarness(persistence);
		runWithContext({ requestId: 'a1', owner: 'alice' }, () => {
			history.addThought({
				thought: 'owned',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: SESSION_A,
			});
		});
		await history._flushBuffer();
		const eventCount = persistence.events.length;

		await expect(
			runWithContext({ requestId: 'b1', owner: 'bob' }, () => history.resetSession(SESSION_A))
		).rejects.toMatchObject({ code: ERROR_CODES.SESSION_ACCESS_DENIED });
		expect(persistence.events).toHaveLength(eventCount);
		runWithContext({ requestId: 'a2', owner: 'alice' }, () => {
			history.addThought({
				thought: 'still usable',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: SESSION_A,
			});
		});
		expect(history.getHistory(SESSION_A)).toHaveLength(2);
		await history.shutdown();
	});
});
