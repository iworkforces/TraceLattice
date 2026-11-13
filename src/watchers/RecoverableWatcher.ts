import { watch, type FSWatcher, type ChokidarOptions } from 'chokidar';
import { resolve, sep } from 'node:path';
import { getErrorMessage } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';

const READY_TIMEOUT_MS = 5_000;
const STOP_CLOSE_TIMEOUT_MS = 2_000;
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;

const WATCH_OPTIONS: ChokidarOptions = {
	ignored: [/node_modules/, /\.DS_Store$/],
	persistent: true,
	ignoreInitial: true,
};

const WATCHED_EVENTS = ['add', 'change', 'unlink'] as const;

export type WatchedEvent = (typeof WATCHED_EVENTS)[number];

export type WatcherFaultHandler = (fault: { error: Error; directory: string }) => void;

export interface RecoverableWatcherConfig {
	readonly label: string;
	readonly directories: readonly string[];
	readonly logger: Logger;
	readonly onEvent: (event: WatchedEvent, path: string) => Promise<void>;
	readonly onRecovered: () => void;
	readonly onFault?: WatcherFaultHandler | undefined;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(getErrorMessage(value));
}

function faultDirectory(error: Error, directories: readonly string[]): string {
	if ('path' in error && typeof error.path === 'string') {
		const failing = resolve(error.path);
		const owner = directories.find((directory) => {
			const root = resolve(directory);
			return failing === root || failing.startsWith(root + sep);
		});
		if (owner !== undefined) return owner;
	}
	return directories[0] ?? '';
}

/**
 * Owns one chokidar instance at a time. A fault retires the instance and schedules a single
 * replacement with capped exponential backoff; events from retired instances are ignored.
 * A replacement that misses the ready bound is reported and refreshed but stays live: closing it
 * could hang, and a restart per backoff period would leak one chokidar instance each time.
 */
export class RecoverableWatcher {
	private _watcher: FSWatcher | null = null;
	private _restartTimer: ReturnType<typeof setTimeout> | undefined;
	private _readyTimer: ReturnType<typeof setTimeout> | undefined;
	private _replacementTimer: ReturnType<typeof setTimeout> | undefined;
	private _backoffMs = RESTART_BASE_DELAY_MS;
	private _stopPromise: Promise<void> | null = null;
	private readonly _readyPromise: Promise<void>;
	private readonly _resolveReady: () => void;

	constructor(private readonly _config: RecoverableWatcherConfig) {
		const ready = Promise.withResolvers<void>();
		this._readyPromise = ready.promise;
		this._resolveReady = ready.resolve;
		if (_config.directories.length === 0) {
			this._resolveReady();
			return;
		}
		this._readyTimer = setTimeout(() => this._degradeReady(), READY_TIMEOUT_MS);
		this._open(false);
	}

	/** Settles once, on first readiness or at the fixed bound; never rejects. */
	public ready(): Promise<void> {
		return this._readyPromise;
	}

	/** Cancels pending timers and closes the live instance within a bounded wait. */
	public stop(): Promise<void> {
		if (this._stopPromise) return this._stopPromise;
		clearTimeout(this._restartTimer);
		this._restartTimer = undefined;
		this._clearReplacementTimer();
		this._settleReady();
		const watcher = this._watcher;
		this._watcher = null;
		this._stopPromise = watcher ? this._closeWithinBound(watcher) : Promise.resolve();
		return this._stopPromise;
	}

	private _open(replacement: boolean): void {
		let watcher: FSWatcher;
		try {
			watcher = watch([...this._config.directories], WATCH_OPTIONS);
		} catch (error) {
			this._fault(toError(error));
			return;
		}
		this._watcher = watcher;
		for (const event of WATCHED_EVENTS) {
			watcher.on(event, (path) => this._dispatch(watcher, event, path));
		}
		watcher.on('error', (error) => this._onError(watcher, error));
		watcher.on('ready', () => this._onReady(watcher, replacement));
		if (replacement) {
			this._replacementTimer = setTimeout(
				() => this._onReplacementBound(watcher),
				READY_TIMEOUT_MS
			);
		}
	}

	private _isLive(watcher: FSWatcher): boolean {
		return this._watcher === watcher;
	}

	private _dispatch(watcher: FSWatcher, event: WatchedEvent, path: string): Promise<void> {
		if (!this._isLive(watcher)) return Promise.resolve();
		return this._config.onEvent(event, path);
	}

	private _onReady(watcher: FSWatcher, replacement: boolean): void {
		if (!this._isLive(watcher)) return;
		this._settleReady();
		if (!replacement) return;
		this._clearReplacementTimer();
		this._backoffMs = RESTART_BASE_DELAY_MS;
		this._config.onRecovered();
	}

	private _onReplacementBound(watcher: FSWatcher): void {
		if (!this._isLive(watcher)) return;
		this._replacementTimer = undefined;
		const { label, directories, logger } = this._config;
		logger.warn(`${label} replacement watcher not ready; continuing degraded`, {
			timeoutMs: READY_TIMEOUT_MS,
			directories,
		});
		// Schedule the refresh first so a fault listener that stops the watcher joins it.
		this._config.onRecovered();
		this._notify({
			error: new Error(`${label} watcher replacement not ready within ${READY_TIMEOUT_MS} ms`),
			directory: directories[0] ?? '',
		});
	}

	private _clearReplacementTimer(): void {
		clearTimeout(this._replacementTimer);
		this._replacementTimer = undefined;
	}

	private _onError(watcher: FSWatcher, error: unknown): void {
		if (this._isLive(watcher)) this._fault(toError(error));
	}

	// Only the live instance or a failed open reaches here, so no restart timer can be pending.
	private _fault(error: Error): void {
		const { label, directories, logger } = this._config;
		this._clearReplacementTimer();
		const delay = this._backoffMs;
		const directory = faultDirectory(error, directories);
		logger.warn(`${label} watcher fault; restarting`, {
			directory,
			error: error.message,
			restartInMs: delay,
		});
		this._notify({ error, directory });
		this._retire();
		this._backoffMs = Math.min(delay * 2, RESTART_MAX_DELAY_MS);
		this._restartTimer = setTimeout(() => {
			this._restartTimer = undefined;
			this._open(true);
		}, delay);
	}

	private _notify(fault: { error: Error; directory: string }): void {
		try {
			this._config.onFault?.(fault);
		} catch (error) {
			this._config.logger.error(`${this._config.label} watcher fault handler failed`, {
				error: getErrorMessage(error),
			});
		}
	}

	private _retire(): void {
		const watcher = this._watcher;
		this._watcher = null;
		if (watcher) void this._closeQuietly(watcher);
	}

	private async _closeQuietly(watcher: FSWatcher): Promise<void> {
		try {
			await watcher.close();
		} catch (error) {
			this._config.logger.warn(`${this._config.label} watcher close failed`, {
				error: getErrorMessage(error),
			});
		}
	}

	private async _closeWithinBound(watcher: FSWatcher): Promise<void> {
		const bound = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this._config.logger.warn(`${this._config.label} watcher close timed out`, {
				timeoutMs: STOP_CLOSE_TIMEOUT_MS,
			});
			bound.resolve();
		}, STOP_CLOSE_TIMEOUT_MS);
		try {
			await Promise.race([watcher.close(), bound.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	private _degradeReady(): void {
		this._readyTimer = undefined;
		this._config.logger.warn(`${this._config.label} watcher not ready; continuing degraded`, {
			timeoutMs: READY_TIMEOUT_MS,
			directories: this._config.directories,
		});
		this._resolveReady();
	}

	private _settleReady(): void {
		clearTimeout(this._readyTimer);
		this._readyTimer = undefined;
		this._resolveReady();
	}
}
