import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSessionId } from '../../contracts/ids.js';
import { createTestThought } from '../helpers/factories.js';
import {
	expire,
	expiredId,
	expiryHarness,
	owned,
	responseBody,
	seed,
} from './SessionExpiryHarness.js';

describe('eviction ownership and admission', () => {
	let harness: ReturnType<typeof expiryHarness>;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		harness = expiryHarness({ maxSessionsPerOwner: 2 });
	});
	afterEach(async () => {
		await harness.history.shutdown();
		vi.useRealTimers();
	});

	it.each([
		{ cause: 'TTL', verification: false },
		{ cause: 'TTL', verification: true },
		{ cause: 'owner capacity', verification: false },
		{ cause: 'owner capacity', verification: true },
		{ cause: 'global capacity', verification: false },
		{ cause: 'global capacity', verification: true },
	])(
		'rejects continuation after $cause eviction with result-bearing verification=$verification',
		async ({ cause, verification }) => {
			owned('alice', () => seed(harness.history));
			if (cause === 'TTL') await expire(harness.history);
			if (cause === 'owner capacity') {
				owned('alice', () => {
					seed(harness.history, asSessionId('second'));
					seed(harness.history, asSessionId('third'));
				});
			}
			if (cause === 'global capacity') {
				for (let index = 0; index < 100; index++)
					seed(harness.history, asSessionId(`global-${index}`));
			}
			expect(harness.history.getSessionIds()).not.toContain(expiredId);
			const result = await owned('alice', () =>
				harness.processor.process(
					createTestThought({
						session_id: expiredId,
						thought_number: 9,
						total_thoughts: 20,
						...(verification
							? { thought_type: 'verification', verification_target: 3, verification_result: 1 }
							: {}),
					})
				)
			);
			expect(responseBody(result)).toMatchObject({ code: 'SESSION_EXPIRED' });
		}
	);

	it.each(['read', 'inspect', 'identity', 'reset', 'reset_state'])(
		'denies a foreign owner before expired %s',
		async (action) => {
			owned('alice', () => seed(harness.history));
			await expire(harness.history);
			if (action === 'read')
				expect(() => owned('bob', () => harness.history.getHistory(expiredId))).toThrowError(
					expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
				);
			if (action === 'inspect')
				expect(() => owned('bob', () => harness.history.inspectSession(expiredId))).toThrowError(
					expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
				);
			if (action === 'identity')
				expect(() =>
					owned('bob', () =>
						harness.history.assertThoughtIdentityAvailable(
							createTestThought({ session_id: expiredId })
						)
					)
				).toThrowError(expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' }));
			if (action === 'reset')
				await expect(
					owned('bob', () => harness.processor.resetSession(expiredId))
				).rejects.toMatchObject({ code: 'SESSION_ACCESS_DENIED' });
			if (action === 'reset_state')
				expect(
					responseBody(
						await owned('bob', () =>
							harness.processor.process(
								createTestThought({ session_id: expiredId, reset_state: true })
							)
						)
					)
				).toMatchObject({ code: 'SESSION_ACCESS_DENIED' });
			expect(harness.history.getSessionCount()).toBe(0);
		}
	);

	it.each(['alice', 'trusted'])(
		'preserves the former owner on %s explicit reset',
		async (authority) => {
			owned('alice', () => seed(harness.history));
			await expire(harness.history);
			if (authority === 'alice')
				await owned('alice', () => harness.processor.resetSession(expiredId));
			else await harness.processor.resetSession(expiredId);
			expect(() => owned('bob', () => harness.history.getHistory(expiredId))).toThrowError(
				expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
			);
			expect(owned('alice', () => harness.history.getHistory(expiredId))).toEqual([]);
		}
	);

	it.each(['history', 'processor'])(
		'binds the caller when %s resets a previously ownerless expired session',
		async (entry) => {
			seed(harness.history);
			await expire(harness.history);
			await owned('alice', () =>
				entry === 'history'
					? harness.history.resetSession(expiredId)
					: harness.processor.resetSession(expiredId)
			);
			expect(() => owned('bob', () => harness.history.inspectSession(expiredId))).toThrowError(
				expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
			);
			expect(owned('alice', () => harness.history.getHistory(expiredId))).toEqual([]);
		}
	);

	it('plans a previously ownerless expired reset under the caller owner quota', async () => {
		seed(harness.history);
		await expire(harness.history);
		owned('alice', () => {
			seed(harness.history, asSessionId('live-one'));
			seed(harness.history, asSessionId('live-two'));
		});
		await owned('alice', () => harness.history.resetSession(expiredId));
		expect(harness.history.getSessionCount()).toBe(2);
		expect(owned('alice', () => harness.history.getHistory(expiredId))).toEqual([]);
	});

	it('keeps old markers through further TTL and capacity churn', async () => {
		seed(harness.history);
		await expire(harness.history);
		for (let index = 0; index < 205; index++) seed(harness.history, asSessionId(`churn-${index}`));
		await vi.advanceTimersByTimeAsync(35 * 60_000 + 1);
		expect(() => harness.history.inspectSession(expiredId)).toThrowError(
			expect.objectContaining({ code: 'SESSION_EXPIRED' })
		);
	});

	it('clears only its own marker on scoped reset', async () => {
		seed(harness.history);
		seed(harness.history, asSessionId('other'));
		await expire(harness.history);
		await harness.processor.resetSession(expiredId);
		expect(harness.history.getHistory(expiredId)).toEqual([]);
		expect(() => harness.history.inspectSession('other')).toThrowError(
			expect.objectContaining({ code: 'SESSION_EXPIRED' })
		);
	});

	it.each(['expired', 'absent'])(
		'enforces owner capacity when resetting an %s session',
		async (scope) => {
			owned('alice', () => seed(harness.history));
			await expire(harness.history);
			owned('alice', () => {
				seed(harness.history, asSessionId('live-one'));
				seed(harness.history, asSessionId('live-two'));
			});
			const target = scope === 'expired' ? expiredId : asSessionId('absent');
			await owned('alice', () => harness.processor.resetSession(target));
			expect(harness.history.getSessionCount()).toBe(2);
			expect(owned('alice', () => harness.history.getHistory(target))).toEqual([]);
		}
	);

	it('enforces global capacity when resetting an absent session', async () => {
		for (let index = 0; index < 100; index++) seed(harness.history, asSessionId(`live-${index}`));
		await harness.processor.resetSession('absent');
		expect(harness.history.getSessionCount()).toBe(100);
	});
});
