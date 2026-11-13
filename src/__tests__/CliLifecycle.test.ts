import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CLI_SHUTDOWN_DEADLINE_MS,
	CliLifecycle,
	createCliShutdownHandler,
	stopWithin,
	transportStopSliceMs,
	type CliLifecycleClock,
	type CliOwnedResource,
} from '../CliLifecycle.js';
import { CliShutdownTimeoutError, TransportStopTimeoutError } from '../errors.js';

class LifecycleFixtureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LifecycleFixtureError';
	}
}

function deferred(): PromiseWithResolvers<void> {
	return Promise.withResolvers<void>();
}

afterEach(() => {
	vi.useRealTimers();
});

describe('CliLifecycle', () => {
	it('uses one 30,000 ms production shutdown deadline', () => {
		// Given / When / Then
		expect(CLI_SHUTDOWN_DEADLINE_MS).toBe(30_000);
	});

	it('returns one exact shutdown promise to first and repeated signal handlers', async () => {
		// Given
		const transportGate = deferred();
		const transport = { stop: vi.fn(() => transportGate.promise) } satisfies CliOwnedResource;
		const server = { stop: vi.fn(async () => undefined) } satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(transport);

		// When
		const first = lifecycle.shutdown();
		const repeated = lifecycle.shutdown();

		// Then
		expect(repeated).toBe(first);
		expect(transport.stop).toHaveBeenCalledOnce();
		expect(server.stop).not.toHaveBeenCalled();
		transportGate.resolve();
		await first;
		expect(server.stop).toHaveBeenCalledOnce();
	});

	it('attempts transport then server cleanup and flattens all failures deterministically', async () => {
		// Given
		const calls: string[] = [];
		const transportFirst = new LifecycleFixtureError('transport first');
		const transportSecond = new LifecycleFixtureError('transport second');
		const serverFailure = new LifecycleFixtureError('server failure');
		const transport = {
			stop: vi.fn(async () => {
				calls.push('transport');
				throw new AggregateError(
					[transportFirst, new AggregateError([transportSecond], 'nested')],
					'transport'
				);
			}),
		} satisfies CliOwnedResource;
		const server = {
			stop: vi.fn(async () => {
				calls.push('server');
				throw serverFailure;
			}),
		} satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(transport);

		// When
		const outcome = await lifecycle.shutdown().then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		// Then
		expect(calls).toEqual(['transport', 'server']);
		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected' || !(outcome.error instanceof AggregateError)) {
			throw new LifecycleFixtureError('Expected aggregate shutdown failure');
		}
		expect(outcome.error.errors).toEqual([transportFirst, transportSecond, serverFailure]);
	});

	it('rolls back partially acquired resources and aggregates rollback failures', async () => {
		// Given
		const startupFailure = new LifecycleFixtureError('startup failed');
		const transportFailure = new LifecycleFixtureError('transport rollback failed');
		const serverFailure = new LifecycleFixtureError('server rollback failed');
		const transport = {
			stop: vi.fn(async () => {
				throw transportFailure;
			}),
		} satisfies CliOwnedResource;
		const server = {
			stop: vi.fn(async () => {
				throw serverFailure;
			}),
		} satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(transport);

		// When
		const outcome = await lifecycle.rollbackStartup(startupFailure).then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		// Then
		expect(transport.stop).toHaveBeenCalledOnce();
		expect(server.stop).toHaveBeenCalledOnce();
		if (outcome.kind !== 'rejected' || !(outcome.error instanceof AggregateError)) {
			throw new LifecycleFixtureError('Expected aggregate startup rollback failure');
		}
		expect(outcome.error.errors).toEqual([startupFailure, transportFailure, serverFailure]);
	});

	it('uses the same coordinator for stdio transport close and server cleanup', async () => {
		// Given
		const calls: string[] = [];
		const stdio = {
			stop: vi.fn(async () => {
				calls.push('stdio');
			}),
		} satisfies CliOwnedResource;
		const server = {
			stop: vi.fn(async () => {
				calls.push('server');
			}),
		} satisfies CliOwnedResource;
		const lifecycle = new CliLifecycle(server);
		lifecycle.attachTransport(stdio);

		// When
		await lifecycle.shutdown();

		// Then
		expect(calls).toEqual(['stdio', 'server']);
	});
});

type ShutdownRigOptions = {
	readonly deadlineMs: number;
	readonly transportStop: (timeoutMs: number) => void | Promise<void>;
	readonly serverStop?: () => void | Promise<void>;
	readonly clock?: CliLifecycleClock;
};

function createShutdownRig(options: ShutdownRigOptions) {
	const transport = { stop: vi.fn(options.transportStop) };
	const server = { stop: vi.fn(options.serverStop ?? (async () => undefined)) };
	const lifecycle = new CliLifecycle(server, {
		deadlineMs: options.deadlineMs,
		...(options.clock ? { clock: options.clock } : {}),
	});
	lifecycle.attachTransport(transport);
	const exit = vi.fn<(code: 0 | 1) => void>();
	const reportFailure = vi.fn<(error: unknown) => void>();
	const handler = createCliShutdownHandler(lifecycle, { exit, reportFailure });
	return { transport, server, lifecycle, exit, reportFailure, handler };
}

function useTimersOnly(): void {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

function rejectionOf(promise: Promise<void>): Promise<unknown> {
	return promise.then(
		() => null,
		(error: unknown) => error
	);
}

function aggregateErrors(failure: unknown): readonly unknown[] {
	if (!(failure instanceof AggregateError)) {
		throw new LifecycleFixtureError('Expected an aggregate shutdown failure');
	}
	return failure.errors;
}

function failureCodes(failure: unknown): readonly unknown[] {
	const failures = failure instanceof AggregateError ? failure.errors : [failure];
	return failures.map((entry) => Reflect.get(entry, 'code'));
}

describe('CliLifecycle shutdown budget', () => {
	it.each([
		{ totalMs: 30_000, sliceMs: 15_000 },
		{ totalMs: 25, sliceMs: 12 },
		{ totalMs: 2, sliceMs: 1 },
		{ totalMs: 1, sliceMs: 1 },
	])('gives the transport a $sliceMs ms slice of a $totalMs ms budget', async (budget) => {
		// Given
		const rig = createShutdownRig({ deadlineMs: budget.totalMs, transportStop: async () => {} });

		// When
		await rig.lifecycle.shutdown();

		// Then
		expect(transportStopSliceMs(budget.totalMs)).toBe(budget.sliceMs);
		expect(rig.transport.stop).toHaveBeenCalledExactlyOnceWith(budget.sliceMs);
	});

	it('arms the total timer, then calls transport.stop, then arms its own slice guard', async () => {
		// Given
		const events: string[] = [];
		const clock: CliLifecycleClock = {
			setTimeout: (callback, delayMs) => {
				events.push(`arm:${delayMs}`);
				return setTimeout(callback, delayMs);
			},
			clearTimeout: (handle) => {
				events.push('clear');
				clearTimeout(handle);
			},
		};
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: (timeoutMs) => {
				events.push(`stop:${timeoutMs}`);
			},
			clock,
		});

		// When
		await rig.lifecycle.shutdown();

		// Then
		expect(events.filter((event) => event !== 'clear')).toEqual(['arm:100', 'stop:50', 'arm:50']);
		expect(events.filter((event) => event === 'clear')).toHaveLength(2);
	});

	it('starts the server stop at the transport slice while a transport that ignores it is stuck', async () => {
		// Given
		useTimersOnly();
		const transportGate = deferred();
		const rig = createShutdownRig({ deadlineMs: 100, transportStop: () => transportGate.promise });

		// When
		const firstSignal = rig.handler();
		const repeatedSignal = rig.handler();
		await vi.advanceTimersByTimeAsync(49);
		const serverStopsBeforeSlice = rig.server.stop.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1);
		await firstSignal;

		// Then
		expect(repeatedSignal).toBe(firstSignal);
		expect(serverStopsBeforeSlice).toBe(0);
		expect(rig.transport.stop).toHaveBeenCalledExactlyOnceWith(50);
		expect(rig.server.stop).toHaveBeenCalledOnce();
		expect(rig.reportFailure).toHaveBeenCalledOnce();
		expect(aggregateErrors(rig.reportFailure.mock.calls[0]?.[0])).toEqual([
			expect.objectContaining({
				code: 'TRANSPORT_STOP_TIMEOUT',
				timeoutMs: 50,
				abandonedRequests: null,
			}),
		]);
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(1);
		expect(vi.getTimerCount()).toBe(0);
		transportGate.resolve();
		await vi.runAllTimersAsync();
		expect(rig.exit).toHaveBeenCalledOnce();
	});

	it('lets a transport that honors its slice report its own typed error before the guard', async () => {
		// Given
		useTimersOnly();
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: (timeoutMs) =>
				new Promise<void>((_resolve, reject) => {
					setTimeout(() => reject(new TransportStopTimeoutError(timeoutMs, 3)), timeoutMs);
				}),
		});
		const outcome = rejectionOf(rig.lifecycle.shutdown());

		// When
		await vi.advanceTimersByTimeAsync(50);

		// Then
		expect(aggregateErrors(await outcome)).toEqual([
			expect.objectContaining({ timeoutMs: 50, abandonedRequests: 3 }),
		]);
		expect(rig.server.stop).toHaveBeenCalledOnce();
	});

	it('reports the transport failure instead of the guard error when it lands before the server stop settles', async () => {
		// Given
		useTimersOnly();
		const transportGate = deferred();
		const serverGate = deferred();
		const lateFailure = new LifecycleFixtureError('transport failed late');
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: () => transportGate.promise,
			serverStop: () => serverGate.promise,
		});
		const outcome = rejectionOf(rig.lifecycle.shutdown());

		// When
		await vi.advanceTimersByTimeAsync(50);
		transportGate.reject(lateFailure);
		await vi.advanceTimersByTimeAsync(0);
		serverGate.resolve();

		// Then
		expect(aggregateErrors(await outcome)).toEqual([lateFailure]);
	});

	it('keeps the slice timeout as a failure when the transport stops cleanly after overrunning it', async () => {
		// Given
		useTimersOnly();
		const transportGate = deferred();
		const serverGate = deferred();
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: () => transportGate.promise,
			serverStop: () => serverGate.promise,
		});
		const signal = rig.handler();

		// When
		await vi.advanceTimersByTimeAsync(50);
		transportGate.resolve();
		await vi.advanceTimersByTimeAsync(0);
		serverGate.resolve();
		await signal;

		// Then
		expect(aggregateErrors(rig.reportFailure.mock.calls[0]?.[0])).toEqual([
			expect.objectContaining({
				code: 'TRANSPORT_STOP_TIMEOUT',
				timeoutMs: 50,
				abandonedRequests: null,
			}),
		]);
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('never leaves a late rejection from an abandoned transport unhandled', async () => {
		// Given
		useTimersOnly();
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			const transportGate = deferred();
			const rig = createShutdownRig({
				deadlineMs: 100,
				transportStop: () => transportGate.promise,
			});
			const outcome = rejectionOf(rig.lifecycle.shutdown());
			await vi.advanceTimersByTimeAsync(50);
			await outcome;

			// When
			transportGate.reject(new LifecycleFixtureError('transport failed after being abandoned'));
			await new Promise<void>((resolve) => setImmediate(resolve));

			// Then
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}
	});

	it('exits 0 only after both stops succeed', async () => {
		// Given
		const rig = createShutdownRig({ deadlineMs: 100, transportStop: async () => {} });

		// When
		await rig.handler();

		// Then
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(rig.reportFailure).not.toHaveBeenCalled();
	});

	it('aggregates a transport failure and a server failure and exits 1', async () => {
		// Given
		const transportFailure = new LifecycleFixtureError('transport failed');
		const serverFailure = new LifecycleFixtureError('server failed');
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: async () => {
				throw transportFailure;
			},
			serverStop: async () => {
				throw serverFailure;
			},
		});

		// When
		await rig.handler();

		// Then
		expect(aggregateErrors(rig.reportFailure.mock.calls[0]?.[0])).toEqual([
			transportFailure,
			serverFailure,
		]);
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('fails with the typed total deadline when the server stop outlives the remaining budget', async () => {
		// Given
		useTimersOnly();
		const serverGate = deferred();
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: async () => {},
			serverStop: () => serverGate.promise,
		});

		// When
		const signal = rig.handler();
		await vi.advanceTimersByTimeAsync(99);
		const reportsBeforeDeadline = rig.reportFailure.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1);
		await signal;

		// Then
		expect(reportsBeforeDeadline).toBe(0);
		const failure = rig.reportFailure.mock.calls[0]?.[0];
		expect(failure).toBeInstanceOf(CliShutdownTimeoutError);
		expect(failure).toMatchObject({ code: 'CLI_SHUTDOWN_TIMEOUT', timeoutMs: 100 });
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(1);
		serverGate.resolve();
		await vi.runAllTimersAsync();
		expect(rig.exit).toHaveBeenCalledOnce();
		expect(rig.server.stop).toHaveBeenCalledOnce();
	});

	it('reports an earlier transport timeout together with the total deadline', async () => {
		// Given
		useTimersOnly();
		const rig = createShutdownRig({
			deadlineMs: 100,
			transportStop: () => new Promise<void>(() => {}),
			serverStop: () => new Promise<void>(() => {}),
		});

		// When
		const signal = rig.handler();
		await vi.advanceTimersByTimeAsync(50);
		const serverStopsAtSlice = rig.server.stop.mock.calls.length;
		await vi.advanceTimersByTimeAsync(50);
		await signal;

		// Then
		expect(serverStopsAtSlice).toBe(1);
		expect(failureCodes(rig.reportFailure.mock.calls[0]?.[0])).toEqual([
			'TRANSPORT_STOP_TIMEOUT',
			'CLI_SHUTDOWN_TIMEOUT',
		]);
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('still starts the server stop when the total deadline expires before the transport phase ends', async () => {
		// Given
		useTimersOnly();
		const rig = createShutdownRig({
			deadlineMs: 1,
			transportStop: () => new Promise<void>(() => {}),
			serverStop: () => new Promise<void>(() => {}),
		});

		// When
		const signal = rig.handler();
		await vi.advanceTimersByTimeAsync(1);
		await signal;

		// Then
		expect(rig.server.stop).toHaveBeenCalledOnce();
		expect(failureCodes(rig.reportFailure.mock.calls[0]?.[0])).toContain('CLI_SHUTDOWN_TIMEOUT');
		expect(rig.exit).toHaveBeenCalledExactlyOnceWith(1);
	});
});

describe('stopWithin', () => {
	it('settles with a close that finishes inside the slice and clears its guard', async () => {
		// Given
		useTimersOnly();
		const closeGate = deferred();
		const closing = stopWithin(() => closeGate.promise, 50);

		// When
		await vi.advanceTimersByTimeAsync(49);
		closeGate.resolve();

		// Then
		await expect(closing).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects with an untracked transport timeout when the close never settles', async () => {
		// Given
		useTimersOnly();
		const closing = stopWithin(() => new Promise<void>(() => {}), 50);
		const outcome = closing.then(
			() => null,
			(error: unknown) => error
		);

		// When
		await vi.advanceTimersByTimeAsync(50);

		// Then
		expect(await outcome).toMatchObject({
			code: 'TRANSPORT_STOP_TIMEOUT',
			timeoutMs: 50,
			abandonedRequests: null,
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});
