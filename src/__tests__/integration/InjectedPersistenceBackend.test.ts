import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createServer,
	type ServerOptions,
	type ToolAwareSequentialThinkingServer,
	type PersistenceBackend,
	type ThoughtData,
	type Edge,
	type Summary,
	type SessionId,
	type ThoughtId,
	type BranchId,
} from '../../lib.js';
import { runWithContext } from '../../context/RequestContext.js';
import { SessionAccessDeniedError } from '../../core/SessionErrors.js';
import { Container } from '../../di/Container.js';
import { PersistenceUnavailableError } from '../../errors.js';
import { StructuredLogger } from '../../logger/StructuredLogger.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import * as persistenceFactory from '../../persistence/PersistenceFactory.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { ServerConfig } from '../../ServerConfig.js';
import {
	createTestSessionId,
	createTestThought,
	createTestThoughtId,
} from '../helpers/factories.js';

const servers = new Set<ToolAwareSequentialThinkingServer>();
const sessionId = createTestSessionId('injected-persistence');

function backend() {
	const persistence = new MemoryPersistence();
	return { persistence, close: vi.spyOn(persistence, 'close') };
}

function options(persistenceBackend?: PersistenceBackend): ServerOptions {
	return {
		persistenceBackend,
		autoDiscover: false,
		lazyDiscovery: true,
		logger: new StructuredLogger({ level: 'error', pretty: false }),
		config: new ServerConfig({
			skillDirs: [],
			toolDirs: [],
			persistenceFlushInterval: 60_000,
		}),
	};
}

async function start(serverOptions: ServerOptions) {
	const server = await createServer(serverOptions);
	servers.add(server);
	return server;
}

afterEach(async () => {
	for (const server of servers) await server.dispose();
	servers.clear();
	vi.restoreAllMocks();
});

describe('injected persistence admission and draining', () => {
	it('exports the complete backend vocabulary as root types', () => {
		expectTypeOf<MemoryPersistence>().toExtend<PersistenceBackend>();
		expectTypeOf<Parameters<PersistenceBackend['saveThoughtForSession']>>().toEqualTypeOf<
			[SessionId, ThoughtData]
		>();
		expectTypeOf<Parameters<PersistenceBackend['saveBacktrackForSession']>>().toEqualTypeOf<
			[SessionId, ThoughtData, ThoughtId]
		>();
		expectTypeOf<Parameters<PersistenceBackend['saveBranchForSession']>>().toEqualTypeOf<
			[SessionId, BranchId, readonly ThoughtData[]]
		>();
		expectTypeOf<Parameters<PersistenceBackend['saveEdges']>>().toEqualTypeOf<
			[SessionId, readonly Edge[]]
		>();
		expectTypeOf<Parameters<PersistenceBackend['saveSummaries']>>().toEqualTypeOf<
			[SessionId, readonly Summary[]]
		>();
	});

	it('bypasses the factory even when configured persistence is enabled', async () => {
		// Given
		const { persistence } = backend();
		const factory = vi.spyOn(persistenceFactory, 'createPersistenceBackend');
		// When
		const server = await start({
			...options(persistence),
			config: new ServerConfig({ persistence: { enabled: true, backend: 'memory' } }),
		});
		// Then
		expect(server.getContainer().resolve('Persistence')).toBe(persistence);
		expect(factory).not.toHaveBeenCalled();
	});

	it('drains accepted writes without closing the borrowed backend when stop resolves', async () => {
		// Given
		const { persistence, close } = backend();
		const save = vi.spyOn(persistence, 'saveThoughtForSession');
		const server = await start(options(persistence));
		const result = await server.processThought(createTestThought({ session_id: sessionId }));
		expect(result.isError).toBeUndefined();
		expect(save).not.toHaveBeenCalled();
		// When
		await server.stop();
		// Then
		expect(save).toHaveBeenCalledExactlyOnceWith(
			sessionId,
			expect.objectContaining({
				session_id: sessionId,
				thought: 'Test thought',
			})
		);
		expect(close).not.toHaveBeenCalled();
	});

	it('uses only the atomic backtrack operation for backtrack thoughts', async () => {
		// Given
		const { persistence } = backend();
		const save = vi.spyOn(persistence, 'saveThoughtForSession');
		const backtrack = vi.spyOn(persistence, 'saveBacktrackForSession');
		const server = await start(options(persistence));
		await server.processThought(createTestThought({ id: 'target', session_id: sessionId }));
		// When
		const result = await server.processThought(
			createTestThought({
				id: 'backtrack',
				session_id: sessionId,
				thought_number: 2,
				total_thoughts: 2,
				thought_type: 'backtrack',
				backtrack_target: 1,
			})
		);
		await server.stop();
		// Then
		expect(result.isError).toBeUndefined();
		expect(save).toHaveBeenCalledTimes(1);
		expect(backtrack).toHaveBeenCalledExactlyOnceWith(
			sessionId,
			expect.objectContaining({ id: 'backtrack' }),
			createTestThoughtId('target')
		);
		expect((await persistence.loadHistoryForSession(sessionId))[0]?.retracted).toBe(true);
	});
});

describe('injected persistence restore', () => {
	it('reads the borrowed backend and preserves restored provenance', async () => {
		// Given
		const { persistence } = backend();
		const thought = createTestThought({ id: 'restored', session_id: sessionId });
		await persistence.saveThoughtForSession(sessionId, thought);
		const read = vi.spyOn(persistence, 'loadHistoryForSession');
		// When
		const server = await start(options(persistence));
		// Then
		expect(read).toHaveBeenCalledExactlyOnceWith(sessionId);
		expect(server.history.getHistory(sessionId)).toEqual([thought]);
		expect(() =>
			runWithContext({ requestId: 'read', owner: 'network-owner' }, () =>
				server.history.getHistory(sessionId)
			)
		).toThrow(SessionAccessDeniedError);
	});

	it('skips persistence reads when loadFromPersistence is false', async () => {
		// Given
		const { persistence } = backend();
		const healthy = vi.spyOn(persistence, 'healthy');
		const sessions = vi.spyOn(persistence, 'listSessions');
		const read = vi.spyOn(persistence, 'loadHistoryForSession');
		// When
		await start({ ...options(persistence), loadFromPersistence: false });
		// Then
		expect(healthy).not.toHaveBeenCalled();
		expect(sessions).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});

	it('rejects an unhealthy borrowed backend without closing it', async () => {
		// Given
		const { persistence, close } = backend();
		vi.spyOn(persistence, 'healthy').mockResolvedValue(false);
		// When / Then
		await expect(createServer(options(persistence))).rejects.toBeInstanceOf(
			PersistenceUnavailableError
		);
		expect(close).not.toHaveBeenCalled();
	});

	it('does not close the borrowed backend after failed restore', async () => {
		// Given
		const { persistence, close } = backend();
		const failure = new Error('restore failed');
		vi.spyOn(persistence, 'listSessions').mockRejectedValue(failure);
		// When / Then
		await expect(createServer(options(persistence))).rejects.toBe(failure);
		expect(close).not.toHaveBeenCalled();
	});
});

describe('injected persistence cleanup ownership', () => {
	it('does not close the borrowed backend on repeated disposal', async () => {
		// Given
		const { persistence, close } = backend();
		const server = await start(options(persistence));
		// When
		await server.dispose();
		await server.dispose();
		// Then
		expect(close).not.toHaveBeenCalled();
	});

	it('does not close the borrowed backend when the constructor fails', async () => {
		// Given
		const { persistence, close } = backend();
		const failure = new Error('constructor failed');
		vi.spyOn(ToolRegistry.prototype, 'add').mockImplementationOnce(() => {
			throw failure;
		});
		// When / Then
		await expect(createServer(options(persistence))).rejects.toBe(failure);
		expect(close).not.toHaveBeenCalled();
	});

	it('does not close the borrowed backend when container construction fails', async () => {
		// Given
		const { persistence, close } = backend();
		const failure = new Error('container failed');
		vi.spyOn(Container.prototype, 'registerInstance').mockImplementationOnce(() => {
			throw failure;
		});
		// When / Then
		await expect(createServer(options(persistence))).rejects.toBe(failure);
		expect(close).not.toHaveBeenCalled();
	});

	it('closes a factory-created backend exactly once', async () => {
		// Given
		const { persistence, close } = backend();
		const factory = vi
			.spyOn(persistenceFactory, 'createPersistenceBackend')
			.mockResolvedValue(persistence);
		const server = await start(options());
		// When
		await server.stop();
		await server.dispose();
		// Then
		expect(factory).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('closes a test-registered replacement even when a borrowed backend was supplied', async () => {
		// Given
		const borrowed = backend();
		const replacement = backend();
		const server = await start(options(borrowed.persistence));
		server.getContainer().unregister('Persistence');
		server.getContainer().registerInstance('Persistence', replacement.persistence);
		// When
		await server.stop();
		await server.dispose();
		// Then
		expect(replacement.close).toHaveBeenCalledOnce();
		expect(borrowed.close).not.toHaveBeenCalled();
	});
});
