import { once } from 'node:events';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import type { Logger, LogLevel } from '../../logger/StructuredLogger.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { ServerConfig } from '../../ServerConfig.js';
import { SkillWatcher } from '../../watchers/SkillWatcher.js';
import { ToolWatcher } from '../../watchers/ToolWatcher.js';

const EVENT_DEADLINE_MS = 5_000;

type RefreshableRegistry = {
	refreshAsync(): Promise<number>;
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

function observeRefreshes(registry: RefreshableRegistry): () => Promise<number> {
	const originalRefresh = registry.refreshAsync.bind(registry);
	const refreshSpy = vi.spyOn(registry, 'refreshAsync');
	return () =>
		new Promise<number>((resolve, reject) => {
			refreshSpy.mockImplementationOnce(async () => {
				try {
					const count = await originalRefresh();
					resolve(count);
					return count;
				} catch (error) {
					reject(error);
					throw error;
				}
			});
		});
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
		let refreshed = nextRefresh();
		await writeFile(betaPath, skillDocument('beta', 'second'), 'utf8');
		await withDeadline(refreshed, 'skill add refresh');
		expect(registry.getNames().sort()).toEqual(['alpha', 'beta']);

		// When/Then: change
		refreshed = nextRefresh();
		await writeFile(alphaPath, skillDocument('alpha', 'updated'), 'utf8');
		await withDeadline(refreshed, 'skill change refresh');
		expect(registry.get('alpha')?.description).toBe('updated');

		// When/Then: unlink
		refreshed = nextRefresh();
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
		const refreshed = observeRefreshes(registry)();

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
		let refreshed = nextRefresh();
		await writeFile(toolPath, toolDocument('search', 'first'), 'utf8');
		await withDeadline(refreshed, 'tool add refresh');
		expect(registry.getNames()).toEqual(['search']);

		// When/Then: change
		refreshed = nextRefresh();
		await writeFile(toolPath, toolDocument('search', 'updated'), 'utf8');
		await withDeadline(refreshed, 'tool change refresh');
		expect(registry.get('search')?.description).toBe('updated');
		expect(registry.size()).toBe(1);

		// When/Then: unlink
		refreshed = nextRefresh();
		await unlink(toolPath);
		await withDeadline(refreshed, 'tool unlink refresh');
		expect(registry.getNames()).toEqual([]);
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
		const refreshSpy = vi.spyOn(registry, 'refreshAsync').mockImplementation(async () => {
			markStarted?.();
			await refreshGate;
			return originalRefresh();
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

		const observer = watch(skillDir, { ignoreInitial: true });
		await withDeadline(
			new Promise<void>((resolve) => observer.once('ready', resolve)),
			'observer ready'
		);
		const observedAdd = waitForEvent(observer, 'add');
		await writeFile(join(skillDir, 'after-stop.md'), skillDocument('after-stop', 'two'), 'utf8');
		await withDeadline(observedAdd, 'post-stop filesystem event');
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		await observer.close();
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

		let skillRefreshed = nextSkillRefresh();
		let toolRefreshed = nextToolRefresh();
		await Promise.all([
			writeFile(skillPath, skillDocument('factory-skill', 'first'), 'utf8'),
			writeFile(toolPath, toolDocument('factory-tool', 'first'), 'utf8'),
		]);
		await Promise.all([
			withDeadline(skillRefreshed, 'factory skill add refresh'),
			withDeadline(toolRefreshed, 'factory tool add refresh'),
		]);
		expect(server.skills.get('factory-skill')?.description).toBe('first');
		expect(server.tools.get('factory-tool')?.description).toBe('first');

		skillRefreshed = nextSkillRefresh();
		toolRefreshed = nextToolRefresh();
		await Promise.all([
			writeFile(skillPath, skillDocument('factory-skill', 'updated'), 'utf8'),
			writeFile(toolPath, toolDocument('factory-tool', 'updated'), 'utf8'),
		]);
		await Promise.all([
			withDeadline(skillRefreshed, 'factory skill change refresh'),
			withDeadline(toolRefreshed, 'factory tool change refresh'),
		]);
		expect(server.skills.get('factory-skill')?.description).toBe('updated');
		expect(server.tools.get('factory-tool')?.description).toBe('updated');

		skillRefreshed = nextSkillRefresh();
		toolRefreshed = nextToolRefresh();
		await Promise.all([unlink(skillPath), unlink(toolPath)]);
		await Promise.all([
			withDeadline(skillRefreshed, 'factory skill unlink refresh'),
			withDeadline(toolRefreshed, 'factory tool unlink refresh'),
		]);
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
		const skillRefreshed = observeRefreshes(server.skills)();
		const toolRefreshed = observeRefreshes(server.tools)();

		await Promise.all([
			writeFile(skillPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8'),
			writeFile(toolPath, '---\n: invalid: [yaml\n---\n# Body', 'utf8'),
		]);
		await Promise.all([
			withDeadline(skillRefreshed, 'malformed configured skill change'),
			withDeadline(toolRefreshed, 'malformed configured tool change'),
		]);

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
