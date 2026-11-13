import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WatcherEventHandler = (path: string) => Promise<void> | void;

vi.mock('chokidar', async () => {
	const { watchMock } = await import('./helpers/chokidar-mock.js');
	return { watch: watchMock };
});

vi.mock('node:os', () => ({ homedir: () => '/mock/home' }));

import { watch } from 'chokidar';
import { emitOn, latestWatcher, resetChokidarMock } from './helpers/chokidar-mock.js';
import { describeWatcherFaultRecovery } from './helpers/watcher-fault-suite.js';
import type { Logger, LogLevel } from '../logger/StructuredLogger.js';
import { SkillRegistry } from '../registry/SkillRegistry.js';
import { SkillWatcher } from '../watchers/SkillWatcher.js';

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

function handler(event: string): WatcherEventHandler {
	return (path) => emitOn(latestWatcher(), event, path);
}

describe('SkillWatcher', () => {
	let registry: SkillRegistry;
	let logger: Logger;
	let refresh: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		resetChokidarMock();
		registry = new SkillRegistry({ skillDirs: [] });
		refresh = vi.spyOn(registry, 'refreshAsync').mockResolvedValue(0);
		logger = createLogger();
	});

	afterEach(() => {
		delete process.env.WATCHER_VERBOSE;
		delete process.env.TRACELATTICE_WATCHER_VERBOSE;
		vi.restoreAllMocks();
	});

	it('watches default directories and all reconciliation events', async () => {
		// Given/When
		const watcher = new SkillWatcher(registry, logger);

		// Then
		expect(watch).toHaveBeenCalledWith(
			['.claude/skills', '/mock/home/.claude/skills'],
			expect.objectContaining({ persistent: true })
		);
		expect(latestWatcher().on).toHaveBeenCalledWith('add', expect.any(Function));
		expect(latestWatcher().on).toHaveBeenCalledWith('change', expect.any(Function));
		expect(latestWatcher().on).toHaveBeenCalledWith('unlink', expect.any(Function));
		await watcher.stop();
	});

	it('resolves ready only after Chokidar signals readiness', async () => {
		// Given
		const watcher = new SkillWatcher(registry, logger);
		let ready = false;
		const readiness = watcher.ready().then(() => {
			ready = true;
		});

		// When
		await Promise.resolve();
		expect(ready).toBe(false);
		handler('ready')('');
		await readiness;

		// Then
		expect(ready).toBe(true);
		await watcher.stop();
	});

	it.each(['add', 'change', 'unlink'])('refreshes the registry on %s', async (event) => {
		// Given
		const watcher = new SkillWatcher(registry, logger);

		// When
		await handler(event)('/skills/example.md');

		// Then
		expect(refresh).toHaveBeenCalledTimes(1);
		await watcher.stop();
	});

	it('coalesces duplicate events while preserving one trailing refresh', async () => {
		// Given
		let release: (() => void) | undefined;
		const gate = new Promise<number>((resolve) => {
			release = () => resolve(1);
		});
		refresh.mockImplementationOnce(() => gate).mockResolvedValue(1);
		const watcher = new SkillWatcher(registry, logger);

		// When
		const events = [
			handler('add')('/skills/example.md'),
			handler('change')('/skills/example.md'),
			handler('change')('/skills/example.md'),
		];
		expect(refresh).toHaveBeenCalledTimes(1);
		release?.();
		await Promise.all(events);

		// Then
		expect(refresh).toHaveBeenCalledTimes(2);
		await watcher.stop();
	});

	it('reports refresh failures without rejecting the event callback', async () => {
		// Given
		refresh.mockRejectedValue(new Error('refresh failed'));
		const watcher = new SkillWatcher(registry, logger);

		// When
		await expect(handler('change')('/skills/example.md')).resolves.toBeUndefined();

		// Then
		expect(logger.error).toHaveBeenCalledWith('Skill discovery refresh failed', {
			path: '/skills/example.md',
			error: 'refresh failed',
		});
		await watcher.stop();
	});

	it('joins a pending refresh and ignores events after stop begins', async () => {
		// Given
		let release: (() => void) | undefined;
		const gate = new Promise<number>((resolve) => {
			release = () => resolve(1);
		});
		refresh.mockImplementationOnce(() => gate);
		const watcher = new SkillWatcher(registry, logger);
		const event = handler('add')('/skills/example.md');

		// When
		let stopped = false;
		const stopping = watcher.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		await handler('change')('/skills/ignored.md');
		release?.();
		await Promise.all([event, stopping]);

		// Then
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(latestWatcher().close).toHaveBeenCalledTimes(1);
		await watcher.stop();
		expect(latestWatcher().close).toHaveBeenCalledTimes(1);
	});

	it('uses debug logging only when watcher verbosity is enabled', async () => {
		// Given
		process.env.TRACELATTICE_WATCHER_VERBOSE = 'true';
		const watcher = new SkillWatcher(registry, logger);

		// When
		await handler('add')('/skills/example.md');

		// Then
		expect(logger.debug).toHaveBeenCalledWith('[Watcher] Skill added: example.md');
		await watcher.stop();
	});

	it('ignores the unprefixed watcher verbosity setting', async () => {
		// Given
		process.env.WATCHER_VERBOSE = 'true';
		const watcher = new SkillWatcher(registry, logger);

		// When
		await handler('add')('/skills/example.md');

		// Then
		expect(logger.debug).not.toHaveBeenCalled();
		await watcher.stop();
	});
});

describeWatcherFaultRecovery({
	name: 'SkillWatcher',
	eventPath: '/skills/example.md',
	create(directories, onFault) {
		const registry = new SkillRegistry({ skillDirs: [] });
		const refresh = vi.spyOn(registry, 'refreshAsync').mockResolvedValue(0);
		const logger = createLogger();
		return { watcher: new SkillWatcher(registry, logger, directories, onFault), refresh, logger };
	},
});
