import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asBranchId, asSessionId } from '../../contracts/ids.js';
import { createTestThought } from '../helpers/factories.js';
import { expire, expiredId, expiryHarness, responseBody, seed } from './SessionExpiryHarness.js';

describe('expired session scope', () => {
	let harness: ReturnType<typeof expiryHarness>;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		harness = expiryHarness();
	});
	afterEach(async () => {
		await harness.history.shutdown();
		vi.useRealTimers();
	});

	it.each([
		['history', () => harness.history.getHistory(expiredId)],
		['hydrated history', () => harness.history.getHistoryHydrated(expiredId)],
		['length', () => harness.history.getHistoryLength(expiredId)],
		['branches', () => harness.history.getBranches(expiredId)],
		['branch IDs', () => harness.history.getBranchIds(expiredId)],
		['tools', () => harness.history.getAvailableMcpTools(expiredId)],
		['skills', () => harness.history.getAvailableSkills(expiredId)],
		['inspect', () => harness.history.inspectSession(expiredId)],
		['reference', () => harness.history.resolveThoughtReference(expiredId, 3)],
		['branch', () => harness.history.getBranch(asBranchId('branch'), expiredId)],
		['branch existence', () => harness.history.branchExists(expiredId, asBranchId('branch'))],
		['add', () => seed(harness.history)],
		[
			'identity with ID',
			() =>
				harness.history.assertThoughtIdentityAvailable(
					createTestThought({ session_id: expiredId, id: 'fresh' })
				),
		],
		[
			'identity without ID',
			() =>
				harness.history.assertThoughtIdentityAvailable(
					createTestThought({ session_id: expiredId })
				),
		],
		['register branch', () => harness.history.registerBranch(expiredId, asBranchId('fresh'))],
		['summary buffering', () => harness.history.bufferSummaries(expiredId, [])],
	])('rejects direct %s after TTL eviction', async (_name, action) => {
		seed(harness.history);
		await expire(harness.history);
		expect(action).toThrowError(expect.objectContaining({ code: 'SESSION_EXPIRED' }));
	});

	it.each([false, true])(
		'rejects continuation with result-bearing verification=%s',
		async (verification) => {
			seed(harness.history);
			await expire(harness.history);
			const result = await harness.processor.process(
				createTestThought({
					session_id: expiredId,
					thought_number: 9,
					total_thoughts: 20,
					...(verification
						? { thought_type: 'verification', verification_target: 3, verification_result: 1 }
						: {}),
				})
			);
			expect(result.isError).toBe(true);
			expect(responseBody(result)).toMatchObject({ code: 'SESSION_EXPIRED' });
		}
	);

	it('admits a never-created session with noncontiguous and duplicate numbers', async () => {
		const first = await harness.processor.process(
			createTestThought({ session_id: 'new', id: 'first', thought_number: 7, total_thoughts: 20 })
		);
		const second = await harness.processor.process(
			createTestThought({ session_id: 'new', id: 'second', thought_number: 7, total_thoughts: 20 })
		);
		expect(first.isError).not.toBe(true);
		expect(second.isError).not.toBe(true);
		expect(harness.history.resolveThoughtReference(asSessionId('new'), 7)).toMatchObject({
			kind: 'ambiguous',
		});
		const ambiguous = await harness.processor.process(
			createTestThought({
				session_id: 'new',
				thought_number: 12,
				total_thoughts: 20,
				thought_type: 'verification',
				verification_target: 7,
				verification_result: 1,
			})
		);
		expect(ambiguous.isError).toBe(true);
		expect(responseBody(ambiguous)).toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(harness.history.getHistoryLength('new')).toBe(2);
		expect(harness.history.getSessionCount()).toBe(1);
	});
});
