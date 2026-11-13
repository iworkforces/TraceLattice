import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PersistenceDrainError,
	PersistenceWriteTimeoutError,
} from '../../core/PersistenceBufferErrors.js';
import { asSessionId } from '../../contracts/ids.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';

const ownedBackend = vi.hoisted(() => ({ current: null as StallingPersistence | null }));

vi.mock('../../persistence/PersistenceFactory.js', () => ({
	createPersistenceBackend: async () => ownedBackend.current,
}));

const TIMEOUT_MS = 1000;
const SESSION_ID = 'write-deadline-session';

type TrackedStop = {
	readonly result: Promise<unknown>;
	readonly isSettled: () => boolean;
};

const backends = new Set<StallingPersistence>();

function deadlineConfig(): ServerConfig {
	return new ServerConfig({
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 3,
		persistenceWriteTimeout: TIMEOUT_MS,
		features: { toolInterleave: false },
	});
}

async function createDeadlineServer(
	persistence: StallingPersistence
): Promise<ToolAwareSequentialThinkingServer> {
	backends.add(persistence);
	return createServer({
		config: deadlineConfig(),
		persistenceBackend: persistence,
		autoDiscover: false,
		loadFromPersistence: false,
		enableWatcher: false,
	});
}

async function createOwnedServer(
	persistence: StallingPersistence
): Promise<ToolAwareSequentialThinkingServer> {
	backends.add(persistence);
	ownedBackend.current = persistence;
	return createServer({
		config: deadlineConfig(),
		autoDiscover: false,
		loadFromPersistence: false,
		enableWatcher: false,
	});
}

function aggregatedErrors(error: unknown): readonly unknown[] {
	return error instanceof AggregateError ? error.errors : [];
}

function trackStop(server: ToolAwareSequentialThinkingServer): TrackedStop {
	let settled = false;
	const result = server.stop().then(
		() => undefined,
		(error: unknown) => error
	);
	void result.then(() => {
		settled = true;
	});
	return { result, isSettled: () => settled };
}

function thoughtInput(thoughtNumber: number, sessionId: string = SESSION_ID) {
	return {
		thought: `deadline thought ${thoughtNumber}`,
		thought_number: thoughtNumber,
		total_thoughts: 3,
		next_thought_needed: true,
		session_id: sessionId,
	};
}

function holdEveryCall(persistence: StallingPersistence): void {
	persistence.holdWrites = true;
	persistence.holdClears = true;
	persistence.holdClose = true;
}

async function stallFirstWrite(server: ToolAwareSequentialThinkingServer): Promise<unknown> {
	const drained = server.history.drainSession(asSessionId(SESSION_ID)).then(
		() => undefined,
		(error: unknown) => error
	);
	await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
	return drained;
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
	for (const backend of backends) {
		backend.holdWrites = false;
		backend.holdClears = false;
		backend.holdClose = false;
		while (backend.heldCallCount > 0) backend.releaseHeldCall();
	}
	backends.clear();
	ownedBackend.current = null;
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('server persistence write deadline', () => {
	it('ends a stalled shutdown flush at the configured persistenceWriteTimeout', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createDeadlineServer(persistence);
		await server.processThought(thoughtInput(1));
		persistence.holdWrites = true;

		// When
		const stopping = trackStop(server);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
		const settledBeforeDeadline = stopping.isSettled();
		await vi.advanceTimersByTimeAsync(1);
		const error = await stopping.result;

		// Then
		expect(settledBeforeDeadline).toBe(false);
		expect(error).toBeInstanceOf(AggregateError);
		const [drainError] = error instanceof AggregateError ? error.errors : [];
		expect(drainError).toBeInstanceOf(PersistenceDrainError);
		const failures = drainError instanceof PersistenceDrainError ? drainError.failures : [];
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ kind: 'thought', attempts: 1 });
		expect(failures[0]?.cause).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(failures[0]?.cause).toMatchObject({ timeoutMs: TIMEOUT_MS });
		expect(persistence.thoughtAttempts).toBe(1);
		expect(persistence.closeCalls).toBe(0);
	});

	it('settles stop at persistenceWriteTimeout when an owned backend close never settles', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		persistence.holdClose = true;

		// When
		const stopping = trackStop(server);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
		const settledBeforeDeadline = stopping.isSettled();
		await vi.advanceTimersByTimeAsync(1);
		const error = await stopping.result;

		// Then
		expect(settledBeforeDeadline).toBe(false);
		expect(error).toBeInstanceOf(AggregateError);
		const errors = aggregatedErrors(error);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(errors[0]).toMatchObject({
			code: 'PERSISTENCE_WRITE_TIMEOUT',
			timeoutMs: TIMEOUT_MS,
			call: { kind: 'close' },
		});
		expect(persistence.closeCalls).toBe(1);
	});

	it('aggregates an owned backend close that rejects before the deadline', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		persistence.holdClose = true;
		const closeFailure = new Error('close failed');

		// When
		const stopping = trackStop(server);
		await vi.advanceTimersByTimeAsync(0);
		persistence.releaseHeldCall(closeFailure);
		const error = await stopping.result;

		// Then
		expect(aggregatedErrors(error)).toEqual([closeFailure]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('closes an owned backend that settles in time and resolves stop', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);

		// When
		const error = await trackStop(server).result;

		// Then
		expect(error).toBeUndefined();
		expect(persistence.closeCalls).toBe(1);
	});

	it('never closes an injected backend at shutdown', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createDeadlineServer(persistence);
		persistence.holdClose = true;

		// When
		const error = await trackStop(server).result;

		// Then
		expect(error).toBeUndefined();
		expect(persistence.closeCalls).toBe(0);
		expect(persistence.heldCallCount).toBe(0);
	});
});

describe('server behaviour while a timed-out write is pending', () => {
	it('keeps answering tool calls in every session', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createDeadlineServer(persistence);
		persistence.holdWrites = true;
		await server.processThought(thoughtInput(1));
		const drainError = await stallFirstWrite(server);

		// When
		const sameSession = await server.processThought(thoughtInput(2));
		const otherSession = await server.processThought(thoughtInput(1, 'write-deadline-other'));

		// Then
		expect(drainError).toBeInstanceOf(PersistenceDrainError);
		expect(sameSession.isError).toBeUndefined();
		expect(otherSession.isError).toBeUndefined();
		expect(persistence.maxConcurrentWrites).toBe(1);
		expect(server.history.getPersistenceBacklogView()).toMatchObject({
			retainedFailureCount: 1,
			blockedSessionCount: 1,
		});
	});

	it('saves a late success exactly once and drains the writes buffered meanwhile', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createDeadlineServer(persistence);
		persistence.holdWrites = true;
		await server.processThought(thoughtInput(1));
		await stallFirstWrite(server);
		await server.processThought(thoughtInput(2));

		// When
		persistence.holdWrites = false;
		persistence.releaseHeldCall();
		await vi.advanceTimersByTimeAsync(0);
		await server.history.drainSession(asSessionId(SESSION_ID));

		// Then
		const saved = await persistence.loadHistoryForSession(asSessionId(SESSION_ID));
		expect(saved.map((thought) => thought.thought_number)).toEqual([1, 2]);
		expect(new Set(saved.map((thought) => thought.id)).size).toBe(2);
		expect(persistence.thoughtAttempts).toBe(2);
		expect(persistence.maxConcurrentWrites).toBe(1);
	});

	it.each(['owned', 'injected'] as const)(
		'settles stop with aggregated failures when an %s backend never settles any call',
		async (ownership) => {
			// Given
			const persistence = new StallingPersistence();
			const server =
				ownership === 'owned'
					? await createOwnedServer(persistence)
					: await createDeadlineServer(persistence);
			await server.processThought(thoughtInput(1));
			holdEveryCall(persistence);

			// When
			const stopping = trackStop(server);
			await vi.advanceTimersByTimeAsync(2 * TIMEOUT_MS);
			const settled = stopping.isSettled();
			const errors = aggregatedErrors(await stopping.result);

			// Then
			expect(settled).toBe(true);
			expect(errors[0]).toBeInstanceOf(PersistenceDrainError);
			expect(errors.slice(1)).toEqual(
				ownership === 'owned' ? [expect.any(PersistenceWriteTimeoutError)] : []
			);
			expect(persistence.closeCalls).toBe(ownership === 'owned' ? 1 : 0);
			expect(persistence.clearCalls).toBe(0);
			expect(persistence.maxConcurrentWrites).toBe(1);
		}
	);
});
