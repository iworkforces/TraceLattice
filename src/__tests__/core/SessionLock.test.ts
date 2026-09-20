/**
 * Tests for SessionLock — per-session async lock used to serialize
 * ThoughtProcessor.process() calls.
 */

import { asSessionId } from '../../contracts/ids.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionLock } from '../../core/SessionLock.js';
import { LockTimeoutError } from '../../core/SessionErrors.js';

describe('SessionLock', () => {
	let lock: SessionLock;

	beforeEach(() => {
		lock = new SessionLock();
	});

	describe('serialization', () => {
		it('reports session activity only while its lock chain exists', async () => {
			const sessionId = asSessionId('s1');
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			expect(lock.isActive(sessionId)).toBe(false);

			const operation = lock.withLock(sessionId, async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;

			expect(lock.isActive(sessionId)).toBe(true);
			expect(lock.isActive(asSessionId('s2'))).toBe(false);
			release.resolve();
			await operation;
			await Promise.resolve();
			expect(lock.isActive(sessionId)).toBe(false);
		});

		it('preserves FIFO order for ordinary same-session callers', async () => {
			const holderEntered = Promise.withResolvers<void>();
			const releaseHolder = Promise.withResolvers<void>();
			const events: string[] = [];

			const first = lock.withLock(asSessionId('s1'), async () => {
				events.push('first-enter');
				holderEntered.resolve();
				await releaseHolder.promise;
				events.push('first-exit');
			});
			const second = lock.withLock(asSessionId('s1'), async () => {
				events.push('second');
			});
			const third = lock.withLock(asSessionId('s1'), async () => {
				events.push('third');
			});

			await holderEntered.promise;
			expect(events).toEqual(['first-enter']);
			releaseHolder.resolve();
			await Promise.all([first, second, third]);
			expect(events).toEqual(['first-enter', 'first-exit', 'second', 'third']);
		});

		it('serializes 100 concurrent calls on the same session', async () => {
			const order: number[] = [];
			const inFlight = { value: 0, peak: 0 };

			const tasks = Array.from({ length: 100 }, (_, i) =>
				lock.withLock(asSessionId('s1'), async () => {
					inFlight.value++;
					inFlight.peak = Math.max(inFlight.peak, inFlight.value);
					await Promise.resolve();
					order.push(i);
					inFlight.value--;
				})
			);

			await Promise.all(tasks);

			expect(inFlight.peak).toBe(1); // only one critical section runs at a time
			expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i)); // FIFO
		});

		it('alternating mutate/clear operations never interleave', async () => {
			const events: string[] = [];

			const tasks: Promise<void>[] = [];
			for (let i = 0; i < 20; i++) {
				const operation = i % 2 === 0 ? 'add' : 'clear';
				tasks.push(
					lock.withLock(asSessionId('s1'), async () => {
						events.push(`${operation}-start-${i}`);
						await Promise.resolve();
						events.push(`${operation}-end-${i}`);
					})
				);
			}

			await Promise.all(tasks);

			// Every start must be immediately followed by its matching end.
			for (const [index, start] of events.filter((_, index) => index % 2 === 0).entries()) {
				expect(events[index * 2 + 1]).toBe(start.replace(/-start-/, '-end-'));
			}
		});
	});

	describe('per-session isolation', () => {
		it('different session ids do NOT block each other', async () => {
			const releaseA = Promise.withResolvers<void>();
			let bRan = false;
			const a = lock.withLock(asSessionId('session-a'), async () => {
				await releaseA.promise;
			});
			const b = lock.withLock(asSessionId('session-b'), async () => {
				bRan = true;
			});

			await b;
			expect(bRan).toBe(true);

			releaseA.resolve();
			await a;
		});
	});

	describe('timeout', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('throws LockTimeoutError when previous holder never releases', async () => {
			const releaseStuck = Promise.withResolvers<void>();
			const stuck = lock.withLock(asSessionId('s1'), () => releaseStuck.promise);

			const waiter = lock.withLock(asSessionId('s1'), async () => 'never', 1000);
			const timeoutAssertion = expect(waiter).rejects.toMatchObject({
				code: 'LOCK_TIMEOUT',
				sessionId: 's1',
				timeoutMs: 1000,
			});

			await vi.advanceTimersByTimeAsync(1001);
			await timeoutAssertion;

			// Cleanup: release the stuck handler so the promise settles.
			releaseStuck.resolve();
			await stuck;
			await vi.advanceTimersByTimeAsync(0);
			expect(lock.size).toBe(0);
		});

		it('keeps a later caller behind the active holder after a waiter times out', async () => {
			const holderEntered = Promise.withResolvers<void>();
			const releaseHolder = Promise.withResolvers<void>();
			const events: string[] = [];
			let active = 0;
			let peak = 0;

			const holder = lock.withLock(asSessionId('s1'), async () => {
				peak = Math.max(peak, ++active);
				events.push('A-enter');
				holderEntered.resolve();
				await releaseHolder.promise;
				events.push('A-exit');
				active--;
			});
			await holderEntered.promise;
			const timedOutCallback = vi.fn(async () => undefined);
			const waiter = lock.withLock(asSessionId('s1'), timedOutCallback, 10);
			const timeoutAssertion = expect(waiter).rejects.toBeInstanceOf(LockTimeoutError);

			await vi.advanceTimersByTimeAsync(10);
			await timeoutAssertion;
			const later = lock.withLock(asSessionId('s1'), async () => {
				peak = Math.max(peak, ++active);
				events.push('C-enter', 'C-exit');
				active--;
			});
			await vi.advanceTimersByTimeAsync(0);
			const peakBeforeRelease = peak;
			const eventsBeforeRelease = [...events];

			releaseHolder.resolve();
			await Promise.all([holder, later]);
			expect(peakBeforeRelease).toBe(1);
			expect(eventsBeforeRelease).toEqual(['A-enter']);
			expect(timedOutCallback).not.toHaveBeenCalled();
			expect(events).toEqual(['A-enter', 'A-exit', 'C-enter', 'C-exit']);
			await vi.advanceTimersByTimeAsync(0);
			expect(lock.size).toBe(0);
		});

		it('retains multiple timed-out waiters until the chain settles', async () => {
			const holderEntered = Promise.withResolvers<void>();
			const releaseHolder = Promise.withResolvers<void>();
			const events: string[] = [];
			let active = 0;
			let peak = 0;
			const holderCallback = vi.fn(async () => {
				peak = Math.max(peak, ++active);
				events.push('A-enter');
				holderEntered.resolve();
				await releaseHolder.promise;
				events.push('A-exit');
				active--;
			});
			const holder = lock.withLock(asSessionId('s1'), holderCallback);
			await holderEntered.promise;

			const timedOutCallbacks = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
			const waiters = timedOutCallbacks.map((callback) =>
				lock.withLock(asSessionId('s1'), callback, 10)
			);
			const timeoutAssertions = Promise.all(
				waiters.map((waiter) => expect(waiter).rejects.toBeInstanceOf(LockTimeoutError))
			);
			await vi.advanceTimersByTimeAsync(10);
			await timeoutAssertions;

			const laterCallback = vi.fn(async () => {
				peak = Math.max(peak, ++active);
				events.push('D-enter', 'D-exit');
				active--;
			});
			const later = lock.withLock(asSessionId('s1'), laterCallback);
			await vi.advanceTimersByTimeAsync(0);
			const eventsBeforeRelease = [...events];
			releaseHolder.resolve();
			await Promise.all([holder, later]);
			await vi.advanceTimersByTimeAsync(0);

			expect(eventsBeforeRelease).toEqual(['A-enter']);
			expect(peak).toBe(1);
			expect(timedOutCallbacks.every((callback) => callback.mock.calls.length === 0)).toBe(true);
			expect([holderCallback.mock.calls.length, laterCallback.mock.calls.length]).toEqual([1, 1]);
			expect(events).toEqual(['A-enter', 'A-exit', 'D-enter', 'D-exit']);
			expect(lock.size).toBe(0);
		});
	});

	describe('error handling', () => {
		it('runs a queued caller once after the first holder rejects', async () => {
			const firstCallback = vi.fn(async () => {
				throw new Error('first failed');
			});
			const secondCallback = vi.fn(async () => 'second-ok');
			const failing = lock.withLock(asSessionId('s1'), firstCallback);
			const ok = lock.withLock(asSessionId('s1'), secondCallback);

			await expect(failing).rejects.toThrow('first failed');
			await expect(ok).resolves.toBe('second-ok');
			expect(firstCallback).toHaveBeenCalledOnce();
			expect(secondCallback).toHaveBeenCalledOnce();
			await Promise.resolve();
			expect(lock.size).toBe(0);
		});
	});

	describe('memory hygiene', () => {
		it('purges the lock map after release', async () => {
			expect(lock.size).toBe(0);
			await lock.withLock(asSessionId('s1'), async () => {
				expect(lock.size).toBe(1);
			});
			// Allow microtasks to flush the deletion.
			await Promise.resolve();
			await Promise.resolve();
			expect(lock.size).toBe(0);
		});

		it('keeps map bounded under heavy churn across sessions', async () => {
			await Promise.all(
				Array.from({ length: 50 }, (_, i) =>
					lock.withLock(asSessionId(`s-${i}`), async () => {
						/* noop */
					})
				)
			);
			await Promise.resolve();
			await Promise.resolve();
			expect(lock.size).toBe(0);
		});
	});
});
