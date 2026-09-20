import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ConnectionPool, Session, createConnectionPool } from '../pool/ConnectionPool.js';
import type { ThoughtData } from '../core/thought.js';
import { asSessionId } from '../contracts/ids.js';
import { NullLogger } from '../logger/NullLogger.js';
import { SessionNotActiveError, SessionNotFoundError } from '../pool/PoolErrors.js';
import type { SessionRunResult } from '../pool/IConnectionPool.js';

const createMockServer = () => ({
	processThought: vi.fn().mockResolvedValue({
		content: [{ type: 'text', text: 'Test response' }],
	}),
	stop: vi.fn().mockResolvedValue(undefined),
});

const createMockServerFactory = () => vi.fn().mockImplementation(async () => createMockServer());

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => resolvePromise?.(),
	};
}

describe('ConnectionPool', () => {
	let pool: ConnectionPool;

	beforeEach(() => {
		const serverFactory = createMockServerFactory();
		pool = new ConnectionPool({
			maxSessions: 5,
			sessionTimeout: 60000, // 1 minute
			autoCleanup: false, // Disable for most tests
			serverFactory,
		});
	});

	afterEach(async () => {
		if (pool.isRunning()) {
			await pool.dispose();
		}
	});

	describe('constructor', () => {
		it('should use default options when none provided', () => {
			const defaultPool = new ConnectionPool({ serverFactory: createMockServerFactory() });

			expect(defaultPool).toBeInstanceOf(ConnectionPool);

			const stats = defaultPool.getStats();
			expect(stats.maxSessions).toBe(100);
			expect(stats.sessionTimeout).toBe(300000);
			expect(stats.cleanupEnabled).toBe(true);

			// Cleanup for default pool
			defaultPool.dispose();
		});

		it('should use custom maxSessions', () => {
			const customPool = new ConnectionPool({
				maxSessions: 10,
				serverFactory: createMockServerFactory(),
			});
			expect(customPool.getStats().maxSessions).toBe(10);
			customPool.dispose();
		});

		it('should use custom sessionTimeout', () => {
			const customPool = new ConnectionPool({
				sessionTimeout: 120000,
				serverFactory: createMockServerFactory(),
			});
			expect(customPool.getStats().sessionTimeout).toBe(120000);
			customPool.dispose();
		});

		it('should allow disabling autoCleanup', () => {
			const noCleanupPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});
			expect(noCleanupPool.getStats().cleanupEnabled).toBe(false);
			noCleanupPool.dispose();
		});

		it('should require serverFactory to create sessions', async () => {
			const missingFactoryPool = new ConnectionPool({
				autoCleanup: false,
			});

			await expect(async () => await missingFactoryPool.createSession()).rejects.toThrow(
				'ConnectionPool requires a serverFactory option to create sessions'
			);

			await missingFactoryPool.dispose();
		});
	});

	describe('createSession', () => {
		it('should create a new session', async () => {
			const sessionId = await pool.createSession();

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');
			expect(sessionId).toMatch(/^session_/);
		});

		it('should add session to pool', async () => {
			await pool.createSession();

			const stats = pool.getStats();
			expect(stats.totalSessions).toBe(1);
		});

		it('should throw error when max sessions reached', async () => {
			const smallPool = new ConnectionPool({
				maxSessions: 2,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			await smallPool.createSession();
			await smallPool.createSession();

			await expect(async () => await smallPool.createSession()).rejects.toThrow(
				'Max sessions (2) reached'
			);

			await smallPool.dispose();
		});

		it('should throw error when terminated', async () => {
			await pool.dispose();

			await expect(async () => await pool.createSession()).rejects.toThrow(
				'ConnectionPool has been terminated'
			);
		});

		it('should create unique session IDs', async () => {
			const id1 = await pool.createSession();
			const id2 = await pool.createSession();

			expect(id1).not.toBe(id2);
		});

		it('rejects an owned-session ID collision before creating another child', async () => {
			const stopFailure = new Error('first stop failed');
			const stop = vi.fn().mockRejectedValueOnce(stopFailure).mockResolvedValue(undefined);
			const serverFactory = vi.fn(async () => ({
				processThought: async () => ({ content: [] }),
				stop,
			}));
			const collisionPool = new ConnectionPool({
				maxSessions: 2,
				autoCleanup: false,
				serverFactory,
			});
			vi.spyOn(Date, 'now').mockReturnValue(1234);
			vi.spyOn(Math, 'random').mockReturnValue(0.5);

			const sessionId = await collisionPool.createSession();
			await expect(collisionPool.closeSession(sessionId)).rejects.toBe(stopFailure);

			try {
				await expect(collisionPool.createSession()).rejects.toThrow('Session ID collision');
				expect(serverFactory).toHaveBeenCalledTimes(1);
			} finally {
				vi.restoreAllMocks();
				await collisionPool.dispose();
			}
		});
	});

	describe('process', () => {
		it('should process thought in existing session', async () => {
			const poolSessionId = await pool.createSession();
			const thoughtSessionId = asSessionId('thought-session');

			const thought: ThoughtData = {
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: thoughtSessionId,
			};

			const result = await pool.process(poolSessionId, thought);

			expect(result).toBeDefined();
			expect(result.content).toEqual([{ type: 'text', text: 'Test response' }]);
			const child = pool.getSessionInfo(poolSessionId)?.server;
			expect(child?.processThought).toHaveBeenCalledWith(thought);
			expect(thought.session_id).toBe(thoughtSessionId);
			expect(thought.session_id).not.toBe(poolSessionId);
		});

		it('throws the typed missing-session error for direct processing', async () => {
			const thought: ThoughtData = {
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('missing-slot-thought'),
			};

			await expect(pool.process(asSessionId('non-existent'), thought)).rejects.toBeInstanceOf(
				SessionNotFoundError
			);
		});

		it('keeps accepted work alive while close rejects later admission', async () => {
			const processing = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const stop = vi.fn();
			const admittingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({
					processThought: async () => {
						started.resolve();
						await processing.promise;
						return { content: [{ type: 'text', text: 'accepted' }] };
					},
					stop,
				}),
			});
			const sessionId = await admittingPool.createSession();
			const accepted = admittingPool.runWithSession(sessionId, (session) =>
				session.processThought({
					thought: 'accepted before close',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('accepted-thought'),
				})
			);
			await started.promise;
			const close = admittingPool.closeSession(sessionId);
			const rejectedCallback = vi.fn(async () => 'unexpected');

			await expect(admittingPool.runWithSession(sessionId, rejectedCallback)).resolves.toEqual({
				status: 'inactive',
			});
			expect(rejectedCallback).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();

			processing.resolve();
			await expect(accepted).resolves.toEqual({
				status: 'completed',
				value: { content: [{ type: 'text', text: 'accepted' }] },
			});
			await close;
			expect(stop).toHaveBeenCalledTimes(1);
			await expect(admittingPool.runWithSession(sessionId, rejectedCallback)).resolves.toEqual({
				status: 'missing',
			});
			await admittingPool.dispose();
		});

		it('throws the typed inactive-session error while direct processing is closing', async () => {
			const operationGate = deferred();
			const started = deferred();
			const typedPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({
					processThought: async () => {
						started.resolve();
						await operationGate.promise;
						return { content: [] };
					},
					stop: (): void => undefined,
				}),
			});
			const sessionId = await typedPool.createSession();
			const processing = typedPool.process(sessionId, {
				thought: 'pending',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('pending-thought'),
			});
			await started.promise;
			const close = typedPool.closeSession(sessionId);

			await expect(
				typedPool.process(sessionId, {
					thought: 'late',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('late-thought'),
				})
			).rejects.toBeInstanceOf(SessionNotActiveError);

			operationGate.resolve();
			await processing;
			await close;
			await typedPool.dispose();
		});
	});

	describe('closeSession', () => {
		it('should close an existing session', async () => {
			const sessionId = await pool.createSession();

			expect(pool.getStats().totalSessions).toBe(1);

			await pool.closeSession(sessionId);

			expect(pool.getStats().totalSessions).toBe(0);
		});

		it('should throw error for non-existent session', async () => {
			await expect(
				async () => await pool.closeSession(asSessionId('non-existent'))
			).rejects.toThrow('Session not found');
		});

		it('should allow reusing session slot after closing', async () => {
			const smallPool = new ConnectionPool({
				maxSessions: 1,
				autoCleanup: false,
				serverFactory: createMockServerFactory(),
			});

			const id1 = await smallPool.createSession();
			await smallPool.closeSession(id1);

			const id2 = await smallPool.createSession();

			expect(id2).toBeDefined();
			expect(smallPool.getStats().totalSessions).toBe(1);

			await smallPool.dispose();
		});

		it('removes routing before awaiting one shared child stop', async () => {
			const stopGate = deferred();
			const stop = vi.fn(() => stopGate.promise);
			const closingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({
					processThought: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
					stop,
				}),
			});
			const sessionId = await closingPool.createSession();

			const firstClose = closingPool.closeSession(sessionId);
			const concurrentClose = closingPool.closeSession(sessionId);

			expect(concurrentClose).toBe(firstClose);
			expect(closingPool.getSessionInfo(sessionId)).toBeUndefined();
			expect(closingPool.getStats().totalSessions).toBe(0);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(
				await Promise.race([firstClose.then(() => 'closed'), Promise.resolve('pending')])
			).toBe('pending');

			stopGate.resolve();
			await firstClose;
			await closingPool.dispose();
		});

		it('retains failed cleanup as inactive owned capacity until a retry succeeds', async () => {
			const stopFailure = new Error('stop failed');
			const stop = vi.fn().mockRejectedValueOnce(stopFailure).mockResolvedValue(undefined);
			const retainedPool = new ConnectionPool({
				maxSessions: 1,
				autoCleanup: false,
				serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
			});
			const sessionId = await retainedPool.createSession();

			await expect(retainedPool.closeSession(sessionId)).rejects.toBe(stopFailure);

			expect(retainedPool.getSessionInfo(sessionId)).toBeUndefined();
			expect(retainedPool.getStats().totalSessions).toBe(0);
			await expect(
				retainedPool.runWithSession(sessionId, async () => 'unexpected')
			).resolves.toEqual({ status: 'inactive' });
			await expect(
				retainedPool.process(sessionId, {
					thought: 'rejected after cleanup failure',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('cleanup-failure-thought'),
				})
			).rejects.toBeInstanceOf(SessionNotActiveError);
			await expect(retainedPool.createSession()).rejects.toThrow('Max sessions (1) reached');

			await expect(retainedPool.closeSession(sessionId)).resolves.toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(2);
			await expect(
				retainedPool.runWithSession(sessionId, async () => 'unexpected')
			).resolves.toEqual({ status: 'missing' });
			await expect(retainedPool.createSession()).resolves.toMatch(/^session_/);
			await retainedPool.dispose();
		});
	});

	describe('getSessionInfo', () => {
		it('should return info for existing session', async () => {
			const sessionId = await pool.createSession();

			const info = pool.getSessionInfo(sessionId);

			expect(info).toBeDefined();
			expect(info?.id).toBe(sessionId);
			expect(info?.isActive).toBe(true);
			expect(info?.createdAt).toBeDefined();
			expect(info?.lastActivityAt).toBeDefined();
		});

		it('should return undefined for non-existent session', () => {
			const info = pool.getSessionInfo(asSessionId('non-existent'));
			expect(info).toBeUndefined();
		});
	});

	describe('getActiveSessions', () => {
		it('should return all active sessions', async () => {
			await pool.createSession();
			await pool.createSession();
			await pool.createSession();

			const activeSessions = pool.getActiveSessions();

			expect(activeSessions).toHaveLength(3);
		});

		it('should return empty array when no sessions', () => {
			const activeSessions = pool.getActiveSessions();
			expect(activeSessions).toEqual([]);
		});

		it('should only include active sessions', async () => {
			const sessionId = await pool.createSession();

			let activeSessions = pool.getActiveSessions();
			expect(activeSessions).toHaveLength(1);

			// Close the session
			await pool.closeSession(sessionId);

			// Should be empty now
			activeSessions = pool.getActiveSessions();
			expect(activeSessions).toHaveLength(0);
		});
	});

	describe('getStats', () => {
		it('should return correct stats when empty', () => {
			const stats = pool.getStats();

			expect(stats.totalSessions).toBe(0);
			expect(stats.activeSessions).toBe(0);
			expect(stats.maxSessions).toBe(5);
			expect(stats.sessionTimeout).toBe(60000);
			expect(stats.cleanupEnabled).toBe(false);
		});

		it('should return correct stats with sessions', async () => {
			await pool.createSession();
			await pool.createSession();

			const stats = pool.getStats();

			expect(stats.totalSessions).toBe(2);
			expect(stats.activeSessions).toBe(2);
		});

		it('should track maxSessions correctly', () => {
			const customPool = new ConnectionPool({
				maxSessions: 50,
				serverFactory: createMockServerFactory(),
			});
			expect(customPool.getStats().maxSessions).toBe(50);
			customPool.dispose();
		});

		it('should track sessionTimeout correctly', () => {
			const customPool = new ConnectionPool({
				sessionTimeout: 120000,
				serverFactory: createMockServerFactory(),
			});
			expect(customPool.getStats().sessionTimeout).toBe(120000);
			customPool.dispose();
		});
	});

	describe('isRunning', () => {
		it('should return true when created', () => {
			expect(pool.isRunning()).toBe(true);
		});

		it('should return false when terminated', async () => {
			await pool.dispose();
			expect(pool.isRunning()).toBe(false);
		});
	});

	describe('dispose', () => {
		it('should dispose gracefully when empty', async () => {
			await expect(pool.dispose()).resolves.toBeUndefined();
		});

		it('should dispose gracefully with sessions', async () => {
			await pool.createSession();
			await pool.createSession();

			await expect(pool.dispose()).resolves.toBeUndefined();
		});

		it('should clear all sessions on dispose', async () => {
			await pool.createSession();
			await pool.createSession();

			expect(pool.getStats().totalSessions).toBe(2);

			await pool.dispose();

			expect(pool.getStats().totalSessions).toBe(0);
		});

		it('should be idempotent', async () => {
			await pool.dispose();
			await expect(pool.dispose()).resolves.toBeUndefined();
		});

		it('should prevent operations after dispose', async () => {
			await pool.dispose();

			await expect(async () => await pool.createSession()).rejects.toThrow(
				'ConnectionPool has been terminated'
			);
		});

		it('joins concurrent termination and aggregates every child stop failure', async () => {
			const firstGate = deferred();
			const secondGate = deferred();
			const firstFailure = new Error('first child stop failed');
			const secondFailure = new Error('second child stop failed');
			const stops = [
				vi.fn(() => firstGate.promise.then(() => Promise.reject(firstFailure))),
				vi.fn(() => secondGate.promise.then(() => Promise.reject(secondFailure))),
			];
			let childIndex = 0;
			const terminatingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => {
					const stop = stops[childIndex++];
					if (!stop) {
						throw new RangeError('Missing child stop fixture');
					}
					return {
						processThought: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
						stop,
					};
				},
			});
			await terminatingPool.createSession();
			await terminatingPool.createSession();

			const firstTerminate = terminatingPool.dispose();
			const concurrentTerminate = terminatingPool.dispose();

			expect(concurrentTerminate).toBe(firstTerminate);
			expect(terminatingPool.getStats().totalSessions).toBe(0);
			expect(stops[0]).toHaveBeenCalledTimes(1);
			expect(stops[1]).toHaveBeenCalledTimes(1);
			expect(
				await Promise.race([firstTerminate.then(() => 'closed'), Promise.resolve('pending')])
			).toBe('pending');

			firstGate.resolve();
			secondGate.resolve();
			const outcome = await Promise.allSettled([firstTerminate, concurrentTerminate]);
			expect(outcome[0]).toMatchObject({
				status: 'rejected',
				reason: { errors: [firstFailure, secondFailure] },
			});
			expect(outcome[1]).toEqual(outcome[0]);
		});

		it('reports a pending-created child stop failure through shared termination', async () => {
			const factory = Promise.withResolvers<ReturnType<typeof createMockServer>>();
			const stopFailure = new Error('pending child stop failed');
			const stop = vi.fn().mockRejectedValueOnce(stopFailure).mockResolvedValue(undefined);
			const terminatingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: () => factory.promise,
			});
			const create = terminatingPool.createSession();

			const terminate = terminatingPool.dispose();
			factory.resolve({
				processThought: vi.fn().mockResolvedValue({ content: [] }),
				stop,
			});
			const [createOutcome, terminateOutcome] = await Promise.allSettled([create, terminate]);

			expect(createOutcome).toMatchObject({ status: 'rejected', reason: stopFailure });
			expect(terminateOutcome).toMatchObject({
				status: 'rejected',
				reason: { errors: [stopFailure] },
			});
			expect(stop).toHaveBeenCalledTimes(1);
			expect(terminatingPool.getStats().totalSessions).toBe(0);

			await expect(terminatingPool.dispose()).resolves.toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(2);
		});

		it('retries retained failures once in a later termination generation', async () => {
			const stopFailure = new Error('first generation failed');
			const stop = vi.fn().mockRejectedValueOnce(stopFailure).mockResolvedValue(undefined);
			const terminatingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
			});
			await terminatingPool.createSession();

			const firstTerminate = terminatingPool.dispose();
			const concurrentTerminate = terminatingPool.dispose();
			expect(concurrentTerminate).toBe(firstTerminate);
			await expect(firstTerminate).rejects.toMatchObject({ errors: [stopFailure] });
			expect(stop).toHaveBeenCalledTimes(1);

			await expect(terminatingPool.dispose()).resolves.toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(2);
			await expect(terminatingPool.dispose()).resolves.toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(2);
		});

		it('shares an overlapping close attempt and retries it only in a later generation', async () => {
			const firstStop = Promise.withResolvers<void>();
			const stopFailure = new Error('shared attempt failed');
			const stop = vi
				.fn()
				.mockImplementationOnce(() => firstStop.promise)
				.mockResolvedValue(undefined);
			const terminatingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
			});
			const sessionId = await terminatingPool.createSession();

			const close = terminatingPool.closeSession(sessionId);
			const terminate = terminatingPool.dispose();
			expect(stop).toHaveBeenCalledTimes(1);
			firstStop.reject(stopFailure);

			await expect(close).rejects.toBe(stopFailure);
			await expect(terminate).rejects.toMatchObject({ errors: [stopFailure] });
			expect(stop).toHaveBeenCalledTimes(1);
			await expect(terminatingPool.dispose()).resolves.toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(2);
		});

		it('waits for successful late-factory cleanup in the active generation', async () => {
			const factory = Promise.withResolvers<ReturnType<typeof createMockServer>>();
			const stopGate = deferred();
			const stop = vi.fn(() => stopGate.promise);
			const terminatingPool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: () => factory.promise,
			});
			const create = terminatingPool.createSession();

			const terminate = terminatingPool.dispose();
			factory.resolve({
				processThought: vi.fn().mockResolvedValue({ content: [] }),
				stop,
			});
			await Promise.resolve();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(
				await Promise.race([terminate.then(() => 'terminated'), Promise.resolve('pending')])
			).toBe('pending');

			stopGate.resolve();
			await expect(create).rejects.toThrow('ConnectionPool has been terminated');
			await expect(terminate).resolves.toBeUndefined();
			expect(terminatingPool.getStats().totalSessions).toBe(0);
		});
	});

	describe('createConnectionPool factory', () => {
		it('should create ConnectionPool with default options', () => {
			const defaultPool = createConnectionPool({
				serverFactory: createMockServerFactory(),
			});

			expect(defaultPool).toBeInstanceOf(ConnectionPool);

			const stats = defaultPool.getStats();
			expect(stats.maxSessions).toBe(100);

			defaultPool.dispose();
		});

		it('should create ConnectionPool with custom options', () => {
			const customPool = createConnectionPool({
				maxSessions: 25,
				sessionTimeout: 60000,
				serverFactory: createMockServerFactory(),
			});

			expect(customPool).toBeInstanceOf(ConnectionPool);

			const stats = customPool.getStats();
			expect(stats.maxSessions).toBe(25);
			expect(stats.sessionTimeout).toBe(60000);

			customPool.dispose();
		});
	});
});

describe('ConnectionPool callback-scoped admission', () => {
	it('exports only the required callback-owned admission contract', async () => {
		const contractText = await readFile(
			new URL('../pool/IConnectionPool.ts', import.meta.url),
			'utf8'
		);
		const source = ts.createSourceFile(
			'IConnectionPool.ts',
			contractText,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const declarationNames = source.statements.flatMap((statement) => {
			if (
				ts.isTypeAliasDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isClassDeclaration(statement)
			) {
				return statement.name ? [statement.name.text] : [];
			}
			return [];
		});
		const poolContract = source.statements.find(
			(statement): statement is ts.InterfaceDeclaration =>
				ts.isInterfaceDeclaration(statement) && statement.name.text === 'IConnectionPool'
		);
		const runMethod = poolContract?.members.find(
			(member): member is ts.MethodSignature =>
				ts.isMethodSignature(member) && member.name.getText(source) === 'runWithSession'
		);

		expect(declarationNames).not.toContain('SessionLease');
		expect(declarationNames).not.toContain('SessionAdmission');
		expect(declarationNames).toContain('SessionRunResult');
		expect(runMethod?.questionToken).toBeUndefined();
		expect(runMethod?.type?.getText(source)).toBe('Promise<SessionRunResult<T>>');
		expect(Object.getOwnPropertyNames(ConnectionPool.prototype)).not.toContain('admitSession');
		expect(typeof ConnectionPool.prototype.runWithSession).toBe('function');
	});

	it('starts an ignored operation synchronously and releases shutdown after it settles', async () => {
		const operationGate = deferred();
		const started = vi.fn();
		const stop = vi.fn();
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => ({
				processThought: async () => ({ content: [] }),
				stop,
			}),
		});
		const sessionId = await pool.createSession();

		void pool.runWithSession(sessionId, async () => {
			started();
			await operationGate.promise;
			return 'settled';
		});
		expect(started).toHaveBeenCalledTimes(1);
		const close = pool.closeSession(sessionId);
		expect(stop).not.toHaveBeenCalled();

		operationGate.resolve();
		await close;
		expect(stop).toHaveBeenCalledTimes(1);
		await pool.dispose();
	});

	it('holds termination only until the pending callback settles and stops once', async () => {
		const operationGate = deferred();
		const operationStarted = deferred();
		const stop = vi.fn();
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
		});
		const sessionId = await pool.createSession();
		void pool.runWithSession(sessionId, async () => {
			operationStarted.resolve();
			await operationGate.promise;
			return 'settled';
		});
		await operationStarted.promise;

		const firstTerminate = pool.dispose();
		const duplicateTerminate = pool.dispose();
		expect(duplicateTerminate).toBe(firstTerminate);
		expect(stop).not.toHaveBeenCalled();

		operationGate.resolve();
		await firstTerminate;
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('propagates the callback error by identity and still permits shutdown', async () => {
		const sentinel = new Error('callback sentinel');
		const stop = vi.fn();
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop }),
		});
		const sessionId = await pool.createSession();

		await expect(
			pool.runWithSession(sessionId, async () => {
				throw sentinel;
			})
		).rejects.toBe(sentinel);
		await expect(pool.dispose()).resolves.toBeUndefined();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('reuses the exact captured child for same-ID nesting without extending the drain', async () => {
		const operationGate = deferred();
		const nestedFinished = deferred();
		const stop = vi.fn();
		const child = {
			processThought: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'nested' }] })),
			stop,
		};
		const pool = new ConnectionPool({ autoCleanup: false, serverFactory: async () => child });
		const sessionId = await pool.createSession();

		const outer = pool.runWithSession(sessionId, async (outerChild) => {
			const nested = await pool.runWithSession(sessionId, async (nestedChild) => {
				expect(nestedChild).toBe(outerChild);
				return pool.process(sessionId, {
					thought: 'nested',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('nested-thought'),
				});
			});
			expect(nested).toEqual({
				status: 'completed',
				value: { content: [{ type: 'text', text: 'nested' }] },
			});
			nestedFinished.resolve();
			await operationGate.promise;
			return 'outer';
		});
		await nestedFinished.promise;
		const close = pool.closeSession(sessionId);
		expect(stop).not.toHaveBeenCalled();

		operationGate.resolve();
		await expect(outer).resolves.toEqual({ status: 'completed', value: 'outer' });
		await close;
		expect(stop).toHaveBeenCalledTimes(1);
		await pool.dispose();
	});

	it('admits a different-ID nested operation against its own child', async () => {
		const children = [
			{ processThought: async () => ({ content: [] }), stop: vi.fn() },
			{ processThought: async () => ({ content: [] }), stop: vi.fn() },
		];
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => {
				const child = children.shift();
				if (!child) throw new RangeError('Missing child fixture');
				return child;
			},
		});
		const firstId = await pool.createSession();
		const secondId = await pool.createSession();

		const result = await pool.runWithSession(firstId, async (firstChild) =>
			pool.runWithSession(secondId, async (secondChild) => {
				expect(secondChild).not.toBe(firstChild);
				return 'second';
			})
		);

		expect(result).toEqual({
			status: 'completed',
			value: { status: 'completed', value: 'second' },
		});
		await pool.dispose();
	});

	it('rejects a stale ALS descendant after its captured child has closed', async () => {
		const trigger = deferred();
		const descendant = Promise.withResolvers<SessionRunResult<string>>();
		const callback = vi.fn(async () => 'unexpected');
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => ({ processThought: async () => ({ content: [] }), stop: vi.fn() }),
		});
		const sessionId = await pool.createSession();

		await pool.runWithSession(sessionId, async () => {
			void trigger.promise.then(async () => {
				descendant.resolve(await pool.runWithSession(sessionId, callback));
			});
			return 'outer';
		});
		await pool.closeSession(sessionId);
		trigger.resolve();

		await expect(descendant.promise).resolves.toEqual({ status: 'missing' });
		expect(callback).not.toHaveBeenCalled();
		await pool.dispose();
	});
});

describe('Session close lifecycle', () => {
	it('returns one promise and awaits the child stop exactly once', async () => {
		const stopGate = deferred();
		const stop = vi.fn(() => stopGate.promise);
		const session = new Session(
			asSessionId('session-controlled'),
			{
				processThought: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				stop,
			},
			60_000,
			new NullLogger()
		);

		const firstClose = session.close();
		const concurrentClose = session.close();

		expect(concurrentClose).toBe(firstClose);
		expect(session.isActive).toBe(false);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(await Promise.race([firstClose.then(() => 'closed'), Promise.resolve('pending')])).toBe(
			'pending'
		);

		stopGate.resolve();
		await firstClose;
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('shares a rejected attempt, retries later, and makes success terminal', async () => {
		const firstStop = Promise.withResolvers<void>();
		const stopFailure = new Error('stop rejected');
		const stop = vi
			.fn()
			.mockImplementationOnce(() => firstStop.promise)
			.mockResolvedValue(undefined);
		const session = new Session(
			asSessionId('session-retry'),
			{ processThought: async () => ({ content: [] }), stop },
			60_000,
			new NullLogger()
		);

		const firstClose = session.close();
		const concurrentClose = session.close();
		expect(concurrentClose).toBe(firstClose);
		firstStop.reject(stopFailure);
		await expect(firstClose).rejects.toBe(stopFailure);
		expect(session.isActive).toBe(false);

		const retry = session.close();
		expect(retry).not.toBe(firstClose);
		await expect(retry).resolves.toBeUndefined();
		expect(session.close()).toBe(retry);
		expect(stop).toHaveBeenCalledTimes(2);
	});
});

describe('ConnectionPool edge cases', () => {
	it('should handle zero maxSessions', async () => {
		const zeroPool = new ConnectionPool({
			maxSessions: 0,
			autoCleanup: false,
			serverFactory: createMockServerFactory(),
		});

		await expect(async () => await zeroPool.createSession()).rejects.toThrow(
			'Max sessions (0) reached'
		);

		await zeroPool.dispose();
	});

	it('should handle very large maxSessions', () => {
		const largePool = new ConnectionPool({
			maxSessions: 10000,
			autoCleanup: false,
			serverFactory: createMockServerFactory(),
		});

		expect(largePool.getStats().maxSessions).toBe(10000);

		largePool.dispose();
	});

	it('should handle very short sessionTimeout', async () => {
		vi.useFakeTimers();
		const startTime = Date.now();
		const shortTimeoutPool = new ConnectionPool({
			sessionTimeout: 1, // 1ms
			autoCleanup: false,
			serverFactory: createMockServerFactory(),
		});

		const sessionId = await shortTimeoutPool.createSession();
		vi.setSystemTime(new Date(startTime + 1));
		await vi.advanceTimersByTimeAsync(1);

		expect(shortTimeoutPool.getSessionInfo(sessionId)).toBeUndefined();

		await shortTimeoutPool.dispose();
		vi.useRealTimers();
	});

	it('should handle very long sessionTimeout', () => {
		const longTimeoutPool = new ConnectionPool({
			sessionTimeout: 3600000, // 1 hour
			autoCleanup: false,
			serverFactory: createMockServerFactory(),
		});

		expect(longTimeoutPool.getStats().sessionTimeout).toBe(3600000);

		longTimeoutPool.dispose();
	});
});

describe('ConnectionPool cleanup', () => {
	it('should enable cleanup by default', () => {
		const defaultPool = new ConnectionPool({ serverFactory: createMockServerFactory() });
		expect(defaultPool.getStats().cleanupEnabled).toBe(true);
		defaultPool.dispose();
	});

	it('should allow disabling cleanup', () => {
		const noCleanupPool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: createMockServerFactory(),
		});
		expect(noCleanupPool.getStats().cleanupEnabled).toBe(false);
		noCleanupPool.dispose();
	});

	it('should use custom cleanup interval', () => {
		const customIntervalPool = new ConnectionPool({
			cleanupInterval: 30000, // 30 seconds
			serverFactory: createMockServerFactory(),
		});

		expect(customIntervalPool).toBeInstanceOf(ConnectionPool);

		customIntervalPool.dispose();
	});
});
