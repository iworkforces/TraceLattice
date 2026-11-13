import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { SkillRegistry } from '../registry/SkillRegistry.js';
import {
	RecoverableWatcher,
	type WatchedEvent,
	type WatcherFaultHandler,
} from './RecoverableWatcher.js';

const EVENT_ACTIONS: Record<WatchedEvent, string> = {
	add: 'added',
	change: 'modified',
	unlink: 'removed',
};

/** Watches skill discovery directories and serializes registry refreshes. */
export class SkillWatcher {
	private readonly _logger: Logger;
	private readonly _recoverable: RecoverableWatcher;
	private _pendingRefresh: Promise<void> | null = null;
	private _refreshQueued = false;
	private _stopPromise: Promise<void> | null = null;

	constructor(
		private readonly _skillRegistry: SkillRegistry,
		logger?: Logger,
		watchDirs: readonly string[] = ['.claude/skills', join(homedir(), '.claude/skills')],
		onFault?: WatcherFaultHandler
	) {
		this._logger = logger ?? this._createNoopLogger();
		this._recoverable = new RecoverableWatcher({
			label: 'Skill',
			directories: watchDirs,
			logger: this._logger,
			onEvent: (event, path) => this._handleEvent(event, path),
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

	private _handleEvent(event: WatchedEvent, path: string): Promise<void> {
		if (!path.includes('.DS_Store')) {
			this._log(`Skill ${EVENT_ACTIONS[event]}: ${path.split(/[/\\]/).pop()}`);
		}
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
				await this._skillRegistry.refreshAsync();
			} catch (error) {
				this._logger.error('Skill discovery refresh failed', {
					path,
					error: getErrorMessage(error),
				});
			}
		}
	}

	private _log(message: string): void {
		if (process.env.TRACELATTICE_WATCHER_VERBOSE === 'true') {
			this._logger.debug(`[Watcher] ${message}`);
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
