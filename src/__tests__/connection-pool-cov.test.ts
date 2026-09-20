import { describe, it, expect, vi } from 'vitest';
import { ConnectionPool, createConnectionPool } from '../pool/ConnectionPool.js';
import type { ThoughtData } from '../core/thought.js';
import { asSessionId } from '../contracts/ids.js';

const createMockServer = () => ({
	processThought: vi.fn().mockResolvedValue({
		content: [{ type: 'text', text: 'Test response' }],
	}),
	stop: vi.fn().mockResolvedValue(undefined),
});

const createMockServerFactory = () => vi.fn().mockImplementation(async () => createMockServer());

describe('ConnectionPool additional coverage', () => {
	describe('Session timeout', () => {
		it('should close session on timeout via auto cleanup', async () => {
			vi.useFakeTimers();

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 1000, // 1 second
				autoCleanup: true,
				cleanupInterval: 500,
				serverFactory: createMockServerFactory(),
			});

			const sessionId = await pool.createSession();
			expect(pool.getSessionInfo(sessionId)?.isActive).toBe(true);

			// Advance past timeout + cleanup interval so cleanup removes the session
			await vi.advanceTimersByTimeAsync(1500);

			// Session should be removed by cleanup
			expect(pool.getSessionInfo(sessionId)).toBeUndefined();

			await pool.dispose();
			vi.useRealTimers();
		});

		it('should reset timeout on activity', async () => {
			vi.useFakeTimers();

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 2000,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const sessionId = await pool.createSession();

			// Advance 1500ms (almost timeout)
			vi.advanceTimersByTime(1500);

			// Process a thought (resets timeout)
			const thought: ThoughtData = {
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('timeout-reset-thought'),
			};
			await pool.process(sessionId, thought);

			// Advance another 1500ms - should still be active because timeout was reset
			vi.advanceTimersByTime(1500);

			expect(pool.getSessionInfo(sessionId)?.isActive).toBe(true);

			await pool.dispose();
			vi.useRealTimers();
		});

		it('should reject process on inactive session', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 1000,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const sessionId = await pool.createSession();

			// Close the session
			await pool.closeSession(sessionId);

			const thought: ThoughtData = {
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('inactive-thought'),
			};

			// Process should fail because session is closed
			// Note: SessionNotFoundError is for sessions not in pool
			// SessionNotActiveError is for inactive sessions
			await expect(pool.process(sessionId, thought)).rejects.toThrow();

			await pool.dispose();
		});
	});

	describe('auto cleanup', () => {
		it('should clean up timed-out sessions automatically', async () => {
			vi.useFakeTimers();

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 1000,
				autoCleanup: true,
				cleanupInterval: 500,
				serverFactory: createMockServerFactory(),
			});

			await pool.createSession();
			expect(pool.getStats().totalSessions).toBe(1);

			// Advance past timeout and cleanup interval
			vi.advanceTimersByTime(1500);

			// Session should be cleaned up
			expect(pool.getStats().totalSessions).toBe(0);

			await pool.dispose();
			vi.useRealTimers();
		});
	});

	describe('dispose', () => {
		it('should dispose all resources', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			await pool.createSession();
			expect(pool.isRunning()).toBe(true);

			await pool.dispose();
			expect(pool.isRunning()).toBe(false);
			expect(pool.getStats().totalSessions).toBe(0);
		});
	});

	describe('concurrent session creation', () => {
		it('should handle concurrent createSession calls', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const [id1, id2, id3] = await Promise.all([
				pool.createSession(),
				pool.createSession(),
				pool.createSession(),
			]);

			expect(id1).not.toBe(id2);
			expect(id2).not.toBe(id3);
			expect(pool.getStats().totalSessions).toBe(3);

			await pool.dispose();
		});
	});

	describe('session isTimedOut', () => {
		it('should detect timed-out session via auto cleanup', async () => {
			vi.useFakeTimers();

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 100,
				autoCleanup: true,
				cleanupInterval: 50,
				serverFactory: createMockServerFactory(),
			});

			const sessionId = await pool.createSession();
			const session = pool.getSessionInfo(sessionId);

			// Not timed out yet
			expect(session?.isActive).toBe(true);

			// Wait past timeout + cleanup interval
			await vi.advanceTimersByTimeAsync(200);

			// Session should be cleaned up (removed from pool)
			expect(pool.getSessionInfo(sessionId)).toBeUndefined();

			await pool.dispose();
			vi.useRealTimers();
		});
	});

	describe('error handling in dispose', () => {
		it('should report errors when closing sessions during dispose', async () => {
			const stopFailure = new Error('Stop failed');
			const failingFactory = vi.fn().mockImplementation(async () => ({
				processThought: vi.fn().mockResolvedValue({
					content: [{ type: 'text', text: 'test' }],
				}),
				stop: vi.fn().mockRejectedValue(stopFailure),
			}));

			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: failingFactory,
			});

			await pool.createSession();

			await expect(pool.dispose()).rejects.toMatchObject({ errors: [stopFailure] });
		});
	});

	describe('createConnectionPool factory', () => {
		it('should create pool with all options', () => {
			const pool = createConnectionPool({
				maxSessions: 50,
				sessionTimeout: 60000,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			expect(pool).toBeInstanceOf(ConnectionPool);
			expect(pool.getStats().maxSessions).toBe(50);

			pool.dispose();
		});
	});

	describe('Session timeout timer with existing timer', () => {
		it('should clear existing timer when _startTimeout is called again (via process)', async () => {
			vi.useFakeTimers();

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 5000,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const sessionId = await pool.createSession();

			const thought: ThoughtData = {
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('timer-reset-thought'),
			};

			// First process call sets timeout timer
			await pool.process(sessionId, thought);

			// Second process call should clear existing timer and reset
			await pool.process(sessionId, thought);

			// Session should still be active
			expect(pool.getSessionInfo(sessionId)?.isActive).toBe(true);

			await pool.dispose();
			vi.useRealTimers();
		});
	});

	describe('cleanup error handling', () => {
		it('should handle session.close() error during auto cleanup', async () => {
			vi.useFakeTimers();
			const stopFailure = new Error('stop failed');
			const stop = vi.fn().mockRejectedValueOnce(stopFailure).mockResolvedValue(undefined);

			const failingFactory = vi.fn().mockImplementation(async () => ({
				processThought: vi.fn().mockResolvedValue({
					content: [{ type: 'text', text: 'test' }],
				}),
				stop,
			}));

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 100,
				autoCleanup: true,
				cleanupInterval: 50,
				serverFactory: failingFactory,
			});

			await pool.createSession();

			// Advance past timeout + cleanup to trigger the error path
			await vi.advanceTimersByTimeAsync(200);

			// Pool should still be running despite the error
			expect(pool.isRunning()).toBe(true);
			expect(stop).toHaveBeenCalledTimes(2);

			await pool.dispose();
			vi.useRealTimers();
		});

		it('routes internal timeout failures through cleanup and retries on the next sweep', async () => {
			vi.useFakeTimers();
			const startTime = Date.now();
			const stopFailure = new Error('timed cleanup failed');
			const stop = vi.fn().mockRejectedValueOnce(stopFailure).mockResolvedValue(undefined);
			const pool = new ConnectionPool({
				maxSessions: 1,
				sessionTimeout: 100,
				autoCleanup: true,
				cleanupInterval: 200,
				serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
			});
			const sessionId = await pool.createSession();

			vi.setSystemTime(new Date(startTime + 1));
			await vi.advanceTimersByTimeAsync(100);

			expect(stop).toHaveBeenCalledTimes(1);
			expect(pool.getSessionInfo(sessionId)).toBeUndefined();
			await expect(pool.createSession()).rejects.toThrow('Max sessions (1) reached');

			await vi.advanceTimersByTimeAsync(100);
			expect(stop).toHaveBeenCalledTimes(2);
			await expect(pool.createSession()).resolves.toMatch(/^session_/);

			await pool.dispose();
			vi.useRealTimers();
		});

		it('retries a synchronous child stop throw on explicit close', async () => {
			const stopFailure = new Error('synchronous stop failure');
			const stop = vi
				.fn()
				.mockImplementationOnce(() => {
					throw stopFailure;
				})
				.mockResolvedValue(undefined);
			const pool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
			});
			const sessionId = await pool.createSession();

			await expect(pool.closeSession(sessionId)).rejects.toBe(stopFailure);
			await expect(pool.closeSession(sessionId)).resolves.toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(2);
			await pool.dispose();
		});
	});

	describe('getActiveSessions', () => {
		it('should return active sessions', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const id1 = await pool.createSession();
			const id2 = await pool.createSession();

			const sessions = pool.getActiveSessions();
			expect(sessions).toHaveLength(2);
			expect(sessions.map((s) => s.id)).toContain(id1);
			expect(sessions.map((s) => s.id)).toContain(id2);

			// Close one session
			await pool.closeSession(id1);

			const after = pool.getActiveSessions();
			expect(after).toHaveLength(1);

			await pool.dispose();
		});
	});

	describe('closeSession errors', () => {
		it('should throw for unknown session', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			await expect(pool.closeSession(asSessionId('nonexistent'))).rejects.toThrow();

			await pool.dispose();
		});
	});

	describe('createSession errors', () => {
		it('should throw when max sessions reached', async () => {
			const pool = new ConnectionPool({
				maxSessions: 1,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			await pool.createSession();
			await expect(pool.createSession()).rejects.toThrow();

			await pool.dispose();
		});

		it('should throw when pool is terminated', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			await pool.dispose();
			await expect(pool.createSession()).rejects.toThrow();
		});

		it('should throw when no serverFactory is provided', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
			});

			await expect(pool.createSession()).rejects.toThrow(
				'ConnectionPool requires a serverFactory option to create sessions'
			);

			await pool.dispose();
		});
	});

	describe('session self-timeout', () => {
		it('should auto-close session via Session internal timeout timer', async () => {
			vi.useFakeTimers();
			const startTime = Date.now();

			const pool = new ConnectionPool({
				maxSessions: 5,
				sessionTimeout: 100,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const sessionId = await pool.createSession();
			expect(pool.getSessionInfo(sessionId)?.isActive).toBe(true);

			// The setTimeout fires at exactly t+100ms. At that point,
			// isTimedOut() checks Date.now() - lastActivity > 100.
			// With fake timers, Date.now() in the callback = startTime + 100,
			// and lastActivity = startTime, so 100 > 100 is false.
			// Fix: set Date.now() ahead so isTimedOut() returns true when timer fires.
			vi.setSystemTime(new Date(startTime + 101));
			await vi.advanceTimersByTimeAsync(100);

			expect(pool.getSessionInfo(sessionId)).toBeUndefined();

			await pool.dispose();
			vi.useRealTimers();
		});
	});

	describe('dispose edge cases', () => {
		it('should be a no-op when already terminated', async () => {
			const pool = new ConnectionPool({
				maxSessions: 5,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			await pool.dispose();
			await expect(pool.dispose()).resolves.toBeUndefined();
		});

		it('attempts a persistent failure only once per termination generation', async () => {
			const stopFailure = new Error('persistent stop failure');
			const stop = vi.fn().mockRejectedValue(stopFailure);
			const pool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
			});
			await pool.createSession();

			await expect(pool.dispose()).rejects.toMatchObject({ errors: [stopFailure] });
			expect(stop).toHaveBeenCalledTimes(1);
			await expect(pool.dispose()).rejects.toMatchObject({ errors: [stopFailure] });
			expect(stop).toHaveBeenCalledTimes(2);
		});
	});
});
