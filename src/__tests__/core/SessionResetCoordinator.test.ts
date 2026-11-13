import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { asSessionId, type SessionId } from '../../contracts/ids.js';
import { PersistenceBuffer } from '../../core/PersistenceBuffer.js';
import { PersistenceWriteTimeoutError } from '../../core/PersistenceBufferErrors.js';
import { SessionResetCoordinator } from '../../core/SessionResetCoordinator.js';
import type { ThoughtData } from '../../core/thought.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought } from '../helpers/factories.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';
import { advanceTimeAsync, useFakeTimers, useRealTimers } from '../helpers/timers.js';

interface TestSessionState {
	readonly owner: string | undefined;
}

function createCoordinator(): {
	coordinator: SessionResetCoordinator<TestSessionState>;
	persistence: MemoryPersistence;
	sessions: Map<ReturnType<typeof asSessionId>, TestSessionState>;
} {
	const persistence = new MemoryPersistence();
	const sessions = new Map<ReturnType<typeof asSessionId>, TestSessionState>();
	const coordinator = new SessionResetCoordinator({
		persistence,
		barrier: {
			withSessionResetBarrier: async (_sessionId, operation) => await operation(),
			withGlobalResetBarrier: async (operation) => await operation(),
		},
		sessions,
		createSessionState: (owner) => ({ owner }),
		assertReplacementCapacity: () => undefined,
		admitReplacement: () => undefined,
		logger: new NullLogger(),
	});
	return { coordinator, persistence, sessions };
}

describe('SessionResetCoordinator', () => {
	it('clears persistent and live session state through the durable barrier', async () => {
		const { coordinator, persistence, sessions } = createCoordinator();
		const sessionId = asSessionId('session-a');
		sessions.set(sessionId, { owner: 'owner-a' });
		const clearSession = vi.spyOn(persistence, 'clearSession');

		await coordinator.resetSession(sessionId, 'owner-a');

		expect(clearSession).toHaveBeenCalledWith(sessionId);
		expect(sessions.get(sessionId)).toEqual({ owner: 'owner-a' });
	});

	it('clears all persistent and live state through the durable barrier', async () => {
		const { coordinator, persistence, sessions } = createCoordinator();
		sessions.set(asSessionId('session-a'), { owner: 'owner-a' });
		const clearAll = vi.spyOn(persistence, 'clearAll');

		await coordinator.resetAll();

		expect(clearAll).toHaveBeenCalledOnce();
		expect(sessions).toHaveLength(0);
	});
});

const TIMEOUT_MS = 1000;
const SESSION_A = asSessionId('clear-deadline-a');
const SESSION_B = asSessionId('clear-deadline-b');

type DeadlineHarness = {
	readonly coordinator: SessionResetCoordinator<TestSessionState>;
	readonly persistence: StallingPersistence;
	readonly buffer: PersistenceBuffer;
	readonly sessions: Map<SessionId, TestSessionState>;
	readonly warn: MockInstance;
};

type Outcome =
	| { readonly status: 'pending' }
	| { readonly status: 'fulfilled' }
	| { readonly status: 'rejected'; readonly reason: unknown };

const deadlineHarnesses = new Set<DeadlineHarness>();

function createDeadlineHarness(timeoutMs: number | undefined): DeadlineHarness {
	const persistence = new StallingPersistence();
	const logger = new NullLogger();
	const warn = vi.spyOn(logger, 'warn');
	const buffer = new PersistenceBuffer({
		persistence,
		bufferSize: 100,
		flushInterval: 60_000,
		maxRetries: 0,
		writeTimeout: timeoutMs,
		logger,
	});
	const sessions = new Map<SessionId, TestSessionState>();
	const coordinator = new SessionResetCoordinator({
		persistence,
		barrier: buffer,
		persistenceWriteTimeout: timeoutMs,
		sessions,
		createSessionState: (owner) => ({ owner }),
		assertReplacementCapacity: () => undefined,
		admitReplacement: () => undefined,
		logger,
	});
	const harness = { coordinator, persistence, buffer, sessions, warn };
	deadlineHarnesses.add(harness);
	return harness;
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

function thought(sessionId: SessionId, thoughtNumber: number): ThoughtData {
	return createTestThought({
		id: `${sessionId}-${thoughtNumber}`,
		thought_number: thoughtNumber,
		session_id: sessionId,
	});
}

const hungClears = [
	{
		clear: 'clearSession',
		reset: (harness: DeadlineHarness, clearAux: () => void) =>
			harness.coordinator.resetSession(SESSION_A, 'owner-a', clearAux),
		call: { kind: 'clearSession', sessionId: SESSION_A },
		quarantine: { globalQuarantined: false, quarantinedSessionCount: 1 },
	},
	{
		clear: 'clearAll',
		reset: (harness: DeadlineHarness, clearAux: () => void) =>
			harness.coordinator.resetAll(clearAux),
		call: { kind: 'clearAll' },
		quarantine: { globalQuarantined: true, quarantinedSessionCount: 0 },
	},
] as const;

describe('SessionResetCoordinator clear deadline', () => {
	beforeEach(() => {
		useFakeTimers();
	});

	afterEach(async () => {
		for (const { buffer, persistence } of deadlineHarnesses) {
			buffer.stopFlushTimer();
			persistence.holdWrites = false;
			persistence.holdClears = false;
			while (persistence.heldCallCount > 0) persistence.releaseHeldCall();
		}
		await advanceTimeAsync(0);
		deadlineHarnesses.clear();
		vi.clearAllTimers();
		useRealTimers();
	});

	it.each(hungClears)(
		'fails the reset at the deadline when $clear never settles and keeps live state',
		async ({ reset, call, quarantine }) => {
			// Given
			const harness = createDeadlineHarness(TIMEOUT_MS);
			const original = { owner: 'owner-a' };
			harness.sessions.set(SESSION_A, original);
			harness.persistence.holdClears = true;
			const clearAux = vi.fn();

			// When
			const outcome = track(reset(harness, clearAux));
			await advanceTimeAsync(TIMEOUT_MS - 1);
			const beforeDeadline = outcome();
			await advanceTimeAsync(1);
			const atDeadline = outcome();
			harness.persistence.releaseHeldCall(new Error('late clear failure'));
			await advanceTimeAsync(0);

			// Then
			expect(beforeDeadline.status).toBe('pending');
			const reason = atDeadline.status === 'rejected' ? atDeadline.reason : undefined;
			expect(reason).toBeInstanceOf(PersistenceWriteTimeoutError);
			expect(reason).toMatchObject({
				code: 'PERSISTENCE_WRITE_TIMEOUT',
				timeoutMs: TIMEOUT_MS,
				call,
			});
			expect(harness.buffer.getBacklogView()).toMatchObject(quarantine);
			expect(harness.sessions.get(SESSION_A)).toBe(original);
			expect(clearAux).not.toHaveBeenCalled();
			expect(harness.persistence.clearCalls).toBe(1);
			expect(harness.warn).toHaveBeenCalledTimes(1);
		}
	);

	it.each(hungClears)(
		'sends no second $clear while the timed-out one is pending and clears again once it settles',
		async ({ reset, call }) => {
			// Given
			const harness = createDeadlineHarness(TIMEOUT_MS);
			harness.sessions.set(SESSION_A, { owner: 'owner-a' });
			harness.persistence.holdClears = true;
			const first = track(reset(harness, () => undefined));
			await advanceTimeAsync(TIMEOUT_MS);

			// When
			const retry = track(reset(harness, () => undefined));
			await advanceTimeAsync(0);
			const clearsWhilePending = harness.persistence.clearCalls;
			harness.persistence.holdClears = false;
			harness.persistence.releaseHeldCall();
			await advanceTimeAsync(0);
			const afterSettle = track(reset(harness, () => undefined));
			await advanceTimeAsync(0);

			// Then
			expect(reasonOf(first())).toMatchObject({ code: 'PERSISTENCE_WRITE_TIMEOUT', call });
			expect(reasonOf(retry())).toBeInstanceOf(PersistenceWriteTimeoutError);
			expect(reasonOf(retry())).toMatchObject({ call });
			expect(clearsWhilePending).toBe(1);
			expect(afterSettle().status).toBe('fulfilled');
			expect(harness.persistence.clearCalls).toBe(2);
			expect(harness.buffer.getBacklogView()).toMatchObject({
				globalQuarantined: false,
				quarantinedSessionCount: 0,
			});
		}
	);

	it.each([
		{ late: 'success', failure: undefined },
		{ late: 'failure', failure: new Error('late clear failure') },
	])(
		'keeps the gate closed until a timed-out clear settles and the reset failed after a late $late',
		async ({ failure }) => {
			// Given
			const harness = createDeadlineHarness(TIMEOUT_MS);
			const original = { owner: 'owner-a' };
			harness.sessions.set(SESSION_A, original);
			harness.persistence.holdClears = true;
			const clearAux = vi.fn();
			const reset = track(harness.coordinator.resetSession(SESSION_A, 'owner-a', clearAux));
			await advanceTimeAsync(TIMEOUT_MS);

			// When
			const drainWhilePending = track(harness.buffer.drain());
			await advanceTimeAsync(0);
			harness.persistence.releaseHeldCall(failure);
			await advanceTimeAsync(0);
			const drainAfterSettle = track(harness.buffer.drain());
			await advanceTimeAsync(0);

			// Then
			expect(reasonOf(reset())).toBeInstanceOf(PersistenceWriteTimeoutError);
			expect(reasonOf(drainWhilePending())).toBe(reasonOf(reset()));
			expect(drainAfterSettle().status).toBe('fulfilled');
			expect(harness.buffer.getBacklogView().quarantinedSessionCount).toBe(1);
			expect(harness.buffer.sessionEvictionState(SESSION_A)).toBe('failed');
			expect(harness.sessions.get(SESSION_A)).toBe(original);
			expect(clearAux).not.toHaveBeenCalled();
		}
	);

	it('reports the oldest stall while a write and a clear are both pending and reopens after both', async () => {
		// Given
		const harness = createDeadlineHarness(TIMEOUT_MS);
		harness.persistence.holdWrites = true;
		harness.persistence.holdClears = true;
		harness.buffer.bufferThought(SESSION_B, thought(SESSION_B, 1));
		void harness.buffer.drain().catch(() => undefined);
		await advanceTimeAsync(0);
		const reset = track(harness.coordinator.resetSession(SESSION_A, 'owner-a'));
		await advanceTimeAsync(TIMEOUT_MS);

		// When
		const withBoth = track(harness.buffer.drain());
		await advanceTimeAsync(0);
		harness.persistence.holdWrites = false;
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);
		const withClear = track(harness.buffer.drain());
		await advanceTimeAsync(0);
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);
		const withNone = track(harness.buffer.drain());
		await advanceTimeAsync(0);

		// Then
		expect(harness.persistence.clearCalls).toBe(1);
		expect(reasonOf(reset())).toMatchObject({ call: { kind: 'clearSession' } });
		expect(reasonOf(withBoth())).toMatchObject({ call: { kind: 'work', sessionId: SESSION_B } });
		expect(reasonOf(withClear())).toBe(reasonOf(reset()));
		expect(withNone().status).toBe('fulfilled');
		expect(await harness.persistence.loadHistoryForSession(SESSION_B)).toHaveLength(1);
	});

	it('waits for a held clear and replaces live state when no deadline is configured', async () => {
		// Given
		const harness = createDeadlineHarness(undefined);
		const original = { owner: 'owner-a' };
		harness.sessions.set(SESSION_A, original);
		harness.persistence.holdClears = true;

		// When
		const outcome = track(harness.coordinator.resetSession(SESSION_A, 'owner-a'));
		await advanceTimeAsync(100 * TIMEOUT_MS);
		const whileHeld = outcome();
		harness.persistence.releaseHeldCall();
		await advanceTimeAsync(0);

		// Then
		expect(whileHeld.status).toBe('pending');
		expect(outcome().status).toBe('fulfilled');
		expect(harness.sessions.get(SESSION_A)).not.toBe(original);
		expect(harness.buffer.getBacklogView().quarantinedSessionCount).toBe(0);
		expect(harness.warn).not.toHaveBeenCalled();
	});
});
