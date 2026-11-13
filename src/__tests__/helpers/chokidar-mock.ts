import type { FSWatcher } from 'chokidar';
import { vi } from 'vitest';

export type WatcherListener = (...args: unknown[]) => Promise<void> | void;

export interface FakeWatcher {
	readonly on: ReturnType<typeof vi.fn>;
	readonly close: ReturnType<typeof vi.fn>;
	readonly handlers: Map<string, WatcherListener>;
}

/** Every instance created through the mocked `watch()`, oldest first. */
export const fakeWatchers: FakeWatcher[] = [];

let readyOnRegistration = false;

/** When true, a registered `ready` listener fires on the next microtask. */
export function setReadyOnRegistration(enabled: boolean): void {
	readyOnRegistration = enabled;
}

function createFakeWatcher(): FakeWatcher {
	const handlers = new Map<string, WatcherListener>();
	const watcher: FakeWatcher = {
		handlers,
		on: vi.fn((event: string, handler: WatcherListener) => {
			handlers.set(event, handler);
			if (event === 'ready' && readyOnRegistration) queueMicrotask(() => handler());
			return watcher;
		}),
		close: vi.fn().mockResolvedValue(undefined),
	};
	return watcher;
}

export const watchMock = vi.fn((): FSWatcher => {
	const watcher = createFakeWatcher();
	fakeWatchers.push(watcher);
	return watcher as unknown as FSWatcher;
});

export function resetChokidarMock(): void {
	fakeWatchers.length = 0;
	readyOnRegistration = false;
	watchMock.mockReset();
}

export function latestWatcher(): FakeWatcher {
	const watcher = fakeWatchers.at(-1);
	if (!watcher) throw new Error('No watcher was created');
	return watcher;
}

/** Invokes the listener the code under test registered on one fake instance. */
export function emitOn(
	watcher: FakeWatcher,
	event: string,
	...args: unknown[]
): Promise<void> | void {
	const listener = watcher.handlers.get(event);
	if (!listener) throw new Error(`Missing ${event} handler`);
	return listener(...args);
}
