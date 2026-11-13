import { expect, it, vi } from 'vitest';
import { emitOn, latestWatcher, watchMock, watcherAt } from './chokidar-mock.js';
import { advanceTime, advanceTimeAsync } from './timers.js';
import {
	DIRS,
	NEVER_SETTLES,
	fault,
	startReady,
	type WatcherSubject,
} from './watcher-fault-harness.js';

export function describeRestart(subject: WatcherSubject): void {
	it('closes the failed instance and creates one replacement after the first backoff', () => {
		startReady(subject);

		fault();
		expect(watcherAt(0).close).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		advanceTime(999);
		expect(watchMock).toHaveBeenCalledOnce();
		advanceTime(1);

		expect(watchMock).toHaveBeenCalledTimes(2);
		expect(watchMock).toHaveBeenLastCalledWith(
			[...DIRS],
			expect.objectContaining({ ignoreInitial: true })
		);
		expect(vi.getTimerCount()).toBe(1);
	});

	it('restarts even when the failed instance never finishes closing', () => {
		startReady(subject);
		watcherAt(0).close.mockReturnValue(NEVER_SETTLES);

		fault();
		advanceTime(1000);

		expect(watchMock).toHaveBeenCalledTimes(2);
	});

	it('logs a rejected close of the failed instance and still restarts', async () => {
		const { logger } = startReady(subject);
		watcherAt(0).close.mockRejectedValue(new Error('close failed'));

		fault();
		await advanceTimeAsync(1000);

		expect(watchMock).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	it('refreshes once after the replacement reports ready', () => {
		const { refresh } = startReady(subject);

		fault();
		advanceTime(1000);
		expect(refresh).not.toHaveBeenCalled();
		emitOn(latestWatcher(), 'ready');
		emitOn(watcherAt(0), 'ready');

		expect(refresh).toHaveBeenCalledOnce();
	});

	it('ignores events from a retired instance', async () => {
		const { refresh } = startReady(subject);
		const retired = latestWatcher();
		fault();
		advanceTime(1000);

		await emitOn(retired, 'add', subject.eventPath);
		await emitOn(retired, 'change', subject.eventPath);
		await emitOn(retired, 'unlink', subject.eventPath);
		expect(refresh).not.toHaveBeenCalled();
		await emitOn(latestWatcher(), 'add', subject.eventPath);

		expect(refresh).toHaveBeenCalledOnce();
	});

	it('ignores readiness from a retired replacement', () => {
		const { refresh } = startReady(subject);
		fault();
		advanceTime(1000);
		fault();
		advanceTime(2000);

		emitOn(watcherAt(1), 'ready');
		expect(refresh).not.toHaveBeenCalled();
		fault();
		advanceTime(3999);
		expect(watchMock).toHaveBeenCalledTimes(3);
		advanceTime(1);

		expect(watchMock).toHaveBeenCalledTimes(4);
	});
}

export function describeBackoff(subject: WatcherSubject): void {
	it('serializes the recovery refresh with event refreshes', async () => {
		const { watcher, refresh } = startReady(subject);
		let active = 0;
		let maxActive = 0;
		const releases: Array<() => void> = [];
		refresh.mockImplementation(() => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			return new Promise<number>((done) => {
				releases.push(() => {
					active -= 1;
					done(0);
				});
			});
		});

		fault();
		advanceTime(1000);
		emitOn(latestWatcher(), 'ready');
		const event = emitOn(latestWatcher(), 'add', subject.eventPath);
		expect(releases).toHaveLength(1);
		releases[0]?.();
		await advanceTimeAsync(0);
		expect(releases).toHaveLength(2);
		releases[1]?.();
		await event;

		expect(maxActive).toBe(1);
		await watcher.stop();
	});

	it('backs off up to the cap without stacking timers or refreshes', () => {
		const onFault = vi.fn();
		const { refresh } = startReady(subject, onFault);
		const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

		delays.forEach((delay, index) => {
			fault();
			emitOn(watcherAt(index), 'error', new Error('duplicate from a retired instance'));
			expect(vi.getTimerCount()).toBe(1);
			expect(onFault).toHaveBeenCalledTimes(index + 1);
			advanceTime(delay - 1);
			expect(watchMock).toHaveBeenCalledTimes(index + 1);
			advanceTime(1);
			expect(watchMock).toHaveBeenCalledTimes(index + 2);
		});

		expect(refresh).not.toHaveBeenCalled();
	});

	it('resets the backoff after a replacement reports ready', () => {
		startReady(subject);

		fault();
		advanceTime(1000);
		fault();
		advanceTime(2000);
		emitOn(latestWatcher(), 'ready');
		fault();
		advanceTime(999);
		expect(watchMock).toHaveBeenCalledTimes(3);
		advanceTime(1);

		expect(watchMock).toHaveBeenCalledTimes(4);
	});
}

export function describeStop(subject: WatcherSubject): void {
	it('cancels a pending restart', async () => {
		const { watcher } = startReady(subject);
		fault();
		expect(vi.getTimerCount()).toBe(1);

		await watcher.stop();
		await advanceTimeAsync(60_000);

		expect(vi.getTimerCount()).toBe(0);
		expect(watchMock).toHaveBeenCalledOnce();
	});

	it('settles at the close bound when close never finishes', async () => {
		const { watcher } = startReady(subject);
		latestWatcher().close.mockReturnValue(NEVER_SETTLES);
		let stopped = false;
		const stopping = watcher.stop().then(() => {
			stopped = true;
		});

		await advanceTimeAsync(1999);
		expect(stopped).toBe(false);
		await advanceTimeAsync(1);
		await stopping;

		expect(stopped).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('joins an in-flight recovery refresh', async () => {
		const { watcher, refresh } = startReady(subject);
		const gate = Promise.withResolvers<number>();
		refresh.mockImplementationOnce(() => gate.promise);
		fault();
		advanceTime(1000);
		emitOn(latestWatcher(), 'ready');
		let stopped = false;

		const stopping = watcher.stop().then(() => {
			stopped = true;
		});
		await advanceTimeAsync(0);
		expect(stopped).toBe(false);
		gate.resolve(0);
		await stopping;

		expect(stopped).toBe(true);
	});

	it('creates nothing when a fault arrives after stop', async () => {
		const onFault = vi.fn();
		const { watcher } = startReady(subject, onFault);
		const live = latestWatcher();
		await watcher.stop();

		expect(() => emitOn(live, 'error', new Error('late'))).not.toThrow();
		await advanceTimeAsync(60_000);

		expect(onFault).not.toHaveBeenCalled();
		expect(watchMock).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears the ready timer and settles ready', async () => {
		const { watcher } = subject.create(DIRS);
		expect(vi.getTimerCount()).toBe(1);

		await watcher.stop();

		expect(vi.getTimerCount()).toBe(0);
		await expect(watcher.ready()).resolves.toBeUndefined();
	});
}
