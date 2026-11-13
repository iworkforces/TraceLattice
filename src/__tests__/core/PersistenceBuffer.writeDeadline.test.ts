import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { asEdgeId, asThoughtId, type SessionId } from '../../contracts/ids.js';
import type { Edge } from '../../core/graph/Edge.js';
import { PersistenceBuffer } from '../../core/PersistenceBuffer.js';
import {
	PersistenceDrainError,
	PersistenceSessionAdmissionClosedError,
	PersistenceWriteTimeoutError,
} from '../../core/PersistenceBufferErrors.js';
import type { ThoughtData } from '../../core/thought.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { createTestSessionId, createTestThought } from '../helpers/factories.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';
import { advanceTimeAsync, useFakeTimers, useRealTimers } from '../helpers/timers.js';

const TIMEOUT_MS = 1000;
const FLUSH_MS = 1000;
const A = createTestSessionId('stall-a');
const B = createTestSessionId('stall-b');
const C = createTestSessionId('stall-c');

type Harness = {
	readonly persistence: StallingPersistence;
	readonly buffer: PersistenceBuffer;
	readonly events: Error[];
	readonly warn: MockInstance;
};

type HarnessOptions = { readonly writeTimeout?: number | undefined; readonly bufferSize?: number };

type Outcome =
	| { readonly status: 'pending' }
	| { readonly status: 'fulfilled' }
	| { readonly status: 'rejected'; readonly reason: unknown };

const harnesses = new Set<Harness>();

function createHarness(options: HarnessOptions = {}): Harness {
	const persistence = new StallingPersistence();
	const events: Error[] = [];
	const logger = new NullLogger();
	const warn = vi.spyOn(logger, 'warn');
	const buffer = new PersistenceBuffer({
		persistence,
		bufferSize: options.bufferSize ?? 100,
		flushInterval: FLUSH_MS,
		maxRetries: 3,
		writeTimeout: 'writeTimeout' in options ? options.writeTimeout : TIMEOUT_MS,
		eventEmitter: {
			emit: (_event, payload) => {
				events.push(payload.error);
				return true;
			},
		},
		logger,
	});
	const harness = { persistence, buffer, events, warn };
	harnesses.add(harness);
	return harness;
}

function thought(sessionId: SessionId, thoughtNumber: number): ThoughtData {
	return createTestThought({
		id: `${sessionId}-${thoughtNumber}`,
		thought_number: thoughtNumber,
		session_id: sessionId,
	});
}

function edge(sessionId: SessionId, suffix: string): Edge {
	return {
		id: asEdgeId(`edge-${suffix}`),
		from: asThoughtId(`from-${suffix}`),
		to: asThoughtId(`to-${suffix}`),
		kind: 'sequence',
		sessionId,
		createdAt: 1,
	};
}

function track(promise: Promise<unknown>): () => Outcome {
	let outcome: Outcome = { status: 'pending' };
	promise.then(
		() => {
			outcome = { status: 'fulfilled' };
		},
		(reason: unknown) => {
			outcome = { status: 'rejected', reason };
		}
	);
	return () => outcome;
}

function reasonOf(outcome: Outcome): unknown {
	return outcome.status === 'rejected' ? outcome.reason : undefined;
}

function firstCause(outcome: Outcome): unknown {
	const reason = reasonOf(outcome);
	return reason instanceof PersistenceDrainError ? reason.failures[0]?.cause : undefined;
}

/** Holds every write, accepts one thought for `sessionId`, and lets its drain time out. */
async function stallFirstWrite(harness: Harness, sessionId: SessionId = A): Promise<Outcome> {
	harness.persistence.holdWrites = true;
	harness.buffer.bufferThought(sessionId, thought(sessionId, 1));
	const drained = track(harness.buffer.drain());
	await advanceTimeAsync(TIMEOUT_MS);
	return drained();
}

/** Joins `drainSession` for A, whose write stalls, and for C, which never had work. */
function joinDrainSessions(harness: Harness): {
	readonly stalledSession: () => Outcome;
	readonly sessionWithoutWork: () => Outcome;
} {
	return {
		stalledSession: track(harness.buffer.drainSession(A)),
		sessionWithoutWork: track(harness.buffer.drainSession(C)),
	};
}

beforeEach(() => {
	useFakeTimers();
});

afterEach(async () => {
	for (const { buffer, persistence } of harnesses) {
		buffer.stopFlushTimer();
		persistence.holdWrites = false;
		persistence.holdClears = false;
		while (persistence.heldCallCount > 0) persistence.releaseHeldCall();
	}
	await advanceTimeAsync(0);
	harnesses.clear();
	vi.clearAllTimers();
	useRealTimers();
});

describe('PersistenceBuffer write deadline gate', () => {
	it('rejects the drain that dispatched a stalled write at the deadline and reports it once', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		harness.buffer.bufferThought(A, thought(A, 1));

		// When
		const drained = track(harness.buffer.drain());
		await advanceTimeAsync(TIMEOUT_MS - 1);
		const beforeDeadline = drained();
		await advanceTimeAsync(1);

		// Then
		expect(beforeDeadline.status).toBe('pending');
		expect(firstCause(drained())).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(harness.events).toHaveLength(1);
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(harness.buffer.getBacklogView()).toMatchObject({
			retainedFailureCount: 1,
			blockedSessionCount: 1,
			pendingThoughtCount: 1,
		});
	});

	it('fails later drain, flush and drainSession calls at once while the call is pending', async () => {
		// Given
		const harness = createHarness();
		await stallFirstWrite(harness);

		// When
		const outcomes = [
			track(harness.buffer.drain()),
			track(harness.buffer.flush()),
			track(harness.buffer.drainSession(A)),
		];
		const sessionWithoutWork = track(harness.buffer.drainSession(B));
		await advanceTimeAsync(0);

		// Then
		for (const outcome of outcomes) {
			expect(reasonOf(outcome())).toBeInstanceOf(PersistenceWriteTimeoutError);
			expect(reasonOf(outcome())).toMatchObject({ code: 'PERSISTENCE_WRITE_TIMEOUT' });
		}
		expect(sessionWithoutWork().status).toBe('fulfilled');
		expect(harness.persistence.thoughtAttempts).toBe(1);
		expect(harness.events).toHaveLength(1);
	});

	it('rejects a drainSession joined before the timeout while its session still has work', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		harness.buffer.bufferThought(A, thought(A, 1));
		harness.buffer.bufferThought(B, thought(B, 1));

		// When
		const sessionB = track(harness.buffer.drainSession(B));
		await advanceTimeAsync(TIMEOUT_MS);

		// Then
		expect(reasonOf(sessionB())).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(await harness.persistence.loadHistoryForSession(B)).toHaveLength(0);
	});

	it.each([
		{
			stall: 'retained',
			start: async (harness: Harness) => {
				harness.persistence.holdWrites = true;
				harness.buffer.bufferThought(A, thought(A, 1));
				return joinDrainSessions(harness);
			},
		},
		{
			stall: 'superseded',
			start: async (harness: Harness) => {
				harness.persistence.holdWrites = true;
				harness.buffer.bufferEdges(A, [edge(A, 'v1')]);
				void track(harness.buffer.drain());
				await advanceTimeAsync(0);
				harness.buffer.bufferEdges(A, [edge(A, 'v2')]);
				return joinDrainSessions(harness);
			},
		},
		{
			stall: 'rejected at join',
			start: async (harness: Harness) => {
				await stallFirstWrite(harness);
				return joinDrainSessions(harness);
			},
		},
	])(
		'resolves drainSession for a session without work and rejects it for the stalled session ($stall)',
		async ({ start }) => {
			// Given
			const harness = createHarness();

			// When
			const { stalledSession, sessionWithoutWork } = await start(harness);
			await advanceTimeAsync(TIMEOUT_MS);

			// Then
			expect(sessionWithoutWork().status).toBe('fulfilled');
			expect(stalledSession().status).toBe('rejected');
		}
	);

	it('keeps timer and size triggers inert while the timed-out call is pending', async () => {
		// Given
		const harness = createHarness({ bufferSize: 2 });
		await stallFirstWrite(harness);
		harness.buffer.startFlushTimer();

		// When
		harness.buffer.bufferThought(B, thought(B, 1));
		harness.buffer.bufferThought(B, thought(B, 2));
		await advanceTimeAsync(10 * FLUSH_MS);

		// Then
		expect(harness.persistence.thoughtAttempts).toBe(1);
		expect(harness.persistence.maxConcurrentWrites).toBe(1);
		expect(await harness.persistence.loadHistoryForSession(B)).toHaveLength(0);
		expect(harness.events).toHaveLength(1);
		expect(harness.warn).toHaveBeenCalledTimes(1);
	});

	it('applies a late success once and resumes background draining of other sessions', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		harness.buffer.bufferThought(A, thought(A, 1));
		harness.buffer.bufferThought(B, thought(B, 1));
		void track(harness.buffer.drain());
		await advanceTimeAsync(TIMEOUT_MS);
		harness.buffer.startFlushTimer();
		await advanceTimeAsync(3 * FLUSH_MS);
		const sessionBWhileStalled = await harness.persistence.loadHistoryForSession(B);

		// When
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);
		const pendingAfterRelease = harness.buffer.pendingThoughtCount;
		await advanceTimeAsync(FLUSH_MS);

		// Then
		expect(sessionBWhileStalled).toHaveLength(0);
		expect(pendingAfterRelease).toBe(1);
		expect(await harness.persistence.loadHistoryForSession(A)).toHaveLength(1);
		expect(await harness.persistence.loadHistoryForSession(B)).toHaveLength(1);
		expect(harness.buffer.pendingThoughtCount).toBe(0);
		expect(harness.persistence.thoughtAttempts).toBe(2);
		expect(harness.persistence.maxConcurrentWrites).toBe(1);
		expect(harness.events).toHaveLength(1);
		await expect(harness.buffer.drain()).resolves.toBeUndefined();
	});

	it('counts a late failure as one failed attempt and retries it on the first background backoff', async () => {
		// Given
		const timeout = 1500;
		const harness = createHarness({ writeTimeout: timeout });
		harness.persistence.holdWrites = true;
		harness.buffer.startFlushTimer();
		harness.buffer.bufferThought(A, thought(A, 1));
		await advanceTimeAsync(FLUSH_MS + timeout);

		// When
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall(new Error('late failure'));
		await advanceTimeAsync(0);
		const retainedAfterRelease = harness.buffer.getBacklogView().retainedFailureCount;
		await advanceTimeAsync(FLUSH_MS / 2);
		const attemptsBeforeBackoff = harness.persistence.thoughtAttempts;
		await advanceTimeAsync(FLUSH_MS);

		// Then
		expect(retainedAfterRelease).toBe(1);
		expect(attemptsBeforeBackoff).toBe(1);
		expect(harness.persistence.thoughtAttempts).toBe(2);
		expect(await harness.persistence.loadHistoryForSession(A)).toHaveLength(1);
		expect(harness.buffer.getBacklogView().retainedFailureCount).toBe(0);
		expect(harness.persistence.maxConcurrentWrites).toBe(1);
		expect(harness.events).toHaveLength(1);
	});

	it('lets an explicit drain retry a late failure at once and save it once', async () => {
		// Given
		const harness = createHarness();
		await stallFirstWrite(harness);
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall(new Error('late failure'));
		await advanceTimeAsync(0);

		// When
		const drained = harness.buffer.drain();

		// Then
		await expect(drained).resolves.toBeUndefined();
		expect(await harness.persistence.loadHistoryForSession(A)).toHaveLength(1);
		expect(harness.persistence.thoughtAttempts).toBe(2);
		expect(harness.persistence.maxConcurrentWrites).toBe(1);
	});

	it('rejects session and eviction barriers that were already waiting when the write timed out', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		harness.buffer.bufferThought(A, thought(A, 1));
		harness.buffer.bufferThought(B, thought(B, 1));
		const operation = vi.fn(async () => undefined);

		// When
		const barrier = track(harness.buffer.withSessionBarrier(B, operation));
		const eviction = track(harness.buffer.withSessionEvictionBarrier(A, operation));
		await advanceTimeAsync(TIMEOUT_MS);

		// Then
		expect(reasonOf(barrier())).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(reasonOf(eviction())).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(operation).not.toHaveBeenCalled();
		expect(harness.buffer.sessionEvictionState(A)).toBe('failed');
		expect(harness.persistence.thoughtAttempts).toBe(1);
	});

	it('fails session resets fast through the failed-reset path without clearing', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		harness.buffer.bufferThought(A, thought(A, 1));
		const clear = (sessionId: SessionId) => () => harness.persistence.clearSession(sessionId);
		const waiting = track(harness.buffer.withSessionResetBarrier(A, clear(A)));
		await advanceTimeAsync(TIMEOUT_MS);

		// When
		const late = track(harness.buffer.withSessionResetBarrier(B, clear(B)));
		await advanceTimeAsync(0);

		// Then
		expect(reasonOf(waiting())).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(reasonOf(late())).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(harness.persistence.clearCalls).toBe(0);
		expect(() => harness.buffer.bufferThought(B, thought(B, 1))).toThrow(
			PersistenceSessionAdmissionClosedError
		);
	});

	it.each(['before', 'after'] as const)(
		'fails a global reset started %s the timeout fast without clearing',
		async (start) => {
			// Given
			const harness = createHarness();
			harness.persistence.holdWrites = true;
			harness.buffer.bufferThought(A, thought(A, 1));
			const clearAll = () => harness.persistence.clearAll();
			const stalling = track(
				start === 'before'
					? harness.buffer.withGlobalResetBarrier(clearAll)
					: harness.buffer.drain()
			);

			// When
			await advanceTimeAsync(TIMEOUT_MS);
			const reset =
				start === 'before' ? stalling : track(harness.buffer.withGlobalResetBarrier(clearAll));
			await advanceTimeAsync(0);

			// Then
			expect(reasonOf(reset())).toBeInstanceOf(PersistenceWriteTimeoutError);
			expect(harness.persistence.clearCalls).toBe(0);
			expect(harness.buffer.getBacklogView().globalQuarantined).toBe(true);
		}
	);

	it('ignores a late success for an edge snapshot that a newer version replaced', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		harness.buffer.bufferEdges(A, [edge(A, 'v1')]);
		void track(harness.buffer.drain());
		await advanceTimeAsync(TIMEOUT_MS);
		harness.buffer.bufferEdges(A, [edge(A, 'v2')]);

		// When
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);
		await harness.buffer.drain();

		// Then
		expect(await harness.persistence.loadEdges(A)).toEqual([edge(A, 'v2')]);
		expect(harness.persistence.maxConcurrentWrites).toBe(1);
	});

	it('rejects every drain joined to a stalled edge snapshot superseded in flight', async () => {
		// Given
		const harness = createHarness();
		const saveEdges = vi.spyOn(harness.persistence, 'saveEdges');
		harness.persistence.holdWrites = true;
		harness.buffer.bufferEdges(A, [edge(A, 'v1')]);
		const drained = track(harness.buffer.drain());
		await advanceTimeAsync(0);
		harness.buffer.bufferEdges(A, [edge(A, 'v2')]);
		harness.buffer.bufferThought(B, thought(B, 1));
		const sessionB = track(harness.buffer.drainSession(B));
		const barrierB = track(harness.buffer.withSessionBarrier(B, async () => undefined));

		// When
		await advanceTimeAsync(TIMEOUT_MS);

		// Then
		for (const outcome of [drained, sessionB, barrierB]) {
			expect(reasonOf(outcome())).toBeInstanceOf(PersistenceWriteTimeoutError);
			expect(reasonOf(outcome())).toMatchObject({ code: 'PERSISTENCE_WRITE_TIMEOUT' });
		}
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]).toBe(reasonOf(drained()));
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(harness.persistence.thoughtAttempts).toBe(0);

		// When the late call succeeds
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);
		const stateAfterRelease = harness.buffer.sessionEvictionState(A);
		await harness.buffer.drain();

		// Then
		expect(stateAfterRelease).toBe('pending');
		expect(await harness.persistence.loadEdges(A)).toEqual([edge(A, 'v2')]);
		expect(saveEdges).toHaveBeenCalledTimes(2);
		expect(saveEdges).toHaveBeenLastCalledWith(A, [edge(A, 'v2')]);
		expect(harness.persistence.thoughtAttempts).toBe(1);
		expect(harness.persistence.maxConcurrentWrites).toBe(1);
		expect(harness.events).toHaveLength(1);
	});

	it('waits on a stalled write without a gate when no deadline is configured', async () => {
		// Given
		const harness = createHarness({ writeTimeout: undefined });
		harness.persistence.holdWrites = true;
		harness.buffer.bufferThought(A, thought(A, 1));
		harness.buffer.bufferThought(B, thought(B, 1));

		// When
		const drained = track(harness.buffer.drain());
		await advanceTimeAsync(100 * TIMEOUT_MS);
		const whileHeld = drained();
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);

		// Then
		expect(whileHeld.status).toBe('pending');
		expect(drained().status).toBe('fulfilled');
		expect(harness.persistence.thoughtAttempts).toBe(2);
		expect(harness.events).toHaveLength(0);
		expect(harness.warn).not.toHaveBeenCalled();
	});
});
