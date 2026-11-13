import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import { RecoverableWatcher, type WatcherFaultHandler } from './RecoverableWatcher.js';

/** Watches tool discovery directories and serializes registry refreshes. */
export class ToolWatcher {
	private readonly _logger: Logger;
	private readonly _recoverable: RecoverableWatcher;
	private _pendingRefresh: Promise<void> | null = null;
	private _refreshQueued = false;
	private _stopPromise: Promise<void> | null = null;

	constructor(
		private readonly _toolRegistry: ToolRegistry,
		logger?: Logger,
		watchDirs: readonly string[] = ['.claude/tools', join(homedir(), '.claude/tools')],
		onFault?: WatcherFaultHandler
	) {
		this._logger = logger ?? this._createNoopLogger();
		this._recoverable = new RecoverableWatcher({
			label: 'Tool',
			directories: watchDirs,
			logger: this._logger,
			onEvent: (_event, path) => this._handleEvent(path),
			onRecovered: () => void this._scheduleRefresh('(watcher restarted)'),
			onFault,
		});
	}

	private _createNoopLogger(): Logger {
		return {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			setLevel: () => {},
			getLevel: () => 'info',
		};
	}

	private _handleEvent(path: string): Promise<void> {
		if (!path.endsWith('.tool.md')) return Promise.resolve();
		return this._scheduleRefresh(path);
	}

	private _scheduleRefresh(path: string): Promise<void> {
		this._refreshQueued = true;
		if (!this._pendingRefresh) {
			this._pendingRefresh = this._drainRefreshes(path).finally(() => {
				this._pendingRefresh = null;
			});
		}
		return this._pendingRefresh;
	}

	private async _drainRefreshes(path: string): Promise<void> {
		while (this._refreshQueued) {
			this._refreshQueued = false;
			try {
				await this._toolRegistry.refreshAsync();
			} catch (error) {
				this._logger.error('Tool discovery refresh failed', {
					path,
					error: getErrorMessage(error),
				});
			}
		}
	}

	/** Resolves when Chokidar is ready, or degraded after a fixed bound; never rejects. */
	public ready(): Promise<void> {
		return this._recoverable.ready();
	}

	/** Cancels pending restarts, closes Chokidar within a bound, and joins any accepted refresh. */
	public stop(): Promise<void> {
		if (this._stopPromise) return this._stopPromise;
		const closing = this._recoverable.stop();
		const pendingRefresh = this._pendingRefresh;
		this._stopPromise = Promise.all([closing, pendingRefresh]).then(() => undefined);
		return this._stopPromise;
	}
}
