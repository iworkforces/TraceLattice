import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../config/ConfigLoader.js';
import { SessionLifecycleClosedError } from '../../core/SessionErrors.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { Container } from '../../di/Container.js';
import { ConfigurationError, PersistenceUnavailableError } from '../../errors.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { asSessionId } from '../../contracts/ids.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { ServerConfig } from '../../ServerConfig.js';
import { SkillWatcher } from '../../watchers/SkillWatcher.js';
import { ToolWatcher } from '../../watchers/ToolWatcher.js';

const temporaryDirectories = new Set<string>();

function skillDocument(description: string): string {
	return ['---', 'name: restart-skill', `description: ${description}`, '---', '# Body'].join('\n');
}

function toolDocument(description: string): string {
	return [
		'---',
		'name: restart-tool',
		`description: ${description}`,
		'inputSchema:',
		'  type: object',
		'---',
		'# Body',
	].join('\n');
}

function delayWatcherStops(
	skillGate: PromiseWithResolvers<void>,
	toolGate: PromiseWithResolvers<void>
): {
	readonly skillStop: ReturnType<typeof vi.spyOn>;
	readonly toolStop: ReturnType<typeof vi.spyOn>;
	readonly pendingStops: Promise<void>[];
	readonly stopsStarted: Promise<void>;
} {
	const originalSkillStop = SkillWatcher.prototype.stop;
	const originalToolStop = ToolWatcher.prototype.stop;
	const pendingStops: Promise<void>[] = [];
	const stopsStarted = Promise.withResolvers<void>();
	let startedStopCount = 0;
	const markStopStarted = (): void => {
		startedStopCount += 1;
		if (startedStopCount === 2) stopsStarted.resolve();
	};
	const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop').mockImplementation(function (
		this: SkillWatcher
	) {
		markStopStarted();
		const pending = Promise.all([originalSkillStop.call(this), skillGate.promise]).then(
			() => undefined
		);
		pendingStops.push(pending);
		return pending;
	});
	const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop').mockImplementation(function (
		this: ToolWatcher
	) {
		markStopStarted();
		const pending = Promise.all([originalToolStop.call(this), toolGate.promise]).then(
			() => undefined
		);
		pendingStops.push(pending);
		return pending;
	});
	return { skillStop, toolStop, pendingStops, stopsStarted: stopsStarted.promise };
}

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	temporaryDirectories.clear();
});

describe('configuration startup resource safety', () => {
	it('T10-L01 rejects unhealthy restore and closes the backend before becoming ready', async () => {
		// Given
		const unhealthy = vi.spyOn(MemoryPersistence.prototype, 'healthy').mockResolvedValue(false);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBeInstanceOf(PersistenceUnavailableError);
		expect(unhealthy).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('T10-L02 propagates restore reads and closes the backend before becoming ready', async () => {
		// Given
		const failure = new Error('injected list failure');
		vi.spyOn(MemoryPersistence.prototype, 'listSessions').mockRejectedValue(failure);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
	});

	it('T10-L03 propagates a thrown health check and closes the backend', async () => {
		// Given
		const failure = new Error('injected health failure');
		vi.spyOn(MemoryPersistence.prototype, 'healthy').mockRejectedValue(failure);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
	});

	it('T10-L04 propagates a partition load failure and closes the backend', async () => {
		// Given
		const failure = new Error('injected partition load failure');
		vi.spyOn(MemoryPersistence.prototype, 'listSessions').mockResolvedValue([
			asSessionId('restore-session'),
		]);
		vi.spyOn(MemoryPersistence.prototype, 'loadHistoryForSession').mockRejectedValue(failure);
		const close = vi.spyOn(MemoryPersistence.prototype, 'close');
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false });

		// Then
		await expect(creation).rejects.toBe(failure);
		expect(close).toHaveBeenCalledOnce();
	});
	it.each([
		['bogus strategy', 'TRACELATTICE_FEATURES_REASONING_STRATEGY', 'bogus'],
		['trailing numeric garbage', 'TRACELATTICE_TOOL_INTERLEAVE_TTL_MS', '1234garbage'],
	])('rejects %s before acquiring resources', async (_caseName, environmentName, value) => {
		// Given
		vi.useFakeTimers();
		vi.stubEnv(environmentName, value);
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-invalid-env-'));
		temporaryDirectories.add(root);
		const dataDir = join(root, 'backend');
		const startSpy = vi.spyOn(InMemorySuspensionStore.prototype, 'start');
		let server: ToolAwareSequentialThinkingServer | undefined;
		let failure: unknown;

		// When
		try {
			server = await createServer({
				fileConfig: {
					persistence: { enabled: true, backend: 'file', options: { dataDir } },
					features: { toolInterleave: true },
				},
				autoDiscover: false,
				loadFromPersistence: false,
			});
		} catch (error) {
			failure = error;
		}
		if (server) await server.dispose();

		// Then
		expect(failure).toBeInstanceOf(ConfigurationError);
		expect(existsSync(dataDir)).toBe(false);
		expect(startSpy).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('closes an acquired backend once when container construction fails', async () => {
		// Given
		const closeSpy = vi.spyOn(MemoryPersistence.prototype, 'close');
		vi.spyOn(Container.prototype, 'registerInstance').mockImplementationOnce(() => {
			throw new Error('injected container construction failure');
		});
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		// When
		const creation = createServer({ config, autoDiscover: false, loadFromPersistence: false });

		// Then
		await expect(creation).rejects.toThrow('injected container construction failure');
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it('preserves construction and backend-close failures together', async () => {
		const constructionFailure = new Error('injected container construction failure');
		const closeFailure = new Error('injected backend close failure');
		const closeSpy = vi.spyOn(MemoryPersistence.prototype, 'close').mockRejectedValue(closeFailure);
		vi.spyOn(Container.prototype, 'registerInstance').mockImplementationOnce(() => {
			throw constructionFailure;
		});
		const config = new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			features: { toolInterleave: false },
		});

		const outcome = await createServer({
			config,
			autoDiscover: false,
			loadFromPersistence: false,
		}).then(
			(value) => ({ kind: 'resolved' as const, value }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		expect(outcome.kind).toBe('rejected');
		if (outcome.kind !== 'rejected') throw new TypeError('Expected server construction to reject');
		expect(outcome.error).toBeInstanceOf(AggregateError);
		if (!(outcome.error instanceof AggregateError)) {
			throw new TypeError('Expected aggregate construction failure');
		}
		expect(outcome.error.cause).toBe(constructionFailure);
		expect(outcome.error.errors).toEqual([constructionFailure, closeFailure]);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it('does not load or warn about environment when explicit config is provided', async () => {
		// Given
		const config = new ServerConfig({ features: { toolInterleave: false } });
		vi.stubEnv('TRACELATTICE_FEATURES_REASONING_STRATEGY', 'bogus');
		const loadSpy = vi.spyOn(ConfigLoader.prototype, 'load');
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		// When
		const server = await createServer({ config, autoDiscover: false, loadFromPersistence: false });
		await server.dispose();

		// Then
		expect(loadSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe('watcher cleanup ownership', () => {
	it('waits for both configured watchers to become ready before resolving creation', async () => {
		const skillGate = Promise.withResolvers<void>();
		const toolGate = Promise.withResolvers<void>();
		const skillReadyCalled = Promise.withResolvers<void>();
		const toolReadyCalled = Promise.withResolvers<void>();
		vi.spyOn(SkillWatcher.prototype, 'ready').mockImplementation(() => {
			skillReadyCalled.resolve();
			return skillGate.promise;
		});
		vi.spyOn(ToolWatcher.prototype, 'ready').mockImplementation(() => {
			toolReadyCalled.resolve();
			return toolGate.promise;
		});
		let settled = false;
		const creation = createServer({
			config: new ServerConfig({
				skillDirs: [],
				toolDirs: [],
				features: { toolInterleave: false },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		}).then((server) => {
			settled = true;
			return server;
		});
		await Promise.all([skillReadyCalled.promise, toolReadyCalled.promise]);

		expect(settled).toBe(false);
		skillGate.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		toolGate.resolve();
		const server = await creation;
		try {
			expect(settled).toBe(true);
		} finally {
			await server.dispose();
		}
	});

	it('restarts with the same configured roots and a fresh discovered snapshot', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-restart-roots-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		const skillPath = join(skillDir, 'restart.md');
		const toolPath = join(toolDir, 'restart.tool.md');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(skillPath, skillDocument('first'), 'utf8'),
			writeFile(toolPath, toolDocument('first'), 'utf8'),
		]);
		const config = new ServerConfig({
			skillDirs: [skillDir],
			toolDirs: [toolDir],
			features: { toolInterleave: false },
		});
		const first = await createServer({
			config,
			enableWatcher: true,
			autoDiscover: true,
			loadFromPersistence: false,
		});
		expect(first.skills.get('restart-skill')?.description).toBe('first');
		expect(first.tools.get('restart-tool')?.description).toBe('first');
		await first.dispose();

		await Promise.all([
			writeFile(skillPath, skillDocument('second'), 'utf8'),
			writeFile(toolPath, toolDocument('second'), 'utf8'),
		]);
		const second = await createServer({
			config,
			enableWatcher: true,
			autoDiscover: true,
			loadFromPersistence: false,
		});
		try {
			expect(second.skills.get('restart-skill')?.description).toBe('second');
			expect(second.tools.get('restart-tool')?.description).toBe('second');
		} finally {
			await second.dispose();
		}
	});

	it('does not create watcher resources when factory watchers are disabled', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-disabled-watchers-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		const skillReady = vi.spyOn(SkillWatcher.prototype, 'ready');
		const toolReady = vi.spyOn(ToolWatcher.prototype, 'ready');
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			enableWatcher: false,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		await server.dispose();

		expect(skillReady).not.toHaveBeenCalled();
		expect(toolReady).not.toHaveBeenCalled();
	});

	it('closes public refresh admission and joins accepted work before idempotent cleanup', async () => {
		// Given
		const toolRefresh = Promise.withResolvers<number>();
		const skillRefresh = Promise.withResolvers<number>();
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [],
				toolDirs: [],
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: false },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		vi.spyOn(server.tools, 'refreshAsync').mockReturnValue(toolRefresh.promise);
		vi.spyOn(server.skills, 'refreshAsync').mockReturnValue(skillRefresh.promise);
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop');
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop');
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');
		const clearLiveState = vi.spyOn(server.history, 'clearLiveStateAfterShutdown');
		const containerDispose = vi.spyOn(server.getContainer(), 'dispose');

		try {
			// When
			const acceptedRefresh = server.refreshDiscovery();
			const firstStop = server.stop();
			const secondStop = server.stop();
			const firstDispose = server.dispose();
			const secondDispose = server.dispose();
			let stopSettled = false;
			let disposeSettled = false;
			void firstStop.then(() => {
				stopSettled = true;
			});
			void firstDispose.then(() => {
				disposeSettled = true;
			});
			const rejectedRefresh = server.refreshDiscovery();
			await Promise.resolve();

			// Then
			expect(secondStop).toBe(firstStop);
			expect(secondDispose).toBe(firstDispose);
			expect(stopSettled).toBe(false);
			expect(disposeSettled).toBe(false);
			await expect(rejectedRefresh).rejects.toBeInstanceOf(SessionLifecycleClosedError);
			await expect(rejectedRefresh).rejects.toMatchObject({ phase: 'shutting_down' });
			expect(server.tools.refreshAsync).toHaveBeenCalledOnce();
			expect(server.skills.refreshAsync).toHaveBeenCalledOnce();

			toolRefresh.resolve(2);
			skillRefresh.resolve(3);
			await expect(acceptedRefresh).resolves.toEqual({ tools: 2, skills: 3 });
			await firstStop;
			await firstDispose;

			expect(skillStop).toHaveBeenCalledOnce();
			expect(toolStop).toHaveBeenCalledOnce();
			expect(historyShutdown).toHaveBeenCalledOnce();
			expect(persistenceClose).toHaveBeenCalledOnce();
			expect(clearLiveState).toHaveBeenCalledOnce();
			expect(containerDispose).toHaveBeenCalledOnce();
		} finally {
			toolRefresh.resolve(2);
			skillRefresh.resolve(3);
			await server.dispose();
		}
	});

	it('finishes remaining shutdown cleanup after an accepted refresh fails', async () => {
		// Given
		const failure = new Error('injected accepted refresh failure');
		const toolRefresh = Promise.withResolvers<number>();
		const skillRefresh = Promise.withResolvers<number>();
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [],
				toolDirs: [],
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: false },
			}),
			enableWatcher: false,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		vi.spyOn(server.tools, 'refreshAsync').mockReturnValue(toolRefresh.promise);
		vi.spyOn(server.skills, 'refreshAsync').mockReturnValue(skillRefresh.promise);
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');
		const clearLiveState = vi.spyOn(server.history, 'clearLiveStateAfterShutdown');

		try {
			// When
			const refreshOutcome = server.refreshDiscovery().then(
				(value: { tools: number; skills: number }) => ({ kind: 'resolved' as const, value }),
				(error: unknown) => ({ kind: 'rejected' as const, error })
			);
			const stopping = server.stop();
			toolRefresh.reject(failure);
			await Promise.resolve();

			// Then
			expect(historyShutdown).not.toHaveBeenCalled();
			skillRefresh.resolve(1);
			expect(await refreshOutcome).toEqual({ kind: 'rejected', error: failure });
			await expect(stopping).rejects.toMatchObject({
				errors: [failure],
			});
			expect(historyShutdown).toHaveBeenCalledOnce();
			expect(persistenceClose).toHaveBeenCalledOnce();
			expect(clearLiveState).not.toHaveBeenCalled();
		} finally {
			toolRefresh.resolve(0);
			skillRefresh.resolve(1);
			await expect(server.dispose()).rejects.toBeInstanceOf(AggregateError);
		}
	});

	it('starts and stops with explicitly empty watcher roots', async () => {
		const skillReady = vi.spyOn(SkillWatcher.prototype, 'ready');
		const toolReady = vi.spyOn(ToolWatcher.prototype, 'ready');
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [],
				toolDirs: [],
				features: { toolInterleave: false },
			}),
			enableWatcher: true,
			autoDiscover: true,
			loadFromPersistence: false,
		});
		await server.dispose();

		expect(skillReady).toHaveBeenCalledOnce();
		expect(toolReady).toHaveBeenCalledOnce();
		expect(server.skills.getNames()).toEqual([]);
		expect(server.tools.getNames()).toEqual(['sequentialthinking_tools']);
	});

	it('joins one successful server cleanup when history initiates shutdown', async () => {
		// Given
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop');
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop');
		const server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: true },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const suspensionStop = vi.spyOn(server.getContainer().resolve('suspensionStore'), 'stop');
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');
		const clearLiveState = vi.spyOn(server.history, 'clearLiveStateAfterShutdown');
		const containerDispose = vi.spyOn(server.getContainer(), 'dispose');

		// When
		const historyShutdownPromise = server.history.shutdown();
		const serverStopPromise = server.stop();
		const repeatedStopPromise = server.stop();
		const firstDisposePromise = server.dispose();
		const secondDisposePromise = server.dispose();
		await Promise.all([
			historyShutdownPromise,
			serverStopPromise,
			repeatedStopPromise,
			firstDisposePromise,
			secondDisposePromise,
		]);

		// Then
		expect(serverStopPromise).toBe(historyShutdownPromise);
		expect(repeatedStopPromise).toBe(historyShutdownPromise);
		expect(secondDisposePromise).toBe(firstDisposePromise);
		expect(skillStop).toHaveBeenCalledOnce();
		expect(toolStop).toHaveBeenCalledOnce();
		expect(suspensionStop).toHaveBeenCalledOnce();
		expect(historyShutdown).toHaveBeenCalledOnce();
		expect(persistenceClose).toHaveBeenCalledOnce();
		expect(clearLiveState).toHaveBeenCalledOnce();
		expect(containerDispose).toHaveBeenCalledOnce();
	});

	it('runs server cleanup after sequential history shutdown, stop, and dispose calls', async () => {
		// Given
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop');
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop');
		const server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: true },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const suspensionStop = vi.spyOn(server.getContainer().resolve('suspensionStore'), 'stop');
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');
		const clearLiveState = vi.spyOn(server.history, 'clearLiveStateAfterShutdown');
		const containerDispose = vi.spyOn(server.getContainer(), 'dispose');

		// When
		await server.history.shutdown();
		await server.stop();
		await server.dispose();

		// Then
		expect(skillStop).toHaveBeenCalledOnce();
		expect(toolStop).toHaveBeenCalledOnce();
		expect(suspensionStop).toHaveBeenCalledOnce();
		expect(historyShutdown).toHaveBeenCalledOnce();
		expect(persistenceClose).toHaveBeenCalledOnce();
		expect(clearLiveState).toHaveBeenCalledOnce();
		expect(containerDispose).toHaveBeenCalledOnce();
	});

	it('joins one watcher cleanup across concurrent dispose calls', async () => {
		// Given
		const skillGate = Promise.withResolvers<void>();
		const toolGate = Promise.withResolvers<void>();
		const { skillStop, toolStop, pendingStops, stopsStarted } = delayWatcherStops(
			skillGate,
			toolGate
		);
		const server = await createServer({
			config: new ServerConfig({ features: { toolInterleave: false } }),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		let settled = false;

		// When
		const disposal = Promise.all([server.dispose(), server.dispose()]).then(() => {
			settled = true;
		});
		await stopsStarted;
		const settledBeforeRelease = settled;
		const skillStopCalls = skillStop.mock.calls.length;
		const toolStopCalls = toolStop.mock.calls.length;
		skillGate.resolve();
		toolGate.resolve();
		await disposal;
		await Promise.all(pendingStops);

		// Then
		expect(settledBeforeRelease).toBe(false);
		expect(skillStopCalls).toBe(1);
		expect(toolStopCalls).toBe(1);
	});

	it('surfaces watcher failures after history initiates every server cleanup once', async () => {
		// Given
		const skillFailure = new Error('injected skill watcher stop failure');
		const toolFailure = new Error('injected tool watcher stop failure');
		const originalSkillStop = SkillWatcher.prototype.stop;
		const originalToolStop = ToolWatcher.prototype.stop;
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop').mockImplementation(async function (
			this: SkillWatcher
		) {
			await originalSkillStop.call(this);
			throw skillFailure;
		});
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop').mockImplementation(async function (
			this: ToolWatcher
		) {
			await originalToolStop.call(this);
			throw toolFailure;
		});
		const server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: true },
			}),
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const suspensionStop = vi.spyOn(server.getContainer().resolve('suspensionStore'), 'stop');
		const historyShutdown = vi.spyOn(server.history, 'shutdownWithinLifecycle');
		const persistence = server.getContainer().resolve('Persistence');
		if (persistence === null) throw new TypeError('Expected configured memory persistence');
		const persistenceClose = vi.spyOn(persistence, 'close');
		const clearLiveState = vi.spyOn(server.history, 'clearLiveStateAfterShutdown');
		const containerDispose = vi.spyOn(server.getContainer(), 'dispose');

		// When
		const historyShutdownPromise = server.history.shutdown();
		const serverStopPromise = server.stop();
		const stopOutcome = await historyShutdownPromise.then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);
		const firstDisposePromise = server.dispose();
		const secondDisposePromise = server.dispose();
		const disposeOutcome = await firstDisposePromise.then(
			() => ({ kind: 'resolved' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);

		// Then
		expect(serverStopPromise).toBe(historyShutdownPromise);
		expect(stopOutcome.kind).toBe('rejected');
		if (stopOutcome.kind !== 'rejected') throw new TypeError('Expected stop to reject');
		expect(stopOutcome.error).toBeInstanceOf(AggregateError);
		if (!(stopOutcome.error instanceof AggregateError)) {
			throw new TypeError('Expected aggregate stop failure');
		}
		expect(stopOutcome.error.errors).toEqual([skillFailure, toolFailure]);
		expect(secondDisposePromise).toBe(firstDisposePromise);
		expect(disposeOutcome.kind).toBe('rejected');
		if (disposeOutcome.kind !== 'rejected') throw new TypeError('Expected dispose to reject');
		expect(disposeOutcome.error).toBeInstanceOf(AggregateError);
		if (!(disposeOutcome.error instanceof AggregateError)) {
			throw new TypeError('Expected aggregate dispose failure');
		}
		expect(disposeOutcome.error.errors).toEqual([skillFailure, toolFailure]);
		expect(skillStop).toHaveBeenCalledOnce();
		expect(toolStop).toHaveBeenCalledOnce();
		expect(suspensionStop).toHaveBeenCalledOnce();
		expect(historyShutdown).toHaveBeenCalledOnce();
		expect(persistenceClose).toHaveBeenCalledOnce();
		expect(clearLiveState).not.toHaveBeenCalled();
		expect(containerDispose).toHaveBeenCalledOnce();
	});

	it.each([
		{
			registryName: 'skill',
			installFailure: (failure: Error) =>
				vi.spyOn(SkillRegistry.prototype, 'discoverAsync').mockRejectedValue(failure),
		},
		{
			registryName: 'tool',
			installFailure: (failure: Error) =>
				vi.spyOn(ToolRegistry.prototype, 'discoverAsync').mockRejectedValue(failure),
		},
	])(
		'joins watcher cleanup before $registryName startup discovery rejects',
		async ({ registryName, installFailure }) => {
			// Given
			const skillGate = Promise.withResolvers<void>();
			const toolGate = Promise.withResolvers<void>();
			const { skillStop, toolStop, pendingStops, stopsStarted } = delayWatcherStops(
				skillGate,
				toolGate
			);
			const failure = new Error(`injected ${registryName} discovery failure`);
			installFailure(failure);
			let settled = false;

			// When
			const creation = createServer({
				config: new ServerConfig({
					skillDirs: [],
					toolDirs: [],
					features: { toolInterleave: false },
				}),
				enableWatcher: true,
				autoDiscover: true,
				loadFromPersistence: false,
			})
				.then(
					(value) => ({ kind: 'resolved' as const, value }),
					(error: unknown) => ({ kind: 'rejected' as const, error })
				)
				.finally(() => {
					settled = true;
				});
			await stopsStarted;
			const settledBeforeRelease = settled;
			skillGate.resolve();
			toolGate.resolve();
			const outcome = await creation;
			await Promise.all(pendingStops);

			// Then
			expect(settledBeforeRelease).toBe(false);
			expect(outcome).toMatchObject({
				kind: 'rejected',
				error: failure,
			});
			expect(skillStop).toHaveBeenCalledOnce();
			expect(toolStop).toHaveBeenCalledOnce();
		}
	);
});
