import { once } from 'node:events';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { StructuredLogger, type Logger, type LogLevel } from '../../logger/StructuredLogger.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { ServerConfig } from '../../ServerConfig.js';
import { SkillWatcher } from '../../watchers/SkillWatcher.js';
import { ToolWatcher } from '../../watchers/ToolWatcher.js';

const EVENT_DEADLINE_MS = 5_000;

type RefreshableRegistry = {
	refreshAsync(): Promise<number>;
};

type RefreshWaiter = {
	readonly isIntended: () => boolean;
	readonly resolve: (count: number) => void;
	readonly reject: (error: unknown) => void;
};

function skillDocument(name: string, description: string): string {
	return ['---', `name: ${name}`, `description: ${description}`, '---', '# Body'].join('\n');
}

function toolDocument(name: string, description: string): string {
	return [
		'---',
		`name: ${name}`,
		`description: ${description}`,
		'inputSchema:',
		'  type: object',
		'---',
		'# Body',
	].join('\n');
}

function createLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		setLevel: vi.fn(),
		getLevel: vi.fn((): LogLevel => 'info'),
	};
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${label}`)),
			EVENT_DEADLINE_MS
		);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function observeRefreshes(
	registry: RefreshableRegistry
): (isIntended: () => boolean) => Promise<number> {
	const originalRefresh = registry.refreshAsync.bind(registry);
	const waiters = new Set<RefreshWaiter>();
	vi.spyOn(registry, 'refreshAsync').mockImplementation(async () => {
		try {
			const count = await originalRefresh();
			for (const waiter of waiters) {
				if (!waiter.isIntended()) continue;
				waiters.delete(waiter);
				waiter.resolve(count);
			}
			return count;
		} catch (error) {
			for (const waiter of waiters) waiter.reject(error);
			waiters.clear();
			throw error;
		}
	});
	return (isIntended) =>
		new Promise<number>((resolve, reject) => {
			waiters.add({ isIntended, resolve, reject });
		});
}

async function withObserver<T>(
	observer: FSWatcher,
	action: (observer: FSWatcher) => Promise<T>
): Promise<T> {
	try {
		return await action(observer);
	} finally {
		await observer.close();
	}
}

describe('Discovery refresh integration', () => {
	let rootDir: string;
	const activeWatchers: Array<{ stop(): Promise<void> }> = [];
	const activeServers: ToolAwareSequentialThinkingServer[] = [];

	beforeEach(async () => {
		rootDir = await mkdtemp(join(tmpdir(), 'tracelattice-discovery-refresh-'));
	});

	afterEach(async () => {
		await Promise.all(activeServers.splice(0).map((server) => server.dispose()));
		await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.stop()));
		await rm(rootDir, { recursive: true, force: true });
	});

	it('reconciles real skill add, change, and unlink events', async () => {
		// Given
		const skillDir = join(rootDir, 'skills');
		const alphaPath = join(skillDir, 'alpha.md');
		const betaPath = join(skillDir, 'beta.md');
		await mkdir(skillDir, { recursive: true });
		await writeFile(alphaPath, skillDocument('alpha', 'first'), 'utf8');
		const registry = new SkillRegistry({ skillDirs: [skillDir] });
		await registry.discoverAsync();
		const watcher = new SkillWatcher(registry, undefined, [skillDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'skill watcher readiness');
		await registry.refreshAsync();
		const nextRefresh = observeRefreshes(registry);

		// When/Then: add
		let refreshed = nextRefresh(() => registry.has('beta'));
		await writeFile(betaPath, skillDocument('beta', 'second'), 'utf8');
		await withDeadline(refreshed, 'skill add refresh');
		expect(registry.getNames().sort()).toEqual(['alpha', 'beta']);

		// When/Then: change
		refreshed = nextRefresh(() => registry.get('alpha')?.description === 'updated');
		await writeFile(alphaPath, skillDocument('alpha', 'updated'), 'utf8');
		await withDeadline(refreshed, 'skill change refresh');
		expect(registry.get('alpha')?.description).toBe('updated');

		// When/Then: unlink
		refreshed = nextRefresh(() => !registry.has('beta'));
		await unlink(betaPath);
		await withDeadline(refreshed, 'skill unlink refresh');
		expect(registry.getNames()).toEqual(['alpha']);
	});

	it('retains the last-known-good skill when replacement metadata is malformed', async () => {
		// Given
		const skillDir = join(rootDir, 'skills');
		const skillPath = join(skillDir, 'alpha.md');
		await mkdir(skillDir, { recursive: true });
		await writeFile(skillPath, skillDocument('alpha', 'stable'), 'utf8');
		const logger = createLogger();
		const registry = new SkillRegistry({ skillDirs: [skillDir], logger });
		await registry.discoverAsync();
		const watcher = new SkillWatcher(registry, logger, [skillDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'malformed skill watcher readiness');
		await registry.refreshAsync();
		const refreshed = observeRefreshes(registry)(() =>
			vi
				.mocked(logger.warn)
				.mock.calls.some(
					([message, meta]) =>
						message === 'Invalid skill discovery file' && meta?.retainedLastKnownGood === true
				)
		);

		// When
		await writeFile(skillPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8');
		await withDeadline(refreshed, 'malformed skill refresh');

		// Then
		expect(registry.get('alpha')?.description).toBe('stable');
		expect(logger.warn).toHaveBeenCalledWith(
			'Invalid skill discovery file',
			expect.objectContaining({ retainedLastKnownGood: true })
		);
	});

	it('reconciles real tool add, change, and unlink events without duplicates', async () => {
		// Given
		const toolDir = join(rootDir, 'tools');
		const toolPath = join(toolDir, 'search.tool.md');
		await mkdir(toolDir, { recursive: true });
		const registry = new ToolRegistry({ toolDirs: [toolDir] });
		await registry.discoverAsync();
		const watcher = new ToolWatcher(registry, undefined, [toolDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'tool watcher readiness');
		const nextRefresh = observeRefreshes(registry);

		// When/Then: add
		let refreshed = nextRefresh(() => registry.has('search'));
		await writeFile(toolPath, toolDocument('search', 'first'), 'utf8');
		await withDeadline(refreshed, 'tool add refresh');
		expect(registry.getNames()).toEqual(['search']);

		// When/Then: change
		refreshed = nextRefresh(() => registry.get('search')?.description === 'updated');
		await writeFile(toolPath, toolDocument('search', 'updated'), 'utf8');
		await withDeadline(refreshed, 'tool change refresh');
		expect(registry.get('search')?.description).toBe('updated');
		expect(registry.size()).toBe(1);

		// When/Then: unlink
		refreshed = nextRefresh(() => !registry.has('search'));
		await unlink(toolPath);
		await withDeadline(refreshed, 'tool unlink refresh');
		expect(registry.getNames()).toEqual([]);
	});

	it('waits past an earlier refresh for the intended tool state', async () => {
		// Given
		const toolDir = join(rootDir, 'targeted-tools');
		const toolPath = join(toolDir, 'target.tool.md');
		await mkdir(toolDir, { recursive: true });
		const registry = new ToolRegistry({ toolDirs: [toolDir] });
		await registry.discoverAsync();
		let waiterResolved = false;
		const refreshed = observeRefreshes(registry)(() => registry.has('target')).then(() => {
			waiterResolved = true;
		});

		// When
		await registry.refreshAsync();

		// Then
		expect(waiterResolved).toBe(false);
		await writeFile(toolPath, toolDocument('target', 'intended'), 'utf8');
		await registry.refreshAsync();
		await refreshed;
		expect(registry.getNames()).toEqual(['target']);
	});

	it('closes an independent observer when its operation fails', async () => {
		// Given
		const observedDir = join(rootDir, 'failing-observer');
		await mkdir(observedDir);
		const observer = watch(observedDir, { ignoreInitial: true });
		await withDeadline(
			new Promise<void>((resolve) => observer.once('ready', resolve)),
			'observer ready'
		);
		const closeObserver = vi.spyOn(observer, 'close');
		const failure = new Error('forced observer operation failure');

		// When/Then
		await expect(withObserver(observer, () => Promise.reject(failure))).rejects.toBe(failure);
		expect(closeObserver).toHaveBeenCalledOnce();
	});

	it('joins an accepted refresh on stop and ignores later filesystem events', async () => {
		// Given
		const skillDir = join(rootDir, 'skills');
		await mkdir(skillDir, { recursive: true });
		const registry = new SkillRegistry({ skillDirs: [skillDir] });
		await registry.discoverAsync();
		let releaseRefresh: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const originalRefresh = registry.refreshAsync.bind(registry);
		let intendedRefreshStarted = false;
		const refreshSpy = vi.spyOn(registry, 'refreshAsync').mockImplementation(async () => {
			const count = await originalRefresh();
			if (registry.has('before-stop') && !intendedRefreshStarted) {
				intendedRefreshStarted = true;
				markStarted?.();
				await refreshGate;
			}
			return count;
		});
		const watcher = new SkillWatcher(registry, undefined, [skillDir]);
		activeWatchers.push(watcher);
		await withDeadline(watcher.ready(), 'stoppable watcher readiness');

		// When
		await writeFile(join(skillDir, 'before-stop.md'), skillDocument('before-stop', 'one'), 'utf8');
		await withDeadline(refreshStarted, 'pending refresh start');
		let stopCompleted = false;
		const stopping = watcher.stop().then(() => {
			stopCompleted = true;
		});
		await Promise.resolve();

		// Then
		expect(stopCompleted).toBe(false);
		releaseRefresh?.();
		await withDeadline(stopping, 'watcher stop');
		expect(registry.has('before-stop')).toBe(true);

		await withObserver(watch(skillDir, { ignoreInitial: true }), async (observer) => {
			await withDeadline(
				new Promise<void>((resolve) => observer.once('ready', resolve)),
				'observer ready'
			);
			const observedAdd = waitForEvent(observer, 'add');
			await writeFile(join(skillDir, 'after-stop.md'), skillDocument('after-stop', 'two'), 'utf8');
			await withDeadline(observedAdd, 'post-stop filesystem event');
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});
	});

	it('refreshes both configured registries through a real server watcher lifecycle', async () => {
		const skillDir = join(rootDir, 'factory-skills');
		const toolDir = join(rootDir, 'factory-tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		const skillReady = vi.spyOn(SkillWatcher.prototype, 'ready');
		const toolReady = vi.spyOn(ToolWatcher.prototype, 'ready');
		const skillRefreshDuringStartup = vi.spyOn(SkillRegistry.prototype, 'refreshAsync');
		const toolRefreshDuringStartup = vi.spyOn(ToolRegistry.prototype, 'refreshAsync');
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			enableWatcher: true,
			autoDiscover: true,
			loadFromPersistence: false,
		});
		activeServers.push(server);

		expect(skillReady).toHaveBeenCalledOnce();
		expect(toolReady).toHaveBeenCalledOnce();
		expect(skillRefreshDuringStartup).not.toHaveBeenCalled();
		expect(toolRefreshDuringStartup).not.toHaveBeenCalled();
		skillRefreshDuringStartup.mockRestore();
		toolRefreshDuringStartup.mockRestore();

		const nextSkillRefresh = observeRefreshes(server.skills);
		const nextToolRefresh = observeRefreshes(server.tools);
		const skillPath = join(skillDir, 'factory.md');
		const toolPath = join(toolDir, 'factory.tool.md');

		let skillRefreshed = nextSkillRefresh(
			() => server.skills.get('factory-skill')?.description === 'first'
		);
		await writeFile(skillPath, skillDocument('factory-skill', 'first'), 'utf8');
		await withDeadline(skillRefreshed, 'factory skill add refresh');
		let toolRefreshed = nextToolRefresh(
			() => server.tools.get('factory-tool')?.description === 'first'
		);
		await writeFile(toolPath, toolDocument('factory-tool', 'first'), 'utf8');
		await withDeadline(toolRefreshed, 'factory tool add refresh');
		expect(server.skills.get('factory-skill')?.description).toBe('first');
		expect(server.tools.get('factory-tool')?.description).toBe('first');

		skillRefreshed = nextSkillRefresh(
			() => server.skills.get('factory-skill')?.description === 'updated'
		);
		await writeFile(skillPath, skillDocument('factory-skill', 'updated'), 'utf8');
		await withDeadline(skillRefreshed, 'factory skill change refresh');
		toolRefreshed = nextToolRefresh(
			() => server.tools.get('factory-tool')?.description === 'updated'
		);
		await writeFile(toolPath, toolDocument('factory-tool', 'updated'), 'utf8');
		await withDeadline(toolRefreshed, 'factory tool change refresh');
		expect(server.skills.get('factory-skill')?.description).toBe('updated');
		expect(server.tools.get('factory-tool')?.description).toBe('updated');

		skillRefreshed = nextSkillRefresh(() => !server.skills.has('factory-skill'));
		await unlink(skillPath);
		await withDeadline(skillRefreshed, 'factory skill unlink refresh');
		toolRefreshed = nextToolRefresh(() => !server.tools.has('factory-tool'));
		await unlink(toolPath);
		await withDeadline(toolRefreshed, 'factory tool unlink refresh');
		expect(server.skills.has('factory-skill')).toBe(false);
		expect(server.tools.has('factory-tool')).toBe(false);
	});

	it('retains both last-known-good items after malformed configured watcher changes', async () => {
		const skillDir = join(rootDir, 'stable-skills');
		const toolDir = join(rootDir, 'stable-tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		const skillPath = join(skillDir, 'stable.md');
		const toolPath = join(toolDir, 'stable.tool.md');
		await Promise.all([
			writeFile(skillPath, skillDocument('stable-skill', 'stable'), 'utf8'),
			writeFile(toolPath, toolDocument('stable-tool', 'stable'), 'utf8'),
		]);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			enableWatcher: true,
			autoDiscover: true,
			loadFromPersistence: false,
		});
		activeServers.push(server);
		const warning = vi.spyOn(StructuredLogger.prototype, 'warn');
		const skillRefreshed = observeRefreshes(server.skills)(() =>
			warning.mock.calls.some(([message]) => message === 'Invalid skill discovery file')
		);
		const toolRefreshed = observeRefreshes(server.tools)(() =>
			warning.mock.calls.some(([message]) => message === 'Invalid tool discovery file')
		);

		try {
			await writeFile(skillPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8');
			await withDeadline(skillRefreshed, 'malformed configured skill change');
			await writeFile(toolPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8');
			await withDeadline(toolRefreshed, 'malformed configured tool change');
		} finally {
			warning.mockRestore();
		}

		expect(server.skills.get('stable-skill')?.description).toBe('stable');
		expect(server.tools.get('stable-tool')?.description).toBe('stable');
	});

	it('refreshes real files with lazy startup and watchers disabled', async () => {
		// Given
		const skillDir = join(rootDir, 'lazy-skills');
		const toolDir = join(rootDir, 'lazy-tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(
				join(skillDir, 'filesystem.md'),
				skillDocument('filesystem-skill', 'fresh'),
				'utf8'
			),
			writeFile(
				join(toolDir, 'filesystem.tool.md'),
				toolDocument('filesystem-tool', 'fresh'),
				'utf8'
			),
		]);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			enableWatcher: false,
			autoDiscover: true,
			lazyDiscovery: true,
			loadFromPersistence: false,
		});
		activeServers.push(server);
		expect(server.skills.has('filesystem-skill')).toBe(false);
		expect(server.tools.has('filesystem-tool')).toBe(false);

		// When
		const result = await server.refreshDiscovery();

		// Then
		expect(result).toEqual({ tools: 1, skills: 1 });
		expect(server.skills.get('filesystem-skill')?.description).toBe('fresh');
		expect(server.tools.get('filesystem-tool')?.description).toBe('fresh');
	});

	it('preserves last-known-good, manual precedence, and the built-in while reporting file counts', async () => {
		// Given
		const skillDir = join(rootDir, 'precedence-skills');
		const toolDir = join(rootDir, 'precedence-tools');
		const stableSkillPath = join(skillDir, 'stable.md');
		const stableToolPath = join(toolDir, 'stable.tool.md');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(stableSkillPath, skillDocument('stable-skill', 'stable'), 'utf8'),
			writeFile(join(skillDir, 'manual.md'), skillDocument('manual-skill', 'filesystem'), 'utf8'),
			writeFile(stableToolPath, toolDocument('stable-tool', 'stable'), 'utf8'),
			writeFile(join(toolDir, 'manual.tool.md'), toolDocument('manual-tool', 'filesystem'), 'utf8'),
			writeFile(
				join(toolDir, 'built-in.tool.md'),
				toolDocument('sequentialthinking_tools', 'filesystem'),
				'utf8'
			),
		]);
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
		activeServers.push(server);
		server.skills.add({
			name: 'manual-skill',
			description: 'manual',
			user_invocable: false,
		});
		server.tools.add({ name: 'manual-tool', description: 'manual', inputSchema: {} });
		await expect(server.refreshDiscovery()).resolves.toEqual({ tools: 1, skills: 1 });
		await Promise.all([
			writeFile(stableSkillPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8'),
			writeFile(stableToolPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8'),
		]);

		// When
		const result = await server.refreshDiscovery();

		// Then
		expect(result).toEqual({ tools: 1, skills: 1 });
		expect(server.skills.get('stable-skill')?.description).toBe('stable');
		expect(server.tools.get('stable-tool')?.description).toBe('stable');
		expect(server.skills.get('manual-skill')?.description).toBe('manual');
		expect(server.tools.get('manual-tool')?.description).toBe('manual');
		expect(server.tools.has('sequentialthinking_tools')).toBe(true);
		expect(server.tools.get('sequentialthinking_tools')?.description).not.toBe('filesystem');
	});
});

async function waitForEvent(watcher: FSWatcher, event: 'add'): Promise<void> {
	await once(watcher, event);
}
