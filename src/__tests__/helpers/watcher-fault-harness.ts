import type { MockInstance } from 'vitest';
import type { Logger } from '../../logger/StructuredLogger.js';
import type { WatcherFaultHandler } from '../../watchers/RecoverableWatcher.js';
import { emitOn, latestWatcher } from './chokidar-mock.js';

export interface WatcherHarness {
	readonly watcher: { ready(): Promise<void>; stop(): Promise<void> };
	readonly refresh: MockInstance<() => Promise<number>>;
	readonly logger: Logger;
}

export interface WatcherSubject {
	readonly name: string;
	readonly eventPath: string;
	create(directories: readonly string[], onFault?: WatcherFaultHandler): WatcherHarness;
}

export const DIRS = ['./watched/one/', 'watched/two'] as const;
export const NEVER_SETTLES = new Promise<void>(() => {});

export function fault(error: unknown = new Error('EACCES')): void {
	emitOn(latestWatcher(), 'error', error);
}

export function startReady(subject: WatcherSubject, onFault?: WatcherFaultHandler): WatcherHarness {
	const harness = subject.create(DIRS, onFault);
	emitOn(latestWatcher(), 'ready');
	return harness;
}

export function errorAt(path: string | undefined): Error {
	return path === undefined ? new Error('fault') : Object.assign(new Error('fault'), { path });
}
