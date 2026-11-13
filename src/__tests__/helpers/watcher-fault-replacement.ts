import { expect, it, vi } from 'vitest';
import type { WatcherFaultHandler } from '../../watchers/RecoverableWatcher.js';
import { emitOn, latestWatcher, watchMock, watcherAt } from './chokidar-mock.js';
import { advanceTime, advanceTimeAsync } from './timers.js';
import {
	DIRS,
	fault,
	startReady,
	type WatcherHarness,
	type WatcherSubject,
} from './watcher-fault-harness.js';

const READY_BOUND_MS = 5000;
const FIRST_BACKOFF_MS = 1000;
const SECOND_BACKOFF_MS = 2000;
const LONG_WAIT_MS = 120_000;

/** A watcher whose first instance faulted and whose replacement never reports ready. */
function startHungReplacement(
	subject: WatcherSubject,
	onFault?: WatcherFaultHandler
): WatcherHarness {
	const harness = startReady(subject, onFault);
	fault();
	advanceTime(FIRST_BACKOFF_MS);
	return harness;
}

export function describeReplacementBound(subject: WatcherSubject): void {
	it('degrades a replacement that never reports ready and keeps it live', async () => {
		const onFault = vi.fn<WatcherFaultHandler>();
		const { refresh, logger } = startHungReplacement(subject, onFault);
		expect(watchMock).toHaveBeenCalledTimes(2);

		await advanceTimeAsync(READY_BOUND_MS - 1);
		expect(onFault).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
		await advanceTimeAsync(1);

		expect(onFault).toHaveBeenCalledTimes(2);
		const reported = onFault.mock.calls[1]?.[0];
		expect(reported?.directory).toBe(DIRS[0]);
		expect(reported?.error.constructor).toBe(Error);
		expect(refresh).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(watcherAt(1).close).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await advanceTimeAsync(LONG_WAIT_MS);
		expect(watchMock).toHaveBeenCalledTimes(2);
		expect(onFault).toHaveBeenCalledTimes(2);
		await emitOn(latestWatcher(), 'add', subject.eventPath);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('resets the backoff and refreshes again when the degraded replacement is ready late', async () => {
		const { refresh } = startHungReplacement(subject);
		await advanceTimeAsync(READY_BOUND_MS);
		expect(refresh).toHaveBeenCalledOnce();

		emitOn(latestWatcher(), 'ready');
		await advanceTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(2);
		fault();
		await advanceTimeAsync(FIRST_BACKOFF_MS - 1);
		expect(watchMock).toHaveBeenCalledTimes(2);
		await advanceTimeAsync(1);

		expect(watchMock).toHaveBeenCalledTimes(3);
	});

	it('never overlaps the bound refresh with the late-ready refresh', async () => {
		const gate = Promise.withResolvers<number>();
		const { refresh } = startHungReplacement(subject);
		refresh.mockImplementationOnce(() => gate.promise);
		await advanceTimeAsync(READY_BOUND_MS);

		emitOn(latestWatcher(), 'ready');
		expect(refresh).toHaveBeenCalledOnce();
		gate.resolve(0);
		await advanceTimeAsync(0);

		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('retires a degraded replacement on error and restarts at the current backoff', async () => {
		const onFault = vi.fn();
		const { refresh } = startHungReplacement(subject, onFault);
		await advanceTimeAsync(READY_BOUND_MS);

		fault();
		expect(watcherAt(1).close).toHaveBeenCalledOnce();
		expect(onFault).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(1);
		await advanceTimeAsync(SECOND_BACKOFF_MS - 1);
		expect(watchMock).toHaveBeenCalledTimes(2);
		await advanceTimeAsync(1);

		expect(watchMock).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(1);
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('clears the bound when the replacement reports ready first', async () => {
		const onFault = vi.fn();
		const { refresh } = startHungReplacement(subject, onFault);
		expect(vi.getTimerCount()).toBe(1);

		emitOn(latestWatcher(), 'ready');
		expect(vi.getTimerCount()).toBe(0);
		await advanceTimeAsync(LONG_WAIT_MS);

		expect(onFault).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('ignores the bound of a retired replacement', async () => {
		const onFault = vi.fn();
		const { refresh } = startHungReplacement(subject, onFault);

		fault();
		expect(vi.getTimerCount()).toBe(1);
		await advanceTimeAsync(READY_BOUND_MS);

		expect(onFault).toHaveBeenCalledTimes(2);
		expect(refresh).not.toHaveBeenCalled();
		expect(watchMock).toHaveBeenCalledTimes(3);
	});

	it('leaves no timer when stop arrives before the bound', async () => {
		const onFault = vi.fn();
		const { watcher, refresh } = startHungReplacement(subject, onFault);

		await watcher.stop();
		expect(vi.getTimerCount()).toBe(0);
		await advanceTimeAsync(LONG_WAIT_MS);

		expect(onFault).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
	});

	it('contains a fault handler that throws at the bound', async () => {
		const onFault = vi.fn<WatcherFaultHandler>();
		const { refresh, logger } = startHungReplacement(subject, onFault);
		onFault.mockImplementation(() => {
			throw new Error('listener failed');
		});

		await advanceTimeAsync(READY_BOUND_MS);

		expect(logger.error).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		await emitOn(latestWatcher(), 'add', subject.eventPath);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('reports no fault and runs no refresh when the first instance degrades', async () => {
		const onFault = vi.fn();
		const { refresh } = subject.create(DIRS, onFault);

		await advanceTimeAsync(READY_BOUND_MS);
		await advanceTimeAsync(LONG_WAIT_MS);

		expect(onFault).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});
}
