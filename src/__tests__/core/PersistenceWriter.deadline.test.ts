import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistenceWork } from '../../contracts/persistence-work.js';
import type { PersistenceCallOutcome } from '../../core/PersistenceCallDeadline.js';
import { PersistenceWriteTimeoutError } from '../../core/PersistenceBufferErrors.js';
import { PersistenceWorkQueue } from '../../core/PersistenceWorkQueue.js';
import {
	PersistenceWriter,
	type PersistenceWriteResult,
	type PersistenceWriterConfig,
} from '../../core/PersistenceWriter.js';
import { createTestSessionId, createTestThought } from '../helpers/factories.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';

const SESSION_ID = createTestSessionId();
const TIMEOUT_MS = 1000;

type WriterHarness = {
	readonly persistence: StallingPersistence;
	readonly writer: PersistenceWriter;
	readonly work: PersistenceWork;
	readonly delays: number[];
};

type TrackedWrite = {
	readonly result: Promise<PersistenceWriteResult>;
	readonly isSettled: () => boolean;
};

function createHarness(
	overrides: Partial<Omit<PersistenceWriterConfig, 'persistence' | 'delay'>> = {}
): WriterHarness {
	const persistence = new StallingPersistence();
	const delays: number[] = [];
	const writer = new PersistenceWriter({
		persistence,
		maxRetries: 3,
		writeTimeout: TIMEOUT_MS,
		delay: async (milliseconds) => {
			delays.push(milliseconds);
		},
		...overrides,
	});
	const work = new PersistenceWorkQueue().enqueueThought(
		SESSION_ID,
		createTestThought({ id: 'deadline-thought-1', thought_number: 1 })
	);
	return { persistence, writer, work, delays };
}

function track(result: Promise<PersistenceWriteResult>): TrackedWrite {
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	return { result, isSettled: () => settled };
}

async function timeOut(harness: WriterHarness): Promise<PersistenceWriteTimeoutError> {
	harness.persistence.holdWrites = true;
	const write = harness.writer.write(harness.work);
	await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
	const result = await write;
	if (result === true || !(result.cause instanceof PersistenceWriteTimeoutError)) {
		throw new Error('expected a timed-out write');
	}
	return result.cause;
}

function observeOnce(error: PersistenceWriteTimeoutError): PersistenceCallOutcome[] {
	const observed: PersistenceCallOutcome[] = [];
	void error.lateOutcome.then((outcome) => {
		observed.push(outcome);
	});
	return observed;
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('PersistenceWriter write deadline', () => {
	it('ends a stalled attempt at the deadline with a typed, attributable timeout cause', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;

		// When
		const write = track(harness.writer.write(harness.work));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
		const settledBeforeDeadline = write.isSettled();
		await vi.advanceTimersByTimeAsync(1);
		const result = await write.result;

		// Then
		expect(settledBeforeDeadline).toBe(false);
		expect(result).toMatchObject({
			kind: 'thought',
			token: harness.work.token,
			sessionId: SESSION_ID,
			attempts: 1,
		});
		const cause = result === true ? undefined : result.cause;
		expect(cause).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(cause).toMatchObject({
			code: 'PERSISTENCE_WRITE_TIMEOUT',
			timeoutMs: TIMEOUT_MS,
			call: {
				kind: 'work',
				operation: 'thought',
				token: harness.work.token,
				sessionId: SESSION_ID,
			},
		});
	});

	it('never dispatches the same work again while the timed-out call is unsettled', async () => {
		// Given
		const harness = createHarness();
		await timeOut(harness);

		// When
		await vi.advanceTimersByTimeAsync(60_000);

		// Then
		expect(harness.persistence.thoughtAttempts).toBe(1);
		expect(harness.persistence.heldCallCount).toBe(1);
		expect(harness.delays).toEqual([]);
	});

	it('counts the attempts made before a later attempt times out', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.down = true;
		const writer = new PersistenceWriter({
			persistence: harness.persistence,
			maxRetries: 3,
			writeTimeout: TIMEOUT_MS,
			delay: async () => {
				harness.persistence.down = false;
				harness.persistence.holdWrites = true;
			},
		});

		// When
		const write = writer.write(harness.work);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		const result = await write;

		// Then
		expect(result).toMatchObject({ attempts: 2 });
		expect(result === true ? undefined : result.cause).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(harness.persistence.thoughtAttempts).toBe(2);
	});

	it('reports a late success exactly once through the late outcome', async () => {
		// Given
		const harness = createHarness();
		const error = await timeOut(harness);
		const observed = observeOnce(error);

		// When
		harness.persistence.releaseHeldCall();
		await vi.advanceTimersByTimeAsync(0);

		// Then
		expect(observed).toEqual([{ kind: 'fulfilled' }]);
		expect(await harness.persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(1);
		expect(harness.persistence.thoughtAttempts).toBe(1);
	});

	it('reports a late failure exactly once through the late outcome', async () => {
		// Given
		const harness = createHarness();
		const error = await timeOut(harness);
		const observed = observeOnce(error);
		const lateFailure = new Error('late failure');

		// When
		harness.persistence.releaseHeldCall(lateFailure);
		await vi.advanceTimersByTimeAsync(0);

		// Then
		expect(observed).toEqual([{ kind: 'rejected', reason: lateFailure }]);
		expect(await harness.persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(0);
	});

	it('clears the deadline timer when the call succeeds first', async () => {
		// Given
		const harness = createHarness();
		harness.persistence.holdWrites = true;
		const write = harness.writer.write(harness.work);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2);

		// When
		harness.persistence.releaseHeldCall();
		const result = await write;

		// Then
		expect(result).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears the deadline timer when the call rejects first', async () => {
		// Given
		const harness = createHarness({ maxRetries: 0 });
		harness.persistence.holdWrites = true;
		const write = harness.writer.write(harness.work);
		const backendFailure = new Error('backend failure');

		// When
		harness.persistence.releaseHeldCall(backendFailure);
		const result = await write;

		// Then
		expect(result).toMatchObject({ attempts: 1, cause: backendFailure });
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([undefined, TIMEOUT_MS])(
		'keeps attempts, retry delays and results unchanged when no deadline fires (writeTimeout %s)',
		async (writeTimeout) => {
			// Given
			const harness = createHarness({ maxRetries: 3, writeTimeout });
			harness.persistence.down = true;

			// When
			const result = await harness.writer.write(harness.work);

			// Then
			expect(result).toMatchObject({ kind: 'thought', attempts: 4 });
			expect(result === true ? undefined : result.cause).toEqual(new Error('backend down'));
			expect(harness.delays).toEqual([100, 500, 2000]);
			expect(harness.persistence.thoughtAttempts).toBe(4);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('waits on a stalled call without a deadline when writeTimeout is undefined', async () => {
		// Given
		const harness = createHarness({ writeTimeout: undefined });
		harness.persistence.holdWrites = true;

		// When
		const write = track(harness.writer.write(harness.work));
		await vi.advanceTimersByTimeAsync(10 * TIMEOUT_MS);
		const settledWhileHeld = write.isSettled();
		harness.persistence.releaseHeldCall();

		// Then
		expect(settledWhileHeld).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(await write.result).toBe(true);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		'rejects writeTimeout %s before accepting a persistence policy',
		(writeTimeout) => {
			// Given
			const persistence = new StallingPersistence();

			// When
			const construct = (): PersistenceWriter =>
				new PersistenceWriter({ persistence, maxRetries: 0, writeTimeout });

			// Then
			expect(construct).toThrow(RangeError);
		}
	);
});

describe('PersistenceWriter retry admission', () => {
	it('is not consulted before the first attempt, nor after a first-attempt success', async () => {
		// Given
		const admitRetry = vi.fn(() => Promise.resolve(true));
		const harness = createHarness({ admitRetry });
		harness.persistence.holdWrites = true;

		// When
		const write = track(harness.writer.write(harness.work));
		await vi.advanceTimersByTimeAsync(0);
		const consultedAtFirstAttempt = admitRetry.mock.calls.length;
		harness.persistence.releaseHeldCall();

		// Then
		expect(consultedAtFirstAttempt).toBe(0);
		expect(await write.result).toBe(true);
		expect(admitRetry).not.toHaveBeenCalled();
	});

	it('ends the write with the attempts made and the real cause when a retry is refused', async () => {
		// Given
		const admitRetry = vi.fn(() => Promise.resolve(false));
		const harness = createHarness({ admitRetry });
		harness.persistence.down = true;

		// When
		const result = await harness.writer.write(harness.work);

		// Then
		expect(result).toMatchObject({ kind: 'thought', token: harness.work.token, attempts: 1 });
		expect(result === true ? undefined : result.cause).toEqual(new Error('backend down'));
		expect(harness.persistence.thoughtAttempts).toBe(1);
		expect(harness.delays).toEqual([100]);
		expect(admitRetry).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps attempts and delays unchanged while every retry is admitted', async () => {
		// Given
		const admitRetry = vi.fn(() => Promise.resolve(true));
		const harness = createHarness({ admitRetry });
		harness.persistence.down = true;

		// When
		const result = await harness.writer.write(harness.work);

		// Then
		expect(result).toMatchObject({ kind: 'thought', attempts: 4 });
		expect(result === true ? undefined : result.cause).toEqual(new Error('backend down'));
		expect(harness.delays).toEqual([100, 500, 2000]);
		expect(harness.persistence.thoughtAttempts).toBe(4);
		expect(admitRetry).toHaveBeenCalledTimes(3);
	});

	it('holds a retry until a pending admission resolves', async () => {
		// Given
		const admission = Promise.withResolvers<boolean>();
		const harness = createHarness({ admitRetry: () => admission.promise });
		harness.persistence.down = true;

		// When
		const write = track(harness.writer.write(harness.work));
		await vi.advanceTimersByTimeAsync(60_000);
		const attemptsWhilePending = harness.persistence.thoughtAttempts;
		const settledWhilePending = write.isSettled();
		harness.persistence.down = false;
		admission.resolve(true);

		// Then
		expect(attemptsWhilePending).toBe(1);
		expect(settledWhilePending).toBe(false);
		expect(await write.result).toBe(true);
		expect(harness.persistence.thoughtAttempts).toBe(2);
	});
});
