// allow: SIZE_OK - Task 8's contract matrix is intentionally colocated in its one authorized test file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asThoughtId,
	type BranchId,
	type SessionId,
} from '../../contracts/ids.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { Edge } from '../../core/graph/Edge.js';
import { PersistenceBuffer, type PersistenceEventEmitter } from '../../core/PersistenceBuffer.js';
import { PersistenceWorkQueue } from '../../core/PersistenceWorkQueue.js';
import { PersistenceWriter, type PersistenceDelay } from '../../core/PersistenceWriter.js';
import type { ThoughtData } from '../../core/thought.js';
import { PersistenceSessionBarrierReentrancyError } from '../../core/PersistenceBufferErrors.js';
import { createTestThought } from '../helpers/factories.js';

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

type PromiseOutcome =
	{ readonly status: 'fulfilled' } | { readonly status: 'rejected'; readonly reason: unknown };

interface ThoughtWrite {
	readonly sessionId: SessionId;
	readonly thought: ThoughtData;
}

interface BranchWrite {
	readonly sessionId: SessionId;
	readonly branchId: BranchId;
	readonly thoughts: readonly ThoughtData[];
}

interface BranchDelete {
	readonly sessionId: SessionId;
	readonly branchId: BranchId;
}

interface SnapshotWrite<T> {
	readonly sessionId: SessionId;
	readonly snapshot: readonly T[];
}

interface PersistenceHandlers {
	readonly thought?: (write: ThoughtWrite) => Promise<void>;
	readonly branch?: (write: BranchWrite) => Promise<void>;
	readonly branchDelete?: (write: BranchDelete) => Promise<void>;
	readonly edges?: (write: SnapshotWrite<Edge>) => Promise<void>;
	readonly summaries?: (write: SnapshotWrite<Summary>) => Promise<void>;
	readonly clearSession?: (sessionId: SessionId) => Promise<void>;
}

class ExpectedWriteError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'ExpectedWriteError';
	}
}

class CoordinatorFault extends Error {
	public constructor() {
		super('coordinator fault');
		this.name = 'CoordinatorFault';
	}
}

class RecordingPersistence implements PersistenceBackend {
	public readonly thoughtWrites: ThoughtWrite[] = [];
	public readonly branchWrites: BranchWrite[] = [];
	public readonly branchDeletes: BranchDelete[] = [];
	public readonly edgeWrites: SnapshotWrite<Edge>[] = [];
	public readonly summaryWrites: SnapshotWrite<Summary>[] = [];
	public readonly scopedThoughts: ThoughtWrite[] = [];
	public readonly scopedBranches: BranchWrite[] = [];

	public constructor(private readonly _handlers: PersistenceHandlers = {}) {}

	public async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		const write = { sessionId, thought };
		this.scopedThoughts.push(write);
		this.thoughtWrites.push(write);
		await this._handlers.thought?.(write);
	}

	public async loadHistoryForSession(_sessionId: SessionId): Promise<ThoughtData[]> {
		return [];
	}

	public async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		const write = { sessionId, branchId, thoughts: [...thoughts] };
		this.scopedBranches.push(write);
		this.branchWrites.push(write);
		await this._handlers.branch?.(write);
	}

	public async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		const write = { sessionId, branchId };
		this.branchDeletes.push(write);
		await this._handlers.branchDelete?.(write);
	}

	public async loadBranchForSession(
		_sessionId: SessionId,
		_branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		return undefined;
	}

	public async listBranchesForSession(_sessionId: SessionId): Promise<BranchId[]> {
		return [];
	}

	public async listSessions(): Promise<SessionId[]> {
		return [];
	}

	public async healthy(): Promise<boolean> {
		return true;
	}

	public async clearAll(): Promise<void> {}

	public async clearSession(sessionId: SessionId): Promise<void> {
		await this._handlers.clearSession?.(sessionId);
	}

	public async close(): Promise<void> {}

	public async saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		const write = { sessionId, snapshot: [...edges] };
		this.edgeWrites.push(write);
		await this._handlers.edges?.(write);
	}

	public async loadEdges(_sessionId: SessionId): Promise<Edge[]> {
		return [];
	}

	public async saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void> {
		const write = { sessionId, snapshot: [...summaries] };
		this.summaryWrites.push(write);
		await this._handlers.summaries?.(write);
	}

	public async loadSummaries(_sessionId: SessionId): Promise<Summary[]> {
		return [];
	}
}

interface Harness {
	readonly buffer: PersistenceBuffer;
}

interface HarnessOptions {
	readonly persistence: PersistenceBackend;
	readonly maxRetries?: number;
	readonly bufferSize?: number;
	readonly flushInterval?: number;
	readonly eventEmitter?: PersistenceEventEmitter;
	readonly delay?: PersistenceDelay;
}

const activeBuffers: PersistenceBuffer[] = [];
const deferredReleases: Array<() => void> = [];
const TEST_SESSION_ID = asSessionId('test-session');

function createDeferred(): Deferred {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	deferredReleases.push(release);
	return { promise, resolve: release };
}

function createHarness(options: HarnessOptions): Harness {
	const buffer = new PersistenceBuffer({
		persistence: options.persistence,
		bufferSize: options.bufferSize ?? 100,
		flushInterval: options.flushInterval ?? 1_000,
		maxRetries: options.maxRetries ?? 0,
		eventEmitter: options.eventEmitter,
		delay: options.delay,
	});
	activeBuffers.push(buffer);
	return { buffer };
}

function drain(buffer: PersistenceBuffer): Promise<void> {
	return buffer.drain();
}

function drainSession(buffer: PersistenceBuffer, sessionId: SessionId): Promise<void> {
	return buffer.drainSession(sessionId);
}

function acceptThought(harness: Harness, sessionId: SessionId, thoughtNumber: number): void {
	const thought = createTestThought({
		id: `${sessionId}-thought-${thoughtNumber}`,
		session_id: sessionId,
		thought_number: thoughtNumber,
	});
	acceptThoughtData(harness, sessionId, thought);
}

function acceptThoughtData(harness: Harness, sessionId: SessionId, thought: ThoughtData): void {
	harness.buffer.bufferThought(sessionId, thought);
}

function acceptBranch(
	buffer: PersistenceBuffer,
	sessionId: SessionId,
	branchId: BranchId,
	thoughts: readonly ThoughtData[]
): void {
	buffer.bufferBranch(sessionId, branchId, thoughts);
}

function acceptBranchDelete(
	buffer: PersistenceBuffer,
	sessionId: SessionId,
	branchId: BranchId
): void {
	buffer.deleteBranch(sessionId, branchId);
}

function acceptEdges(harness: Harness, sessionId: SessionId, edges: readonly Edge[]): void {
	harness.buffer.bufferEdges(sessionId, edges);
}

function acceptSummaries(
	buffer: PersistenceBuffer,
	sessionId: SessionId,
	summaries: readonly Summary[]
): void {
	buffer.bufferSummaries(sessionId, summaries);
}

function edge(sessionId: SessionId, suffix: string, createdAt: number): Edge {
	return {
		id: asEdgeId(`edge-${suffix}`),
		from: asThoughtId(`from-${suffix}`),
		to: asThoughtId(`to-${suffix}`),
		kind: 'sequence',
		sessionId,
		createdAt,
	};
}

function summary(sessionId: SessionId, suffix: string): Summary {
	return {
		id: `summary-${suffix}`,
		sessionId,
		rootThoughtId: asThoughtId(`root-${suffix}`),
		coveredIds: [asThoughtId(`covered-${suffix}`)],
		coveredRange: [1, 1],
		topics: ['persistence'],
		aggregateConfidence: 0.8,
		createdAt: 1,
	};
}

function settle(promise: Promise<void>): Promise<PromiseOutcome> {
	return promise.then(
		() => ({ status: 'fulfilled' }),
		(reason: unknown) => ({ status: 'rejected', reason })
	);
}

function settlementProbe(promise: Promise<void>): () => boolean {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		}
	);
	return () => settled;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(async () => {
	for (const buffer of activeBuffers.splice(0)) buffer.stopFlushTimer();
	for (const release of deferredReleases.splice(0)) release();
	await vi.runAllTimersAsync();
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('PersistenceBuffer joinable drain generation', () => {
	it('returns exact shared identity for drain, flush, and drain joiners', async () => {
		// Given
		const gate = createDeferred();
		const persistence = new RecordingPersistence({ thought: async () => gate.promise });
		const harness = createHarness({ persistence });
		acceptThought(harness, TEST_SESSION_ID, 1);

		// When
		const first = drain(harness.buffer);
		const second = harness.buffer.flush();
		const third = drain(harness.buffer);

		// Then
		try {
			expect(first).toBe(second);
			expect(second).toBe(third);
		} finally {
			gate.resolve();
			await Promise.all([settle(first), settle(second), settle(third)]);
		}
	});

	it('keeps every joiner pending while the first backend write is blocked', async () => {
		// Given
		const gate = createDeferred();
		const persistence = new RecordingPersistence({ thought: async () => gate.promise });
		const harness = createHarness({ persistence });
		acceptThought(harness, TEST_SESSION_ID, 1);

		// When
		const first = drain(harness.buffer);
		const second = harness.buffer.flush();
		const third = drain(harness.buffer);
		const probes = [settlementProbe(first), settlementProbe(second), settlementProbe(third)];
		await flushMicrotasks();

		// Then
		try {
			expect(probes.map((probe) => probe())).toEqual([false, false, false]);
		} finally {
			gate.resolve();
			await Promise.all([settle(first), settle(second), settle(third)]);
		}
	});

	it('settles late accepted work before the active generation resolves', async () => {
		// Given
		const gate = createDeferred();
		const persistence = new RecordingPersistence({
			thought: async () => {
				if (persistence.thoughtWrites.length === 1) await gate.promise;
			},
		});
		const harness = createHarness({ persistence });
		acceptThoughtData(
			harness,
			TEST_SESSION_ID,
			createTestThought({ id: 'shared-acceptance-id', thought_number: 1 })
		);

		// When
		const generation = settle(drain(harness.buffer));
		await flushMicrotasks();
		acceptThoughtData(
			harness,
			TEST_SESSION_ID,
			createTestThought({ id: 'shared-acceptance-id', thought_number: 2 })
		);
		gate.resolve();
		const outcome = await generation;

		// Then
		expect(outcome).toEqual({ status: 'fulfilled' });
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([1, 2]);
	});
});

describe('PersistenceBuffer bounded attributable retries', () => {
	it.each([-1, 0.5])(
		'rejects invalid retry bound %s before accepting a persistence policy',
		(maxRetries) => {
			// Given
			const persistence = new RecordingPersistence();

			// When
			const construct = (): PersistenceWriter => new PersistenceWriter({ persistence, maxRetries });

			// Then
			expect(construct).toThrow(new RangeError('maxRetries must be a non-negative safe integer'));
		}
	);

	it('retries with zero delay from an explicitly empty schedule and persists the work', async () => {
		// Given
		const retryDelays: number[] = [];
		const persistence = new RecordingPersistence({
			thought: async () => {
				if (persistence.thoughtWrites.length === 1) throw new ExpectedWriteError('first attempt');
			},
		});
		const writer = new PersistenceWriter({
			persistence,
			maxRetries: 1,
			retryDelays: [],
			delay: async (milliseconds) => {
				retryDelays.push(milliseconds);
			},
		});
		const queue = new PersistenceWorkQueue();
		const work = queue.enqueueThought(TEST_SESSION_ID, createTestThought({ thought_number: 1 }));

		// When
		const outcome = await writer.write(work);

		// Then
		expect(outcome).toBe(true);
		expect(retryDelays).toEqual([0]);
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([1, 1]);
	});

	it('removes successes once and retains only terminal failures for an explicit later generation', async () => {
		// Given
		const sessionId = asSessionId('partial-session');
		let failSecond = true;
		const persistence = new RecordingPersistence({
			thought: async ({ thought }) => {
				if (thought.thought_number === 2 && failSecond) throw new ExpectedWriteError('second');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptThought(harness, sessionId, 1);
		acceptThought(harness, sessionId, 2);
		acceptThought(harness, sessionId, 3);

		// When
		const first = await settle(drain(harness.buffer));
		failSecond = false;
		const second = await settle(drain(harness.buffer));

		// Then
		expect(first).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				code: 'PERSISTENCE_DRAIN',
				failures: [{ sessionId, kind: 'thought', attempts: 1 }],
			},
		});
		expect(second).toEqual({ status: 'fulfilled' });
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([
			1, 2, 3, 2,
		]);
	});

	it('uses the same named SessionId and only scoped persistence methods for every retry', async () => {
		// Given
		const sessionId = asSessionId('named-retry');
		const persistence = new RecordingPersistence({
			thought: async ({ sessionId: actualSessionId }) => {
				if (actualSessionId === undefined) throw new ExpectedWriteError('legacy method');
				if (persistence.scopedThoughts.length === 1) throw new ExpectedWriteError('retry once');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 1 });
		acceptThought(harness, sessionId, 1);

		// When
		const outcomePromise = settle(drain(harness.buffer));
		await vi.runAllTimersAsync();
		const outcome = await outcomePromise;

		// Then
		expect(outcome).toEqual({ status: 'fulfilled' });
		expect(persistence.scopedThoughts.map((write) => write.sessionId)).toEqual([
			sessionId,
			sessionId,
		]);
	});

	it('rejects with a typed failure after exactly maxRetries plus one attempts and retains work', async () => {
		// Given
		const sessionId = asSessionId('bounded-retry');
		const failure = new ExpectedWriteError('always fails');
		const persistence = new RecordingPersistence({
			thought: async () => {
				throw failure;
			},
		});
		const harness = createHarness({ persistence, maxRetries: 2 });
		acceptThought(harness, sessionId, 1);

		// When
		const outcomePromise = settle(drain(harness.buffer));
		await vi.runAllTimersAsync();
		const outcome = await outcomePromise;

		// Then
		expect(persistence.thoughtWrites).toHaveLength(3);
		expect(outcome).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				code: 'PERSISTENCE_DRAIN',
				failures: [{ sessionId, kind: 'thought', attempts: 3, cause: failure }],
			},
		});
	});

	it('does not let timer generations reattempt exhausted work until an explicit drain rearms it', async () => {
		// Given
		const sessionId = asSessionId('timer-exhaustion');
		const persistence = new RecordingPersistence({
			thought: async () => {
				throw new ExpectedWriteError('terminal');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0, flushInterval: 100 });
		acceptThought(harness, sessionId, 1);
		harness.buffer.startFlushTimer();

		// When
		const first = await settle(drain(harness.buffer));
		await vi.advanceTimersByTimeAsync(500);
		const attemptsBeforeRearm = persistence.thoughtWrites.length;
		harness.buffer.stopFlushTimer();
		const second = await settle(drain(harness.buffer));

		// Then
		expect(first.status).toBe('rejected');
		expect(attemptsBeforeRearm).toBe(1);
		expect(second.status).toBe('rejected');
		expect(persistence.thoughtWrites).toHaveLength(2);
	});

	it('does not let a capacity trigger reattempt exhausted work without explicit rearm', async () => {
		// Given
		const sessionId = asSessionId('capacity-exhaustion');
		const persistence = new RecordingPersistence({
			thought: async ({ thought }) => {
				if (thought.thought_number === 1) throw new ExpectedWriteError('terminal');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0, bufferSize: 1 });
		acceptThought(harness, sessionId, 1);
		await flushMicrotasks();

		// When
		acceptThought(harness, sessionId, 2);
		await flushMicrotasks();

		// Then
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([1, 2]);
	});
});

describe('PersistenceBuffer auxiliary-only work', () => {
	it('drains edge-only work without requiring a thought', async () => {
		// Given
		const sessionId = asSessionId('edge-only');
		const failure = new ExpectedWriteError('edge failure');
		const persistence = new RecordingPersistence({
			edges: async () => {
				throw failure;
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptEdges(harness, sessionId, [edge(sessionId, 'only', 1)]);

		// When
		const outcome = await settle(drain(harness.buffer));

		// Then
		expect(persistence.edgeWrites).toHaveLength(1);
		expect(outcome).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				failures: [{ sessionId, kind: 'edge', attempts: 1, cause: failure }],
			},
		});
	});

	it('drains branch-only work through the scoped branch method and rejects exhaustion', async () => {
		// Given
		const sessionId = asSessionId('branch-only');
		const branchId = asBranchId('branch-a');
		const failure = new ExpectedWriteError('branch failure');
		const persistence = new RecordingPersistence({
			branch: async () => {
				throw failure;
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptBranch(harness.buffer, sessionId, branchId, [
			createTestThought({ id: 'branch-thought', session_id: sessionId }),
		]);

		// When
		const outcome = await settle(drain(harness.buffer));

		// Then
		expect(persistence.scopedBranches).toHaveLength(1);
		expect(outcome).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				failures: [{ sessionId, kind: 'branch', key: branchId, attempts: 1, cause: failure }],
			},
		});
	});

	it('drains summary-only work and rejects exhaustion', async () => {
		// Given
		const sessionId = asSessionId('summary-only');
		const failure = new ExpectedWriteError('summary failure');
		const persistence = new RecordingPersistence({
			summaries: async () => {
				throw failure;
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptSummaries(harness.buffer, sessionId, [summary(sessionId, 'only')]);

		// When
		const outcome = await settle(drain(harness.buffer));

		// Then
		expect(persistence.summaryWrites).toHaveLength(1);
		expect(outcome).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				failures: [{ sessionId, kind: 'summary', attempts: 1, cause: failure }],
			},
		});
	});

	it('captures a shallow branch snapshot at acceptance time', async () => {
		// Given
		const sessionId = asSessionId('branch-snapshot');
		const branchId = asBranchId('branch-snapshot');
		const original = createTestThought({ id: 'original', session_id: sessionId });
		const mutableInput = [original];
		const persistence = new RecordingPersistence();
		const harness = createHarness({ persistence });
		acceptBranch(harness.buffer, sessionId, branchId, mutableInput);
		mutableInput.push(createTestThought({ id: 'late-mutation', session_id: sessionId }));

		// When
		const outcome = await settle(drain(harness.buffer));

		// Then
		expect(outcome).toEqual({ status: 'fulfilled' });
		expect(persistence.branchWrites[0]?.thoughts).toEqual([original]);
	});
});

describe('PersistenceBuffer versioned auxiliary acknowledgements', () => {
	it('coalesces save then delete at one branch coordinate with the delete as last write', () => {
		const sessionId = asSessionId('branch-delete-coalesce');
		const branchId = asBranchId('branch');
		const queue = new PersistenceWorkQueue();
		const save = queue.replaceBranch(sessionId, branchId, [createTestThought()]);
		const deletion = queue.deleteBranch(sessionId, branchId);
		const selected = new Set<string>();

		expect(queue.nextEligibleWork(selected, 'explicit')).toEqual(deletion);
		expect(deletion).toMatchObject({ operation: 'delete', version: 2 });
		queue.acknowledgeSuccess(save);
		expect(queue.pendingWorkCount).toBe(1);
	});

	it('writes an in-flight branch save before the accepted delete in the same generation', async () => {
		const sessionId = asSessionId('branch-delete-in-flight');
		const branchId = asBranchId('branch');
		const saveGate = createDeferred();
		const events: string[] = [];
		const persistence = new RecordingPersistence({
			branch: async () => {
				events.push('save');
				await saveGate.promise;
			},
			branchDelete: async () => {
				events.push('delete');
			},
		});
		const harness = createHarness({ persistence });
		acceptBranch(harness.buffer, sessionId, branchId, [createTestThought()]);
		const draining = drain(harness.buffer);
		await flushMicrotasks();

		acceptBranchDelete(harness.buffer, sessionId, branchId);
		saveGate.resolve();
		await draining;

		expect(events).toEqual(['save', 'delete']);
	});

	it('retains an attributable branch deletion failure for an explicit retry', async () => {
		const sessionId = asSessionId('branch-delete-failure');
		const branchId = asBranchId('branch');
		let fail = true;
		const persistence = new RecordingPersistence({
			branchDelete: async () => {
				if (fail) throw new ExpectedWriteError('delete failed');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptBranchDelete(harness.buffer, sessionId, branchId);

		await expect(drain(harness.buffer)).rejects.toMatchObject({
			failures: [expect.objectContaining({ kind: 'branch', key: branchId, version: 1 })],
		});
		fail = false;
		await drain(harness.buffer);

		expect(persistence.branchDeletes).toHaveLength(2);
	});

	it('does not let stale v1 success clear v2 and writes v2 in the same generation', async () => {
		// Given
		const sessionId = asSessionId('edge-version-success');
		const gate = createDeferred();
		const persistence = new RecordingPersistence({
			edges: async () => {
				if (persistence.edgeWrites.length === 1) await gate.promise;
			},
		});
		const harness = createHarness({ persistence });
		const v1 = [edge(sessionId, 'v1', 1)];
		const v2 = [...v1, edge(sessionId, 'v2', 2)];
		acceptThought(harness, sessionId, 1);
		acceptEdges(harness, sessionId, v1);

		// When
		const generation = settle(drain(harness.buffer));
		await flushMicrotasks();
		acceptEdges(harness, sessionId, v2);
		gate.resolve();
		const outcome = await generation;

		// Then
		expect(outcome).toEqual({ status: 'fulfilled' });
		expect(persistence.edgeWrites.map((write) => write.snapshot.map((item) => item.id))).toEqual([
			v1.map((item) => item.id),
			v2.map((item) => item.id),
		]);
	});

	it('does not let stale v1 failure fail v2 when v2 succeeds in the same generation', async () => {
		// Given
		const sessionId = asSessionId('edge-version-failure');
		const gate = createDeferred();
		const persistence = new RecordingPersistence({
			edges: async () => {
				if (persistence.edgeWrites.length === 1) {
					await gate.promise;
					throw new ExpectedWriteError('stale v1 failure');
				}
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		const v1 = [edge(sessionId, 'failure-v1', 1)];
		const v2 = [...v1, edge(sessionId, 'failure-v2', 2)];
		acceptThought(harness, sessionId, 1);
		acceptEdges(harness, sessionId, v1);

		// When
		const generation = settle(drain(harness.buffer));
		await flushMicrotasks();
		acceptEdges(harness, sessionId, v2);
		gate.resolve();
		const outcome = await generation;

		// Then
		expect(outcome).toEqual({ status: 'fulfilled' });
		expect(persistence.edgeWrites.map((write) => write.snapshot.length)).toEqual([1, 2]);
	});
});

describe('PersistenceBuffer session-filtered barriers', () => {
	it('selects only requested session work and projects only its terminal failure', () => {
		// Given
		const sessionA = asSessionId('queue-session-a');
		const sessionB = asSessionId('queue-session-b');
		const queue = new PersistenceWorkQueue();
		const workA = queue.enqueueThought(sessionA, createTestThought({ session_id: sessionA }));
		const workB = queue.enqueueThought(sessionB, createTestThought({ session_id: sessionB }));
		const failureA = new ExpectedWriteError('A failed');
		const failureB = new ExpectedWriteError('B failed');
		queue.acknowledgeFailure(workA, {
			kind: 'thought',
			token: workA.token,
			sessionId: sessionA,
			attempts: 1,
			cause: failureA,
		});
		queue.acknowledgeFailure(workB, {
			kind: 'thought',
			token: workB.token,
			sessionId: sessionB,
			attempts: 1,
			cause: failureB,
		});

		// When
		const selected = queue.nextEligibleWork(new Set(), 'explicit', sessionB);
		const result = queue.generationResult(undefined, sessionB);

		// Then
		expect(selected).toMatchObject({ token: workB.token, sessionId: sessionB });
		expect(result.failures).toEqual([
			{ kind: 'thought', token: workB.token, sessionId: sessionB, attempts: 1, cause: failureB },
		]);
	});

	it('joins an active global generation and includes A work accepted while B is blocked', async () => {
		// Given
		const sessionA = asSessionId('join-session-a');
		const sessionB = asSessionId('join-session-b');
		const gate = createDeferred();
		const persistence = new RecordingPersistence({
			thought: async ({ thought }) => {
				if (thought.session_id === sessionB) await gate.promise;
			},
		});
		const harness = createHarness({ persistence });
		acceptThought(harness, sessionB, 1);
		const globalDrain = settle(drain(harness.buffer));
		await flushMicrotasks();

		// When
		const sessionDrain = drainSession(harness.buffer, sessionA);
		const sessionSettled = settlementProbe(sessionDrain);
		acceptThought(harness, sessionA, 1);
		await flushMicrotasks();
		const settledBeforeRelease = sessionSettled();
		gate.resolve();
		const [globalOutcome, sessionOutcome] = await Promise.all([globalDrain, settle(sessionDrain)]);

		// Then
		expect(settledBeforeRelease).toBe(false);
		expect(globalOutcome).toEqual({ status: 'fulfilled' });
		expect(sessionOutcome).toEqual({ status: 'fulfilled' });
		expect(persistence.thoughtWrites.map((write) => write.thought.session_id)).toEqual([
			sessionB,
			sessionA,
		]);
	});

	it('resolves A projection when only B fails while the global generation rejects', async () => {
		// Given
		const sessionA = asSessionId('projection-a');
		const sessionB = asSessionId('projection-b');
		const persistence = new RecordingPersistence({
			thought: async ({ thought }) => {
				if (thought.session_id === sessionB) throw new ExpectedWriteError('B failed');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptThought(harness, sessionA, 1);
		acceptThought(harness, sessionB, 1);

		// When
		const globalDrain = settle(drain(harness.buffer));
		const sessionDrain = settle(drainSession(harness.buffer, sessionA));
		const [globalOutcome, sessionOutcome] = await Promise.all([globalDrain, sessionDrain]);

		// Then
		expect(globalOutcome).toMatchObject({ status: 'rejected' });
		expect(sessionOutcome).toEqual({ status: 'fulfilled' });
	});

	it('rejects A with only A failures and rearms retained A work on a later session drain', async () => {
		// Given
		const sessionA = asSessionId('failure-a');
		const sessionB = asSessionId('failure-b');
		let failA = true;
		const persistence = new RecordingPersistence({
			thought: async ({ thought }) => {
				if (thought.session_id === sessionA && failA) throw new ExpectedWriteError('A failed');
				if (thought.session_id === sessionB) throw new ExpectedWriteError('B failed');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptThought(harness, sessionA, 1);
		acceptThought(harness, sessionB, 1);

		// When
		const first = await settle(drainSession(harness.buffer, sessionA));
		failA = false;
		const second = await settle(drainSession(harness.buffer, sessionA));

		// Then
		expect(first).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				failures: [{ sessionId: sessionA, kind: 'thought', attempts: 1 }],
			},
		});
		expect(second).toEqual({ status: 'fulfilled' });
		expect(
			persistence.thoughtWrites.filter((write) => write.thought.session_id === sessionA)
		).toHaveLength(2);
	});

	it('propagates an unrelated coordinator fault unchanged', async () => {
		// Given
		const sessionId = asSessionId('coordinator-session');
		const fault = new CoordinatorFault();
		const persistence = new RecordingPersistence({
			thought: async () => {
				throw new ExpectedWriteError('retry once');
			},
		});
		const harness = createHarness({
			persistence,
			maxRetries: 1,
			delay: async () => {
				throw fault;
			},
		});
		acceptThought(harness, sessionId, 1);

		// When
		const outcome = await settle(drainSession(harness.buffer, sessionId));

		// Then
		expect(outcome).toEqual({ status: 'rejected', reason: fault });
	});

	it('keeps a reset-like continuation pending until accepted A work settles', async () => {
		// Given
		const sessionId = asSessionId('reset-order');
		const gate = createDeferred();
		const persistence = new RecordingPersistence({ thought: async () => gate.promise });
		const harness = createHarness({ persistence });
		acceptThought(harness, sessionId, 1);
		let continuationRan = false;

		// When
		const continuation = drainSession(harness.buffer, sessionId).then(() => {
			continuationRan = true;
		});
		await flushMicrotasks();
		const ranBeforeRelease = continuationRan;
		gate.resolve();
		await settle(continuation);

		// Then
		expect(ranBeforeRelease).toBe(false);
		expect(continuationRan).toBe(true);
	});
});

describe('PersistenceBuffer exclusive session lifecycle barrier', () => {
	it('closes A admission synchronously, waits for prior A, and does not wait for blocked B', async () => {
		// Given
		const sessionA = asSessionId('barrier-session-a');
		const sessionB = asSessionId('barrier-session-b');
		const oldAGate = createDeferred();
		const blockedBGate = createDeferred();
		const clearGate = createDeferred();
		const blockedBStarted = createDeferred();
		const clearStarted = createDeferred();
		const events: string[] = [];
		const persistence = new RecordingPersistence({
			thought: async ({ thought }) => {
				events.push(`${thought.id}:start`);
				if (thought.id === asThoughtId('barrier-session-a-thought-1')) await oldAGate.promise;
				if (thought.id === asThoughtId('barrier-session-b-thought-1')) {
					blockedBStarted.resolve();
					await blockedBGate.promise;
				}
				events.push(`${thought.id}:complete`);
			},
		});
		const harness = createHarness({ persistence });
		acceptThought(harness, sessionA, 1);
		const globalDrain = settle(drain(harness.buffer));
		await flushMicrotasks();

		// When
		const barrier = harness.buffer.withSessionBarrier(sessionA, async () => {
			events.push('clear:start');
			clearStarted.resolve();
			await clearGate.promise;
			events.push('clear:complete');
			return 'cleared';
		});
		const barrierSettled = settlementProbe(barrier.then(() => undefined));
		let closedAdmissionError: unknown;
		try {
			acceptThought(harness, sessionA, 2);
		} catch (error) {
			closedAdmissionError = error;
		}
		acceptThought(harness, sessionB, 1);
		await flushMicrotasks();

		// Then
		try {
			expect(closedAdmissionError).toMatchObject({
				name: 'PersistenceSessionAdmissionClosedError',
				sessionId: sessionA,
			});
			expect([...events]).toEqual(['barrier-session-a-thought-1:start']);
			expect(barrierSettled()).toBe(false);

			oldAGate.resolve();
			await Promise.all([blockedBStarted.promise, clearStarted.promise]);
			expect([...events]).toEqual([
				'barrier-session-a-thought-1:start',
				'barrier-session-a-thought-1:complete',
				'barrier-session-b-thought-1:start',
				'clear:start',
			]);
			expect(barrierSettled()).toBe(false);

			const blockedAdmissions = [
				() => acceptThought(harness, sessionA, 3),
				() =>
					acceptBranch(harness.buffer, sessionA, asBranchId('blocked-branch'), [
						createTestThought({ session_id: sessionA }),
					]),
				() => acceptEdges(harness, sessionA, [edge(sessionA, 'blocked-edge', 1)]),
				() => acceptSummaries(harness.buffer, sessionA, [summary(sessionA, 'blocked-summary')]),
			];
			const callbackAdmissionErrors: unknown[] = [];
			for (const admission of blockedAdmissions) {
				try {
					admission();
				} catch (error) {
					callbackAdmissionErrors.push(error);
				}
			}
			expect(callbackAdmissionErrors).toHaveLength(4);
			for (const error of callbackAdmissionErrors) {
				expect(error).toMatchObject({
					name: 'PersistenceSessionAdmissionClosedError',
					sessionId: sessionA,
				});
			}

			clearGate.resolve();
			expect(await barrier).toBe('cleared');
			await flushMicrotasks();
			expect(barrierSettled()).toBe(true);
			acceptThought(harness, sessionA, 4);
		} finally {
			oldAGate.resolve();
			clearGate.resolve();
			blockedBGate.resolve();
		}
		const globalOutcome = await globalDrain;

		// Then
		expect(globalOutcome).toEqual({ status: 'fulfilled' });
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([
			1, 1, 4,
		]);
	});

	it('rejects completion-triggered stale A admission while the callback owns A', async () => {
		// Given
		const sessionA = asSessionId('completion-race-a');
		const oldGate = createDeferred();
		const persistence = new RecordingPersistence({ thought: async () => oldGate.promise });
		const harness = createHarness({ persistence });
		acceptThought(harness, sessionA, 1);
		const globalDrain = drain(harness.buffer);
		await flushMicrotasks();
		let racingAdmissionError: unknown;

		// When
		const barrier = harness.buffer.withSessionBarrier(sessionA, async () => {
			await Promise.resolve();
		});
		void globalDrain.then(() => {
			try {
				acceptThought(harness, sessionA, 2);
			} catch (error) {
				racingAdmissionError = error;
			}
		});
		oldGate.resolve();
		await Promise.all([globalDrain, barrier]);

		// Then
		expect(racingAdmissionError).toMatchObject({
			name: 'PersistenceSessionAdmissionClosedError',
			sessionId: sessionA,
		});
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([1]);
	});

	it('rejects on exhausted prior A work without running the lifecycle callback', async () => {
		// Given
		const sessionA = asSessionId('barrier-failure-a');
		const failure = new ExpectedWriteError('A cannot settle');
		const persistence = new RecordingPersistence({
			thought: async () => {
				throw failure;
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptThought(harness, sessionA, 1);
		let callbackCount = 0;

		// When
		const outcome = await settle(
			harness.buffer.withSessionBarrier(sessionA, async () => {
				callbackCount += 1;
			})
		);

		// Then
		expect(outcome).toMatchObject({
			status: 'rejected',
			reason: {
				name: 'PersistenceDrainError',
				failures: [{ sessionId: sessionA, attempts: 1, cause: failure }],
			},
		});
		expect(callbackCount).toBe(0);
	});

	it('serializes repeated A barriers in call order without duplicate accepted writes', async () => {
		// Given
		const sessionA = asSessionId('serialized-barrier-a');
		const firstGate = createDeferred();
		const secondGate = createDeferred();
		const firstStarted = createDeferred();
		const secondStarted = createDeferred();
		const events: string[] = [];
		const persistence = new RecordingPersistence();
		const harness = createHarness({ persistence });
		acceptThought(harness, sessionA, 1);

		// When
		const first = harness.buffer.withSessionBarrier(sessionA, async () => {
			events.push('first:start');
			firstStarted.resolve();
			await firstGate.promise;
			events.push('first:complete');
			return 1;
		});
		const second = harness.buffer.withSessionBarrier(sessionA, async () => {
			events.push('second:start');
			secondStarted.resolve();
			await secondGate.promise;
			events.push('second:complete');
			return 2;
		});
		await firstStarted.promise;

		// Then
		try {
			expect([...events]).toEqual(['first:start']);
			let closedAdmissionError: unknown;
			try {
				acceptThought(harness, sessionA, 2);
			} catch (error) {
				closedAdmissionError = error;
			}
			expect(closedAdmissionError).toMatchObject({
				name: 'PersistenceSessionAdmissionClosedError',
				sessionId: sessionA,
			});

			firstGate.resolve();
			expect(await first).toBe(1);
			await secondStarted.promise;
			expect([...events]).toEqual(['first:start', 'first:complete', 'second:start']);

			secondGate.resolve();
			expect(await second).toBe(2);
			acceptThought(harness, sessionA, 3);
			await drain(harness.buffer);
		} finally {
			firstGate.resolve();
			secondGate.resolve();
		}

		// Then
		expect(events).toEqual(['first:start', 'first:complete', 'second:start', 'second:complete']);
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([1, 3]);
	});

	it('rejects awaited same-chain A reentrancy without disturbing external A FIFO or nested B', async () => {
		// Given
		const sessionA = asSessionId('reentrant-barrier-a');
		const sessionB = asSessionId('reentrant-barrier-b');
		const nestedAttempted = createDeferred();
		const externalStarted = createDeferred();
		const externalRelease = createDeferred();
		const events: string[] = [];
		const persistence = new RecordingPersistence();
		const harness = createHarness({ persistence });
		let nestedCallbackEntered = false;
		let nestedError: unknown;
		let nestedSettled = false;

		// When
		const outer = harness.buffer.withSessionBarrier(sessionA, async () => {
			events.push('outer-a:start');
			await harness.buffer.withSessionBarrier(sessionB, async () => {
				events.push('nested-b:start');
				events.push('nested-b:complete');
			});
			const nested = harness.buffer.withSessionBarrier(sessionA, async () => {
				nestedCallbackEntered = true;
			});
			nestedAttempted.resolve();
			try {
				await nested;
			} catch (error) {
				nestedError = error;
				events.push('nested-a:rejected');
			} finally {
				nestedSettled = true;
			}
			events.push('outer-a:complete');
		});
		const external = harness.buffer.withSessionBarrier(sessionA, async () => {
			events.push('external-a:start');
			externalStarted.resolve();
			await externalRelease.promise;
			events.push('external-a:complete');
		});
		const outerOutcome = settle(outer);
		const externalOutcome = settle(external);
		await nestedAttempted.promise;
		await flushMicrotasks();

		// Then
		expect(nestedSettled).toBe(true);
		expect(nestedCallbackEntered).toBe(false);
		expect(nestedError).toBeInstanceOf(PersistenceSessionBarrierReentrancyError);
		expect(nestedError).toMatchObject({
			name: 'PersistenceSessionBarrierReentrancyError',
			code: 'PERSISTENCE_SESSION_BARRIER_REENTRANCY',
			sessionId: sessionA,
			message: `Persistence lifecycle barrier for session '${sessionA}' is not reentrant`,
		});
		await externalStarted.promise;
		expect(events).toEqual([
			'outer-a:start',
			'nested-b:start',
			'nested-b:complete',
			'nested-a:rejected',
			'outer-a:complete',
			'external-a:start',
		]);
		expect(() => acceptThought(harness, sessionA, 1)).toThrow(
			expect.objectContaining({ name: 'PersistenceSessionAdmissionClosedError' })
		);

		externalRelease.resolve();
		expect(await Promise.all([outerOutcome, externalOutcome])).toEqual([
			{ status: 'fulfilled' },
			{ status: 'fulfilled' },
		]);
		acceptThought(harness, sessionA, 2);
		await drain(harness.buffer);
		expect(events.at(-1)).toBe('external-a:complete');
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([2]);
	});

	it('quarantines a failed scoped reset until successful deletion discards stale A work', async () => {
		// Given
		const sessionA = asSessionId('reset-quarantine-a');
		const sessionB = asSessionId('reset-quarantine-b');
		const events: string[] = [];
		let deletionFails = true;
		const persistence = new RecordingPersistence({
			thought: async ({ sessionId, thought }) => {
				events.push(`write:${sessionId}:${thought.thought_number}`);
				if (sessionId === sessionA && thought.thought_number === 1) {
					throw new ExpectedWriteError('stale A write');
				}
			},
			clearSession: async (sessionId) => {
				events.push(`clear:${sessionId}:${deletionFails ? 'failed' : 'succeeded'}`);
				if (deletionFails) throw new ExpectedWriteError('scoped deletion failed');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptThought(harness, sessionA, 1);
		expect((await settle(drain(harness.buffer))).status).toBe('rejected');

		// When
		const failedReset = await settle(
			harness.buffer.withSessionResetBarrier(sessionA, () => persistence.clearSession(sessionA))
		);

		// Then
		expect(failedReset.status).toBe('rejected');
		expect(() => acceptThought(harness, sessionA, 2)).toThrow(
			expect.objectContaining({ name: 'PersistenceSessionAdmissionClosedError' })
		);
		acceptThought(harness, sessionB, 1);
		expect((await settle(drain(harness.buffer))).status).toBe('rejected');
		expect(events).toContain(`write:${sessionB}:1`);

		deletionFails = false;
		await harness.buffer.withSessionResetBarrier(sessionA, () =>
			persistence.clearSession(sessionA)
		);
		const recoveryIndex = events.indexOf(`clear:${sessionA}:succeeded`);
		acceptThought(harness, sessionA, 2);
		await drain(harness.buffer);
		expect(events.slice(recoveryIndex + 1)).toEqual([`write:${sessionA}:2`]);
	});
});

describe('PersistenceBuffer background joiner regression', () => {
	it('does not duplicate writes or failure observations for timer and capacity joiners', async () => {
		// Given
		const sessionId = asSessionId('background-joiners');
		const gate = createDeferred();
		const events: Error[] = [];
		const persistence = new RecordingPersistence({
			thought: async () => {
				if (persistence.thoughtWrites.length === 1) await gate.promise;
				throw new ExpectedWriteError('generation failure');
			},
		});
		const harness = createHarness({
			persistence,
			maxRetries: 0,
			bufferSize: 1,
			flushInterval: 100,
			eventEmitter: {
				emit(_event, payload) {
					events.push(payload.error);
					return true;
				},
			},
		});
		acceptThought(harness, sessionId, 1);
		harness.buffer.startFlushTimer();
		await vi.advanceTimersByTimeAsync(300);

		// When
		acceptThought(harness, sessionId, 2);
		const joined = settle(drain(harness.buffer));
		harness.buffer.stopFlushTimer();
		gate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		const outcome = await joined;

		// Then
		expect(outcome.status).toBe('rejected');
		expect(persistence.thoughtWrites.map((write) => write.thought.thought_number)).toEqual([1, 2]);
		expect(events).toHaveLength(1);
	});
});

describe('PersistenceBuffer eviction state and barrier', () => {
	it('reports pending, barrier, and quiescent states around accepted work and cleanup', async () => {
		// Given
		const sessionId = asSessionId('eviction-state');
		const writeGate = createDeferred();
		const callbackGate = createDeferred();
		const persistence = new RecordingPersistence({ thought: async () => writeGate.promise });
		const harness = createHarness({ persistence });
		acceptThought(harness, sessionId, 1);
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('pending');

		// When
		const barrier = harness.buffer.withSessionEvictionBarrier(sessionId, async () => {
			await callbackGate.promise;
		});

		// Then
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('barrier');
		writeGate.resolve();
		await flushMicrotasks();
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('barrier');
		callbackGate.resolve();
		await barrier;
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('quiescent');
	});

	it('retains failed work and quarantine until one later explicit eviction retry succeeds', async () => {
		// Given
		const sessionId = asSessionId('eviction-failure');
		let writeFails = true;
		const persistence = new RecordingPersistence({
			thought: async () => {
				if (writeFails) throw new ExpectedWriteError('retained failure');
			},
		});
		const harness = createHarness({ persistence, maxRetries: 0 });
		acceptThought(harness, sessionId, 1);
		const cleanup = vi.fn(async () => undefined);

		// When
		const first = await settle(harness.buffer.withSessionEvictionBarrier(sessionId, cleanup));

		// Then
		expect(first.status).toBe('rejected');
		expect(cleanup).not.toHaveBeenCalled();
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('failed');
		expect(() => acceptThought(harness, sessionId, 2)).toThrow(
			expect.objectContaining({ name: 'PersistenceSessionAdmissionClosedError' })
		);

		writeFails = false;
		await harness.buffer.withSessionEvictionBarrier(sessionId, cleanup);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(persistence.thoughtWrites).toHaveLength(2);
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('quiescent');
	});

	it('quarantines callback failure and clears it after a successful explicit retry', async () => {
		// Given
		const sessionId = asSessionId('callback-failure');
		const harness = createHarness({ persistence: new RecordingPersistence() });
		const failure = new ExpectedWriteError('cleanup failed');

		// When
		const first = await settle(
			harness.buffer.withSessionEvictionBarrier(sessionId, async () => Promise.reject(failure))
		);

		// Then
		expect(first).toEqual({ status: 'rejected', reason: failure });
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('failed');
		await harness.buffer.withSessionEvictionBarrier(sessionId, async () => undefined);
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('quiescent');
	});

	it('rejects same-chain eviction barrier reentrancy before joining its own tail', async () => {
		// Given
		const sessionId = asSessionId('eviction-reentrant');
		const harness = createHarness({ persistence: new RecordingPersistence() });
		let nestedEntered = false;

		// When
		const result = harness.buffer.withSessionEvictionBarrier(sessionId, async () =>
			harness.buffer.withSessionEvictionBarrier(sessionId, async () => {
				nestedEntered = true;
			})
		);

		// Then
		await expect(result).rejects.toBeInstanceOf(PersistenceSessionBarrierReentrancyError);
		expect(nestedEntered).toBe(false);
	});

	it('forgets only quiescent queue coordinates and never discards accepted work', () => {
		// Given
		const sessionId = asSessionId('coordinate-cleanup');
		const queue = new PersistenceWorkQueue();
		const first = queue.replaceEdges(sessionId, [edge(sessionId, 'first', 1)]);

		// When
		const pendingForgotten = queue.forgetQuiescentSession(sessionId);
		queue.acknowledgeSuccess(first);
		const quiescentForgotten = queue.forgetQuiescentSession(sessionId);
		const next = queue.replaceEdges(sessionId, [edge(sessionId, 'next', 2)]);

		// Then
		expect(pendingForgotten).toBe(false);
		expect(quiescentForgotten).toBe(true);
		expect(next.version).toBe(1);
		expect(queue.hasSessionWork(sessionId)).toBe(true);
		expect(queue.hasSessionTerminalFailure(sessionId)).toBe(false);
	});

	it('successful scoped reset clears a prior eviction quarantine', async () => {
		// Given
		const sessionId = asSessionId('eviction-then-reset');
		const harness = createHarness({ persistence: new RecordingPersistence() });
		await settle(
			harness.buffer.withSessionEvictionBarrier(sessionId, async () =>
				Promise.reject(new ExpectedWriteError('eviction cleanup failed'))
			)
		);
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('failed');

		// When
		await harness.buffer.withSessionResetBarrier(sessionId, async () => undefined);

		// Then
		expect(harness.buffer.sessionEvictionState(sessionId)).toBe('quiescent');
		expect(() => acceptThought(harness, sessionId, 1)).not.toThrow();
	});

	it('rejects a new eviction barrier after global reset closes admission', async () => {
		// Given
		const sessionId = asSessionId('global-reset-eviction');
		const harness = createHarness({ persistence: new RecordingPersistence() });
		const resetGate = createDeferred();
		const globalReset = harness.buffer.withGlobalResetBarrier(async () => resetGate.promise);

		// When
		const stateDuringReset = harness.buffer.sessionEvictionState(sessionId);
		const eviction = harness.buffer.withSessionEvictionBarrier(sessionId, async () => undefined);

		// Then
		await expect(eviction).rejects.toMatchObject({
			name: 'PersistenceSessionAdmissionClosedError',
			sessionId,
		});
		expect(stateDuringReset).toBe('barrier');
		resetGate.resolve();
		await globalReset;
	});

	it('attributes work and terminal failure introspection across every queue work kind', () => {
		// Given
		const thoughtSession = asSessionId('introspection-thought');
		const branchSession = asSessionId('introspection-branch');
		const edgeSession = asSessionId('introspection-edge');
		const summarySession = asSessionId('introspection-summary');
		const queue = new PersistenceWorkQueue();
		const thoughtWork = queue.enqueueThought(
			thoughtSession,
			createTestThought({ session_id: thoughtSession })
		);
		queue.replaceBranch(branchSession, asBranchId('introspection'), []);
		queue.replaceEdges(edgeSession, []);
		queue.replaceSummaries(summarySession, []);
		queue.acknowledgeFailure(thoughtWork, {
			kind: 'thought',
			token: thoughtWork.token,
			sessionId: thoughtSession,
			attempts: 1,
			cause: new ExpectedWriteError('terminal'),
		});

		// When
		const states = [thoughtSession, branchSession, edgeSession, summarySession].map(
			(sessionId) => ({
				hasWork: queue.hasSessionWork(sessionId),
				hasFailure: queue.hasSessionTerminalFailure(sessionId),
			})
		);

		// Then
		expect(states).toEqual([
			{ hasWork: true, hasFailure: true },
			{ hasWork: true, hasFailure: false },
			{ hasWork: true, hasFailure: false },
			{ hasWork: true, hasFailure: false },
		]);
	});
});
