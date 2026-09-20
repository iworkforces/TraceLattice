import { describe, it, expect, vi } from 'vitest';
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
		clearSession: vi.fn().mockResolvedValue(undefined),
		clearAll: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		saveEdges: vi.fn().mockResolvedValue(undefined),
		loadEdges: vi.fn().mockResolvedValue([]),
		saveSummaries: vi.fn().mockResolvedValue(undefined),
		loadSummaries: vi.fn().mockResolvedValue([]),
		...overrides,
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
