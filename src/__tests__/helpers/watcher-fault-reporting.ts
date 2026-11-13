import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { WatcherFaultHandler } from '../../watchers/RecoverableWatcher.js';
import { emitOn, latestWatcher, watchMock } from './chokidar-mock.js';
import { advanceTime, advanceTimeAsync } from './timers.js';
import {
	DIRS,
	errorAt,
	fault,
	instance,
	startReady,
	type WatcherSubject,
} from './watcher-fault-harness.js';

export function describeFaultHandling(subject: WatcherSubject): void {
	it('handles an error event without throwing and reports it once', () => {
		const onFault = vi.fn();
		const { logger } = startReady(subject, onFault);
		const error = errorAt(resolve('watched/two/deep/file.md'));

		expect(() => fault(error)).not.toThrow();

		expect(onFault).toHaveBeenCalledOnce();
		expect(onFault).toHaveBeenCalledWith({ error, directory: 'watched/two' });
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it.each([
		['a path inside the first root', resolve('watched/one/f.md'), './watched/one/'],
		['a path inside the second root', resolve('watched/two/a/b.md'), 'watched/two'],
		['the root itself', resolve('watched/two'), 'watched/two'],
		['a sibling sharing only a name prefix', resolve('watched/twofold/f.md'), './watched/one/'],
		['a path outside every root', resolve('elsewhere/f.md'), './watched/one/'],
		['no path', undefined, './watched/one/'],
	])('reports the configured root for %s', (_name, path, directory) => {
		const onFault = vi.fn();
		startReady(subject, onFault);
		const error = errorAt(path);

		fault(error);

		expect(onFault).toHaveBeenCalledWith({ error, directory });
	});

	it('wraps a non-Error payload in an Error', () => {
		const onFault = vi.fn<WatcherFaultHandler>();
		startReady(subject, onFault);

		fault('plain failure');

		const reported = onFault.mock.calls[0]?.[0];
		expect(reported?.error).toBeInstanceOf(Error);
		expect(reported?.error.message).toBe('plain failure');
	});

	it('keeps recovering when the fault callback throws', () => {
		const onFault = vi.fn(() => {
			throw new Error('listener failed');
		});
		const { logger } = startReady(subject, onFault);

		expect(() => fault()).not.toThrow();
		advanceTime(1000);

		expect(logger.error).toHaveBeenCalledOnce();
		expect(watchMock).toHaveBeenCalledTimes(2);
	});

	it('treats a synchronous watch() throw as a fault and keeps backing off', async () => {
		const onFault = vi.fn();
		watchMock.mockImplementationOnce(() => {
			throw new Error('EMFILE');
		});
		watchMock.mockImplementationOnce(() => {
			throw new Error('EMFILE again');
		});
		const { watcher, refresh } = subject.create(DIRS, onFault);

		expect(onFault).toHaveBeenCalledOnce();
		expect(onFault).toHaveBeenCalledWith({
			error: expect.objectContaining({ message: 'EMFILE' }),
			directory: './watched/one/',
		});
		advanceTime(1000);
		expect(onFault).toHaveBeenCalledTimes(2);
		advanceTime(1999);
		expect(watchMock).toHaveBeenCalledTimes(2);
		advanceTime(1);
		expect(watchMock).toHaveBeenCalledTimes(3);
		emitOn(latestWatcher(), 'ready');

		await expect(watcher.ready()).resolves.toBeUndefined();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('creates no watcher and no timer without directories', async () => {
		const { watcher } = subject.create([]);

		await expect(watcher.ready()).resolves.toBeUndefined();
		await watcher.stop();

		expect(watchMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
}

export function describeReady(subject: WatcherSubject): void {
	it('resolves ready degraded at the fixed bound without restarting', async () => {
		const { watcher, logger } = subject.create(DIRS);
		let settled = false;
		const readiness = watcher.ready().then(() => {
			settled = true;
		});

		await advanceTimeAsync(4999);
		expect(settled).toBe(false);
		await advanceTimeAsync(1);
		await readiness;
		await advanceTimeAsync(120_000);

		expect(logger.warn).toHaveBeenCalledOnce();
		expect(watchMock).toHaveBeenCalledOnce();
		expect(instance(0).close).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears the ready timer when readiness arrives first', async () => {
		const { watcher, logger } = subject.create(DIRS);
		expect(vi.getTimerCount()).toBe(1);

		emitOn(latestWatcher(), 'ready');
		await watcher.ready();
		await advanceTimeAsync(10_000);

		expect(vi.getTimerCount()).toBe(0);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('keeps the constructor-time ready promise across a restart', async () => {
		const { watcher } = subject.create(DIRS);
		const first = watcher.ready();

		fault();
		advanceTime(1000);
		emitOn(latestWatcher(), 'ready');

		expect(watcher.ready()).toBe(first);
		await expect(first).resolves.toBeUndefined();
	});
}
