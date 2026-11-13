import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '../../contracts/ids.js';
import { PersistenceBuffer } from '../../core/PersistenceBuffer.js';
import { SessionLifecycleClosedError } from '../../core/SessionErrors.js';
import type { ThoughtData } from '../../core/thought.js';
import { ServerStopTimeoutError } from '../../errors.js';
import { createTestSessionId, createTestThought } from '../helpers/factories.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';
import { advanceTimeAsync, useFakeTimers, useRealTimers } from '../helpers/timers.js';

const WRITE_TIMEOUT_MS = 1000;
const FLUSH_BOUND_MS = 400;
const A = createTestSessionId('shutdown-a');
const B = createTestSessionId('shutdown-b');

type Outcome =
	| { readonly status: 'pending' }
	| { readonly status: 'fulfilled' }
	| { readonly status: 'rejected'; readonly reason: unknown };

type Harness = { readonly persistence: StallingPersistence; readonly buffer: PersistenceBuffer };

const harnesses = new Set<Harness>();

function createHarness(
	options: {
		readonly writeTimeout?: number;
		readonly bufferSize?: number;
		readonly maxRetries?: number;
	} = {}
): Harness {
	const persistence = new StallingPersistence();
	const buffer = new PersistenceBuffer({
		persistence,
		bufferSize: options.bufferSize ?? 100,
		flushInterval: 60_000,
		maxRetries: options.maxRetries ?? 0,
		writeTimeout: options.writeTimeout,
	});
	const harness = { persistence, buffer };
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

beforeEach(() => {
	useFakeTimers();
});

afterEach(async () => {
	for (const { persistence } of harnesses) {
		persistence.holdWrites = false;
		while (persistence.heldCallCount > 0) persistence.releaseHeldCall();
	}
	await advanceTimeAsync(0);
	harnesses.clear();
	vi.clearAllTimers();
	useRealTimers();
});

describe('PersistenceBuffer shutdown seal', () => {
	it('refuses buffering, size triggers and barriers once sealed without touching the queue', async () => {
		// Given
		const { persistence, buffer } = createHarness({ bufferSize: 1 });
		await buffer.closeForShutdown();

		// When
		const buffered = (): void => buffer.bufferThought(A, thought(A, 1));
		const barrier = track(buffer.withSessionBarrier(A, async () => undefined));
		await advanceTimeAsync(0);

		// Then
		expect(buffered).toThrow(SessionLifecycleClosedError);
		expect(buffered).toThrow(expect.objectContaining({ phase: 'shutting_down', sessionId: A }));
		expect(() => buffer.assertThoughtBacklogAvailable(A)).toThrow(SessionLifecycleClosedError);
		expect(reasonOf(barrier())).toBeInstanceOf(SessionLifecycleClosedError);
		expect(buffer.pendingThoughtCount).toBe(0);
		expect(buffer.isFlushing).toBe(false);
		expect(persistence.thoughtAttempts).toBe(0);
	});

	it('rejects at the flush bound with the pending count and dispatches nothing afterwards', async () => {
		// Given
		const { persistence, buffer } = createHarness({ writeTimeout: WRITE_TIMEOUT_MS });
		persistence.holdWrites = true;
		buffer.bufferThought(A, thought(A, 1));
		buffer.bufferThought(B, thought(B, 1));

		// When
		const closed = track(buffer.closeForShutdown(FLUSH_BOUND_MS));
		await advanceTimeAsync(FLUSH_BOUND_MS - 1);
		const beforeBound = closed();
		await advanceTimeAsync(1);

		// Then
		expect(beforeBound).toEqual({ status: 'pending' });
		const reason = reasonOf(closed());
		expect(reason).toBeInstanceOf(ServerStopTimeoutError);
		expect(reason).toMatchObject({
			code: 'SERVER_STOP_TIMEOUT',
			phase: 'flush',
			timeoutMs: FLUSH_BOUND_MS,
			pending: 2,
		});
		persistence.releaseHeldCall();
		await advanceTimeAsync(WRITE_TIMEOUT_MS);
		expect(persistence.thoughtAttempts).toBe(1);
		expect(buffer.pendingThoughtCount).toBe(1);
		expect(buffer.isFlushing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('never settles a generation stopped by the seal as a success for unsent work', async () => {
		// Given
		const { persistence, buffer } = createHarness({ writeTimeout: WRITE_TIMEOUT_MS });
		persistence.holdWrites = true;
		buffer.bufferThought(A, thought(A, 1));
		buffer.bufferThought(B, thought(B, 1));
		const abandoned = track(buffer.drain());
		const closed = track(buffer.closeForShutdown(FLUSH_BOUND_MS));
		await advanceTimeAsync(FLUSH_BOUND_MS);

		// When
		persistence.releaseHeldCall();
		await advanceTimeAsync(0);

		// Then
		expect(reasonOf(closed())).toBeInstanceOf(ServerStopTimeoutError);
		expect(reasonOf(abandoned())).toBeInstanceOf(SessionLifecycleClosedError);
		expect(persistence.thoughtAttempts).toBe(1);
		expect(await persistence.loadHistoryForSession(A)).toHaveLength(1);
		expect(await persistence.loadHistoryForSession(B)).toEqual([]);
	});

	it('lets a write that times out after the bound close the gate harmlessly', async () => {
		// Given
		const { persistence, buffer } = createHarness({ writeTimeout: WRITE_TIMEOUT_MS });
		persistence.holdWrites = true;
		buffer.bufferThought(A, thought(A, 1));
		buffer.bufferThought(B, thought(B, 1));
		const closed = track(buffer.closeForShutdown(FLUSH_BOUND_MS));

		// When
		await advanceTimeAsync(WRITE_TIMEOUT_MS);

		// Then
		expect(reasonOf(closed())).toMatchObject({ phase: 'flush', pending: 2 });
		expect(persistence.thoughtAttempts).toBe(1);
		expect(buffer.isFlushing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('waits without a bound when no timeout is given', async () => {
		// Given
		const { persistence, buffer } = createHarness();
		persistence.holdWrites = true;
		buffer.bufferThought(A, thought(A, 1));
		buffer.bufferThought(B, thought(B, 1));

		// When
		const closed = track(buffer.closeForShutdown());
		await advanceTimeAsync(60_000);
		const whileHeld = closed();
		persistence.holdWrites = false;
		persistence.releaseHeldCall();
		await advanceTimeAsync(0);

		// Then
		expect(whileHeld).toEqual({ status: 'pending' });
		expect(closed()).toEqual({ status: 'fulfilled' });
		expect(persistence.thoughtAttempts).toBe(2);
		expect(buffer.pendingThoughtCount).toBe(0);
	});

	it('resolves a drain that finishes inside the bound and leaves no timer', async () => {
		// Given
		const { persistence, buffer } = createHarness({ writeTimeout: WRITE_TIMEOUT_MS });
		buffer.bufferThought(A, thought(A, 1));

		// When
		await buffer.closeForShutdown(FLUSH_BOUND_MS);

		// Then
		expect(vi.getTimerCount()).toBe(0);
		expect(buffer.pendingThoughtCount).toBe(0);
		expect(await persistence.loadHistoryForSession(A)).toHaveLength(1);
	});

	it('refuses a retry attempt that comes due after the bounded flush settled', async () => {
		// Given
		const { persistence, buffer } = createHarness({ maxRetries: 3 });
		persistence.down = true;
		buffer.bufferThought(A, thought(A, 1));

		// When
		const closed = track(buffer.closeForShutdown(FLUSH_BOUND_MS));
		await advanceTimeAsync(FLUSH_BOUND_MS);
		const attemptsAtSeal = persistence.thoughtAttempts;
		await advanceTimeAsync(3000);

		// Then
		expect(reasonOf(closed())).toMatchObject({ phase: 'flush' });
		expect(attemptsAtSeal).toBe(2);
		expect(persistence.thoughtAttempts).toBe(attemptsAtSeal);
		expect(buffer.pendingThoughtCount).toBe(1);
		expect(buffer.isFlushing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
