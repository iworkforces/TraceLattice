import { afterEach, describe, expect, it, vi } from 'vitest';

import { asSessionId } from '../../contracts/ids.js';
import { SessionLifecycleCoordinator } from '../../core/SessionLifecycleCoordinator.js';
import { SessionLifecycleClosedError } from '../../core/SessionErrors.js';

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function deferred(): Deferred {
	const result = Promise.withResolvers<void>();
	return { promise: result.promise, resolve: result.resolve };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('SessionLifecycleCoordinator admission', () => {
	it('counts a pre-close operation until completion and rejects post-close work before callback', async () => {
		// Given
		const sessionId = asSessionId('admission-session');
		const coordinator = new SessionLifecycleCoordinator();
		const operationGate = deferred();
		const resetStarted = deferred();
		const operation = coordinator.runOperation(sessionId, async () => operationGate.promise);
		const rejectedCallback = vi.fn(async () => undefined);

		// When
		const reset = coordinator.withSessionReset(sessionId, async () => {
			resetStarted.resolve();
		});
		const rejected = coordinator.runOperation(sessionId, rejectedCallback);
		await flushMicrotasks();

		// Then
		expect(coordinator.phaseFor(sessionId)).toBe('resetting');
		expect(coordinator.isIdle(sessionId)).toBe(false);
		await expect(rejected).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		expect(rejectedCallback).not.toHaveBeenCalled();
		let resetEntered = false;
		void resetStarted.promise.then(() => {
			resetEntered = true;
		});
		await flushMicrotasks();
		expect(resetEntered).toBe(false);

		operationGate.resolve();
		await operation;
		await reset;
		expect(coordinator.phaseFor(sessionId)).toBe('open');
		expect(coordinator.isIdle(sessionId)).toBe(true);
	});

	it('reuses a same-session lifecycle context for nested synchronous mutation', async () => {
		// Given
		const sessionId = asSessionId('nested-mutation');
		const coordinator = new SessionLifecycleCoordinator();
		const events: string[] = [];

		// When
		await coordinator.runOperation(sessionId, async () => {
			coordinator.runMutation(sessionId, () => events.push('nested'));
		});

		// Then
		expect(events).toEqual(['nested']);
		expect(coordinator.isIdle(sessionId)).toBe(true);
	});

	it('rejects an ordinary-operation to exclusive upgrade without deadlocking', async () => {
		// Given
		const sessionId = asSessionId('upgrade-session');
		const coordinator = new SessionLifecycleCoordinator();
		const exclusiveCallback = vi.fn(async () => undefined);

		// When
		const result = coordinator.runOperation(sessionId, async () =>
			coordinator.withSessionReset(sessionId, exclusiveCallback)
		);

		// Then
		await expect(result).rejects.toThrow(
			"Cannot upgrade an admitted operation for session 'upgrade-session' to reset"
		);
		expect(exclusiveCallback).not.toHaveBeenCalled();
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});
});

describe('SessionLifecycleCoordinator exclusives', () => {
	it('retains reset failure state and permits one explicit reset retry', async () => {
		// Given
		const sessionId = asSessionId('reset-retry');
		const coordinator = new SessionLifecycleCoordinator();
		const failure = new Error('reset failed');

		// When
		await expect(
			coordinator.withSessionReset(sessionId, async () => Promise.reject(failure))
		).rejects.toBe(failure);
		const retry = coordinator.withSessionReset(sessionId, async () => 'reset');

		// Then
		expect(coordinator.phaseFor(sessionId)).toBe('resetting');
		await expect(retry).resolves.toBe('reset');
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});

	it('reuses the owning same-session reset exclusive for reset internals', async () => {
		// Given
		const sessionId = asSessionId('reset-internals');
		const coordinator = new SessionLifecycleCoordinator();
		const events: string[] = [];

		// When
		await coordinator.withSessionReset(sessionId, async () => {
			events.push('outer');
			await coordinator.withSessionReset(sessionId, async () => {
				events.push('inner');
			});
		});

		// Then
		expect(events).toEqual(['outer', 'inner']);
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});

	it('rejects a different-session exclusive before invoking its callback', async () => {
		// Given
		const sessionA = asSessionId('exclusive-session-a');
		const sessionB = asSessionId('exclusive-session-b');
		const coordinator = new SessionLifecycleCoordinator();
		const nestedCallback = vi.fn(async () => undefined);
		let nested: Promise<void> | undefined;

		// When
		await coordinator.withSessionReset(sessionA, async () => {
			nested = coordinator.withSessionEviction(sessionB, nestedCallback);
		});

		// Then
		await expect(nested).rejects.toBeInstanceOf(TypeError);
		expect(nestedCallback).not.toHaveBeenCalled();
		expect(coordinator.phaseFor(sessionA)).toBe('open');
		expect(coordinator.phaseFor(sessionB)).toBe('open');
	});

	it('retains eviction failure and requires retryFailed for the later retry', async () => {
		// Given
		const sessionId = asSessionId('eviction-retry');
		const coordinator = new SessionLifecycleCoordinator();
		const failure = new Error('eviction failed');

		// When
		await expect(
			coordinator.withSessionEviction(sessionId, async () => Promise.reject(failure))
		).rejects.toBe(failure);
		const implicitRetry = coordinator.withSessionEviction(sessionId, async () => undefined);

		// Then
		await expect(implicitRetry).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		await expect(
			coordinator.withSessionEviction(sessionId, async () => 'evicted', { retryFailed: true })
		).resolves.toBe('evicted');
		expect(coordinator.phaseFor(sessionId)).toBe('open');
	});

	it('gives a session exclusive one owner while it waits for admitted work', async () => {
		// Given
		const sessionId = asSessionId('single-owner');
		const coordinator = new SessionLifecycleCoordinator();
		const operationGate = deferred();
		const operation = coordinator.runOperation(sessionId, async () => operationGate.promise);
		const first = coordinator.withSessionReset(sessionId, async () => undefined);

		// When
		const second = coordinator.withSessionReset(sessionId, async () => undefined);

		// Then
		await expect(second).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		operationGate.resolve();
		await Promise.all([operation, first]);
	});

	it('global reset closes admission, waits for all pre-close work, and has one owner', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const sessionA = asSessionId('global-a');
		const gate = deferred();
		const operation = coordinator.runOperation(sessionA, async () => gate.promise);
		const resetCallback = vi.fn(async () => 'reset');

		// When
		const reset = coordinator.withGlobalReset(resetCallback);
		const competing = coordinator.withGlobalReset(async () => undefined);
		await flushMicrotasks();

		// Then
		expect(coordinator.globalPhase).toBe('resetting');
		expect(resetCallback).not.toHaveBeenCalled();
		await expect(competing).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		await expect(
			coordinator.runOperation(asSessionId('global-b'), async () => undefined)
		).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		gate.resolve();
		await operation;
		await expect(reset).resolves.toBe('reset');
		expect(coordinator.globalPhase).toBe('open');
	});

	it('rejects a session-exclusive to global-exclusive upgrade without self-waiting', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const sessionId = asSessionId('exclusive-upgrade');
		let upgrade: Promise<void> | undefined;

		// When
		await coordinator.withSessionReset(sessionId, async () => {
			upgrade = coordinator.withGlobalReset(async () => undefined);
		});

		// Then
		await expect(upgrade).rejects.toThrow(
			'Cannot upgrade an active lifecycle context to global reset'
		);
		expect(coordinator.globalPhase).toBe('open');
	});
});

describe('SessionLifecycleCoordinator shutdown and atomic idle eviction', () => {
	it('memoizes one successful shutdown settlement', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const operation = vi.fn(async () => undefined);

		// When
		const first = coordinator.shutdown(operation);
		const second = coordinator.shutdown(operation);

		// Then
		expect(first).toBe(second);
		await expect(first).resolves.toBeUndefined();
		expect(operation).toHaveBeenCalledOnce();
		expect(coordinator.globalPhase).toBe('stopped');
	});

	it('memoizes a failed shutdown and never retries its callback', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const failure = new Error('shutdown failed');
		const operation = vi.fn(async () => Promise.reject(failure));

		// When
		const first = coordinator.shutdown(operation);
		const second = coordinator.shutdown(async () => undefined);

		// Then
		expect(first).toBe(second);
		await expect(first).rejects.toBe(failure);
		expect(operation).toHaveBeenCalledOnce();
		expect(coordinator.globalPhase).toBe('shutdown_failed');
	});

	it('allows shutdown to own the coordinator after a failed global reset', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		await expect(
			coordinator.withGlobalReset(async () => Promise.reject(new Error('reset failed')))
		).rejects.toThrow('reset failed');

		// When
		const result = coordinator.shutdown(async () => undefined);

		// Then
		await expect(result).resolves.toBeUndefined();
		expect(coordinator.globalPhase).toBe('stopped');
	});

	it('prevalidates a complete idle set before one synchronous eviction callback', () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const idle = asSessionId('idle');
		const active = asSessionId('active');
		const gate = deferred();
		const activeOperation = coordinator.runOperation(active, async () => gate.promise);
		const cleanup = vi.fn((_sessionIds: readonly (typeof idle)[]) => undefined);

		// When
		const evicted = coordinator.tryEvictIdleSessions([idle, active], cleanup);

		// Then
		expect(evicted).toBe(false);
		expect(cleanup).not.toHaveBeenCalled();
		expect(coordinator.phaseFor(idle)).toBe('open');
		gate.resolve();
		return activeOperation;
	});

	it('leaves every selected session failed when atomic idle cleanup throws', () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const sessionA = asSessionId('idle-a');
		const sessionB = asSessionId('idle-b');
		const failure = new Error('cleanup failed');

		// When
		const cleanup = (): void => {
			throw failure;
		};

		// Then
		expect(() => coordinator.tryEvictIdleSessions([sessionA, sessionB], cleanup)).toThrow(failure);
		expect(coordinator.phaseFor(sessionA)).toBe('eviction_failed');
		expect(coordinator.phaseFor(sessionB)).toBe('eviction_failed');
	});
});

function useTimersOnly(): void {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => null,
		(error: unknown) => error
	);
}

function aggregateErrors(failure: unknown): readonly unknown[] {
	if (!(failure instanceof AggregateError)) throw new TypeError('Expected an aggregate failure');
	return failure.errors;
}

describe('SessionLifecycleCoordinator bounded idle', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('waits for admitted work without a bound when no idle timeout is given', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const gate = deferred();
		const held = coordinator.runOperation(asSessionId('unbounded'), async () => gate.promise);
		const operation = vi.fn(async () => undefined);

		// When
		const stopping = coordinator.shutdown(operation);
		await vi.advanceTimersByTimeAsync(60_000);

		// Then
		expect(operation).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(coordinator.globalPhase).toBe('shutting_down');
		gate.resolve();
		await held;
		await expect(stopping).resolves.toBeUndefined();
		expect(coordinator.globalPhase).toBe('stopped');
	});

	it('runs the operation at the bound and rejects with the operations timeout', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const gate = deferred();
		const held = coordinator.runOperation(asSessionId('held'), async () => gate.promise);
		const operation = vi.fn(async (_idle: unknown) => undefined);
		const outcome = rejectionOf(coordinator.shutdown(operation, { idleTimeoutMs: 100 }));

		// When
		await vi.advanceTimersByTimeAsync(99);
		const callsBeforeBound = operation.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1);

		// Then
		expect(callsBeforeBound).toBe(0);
		expect(operation).toHaveBeenCalledExactlyOnceWith({
			timedOut: true,
			admissionClosedSettled: true,
		});
		expect(aggregateErrors(await outcome)).toEqual([
			expect.objectContaining({
				code: 'SERVER_STOP_TIMEOUT',
				phase: 'operations',
				timeoutMs: 100,
				pending: 1,
			}),
		]);
		expect(coordinator.globalPhase).toBe('shutdown_failed');
		expect(vi.getTimerCount()).toBe(0);
		gate.resolve();
		await held;
	});

	it('counts a held session reset as pending maintenance', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const operationGate = deferred();
		const resetGate = deferred();
		const held = coordinator.runOperation(asSessionId('op'), async () => operationGate.promise);
		const reset = coordinator.withSessionReset(asSessionId('reset'), async () => resetGate.promise);
		const outcome = rejectionOf(
			coordinator.shutdown(async () => undefined, { idleTimeoutMs: 100 })
		);

		// When
		await vi.advanceTimersByTimeAsync(100);

		// Then
		expect(aggregateErrors(await outcome)).toEqual([
			expect.objectContaining({ code: 'SERVER_STOP_TIMEOUT', pending: 2 }),
		]);
		operationGate.resolve();
		resetGate.resolve();
		await Promise.all([held, reset]);
		expect(coordinator.hasMaintenance).toBe(false);
	});

	it('refuses the mutation of an operation abandoned at the bound', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const sessionId = asSessionId('abandoned');
		const gate = deferred();
		const mutation = vi.fn(() => 'mutated');
		const held = rejectionOf(
			coordinator.runOperation(sessionId, async () => {
				await gate.promise;
				return coordinator.runMutation(sessionId, mutation);
			})
		);
		const outcome = rejectionOf(
			coordinator.shutdown(async () => undefined, { idleTimeoutMs: 100 })
		);
		await vi.advanceTimersByTimeAsync(100);
		await outcome;

		// When
		gate.resolve();

		// Then
		const failure = await held;
		expect(failure).toBeInstanceOf(SessionLifecycleClosedError);
		expect(failure).toMatchObject({ sessionId, phase: 'shutdown_failed' });
		expect(mutation).not.toHaveBeenCalled();
		expect(coordinator.isIdle(sessionId)).toBe(true);
	});

	it('refuses the same-session exclusive re-entry of an abandoned reset', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const sessionId = asSessionId('abandoned-reset');
		const gate = deferred();
		const inner = vi.fn(async () => undefined);
		const reset = rejectionOf(
			coordinator.withSessionReset(sessionId, async () => {
				await gate.promise;
				await coordinator.withSessionReset(sessionId, inner);
			})
		);
		const outcome = rejectionOf(
			coordinator.shutdown(async () => undefined, { idleTimeoutMs: 100 })
		);
		await vi.advanceTimersByTimeAsync(100);
		await outcome;

		// When
		gate.resolve();

		// Then
		expect(await reset).toBeInstanceOf(SessionLifecycleClosedError);
		expect(inner).not.toHaveBeenCalled();
		expect(coordinator.hasMaintenance).toBe(false);
	});

	it('never starts a session exclusive that was still waiting for its session at the bound', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const sessionId = asSessionId('queued-reset');
		const gate = deferred();
		const resetCallback = vi.fn(async () => undefined);
		const held = coordinator.runOperation(sessionId, async () => gate.promise);
		const reset = rejectionOf(coordinator.withSessionReset(sessionId, resetCallback));
		const outcome = rejectionOf(
			coordinator.shutdown(async () => undefined, { idleTimeoutMs: 100 })
		);
		await vi.advanceTimersByTimeAsync(100);
		await outcome;

		// When
		gate.resolve();
		await held;

		// Then
		expect(await reset).toBeInstanceOf(SessionLifecycleClosedError);
		expect(resetCallback).not.toHaveBeenCalled();
		expect(coordinator.hasMaintenance).toBe(false);
	});

	it('stops cleanly and clears its timer when work finishes inside the bound', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const gate = deferred();
		const held = coordinator.runOperation(asSessionId('quick'), async () => gate.promise);
		const operation = vi.fn(async (_idle: unknown) => undefined);
		const stopping = coordinator.shutdown(operation, { idleTimeoutMs: 100 });

		// When
		await vi.advanceTimersByTimeAsync(50);
		gate.resolve();
		await held;

		// Then
		await expect(stopping).resolves.toBeUndefined();
		expect(operation).toHaveBeenCalledExactlyOnceWith({
			timedOut: false,
			admissionClosedSettled: true,
		});
		expect(coordinator.globalPhase).toBe('stopped');
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		{ label: 'an aggregate', flattened: true },
		{ label: 'a single failure', flattened: false },
	])('aggregates $label from the operation after the timeout error', async ({ flattened }) => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const gate = deferred();
		const first = new Error('first cleanup failure');
		const second = new Error('second cleanup failure');
		const failure = flattened ? new AggregateError([first, second], 'cleanup') : first;
		const held = coordinator.runOperation(asSessionId('failing'), async () => gate.promise);
		const outcome = rejectionOf(
			coordinator.shutdown(async () => Promise.reject(failure), { idleTimeoutMs: 100 })
		);

		// When
		await vi.advanceTimersByTimeAsync(100);

		// Then
		expect(aggregateErrors(await outcome)).toEqual([
			expect.objectContaining({ code: 'SERVER_STOP_TIMEOUT' }),
			...(flattened ? [first, second] : [first]),
		]);
		expect(coordinator.globalPhase).toBe('shutdown_failed');
		gate.resolve();
		await held;
	});
});

describe('SessionLifecycleCoordinator admission-closed callback', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls the callback once, synchronously, after admission closes', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const phases: string[] = [];
		const onAdmissionClosed = vi.fn(async () => {
			phases.push(coordinator.globalPhase);
		});

		// When
		const first = coordinator.shutdown(async () => undefined, { onAdmissionClosed });
		const second = coordinator.shutdown(async () => undefined, { onAdmissionClosed });

		// Then
		expect(phases).toEqual(['shutting_down']);
		expect(onAdmissionClosed).toHaveBeenCalledOnce();
		expect(second).toBe(first);
		await expect(first).resolves.toBeUndefined();
	});

	it('does not call the callback when a global reset refuses the shutdown', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const gate = deferred();
		const reset = coordinator.withGlobalReset(async () => gate.promise);
		const onAdmissionClosed = vi.fn(async () => undefined);

		// When
		const refused = coordinator.shutdown(async () => undefined, { onAdmissionClosed });

		// Then
		await expect(refused).rejects.toBeInstanceOf(SessionLifecycleClosedError);
		expect(onAdmissionClosed).not.toHaveBeenCalled();
		gate.resolve();
		await reset;
	});

	it('waits for the callback before the operation when no bound is given', async () => {
		// Given
		const coordinator = new SessionLifecycleCoordinator();
		const callbackGate = deferred();
		const operation = vi.fn(async (_idle: unknown) => undefined);

		// When
		const stopping = coordinator.shutdown(operation, {
			onAdmissionClosed: () => callbackGate.promise,
		});
		await flushMicrotasks();

		// Then
		expect(operation).not.toHaveBeenCalled();
		callbackGate.resolve();
		await expect(stopping).resolves.toBeUndefined();
		expect(operation).toHaveBeenCalledExactlyOnceWith({
			timedOut: false,
			admissionClosedSettled: true,
		});
	});

	it('runs the operation without an operations error when only the callback is pending', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const operation = vi.fn(async (_idle: unknown) => undefined);
		const stopping = coordinator.shutdown(operation, {
			idleTimeoutMs: 100,
			onAdmissionClosed: () => new Promise<void>(() => {}),
		});

		// When
		await vi.advanceTimersByTimeAsync(100);

		// Then
		await expect(stopping).resolves.toBeUndefined();
		expect(operation).toHaveBeenCalledExactlyOnceWith({
			timedOut: true,
			admissionClosedSettled: false,
		});
		expect(coordinator.globalPhase).toBe('stopped');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('never leaves a rejected callback promise unhandled', async () => {
		// Given
		useTimersOnly();
		const unhandledRejections: unknown[] = [];
		const record = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on('unhandledRejection', record);
		try {
			const coordinator = new SessionLifecycleCoordinator();
			const operation = vi.fn(async (_idle: unknown) => undefined);

			// When
			await coordinator.shutdown(operation, {
				idleTimeoutMs: 100,
				onAdmissionClosed: async () => Promise.reject(new Error('discovery teardown failed')),
			});
			await new Promise<void>((resolve) => setImmediate(resolve));

			// Then
			expect(unhandledRejections).toEqual([]);
			expect(operation).toHaveBeenCalledExactlyOnceWith({
				timedOut: false,
				admissionClosedSettled: true,
			});
		} finally {
			process.off('unhandledRejection', record);
		}
	});

	it('returns one bounded settlement to every caller and runs one operation', async () => {
		// Given
		useTimersOnly();
		const coordinator = new SessionLifecycleCoordinator();
		const gate = deferred();
		const held = coordinator.runOperation(asSessionId('shared'), async () => gate.promise);
		const operation = vi.fn(async () => undefined);
		const later = vi.fn(async () => undefined);

		// When
		const first = coordinator.shutdown(operation, { idleTimeoutMs: 100 });
		const second = coordinator.shutdown(later, { idleTimeoutMs: 5 });
		const outcome = rejectionOf(first);
		await vi.advanceTimersByTimeAsync(100);

		// Then
		expect(second).toBe(first);
		expect(aggregateErrors(await outcome)).toHaveLength(1);
		expect(operation).toHaveBeenCalledOnce();
		expect(later).not.toHaveBeenCalled();
		gate.resolve();
		await held;
	});
});
