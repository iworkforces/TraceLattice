import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolAwareSequentialThinkingServer, createServer, initializeServer } from '../lib.js';
import { Container } from '../di/Container.js';
import { ServerConfig } from '../ServerConfig.js';
import type { StructuredLogger } from '../logger/StructuredLogger.js';
import type { HistoryManager } from '../core/HistoryManager.js';
import type { ThoughtProcessor } from '../core/ThoughtProcessor.js';
import type { Metrics } from '../metrics/metrics.impl.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { SkillRegistry } from '../registry/SkillRegistry.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import { SessionLifecycleCoordinator } from '../core/SessionLifecycleCoordinator.js';
import { asSessionId, asThoughtId } from '../contracts/ids.js';
import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import { createTestThought } from './helpers/factories.js';

function createMockContainer() {
	const container = new Container();

	const mockLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		setLevel: vi.fn(),
		getLevel: vi.fn().mockReturnValue('info'),
	};

	const mockHistoryManager = {
		addThought: vi.fn(),
		getHistory: vi.fn().mockReturnValue([]),
		getHistoryLength: vi.fn().mockReturnValue(0),
		getBranches: vi.fn().mockReturnValue({}),
		getBranchIds: vi.fn().mockReturnValue([]),
		registerBranch: vi.fn(),
		resetSession: vi.fn().mockResolvedValue(undefined),
		resetAll: vi.fn().mockResolvedValue(undefined),
		getAvailableMcpTools: vi.fn().mockReturnValue([]),
		getAvailableSkills: vi.fn().mockReturnValue([]),
		setEventEmitter: vi.fn(),
		bindShutdownOwner: vi.fn<(owner: () => Promise<void>) => void>(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		shutdownWithinLifecycle: vi.fn().mockResolvedValue(undefined),
		clearLiveStateAfterShutdown: vi.fn(),
		loadFromPersistence: vi.fn().mockResolvedValue(undefined),
	};

	const mockThoughtProcessor = {
		process: vi.fn().mockResolvedValue({
			content: [{ type: 'text', text: 'Processed thought' }],
		}),
		resetSession: vi.fn().mockResolvedValue(undefined),
		resetAll: vi.fn().mockResolvedValue(undefined),
	};

	const mockMetrics = {
		counter: vi.fn(),
		histogram: vi.fn(),
		gauge: vi.fn(),
		export: vi.fn().mockReturnValue('# Test metrics\n'),
	};

	const config = new ServerConfig({ maxHistorySize: 100 });

	const mockToolRegistry = {
		add: vi.fn(),
		get: vi.fn(),
		discoverAsync: vi.fn().mockResolvedValue(0),
		refreshAsync: vi.fn().mockResolvedValue(0),
	};

	const mockSkillRegistry = {
		discoverAsync: vi.fn().mockResolvedValue(0),
		refreshAsync: vi.fn().mockResolvedValue(0),
	};

	container.registerInstance('Logger', mockLogger as unknown as StructuredLogger);
	container.registerInstance('HistoryManager', mockHistoryManager as unknown as HistoryManager);
	container.registerInstance(
		'ThoughtProcessor',
		mockThoughtProcessor as unknown as ThoughtProcessor
	);
	container.registerInstance('Metrics', mockMetrics as unknown as Metrics);
	container.registerInstance('Config', config);
	container.registerInstance('ToolRegistry', mockToolRegistry as unknown as ToolRegistry);
	container.registerInstance('SkillRegistry', mockSkillRegistry as unknown as SkillRegistry);
	container.registerInstance('Persistence', null);
	container.registerInstance('sessionLifecycle', new SessionLifecycleCoordinator());

	return {
		container,
		mockLogger,
		mockHistoryManager,
		mockThoughtProcessor,
		mockMetrics,
		config,
		mockToolRegistry,
		mockSkillRegistry,
	};
}

function createCloseOnlyPersistence(close = vi.fn().mockResolvedValue(undefined)) {
	return {
		async saveThoughtForSession(_sessionId: SessionId, _thought: ThoughtData) {},
		async saveBacktrackForSession(
			_sessionId: SessionId,
			_thought: ThoughtData,
			_targetThoughtId: ThoughtId
		) {},
		async loadHistoryForSession(_sessionId: SessionId) {
			return [];
		},
		async saveBranchForSession(
			_sessionId: SessionId,
			_branchId: BranchId,
			_thoughts: readonly ThoughtData[]
		) {},
		async deleteBranchForSession(_sessionId: SessionId, _branchId: BranchId) {},
		async loadBranchForSession(_sessionId: SessionId, _branchId: BranchId) {
			return undefined;
		},
		async listBranchesForSession(_sessionId: SessionId) {
			return [];
		},
		async listSessions() {
			return [];
		},
		async healthy() {
			return true;
		},
		async clearSession(_sessionId: SessionId) {},
		async clearAll() {},
		async saveEdges(_sessionId: SessionId, _edges: readonly Edge[]) {},
		async loadEdges(_sessionId: SessionId) {
			return [];
		},
		async saveSummaries(_sessionId: SessionId, _summaries: readonly Summary[]) {},
		async loadSummaries(_sessionId: SessionId) {
			return [];
		},
		close,
	} satisfies PersistenceBackend;
}

describe('ToolAwareSequentialThinkingServer', () => {
	let server: ToolAwareSequentialThinkingServer;
	let mocks: ReturnType<typeof createMockContainer>;

	beforeEach(() => {
		mocks = createMockContainer();
		server = new ToolAwareSequentialThinkingServer({
			container: mocks.container,
			autoDiscover: false,
		});
	});

	describe('constructor', () => {
		it('should create server with custom container', () => {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
			expect(server.history).toBeDefined();
			expect(server.tools).toBeDefined();
			expect(server.skills).toBeDefined();
			expect(server.config).toBeDefined();
		});

		it('should register sequential thinking tool', () => {
			expect(mocks.mockToolRegistry.add).toHaveBeenCalled();
		});

		it('should bind history shutdown to one server-owned callback', () => {
			expect(mocks.mockHistoryManager.bindShutdownOwner).toHaveBeenCalledOnce();
			expect(mocks.mockHistoryManager.bindShutdownOwner).toHaveBeenCalledWith(expect.any(Function));
		});

		it('should create watchers when enableWatcher is true', async () => {
			const watcherMocks = createMockContainer();
			const serverWithWatchers = new ToolAwareSequentialThinkingServer({
				container: watcherMocks.container,
				enableWatcher: true,
				autoDiscover: false,
			});
			try {
				expect(serverWithWatchers).toBeInstanceOf(ToolAwareSequentialThinkingServer);
			} finally {
				await serverWithWatchers.stop();
			}
		});

		it('should not create watchers when enableWatcher is false', () => {
			const noWatcherMocks = createMockContainer();
			const serverNoWatchers = new ToolAwareSequentialThinkingServer({
				container: noWatcherMocks.container,
				enableWatcher: false,
				autoDiscover: false,
			});
			expect(serverNoWatchers).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		});
	});

	describe('getContainer', () => {
		it('should return the DI container', () => {
			const container = server.getContainer();
			expect(container).toBe(mocks.container);
		});
	});

	describe('processThought', () => {
		it('should process a thought and record metrics', async () => {
			const input = {
				thought: 'test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'public-session',
			};

			const result = await server.processThought(input);

			expect(mocks.mockThoughtProcessor.process).toHaveBeenCalled();
			expect(mocks.mockMetrics.histogram).toHaveBeenCalledWith(
				'thought_processing_duration_seconds',
				expect.any(Number),
				{}
			);
			expect(result).toBeDefined();
		});

		it('delegates reset and branch registration input without mutating or pre-registering it', async () => {
			const input = {
				thought: 'fresh thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'session-a',
				reset_state: true,
				register_branch_id: 'future',
				tool_arguments: { nested: { values: ['unchanged'] } },
			};
			const before = structuredClone(input);

			await server.processThought(input);

			expect(mocks.mockThoughtProcessor.process).toHaveBeenCalledWith(input);
			expect(mocks.mockHistoryManager.registerBranch).not.toHaveBeenCalled();
			expect(input).toEqual(before);
		});
	});

	describe('getMetricsSnapshot', () => {
		it('should export metrics', () => {
			const snapshot = server.getMetricsSnapshot();
			expect(snapshot).toBe('# Test metrics\n');
			expect(mocks.mockMetrics.export).toHaveBeenCalled();
		});
	});

	describe('getBranches', () => {
		it('returns branches for the explicitly validated session', () => {
			mocks.mockHistoryManager.getBranches.mockReturnValue({ 'branch-1': [] });
			const branches = server.getBranches('branch-session');
			expect(branches).toEqual({ 'branch-1': [] });
			expect(mocks.mockHistoryManager.getBranches).toHaveBeenCalledWith(
				asSessionId('branch-session')
			);
		});

		it('rejects omitted and retired global session identities', () => {
			expect(() => Reflect.apply(server.getBranches, server, [])).toThrow(/session_id/);
			expect(() => server.getBranches('__global__')).toThrow(/reserved value '__global__'/);
			expect(mocks.mockHistoryManager.getBranches).not.toHaveBeenCalled();
		});
	});

	describe('discoverSkillsAsync', () => {
		it('should discover skills', async () => {
			mocks.mockSkillRegistry.discoverAsync.mockResolvedValue(5);
			const count = await server.discoverSkillsAsync();
			expect(count).toBe(5);
		});
	});

	describe('refreshDiscovery', () => {
		it('returns the exact filesystem-discovered counts from both registries', async () => {
			// Given
			mocks.mockToolRegistry.refreshAsync.mockResolvedValue(2);
			mocks.mockSkillRegistry.refreshAsync.mockResolvedValue(3);

			// When
			const result = await server.refreshDiscovery();

			// Then
			expect(result).toEqual({ tools: 2, skills: 3 });
			expect(mocks.mockToolRegistry.refreshAsync).toHaveBeenCalledOnce();
			expect(mocks.mockSkillRegistry.refreshAsync).toHaveBeenCalledOnce();
		});

		it('returns one shared promise for concurrent public calls', async () => {
			// Given
			const toolRefresh = Promise.withResolvers<number>();
			const skillRefresh = Promise.withResolvers<number>();
			mocks.mockToolRegistry.refreshAsync.mockReturnValue(toolRefresh.promise);
			mocks.mockSkillRegistry.refreshAsync.mockReturnValue(skillRefresh.promise);

			try {
				// When
				const first = server.refreshDiscovery();
				const second = server.refreshDiscovery();

				// Then
				expect(second).toBe(first);
				expect(mocks.mockToolRegistry.refreshAsync).toHaveBeenCalledOnce();
				expect(mocks.mockSkillRegistry.refreshAsync).toHaveBeenCalledOnce();
				toolRefresh.resolve(4);
				skillRefresh.resolve(5);
				await expect(first).resolves.toEqual({ tools: 4, skills: 5 });
			} finally {
				toolRefresh.resolve(4);
				skillRefresh.resolve(5);
			}
		});

		it('waits for the successful registry before propagating one peer failure', async () => {
			// Given
			const failure = new Error('injected tool refresh failure');
			const toolRefresh = Promise.withResolvers<number>();
			const skillRefresh = Promise.withResolvers<number>();
			mocks.mockToolRegistry.refreshAsync.mockReturnValue(toolRefresh.promise);
			mocks.mockSkillRegistry.refreshAsync.mockReturnValue(skillRefresh.promise);
			let settled = false;

			try {
				// When
				const outcome = server
					.refreshDiscovery()
					.then(
						(value: { tools: number; skills: number }) => ({
							kind: 'resolved' as const,
							value,
						}),
						(error: unknown) => ({ kind: 'rejected' as const, error })
					)
					.finally(() => {
						settled = true;
					});
				toolRefresh.reject(failure);
				await Promise.resolve();

				// Then
				expect(settled).toBe(false);
				skillRefresh.resolve(7);
				expect(await outcome).toEqual({ kind: 'rejected', error: failure });
			} finally {
				toolRefresh.resolve(0);
				skillRefresh.resolve(7);
			}
		});

		it('aggregates failures from both registries in stable tool-skill order', async () => {
			// Given
			const toolFailure = new Error('injected tool refresh failure');
			const skillFailure = new Error('injected skill refresh failure');
			mocks.mockToolRegistry.refreshAsync.mockRejectedValue(toolFailure);
			mocks.mockSkillRegistry.refreshAsync.mockRejectedValue(skillFailure);

			// When
			const outcome = await server.refreshDiscovery().then(
				(value: { tools: number; skills: number }) => ({
					kind: 'resolved' as const,
					value,
				}),
				(error: unknown) => ({ kind: 'rejected' as const, error })
			);

			// Then
			expect(outcome.kind).toBe('rejected');
			if (outcome.kind !== 'rejected') throw new TypeError('Expected refresh to reject');
			expect(outcome.error).toBeInstanceOf(AggregateError);
			if (!(outcome.error instanceof AggregateError)) {
				throw new TypeError('Expected aggregate refresh failure');
			}
			expect(outcome.error.errors).toEqual([toolFailure, skillFailure]);
		});
	});

	describe('resetAll', () => {
		it('should reset all state awaitably', async () => {
			await server.resetAll();
			expect(mocks.mockThoughtProcessor.resetAll).toHaveBeenCalled();
		});
	});

	describe('stop', () => {
		it('provides the required backtrack operation on the close-observable backend', async () => {
			const mockPersistence = createCloseOnlyPersistence();

			await mockPersistence.saveBacktrackForSession(
				asSessionId('close-only-persistence'),
				createTestThought({ id: 'backtrack' }),
				asThoughtId('target')
			);
			await mockPersistence.close();

			expect(mockPersistence.saveBacktrackForSession).toBeTypeOf('function');
			expect(mockPersistence.close).toHaveBeenCalledOnce();
		});

		it('should join the history-owned callback to the exact server stop promise', async () => {
			// Given
			const shutdownOwner = mocks.mockHistoryManager.bindShutdownOwner.mock.calls[0]?.[0];

			// When
			expect(shutdownOwner).toBeTypeOf('function');
			if (shutdownOwner === undefined) return;
			const historyShutdownPromise = shutdownOwner();
			const serverStopPromise = server.stop();

			// Then
			expect(serverStopPromise).toBe(historyShutdownPromise);
			await Promise.all([historyShutdownPromise, serverStopPromise]);
			expect(mocks.mockHistoryManager.shutdownWithinLifecycle).toHaveBeenCalledOnce();
		});

		it('should stop server and flush persistence', async () => {
			await server.stop();
			expect(mocks.mockHistoryManager.shutdownWithinLifecycle).toHaveBeenCalled();
		});

		it('should surface shutdown errors after cleanup', async () => {
			const failure = new Error('Flush failed');
			mocks.mockHistoryManager.shutdownWithinLifecycle.mockRejectedValue(failure);
			await expect(server.stop()).rejects.toMatchObject({ errors: [failure] });
			expect(mocks.mockLogger.error).toHaveBeenCalled();
		});

		it('should close persistence if available', async () => {
			const mockPersistence = createCloseOnlyPersistence();
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence);

			await server.stop();
			expect(mockPersistence.close).toHaveBeenCalled();
		});

		it('should surface persistence close errors', async () => {
			const failure = new Error('Close failed');
			const mockPersistence = createCloseOnlyPersistence(vi.fn().mockRejectedValue(failure));
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence);

			await expect(server.stop()).rejects.toMatchObject({ errors: [failure] });
			expect(mocks.mockLogger.error).toHaveBeenCalled();
		});

		it('should aggregate history-drain and persistence-close failures through the owner callback', async () => {
			// Given
			const historyFailure = new Error('History drain failed');
			const persistenceFailure = new Error('Persistence close failed');
			const mockPersistence = createCloseOnlyPersistence(
				vi.fn().mockRejectedValue(persistenceFailure)
			);
			mocks.mockHistoryManager.shutdownWithinLifecycle.mockRejectedValue(historyFailure);
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence);
			const shutdownOwner = mocks.mockHistoryManager.bindShutdownOwner.mock.calls[0]?.[0];

			// When
			expect(shutdownOwner).toBeTypeOf('function');
			if (shutdownOwner === undefined) return;
			const historyShutdownPromise = shutdownOwner();
			const serverStopPromise = server.stop();
			const outcome = await historyShutdownPromise.then(
				() => ({ kind: 'resolved' as const }),
				(error: unknown) => ({ kind: 'rejected' as const, error })
			);

			// Then
			expect(serverStopPromise).toBe(historyShutdownPromise);
			expect(outcome.kind).toBe('rejected');
			if (outcome.kind !== 'rejected') throw new TypeError('Expected stop to reject');
			expect(outcome.error).toBeInstanceOf(AggregateError);
			if (!(outcome.error instanceof AggregateError)) {
				throw new TypeError('Expected aggregate stop failure');
			}
			expect(outcome.error.errors).toEqual([historyFailure, persistenceFailure]);
			expect(mocks.mockHistoryManager.shutdownWithinLifecycle).toHaveBeenCalledOnce();
			expect(mockPersistence.close).toHaveBeenCalledOnce();
			expect(mocks.mockHistoryManager.clearLiveStateAfterShutdown).not.toHaveBeenCalled();
			expect(mocks.mockLogger.error).toHaveBeenCalledTimes(2);
		});

		it('should handle null persistence', async () => {
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', null);
			await expect(server.stop()).resolves.toBeUndefined();
		});
	});

	describe('dispose', () => {
		it('should stop server and dispose container', async () => {
			await server.dispose();
			expect(mocks.mockHistoryManager.shutdownWithinLifecycle).toHaveBeenCalled();
		});
	});

	describe('events', () => {
		it('should emit and receive persistenceError events', () => {
			const handler = vi.fn();
			server.on('persistenceError', handler);
			server.emit('persistenceError', { operation: 'save', error: new Error('test') });
			expect(handler).toHaveBeenCalledWith({
				operation: 'save',
				error: expect.any(Error),
			});
		});

		it('should emit and receive discoveryError events', () => {
			const handler = vi.fn();
			server.on('discoveryError', handler);
			server.emit('discoveryError', { directory: '/skills', error: new Error('test') });
			expect(handler).toHaveBeenCalledWith({
				directory: '/skills',
				error: expect.any(Error),
			});
		});

		it('should emit and receive transportError events', () => {
			const handler = vi.fn();
			server.on('transportError', handler);
			server.emit('transportError', { transport: 'http', error: new Error('test') });
			expect(handler).toHaveBeenCalled();
		});

		it('should emit and receive thoughtProcessed events', () => {
			const handler = vi.fn();
			server.on('thoughtProcessed', handler);
			server.emit('thoughtProcessed', { thoughtNumber: 1, duration: 100 });
			expect(handler).toHaveBeenCalledWith({ thoughtNumber: 1, duration: 100 });
		});
	});
});

describe('createServer', () => {
	it('should create a server with async initialization', async () => {
		const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
			expect(server.getContainer()).toBeDefined();
		} finally {
			await server.stop();
		}
	});

	it('should create server with all options disabled', async () => {
		const server = await createServer({
			autoDiscover: false,
			loadFromPersistence: false,
			lazyDiscovery: true,
		});
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		} finally {
			await server.stop();
		}
	});

	it('should load from persistence when enabled', async () => {
		const server = await createServer({
			autoDiscover: false,
			loadFromPersistence: true,
		});
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		} finally {
			await server.stop();
		}
	});
});

describe('initializeServer', () => {
	it('should create and return a server', async () => {
		const server = await initializeServer();
		try {
			expect(server).toBeInstanceOf(ToolAwareSequentialThinkingServer);
		} finally {
			await server.stop();
		}
	});
});

describe('lib.ts — uncovered branches', () => {
	describe('constructor without container (lines 246-264)', () => {
		it('should throw when no container is provided', () => {
			expect(
				() =>
					new ToolAwareSequentialThinkingServer({
						autoDiscover: false,
						enableWatcher: false,
					})
			).toThrow('Container is required. Use createServer() or provide a container.');
		});

		it('should throw when no container is provided even with custom logger', async () => {
			const customLogger = new (await import('../logger/StructuredLogger.js')).StructuredLogger({
				context: 'CustomTest',
				pretty: false,
				level: 'warn',
			});
			expect(
				() =>
					new ToolAwareSequentialThinkingServer({
						autoDiscover: false,
						enableWatcher: false,
						logger: customLogger,
					})
			).toThrow('Container is required. Use createServer() or provide a container.');
		});
	});

	describe('stop() non-Error branches (lines 389, 401)', () => {
		it('should surface a non-Error thrown during shutdown flush', async () => {
			const mocks = createMockContainer();
			mocks.mockHistoryManager.shutdownWithinLifecycle.mockRejectedValue('raw string error');
			const server = new ToolAwareSequentialThinkingServer({
				container: mocks.container,
				autoDiscover: false,
			});

			await expect(server.stop()).rejects.toMatchObject({ errors: ['raw string error'] });
			expect(mocks.mockLogger.error).toHaveBeenCalledWith(
				'Error flushing write buffer during shutdown',
				expect.objectContaining({ error: 'raw string error' })
			);
		});

		it('should surface a non-Error thrown during persistence close', async () => {
			const mocks = createMockContainer();
			const mockPersistence = createCloseOnlyPersistence(vi.fn().mockRejectedValue(42));
			mocks.container.unregister('Persistence');
			mocks.container.registerInstance('Persistence', mockPersistence);
			const server = new ToolAwareSequentialThinkingServer({
				container: mocks.container,
				autoDiscover: false,
			});

			await expect(server.stop()).rejects.toMatchObject({ errors: [42] });
			expect(mocks.mockLogger.error).toHaveBeenCalledWith(
				'Error closing persistence backend',
				expect.objectContaining({ error: '42' })
			);
		});
	});
});
