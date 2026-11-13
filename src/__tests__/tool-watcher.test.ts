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
import { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolWatcher } from '../watchers/ToolWatcher.js';

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

describe('ToolWatcher', () => {
	let registry: ToolRegistry;
	let logger: Logger;
	let refresh: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		resetChokidarMock();
		registry = new ToolRegistry({ toolDirs: [] });
		refresh = vi.spyOn(registry, 'refreshAsync').mockResolvedValue(0);
		logger = createLogger();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('watches default directories and all reconciliation events', async () => {
		// Given/When
		const watcher = new ToolWatcher(registry, logger);

		// Then
		expect(watch).toHaveBeenCalledWith(
			['.claude/tools', '/mock/home/.claude/tools'],
			expect.objectContaining({ persistent: true })
		);
		expect(latestWatcher().on).toHaveBeenCalledWith('add', expect.any(Function));
		expect(latestWatcher().on).toHaveBeenCalledWith('change', expect.any(Function));
		expect(latestWatcher().on).toHaveBeenCalledWith('unlink', expect.any(Function));
		await watcher.stop();
	});

	it('resolves ready after Chokidar signals readiness', async () => {
		// Given
		const watcher = new ToolWatcher(registry, logger);
		const readiness = watcher.ready();

		// When
		handler('ready')('');

		// Then
		await expect(readiness).resolves.toBeUndefined();
		await watcher.stop();
	});

	it.each(['add', 'change', 'unlink'])('refreshes the registry on tool %s', async (event) => {
		// Given
		const watcher = new ToolWatcher(registry, logger);

		// When
		await handler(event)('/tools/example.tool.md');

		// Then
		expect(refresh).toHaveBeenCalledTimes(1);
		await watcher.stop();
	});

	it.each(['add', 'change', 'unlink'])('ignores non-tool %s events', async (event) => {
		// Given
		const watcher = new ToolWatcher(registry, logger);

		// When
		await handler(event)('/tools/readme.md');

		// Then
		expect(refresh).not.toHaveBeenCalled();
		await watcher.stop();
	});

	it('coalesces duplicate events while preserving one trailing refresh', async () => {
		// Given
		let release: (() => void) | undefined;
		const gate = new Promise<number>((resolve) => {
			release = () => resolve(1);
		});
		refresh.mockImplementationOnce(() => gate).mockResolvedValue(1);
		const watcher = new ToolWatcher(registry, logger);

		// When
		const events = [
			handler('add')('/tools/example.tool.md'),
			handler('change')('/tools/example.tool.md'),
			handler('change')('/tools/example.tool.md'),
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
		refresh.mockRejectedValue('refresh failed');
		const watcher = new ToolWatcher(registry, logger);

		// When
		await expect(handler('add')('/tools/example.tool.md')).resolves.toBeUndefined();

		// Then
		expect(logger.error).toHaveBeenCalledWith('Tool discovery refresh failed', {
			path: '/tools/example.tool.md',
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
		const watcher = new ToolWatcher(registry, logger);
		const event = handler('add')('/tools/example.tool.md');

		// When
		let stopped = false;
		const stopping = watcher.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		await handler('unlink')('/tools/ignored.tool.md');
		release?.();
		await Promise.all([event, stopping]);

		// Then
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(latestWatcher().close).toHaveBeenCalledTimes(1);
		await watcher.stop();
		expect(latestWatcher().close).toHaveBeenCalledTimes(1);
	});
});

describeWatcherFaultRecovery({
	name: 'ToolWatcher',
	eventPath: '/tools/example.tool.md',
	create(directories, onFault) {
		const registry = new ToolRegistry({ toolDirs: [] });
		const refresh = vi.spyOn(registry, 'refreshAsync').mockResolvedValue(0);
		const logger = createLogger();
		return { watcher: new ToolWatcher(registry, logger, directories, onFault), refresh, logger };
	},
});
