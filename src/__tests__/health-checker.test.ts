import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthChecker } from '../health/HealthChecker.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { Logger } from '../logger/StructuredLogger.js';

/**
 * Create a mock PersistenceBackend with all methods stubbed.
 */
function createMockBackend(overrides: Partial<PersistenceBackend> = {}): PersistenceBackend {
	return {
		healthy: vi.fn().mockResolvedValue(true),
		saveThoughtForSession: vi.fn().mockResolvedValue(undefined),
		loadHistoryForSession: vi.fn().mockResolvedValue([]),
		saveBranchForSession: vi.fn().mockResolvedValue(undefined),
		deleteBranchForSession: vi.fn().mockResolvedValue(undefined),
		loadBranchForSession: vi.fn().mockResolvedValue(undefined),
		listBranchesForSession: vi.fn().mockResolvedValue([]),
		listSessions: vi.fn().mockResolvedValue([]),
		loadAllSessionsForRestore: vi.fn().mockResolvedValue({ sessions: [] }),
		clearSession: vi.fn().mockResolvedValue(undefined),
		clearAll: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		saveEdges: vi.fn().mockResolvedValue(undefined),
		loadEdges: vi.fn().mockResolvedValue([]),
		saveSummaries: vi.fn().mockResolvedValue(undefined),
		loadSummaries: vi.fn().mockResolvedValue([]),
		...overrides,
		saveBacktrackForSession:
			overrides.saveBacktrackForSession ?? vi.fn().mockResolvedValue(undefined),
	};
}

/**
 * Create a mock Logger with all methods stubbed.
 */
function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as Logger;
}

describe('HealthChecker', () => {
	describe('checkLiveness()', () => {
		it('should return status ok', () => {
			const checker = new HealthChecker();
			const result = checker.checkLiveness();

			expect(result.status).toBe('ok');
		});

		it('should return a valid ISO timestamp', () => {
			const checker = new HealthChecker();
			const result = checker.checkLiveness();

			// Verify it's a valid ISO date string
			const parsed = new Date(result.timestamp);
			expect(parsed.toISOString()).toBe(result.timestamp);
			expect(isNaN(parsed.getTime())).toBe(false);
		});

		it('should return an empty components object', () => {
			const checker = new HealthChecker();
			const result = checker.checkLiveness();

			expect(result.components).toEqual({});
		});

		it('should return synchronously (no promise)', () => {
			const checker = new HealthChecker();
			const result = checker.checkLiveness();

			// checkLiveness returns HealthCheckResult, not a Promise
			expect(result).not.toBeInstanceOf(Promise);
			expect(result.status).toBeDefined();
		});
	});

	describe('checkReadiness()', () => {
		it('should return status ok when no components are registered', async () => {
			const checker = new HealthChecker();
			const result = await checker.checkReadiness();

			expect(result.status).toBe('ok');
			expect(result.components).toEqual({});
		});

		it('should return status ok when persistence is null', async () => {
			const checker = new HealthChecker({ persistence: null });
			const result = await checker.checkReadiness();

			expect(result.status).toBe('ok');
			expect(result.components).toEqual({});
		});

		it('should return status ok when persistence is healthy', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockResolvedValue(true),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.status).toBe('ok');
			expect(result.components['persistence']).toBeDefined();
			expect(result.components['persistence']!.healthy).toBe(true);
		});

		it('should return status unhealthy when persistence reports unhealthy', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockResolvedValue(false),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.status).toBe('unhealthy');
			expect(result.components['persistence']!.healthy).toBe(false);
		});

		it('should return status unhealthy when persistence.healthy() throws', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockRejectedValue(new Error('Connection refused')),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.status).toBe('unhealthy');
			expect(result.components['persistence']!.healthy).toBe(false);
		});

		it('should include latencyMs in component result', async () => {
			const mockBackend = createMockBackend();
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.components['persistence']!.latencyMs).toBeDefined();
			expect(typeof result.components['persistence']!.latencyMs).toBe('number');
			expect(result.components['persistence']!.latencyMs).toBeGreaterThanOrEqual(0);
		});

		it('should include details string when persistence is healthy', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockResolvedValue(true),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.components['persistence']!.details).toBe('Backend is responsive');
		});

		it('should include details string when persistence is unhealthy', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockResolvedValue(false),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.components['persistence']!.details).toBe('Backend reported unhealthy');
		});

		it('should include error details when persistence.healthy() throws', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockRejectedValue(new Error('Connection refused')),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.components['persistence']!.details).toBe(
				'Health check error: Connection refused'
			);
		});

		it('should handle non-Error thrown values', async () => {
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockRejectedValue('string error'),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.components['persistence']!.healthy).toBe(false);
			expect(result.components['persistence']!.details).toBe('Health check error: string error');
		});

		it('should return a valid ISO timestamp', async () => {
			const checker = new HealthChecker();
			const result = await checker.checkReadiness();

			const parsed = new Date(result.timestamp);
			expect(parsed.toISOString()).toBe(result.timestamp);
		});

		it('should set component name to persistence', async () => {
			const mockBackend = createMockBackend();
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.components['persistence']!.name).toBe('persistence');
		});
	});

	describe('Logging behavior', () => {
		it('should log warning when status is not ok', async () => {
			const mockLogger = createMockLogger();
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockResolvedValue(false),
			});
			const checker = new HealthChecker({
				persistence: mockBackend,
				logger: mockLogger,
			});

			await checker.checkReadiness();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Readiness check returned non-ok status',
				expect.objectContaining({
					status: 'unhealthy',
					components: expect.any(Object),
				})
			);
		});

		it('should not log warning when status is ok', async () => {
			const mockLogger = createMockLogger();
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockResolvedValue(true),
			});
			const checker = new HealthChecker({
				persistence: mockBackend,
				logger: mockLogger,
			});

			await checker.checkReadiness();

			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		it('should not log warning when no components are registered', async () => {
			const mockLogger = createMockLogger();
			const checker = new HealthChecker({ logger: mockLogger });

			await checker.checkReadiness();

			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		it('should log error when persistence.healthy() throws', async () => {
			const mockLogger = createMockLogger();
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockRejectedValue(new Error('DB crashed')),
			});
			const checker = new HealthChecker({
				persistence: mockBackend,
				logger: mockLogger,
			});

			await checker.checkReadiness();

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Persistence health check failed',
				expect.objectContaining({
					error: 'DB crashed',
				})
			);
		});

		it('should log error with stringified non-Error value', async () => {
			const mockLogger = createMockLogger();
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockRejectedValue(42),
			});
			const checker = new HealthChecker({
				persistence: mockBackend,
				logger: mockLogger,
			});

			await checker.checkReadiness();

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Persistence health check failed',
				expect.objectContaining({
					error: '42',
				})
			);
		});
	});

	describe('Edge cases', () => {
		it('should handle slow persistence backend', async () => {
			const mockBackend = createMockBackend({
				healthy: vi
					.fn()
					.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(true), 50))),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			expect(result.status).toBe('ok');
			expect(result.components['persistence']!.healthy).toBe(true);
			expect(result.components['persistence']!.latencyMs).toBeGreaterThanOrEqual(0);
		});

		it('should produce fresh timestamps on multiple calls', async () => {
			const checker = new HealthChecker();

			const result1 = await checker.checkReadiness();
			// Small delay to ensure different timestamps
			await new Promise((resolve) => setTimeout(resolve, 5));
			const result2 = await checker.checkReadiness();

			// Timestamps should be valid ISOs; may or may not be identical
			// depending on timing, but both should be valid
			expect(new Date(result1.timestamp).getTime()).toBeLessThanOrEqual(
				new Date(result2.timestamp).getTime()
			);
		});

		it('should produce fresh timestamps for liveness on multiple calls', () => {
			const checker = new HealthChecker();

			const result1 = checker.checkLiveness();
			const result2 = checker.checkLiveness();

			// Both should be valid timestamps
			expect(new Date(result1.timestamp).getTime()).toBeLessThanOrEqual(
				new Date(result2.timestamp).getTime()
			);
		});

		it('should use noop logger when no logger provided', async () => {
			// Should not throw when using internal NoopLogger
			const mockBackend = createMockBackend({
				healthy: vi.fn().mockRejectedValue(new Error('test')),
			});
			const checker = new HealthChecker({ persistence: mockBackend });
			const result = await checker.checkReadiness();

			// Should complete without errors even with no custom logger
			expect(result.status).toBe('unhealthy');
		});

		it('should work with default empty options', async () => {
			const checker = new HealthChecker({});
			const result = await checker.checkReadiness();

			expect(result.status).toBe('ok');
			expect(result.components).toEqual({});
		});

		it('should work with no constructor argument', async () => {
			const checker = new HealthChecker();
			const result = await checker.checkReadiness();

			expect(result.status).toBe('ok');
		});

		it('should call persistence.healthy() exactly once per readiness check', async () => {
			const healthyFn = vi.fn().mockResolvedValue(true);
			const mockBackend = createMockBackend({ healthy: healthyFn });
			const checker = new HealthChecker({ persistence: mockBackend });

			await checker.checkReadiness();

			expect(healthyFn).toHaveBeenCalledTimes(1);
		});

		it('should call persistence.healthy() on each readiness check', async () => {
			const healthyFn = vi.fn().mockResolvedValue(true);
			const mockBackend = createMockBackend({ healthy: healthyFn });
			const checker = new HealthChecker({ persistence: mockBackend });

			await checker.checkReadiness();
			await checker.checkReadiness();
			await checker.checkReadiness();

			expect(healthyFn).toHaveBeenCalledTimes(3);
		});
	});
});

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const TIMED_OUT_DETAILS = 'Health check timed out after 1000ms';

describe('HealthChecker bounded shared probe', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reports persistence unhealthy when healthy() outlives the default deadline', async () => {
		// Given
		const probe = createDeferred<boolean>();
		const persistence = createMockBackend({ healthy: vi.fn(() => probe.promise) });
		const checker = new HealthChecker({ persistence });
		let settled = false;
		const pending = checker.checkReadiness().then((result) => {
			settled = true;
			return result;
		});

		// When
		await vi.advanceTimersByTimeAsync(999);
		const settledBeforeDeadline = settled;
		await vi.advanceTimersByTimeAsync(1);
		const result = await pending;

		// Then
		expect(settledBeforeDeadline).toBe(false);
		expect(result.status).toBe('unhealthy');
		expect(result.components['persistence']).toEqual({
			name: 'persistence',
			healthy: false,
			latencyMs: 1000,
			details: TIMED_OUT_DETAILS,
		});
	});

	it('honours a configured probeTimeoutMs', async () => {
		// Given
		const probe = createDeferred<boolean>();
		const persistence = createMockBackend({ healthy: vi.fn(() => probe.promise) });
		const checker = new HealthChecker({ persistence, probeTimeoutMs: 250 });
		const pending = checker.checkReadiness();

		// When
		await vi.advanceTimersByTimeAsync(250);
		const result = await pending;

		// Then
		expect(result.components['persistence']!.details).toBe('Health check timed out after 250ms');
	});

	it('converts a synchronous healthy() throw into an unhealthy component', async () => {
		// Given
		const persistence = createMockBackend({
			healthy: vi.fn(() => {
				throw new Error('sync boom');
			}),
		});
		const checker = new HealthChecker({ persistence });

		// When
		const result = await checker.checkReadiness();

		// Then
		expect(result.components['persistence']!.healthy).toBe(false);
		expect(result.components['persistence']!.details).toBe('Health check error: sync boom');
	});

	it('shares one backend probe between concurrent readiness checks', async () => {
		// Given
		const probe = createDeferred<boolean>();
		const healthy = vi.fn(() => probe.promise);
		const checker = new HealthChecker({ persistence: createMockBackend({ healthy }) });
		const calls = [checker.checkReadiness(), checker.checkReadiness(), checker.checkReadiness()];

		// When
		probe.resolve(true);
		const results = await Promise.all(calls);

		// Then
		expect(healthy).toHaveBeenCalledTimes(1);
		expect(results.map((result) => result.status)).toEqual(['ok', 'ok', 'ok']);
	});

	it('joins a timed-out probe instead of starting another one', async () => {
		// Given
		const stuck = createDeferred<boolean>();
		const healthy = vi
			.fn<() => Promise<boolean>>()
			.mockReturnValueOnce(stuck.promise)
			.mockResolvedValue(true);
		const checker = new HealthChecker({ persistence: createMockBackend({ healthy }) });
		const first = checker.checkReadiness();
		await vi.advanceTimersByTimeAsync(1000);
		await first;

		// When
		const polls = [];
		for (let index = 0; index < 3; index += 1) polls.push(await checker.checkReadiness());

		// Then
		expect(healthy).toHaveBeenCalledTimes(1);
		expect(polls.map((poll) => poll.components['persistence']!.details)).toEqual([
			TIMED_OUT_DETAILS,
			TIMED_OUT_DETAILS,
			TIMED_OUT_DETAILS,
		]);

		// When the stuck probe finally settles
		stuck.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		const recovered = await checker.checkReadiness();

		// Then a fresh probe runs and the instance is ready again
		expect(healthy).toHaveBeenCalledTimes(2);
		expect(recovered.status).toBe('ok');
	});

	it('handles a late rejection of a timed-out probe without an unhandled rejection', async () => {
		// Given
		const logger = createMockLogger();
		const stuck = createDeferred<boolean>();
		const persistence = createMockBackend({ healthy: vi.fn(() => stuck.promise) });
		const checker = new HealthChecker({ persistence, logger });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);

		try {
			const pending = checker.checkReadiness();
			await vi.advanceTimersByTimeAsync(1000);
			await pending;

			// When
			stuck.reject(new Error('late failure'));
			await vi.advanceTimersByTimeAsync(0);
			await new Promise<void>((resolve) => setImmediate(resolve));

			// Then
			expect(unhandled).toEqual([]);
			expect(logger.error).toHaveBeenCalledTimes(1);
			expect(logger.error).toHaveBeenCalledWith(
				'Persistence health check failed',
				expect.objectContaining({ error: 'late failure' })
			);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('reuses a settled result inside probeFreshnessMs and probes again after it', async () => {
		// Given
		const healthy = vi.fn().mockResolvedValue(true);
		const checker = new HealthChecker({
			persistence: createMockBackend({ healthy }),
			probeFreshnessMs: 1000,
		});
		const first = await checker.checkReadiness();

		// When
		await vi.advanceTimersByTimeAsync(999);
		const reused = await checker.checkReadiness();
		const callsInsideWindow = healthy.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1);
		await checker.checkReadiness();

		// Then
		expect(callsInsideWindow).toBe(1);
		expect(healthy).toHaveBeenCalledTimes(2);
		expect(reused.components['persistence']).toEqual(first.components['persistence']);
	});

	it('reuses a failed result inside the freshness window and logs the failure once', async () => {
		// Given
		const logger = createMockLogger();
		const healthy = vi.fn().mockRejectedValue(new Error('disk gone'));
		const checker = new HealthChecker({
			persistence: createMockBackend({ healthy }),
			probeFreshnessMs: 1000,
			logger,
		});

		// When
		const first = await checker.checkReadiness();
		const second = await checker.checkReadiness();

		// Then
		expect(healthy).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(second.components['persistence']).toEqual(first.components['persistence']);
		expect(second.status).toBe('unhealthy');
	});

	it('clears the deadline timer when the probe settles first', async () => {
		// Given
		const checker = new HealthChecker({ persistence: createMockBackend() });

		// When
		await checker.checkReadiness();

		// Then
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not let a pending deadline timer keep the process alive', async () => {
		// Given
		const probe = createDeferred<boolean>();
		const startedTimers: { hasRef(): boolean }[] = [];
		const fakeSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const timer = fakeSetTimeout(...args);
			startedTimers.push(timer);
			return timer;
		}) as typeof setTimeout);
		const checker = new HealthChecker({
			persistence: createMockBackend({ healthy: vi.fn(() => probe.promise) }),
		});

		// When
		const pending = checker.checkReadiness();

		// Then
		expect(startedTimers).toHaveLength(1);
		expect(startedTimers[0]!.hasRef()).toBe(false);

		probe.resolve(true);
		await pending;
	});

	it('keeps the persistence component shape for a checker built with only persistence', async () => {
		// Given
		const checker = new HealthChecker({ persistence: createMockBackend() });

		// When
		const result = await checker.checkReadiness();

		// Then
		expect(Object.keys(result.components)).toEqual(['persistence']);
		expect(Object.keys(result.components['persistence']!).sort()).toEqual([
			'details',
			'healthy',
			'latencyMs',
			'name',
		]);
	});
});
