import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSessionId } from '../../contracts/ids.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought } from '../helpers/factories.js';
import {
	expire,
	expiredId,
	expiryHarness,
	owned,
	responseBody,
	seed,
} from './SessionExpiryHarness.js';

describe('expired session reset commit', () => {
	let harness: ReturnType<typeof expiryHarness>;
	let backend: MemoryPersistence;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		backend = new MemoryPersistence();
		harness = expiryHarness({
			persistence: backend,
			persistenceFlushInterval: 60_000,
			persistenceMaxRetries: 0,
		});
	});
	afterEach(async () => {
		await harness.history.shutdown();
		vi.useRealTimers();
	});

	it.each(['alice', 'trusted'])(
		'admits %s valid reset_state and preserves the evicted owner',
		async (authority) => {
			owned('alice', () => seed(harness.history));
			await expire(harness.history);
			const replacement = createTestThought({
				session_id: expiredId,
				id: 'replacement',
				reset_state: true,
				thought_number: 9,
				total_thoughts: 20,
			});
			const result =
				authority === 'alice'
					? await owned('alice', () => harness.processor.process(replacement))
					: await harness.processor.process(replacement);
			expect(result.isError).not.toBe(true);
			expect(() => owned('bob', () => harness.history.inspectSession(expiredId))).toThrowError(
				expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
			);
			expect(
				owned('alice', () => harness.history.getHistory(expiredId)).map((thought) => thought.id)
			).toEqual(['replacement']);
		}
	);

	it.each([
		{ thought_number: 0 },
		{ thought_type: 'verification', verification_target: 3, verification_result: 1 },
		{ thought_type: 'backtrack', backtrack_target: 3 },
	] satisfies readonly Partial<ReturnType<typeof createTestThought>>[])(
		'preserves live old state on invalid reset %j',
		async (fields) => {
			seed(harness.history);
			await harness.history.drainSession(expiredId);
			const clear = vi.spyOn(backend, 'clearSession');
			const result = await harness.processor.process(
				createTestThought({
					session_id: expiredId,
					reset_state: true,
					thought_number: 9,
					total_thoughts: 20,
					...fields,
				})
			);
			expect(result.isError).toBe(true);
			expect(clear).not.toHaveBeenCalled();
			expect(harness.history.getHistory(expiredId).map((thought) => thought.id)).toEqual([
				'target-expired',
			]);
		}
	);

	it.each([
		{ thought_number: 0 },
		{ thought_type: 'verification', verification_target: 3, verification_result: 1 },
		{ thought_type: 'backtrack', backtrack_target: 3 },
	] satisfies readonly Partial<ReturnType<typeof createTestThought>>[])(
		'retains expiry after invalid reset replacement %j',
		async (fields) => {
			seed(harness.history);
			await expire(harness.history);
			const clear = vi.spyOn(backend, 'clearSession');
			const result = await harness.processor.process(
				createTestThought({
					session_id: expiredId,
					reset_state: true,
					thought_number: 9,
					total_thoughts: 20,
					...fields,
				})
			);
			expect(result.isError).toBe(true);
			expect(clear).not.toHaveBeenCalled();
			expect(() => harness.history.inspectSession(expiredId)).toThrowError(
				expect.objectContaining({ code: 'SESSION_EXPIRED' })
			);
		}
	);

	it('denies foreign reset before durable deletion or lifecycle mutation', async () => {
		owned('alice', () => seed(harness.history));
		await expire(harness.history);
		const clear = vi.spyOn(backend, 'clearSession');
		await expect(
			owned('bob', () => harness.processor.resetSession(expiredId))
		).rejects.toMatchObject({ code: 'SESSION_ACCESS_DENIED' });
		expect(clear).not.toHaveBeenCalled();
		expect(harness.lifecycle.phaseFor(expiredId)).toBe('open');
	});

	it('retains marker and ownership after failed durable deletion, then allows authorized retry', async () => {
		owned('alice', () => seed(harness.history));
		await expire(harness.history);
		const started = Promise.withResolvers<void>();
		const deletion = Promise.withResolvers<void>();
		vi.spyOn(backend, 'clearSession').mockImplementationOnce(async () => {
			started.resolve();
			await deletion.promise;
		});
		const reset = owned('alice', () => harness.processor.resetSession(expiredId));
		const rejected = expect(reset).rejects.toBeDefined();
		await started.promise;
		deletion.reject(new Error('durable deletion failed'));
		await rejected;
		expect(harness.lifecycle.phaseFor(expiredId)).toBe('reset_failed');
		expect(() => owned('alice', () => harness.history.inspectSession(expiredId))).toThrowError(
			expect.objectContaining({ code: 'SESSION_EXPIRED' })
		);
		await expect(
			owned('bob', () => harness.processor.resetSession(expiredId))
		).rejects.toMatchObject({ code: 'SESSION_ACCESS_DENIED' });
		await owned('alice', () => harness.processor.resetSession(expiredId));
		expect(owned('alice', () => harness.history.getHistory(expiredId))).toEqual([]);
		expect(() => owned('bob', () => harness.history.getHistory(expiredId))).toThrowError(
			expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
		);
	});

	it('recovers on authorized retry after a failed durable deletion', async () => {
		owned('alice', () => seed(harness.history));
		await expire(harness.history);
		const deletion = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(backend, 'clearSession').mockImplementationOnce(async () => {
			started.resolve();
			await deletion.promise;
		});
		const rejected = expect(
			owned('alice', () => harness.processor.resetSession(expiredId))
		).rejects.toBeDefined();
		await started.promise;
		deletion.reject(new Error('durable deletion failed'));
		await rejected;
		await owned('alice', () => harness.processor.resetSession(expiredId));
		expect(harness.lifecycle.phaseFor(expiredId)).toBe('open');
		expect(owned('alice', () => harness.history.getHistory(expiredId))).toEqual([]);
		expect(() => owned('bob', () => harness.history.inspectSession(expiredId))).toThrowError(
			expect.objectContaining({ code: 'SESSION_ACCESS_DENIED' })
		);
	});

	it.each([
		{ owner: 'alice', code: 'SESSION_EXPIRED' },
		{ owner: 'bob', code: 'SESSION_ACCESS_DENIED' },
	])('checks $owner access before failed-reset lifecycle availability', async ({ owner, code }) => {
		owned('alice', () => seed(harness.history));
		await expire(harness.history);
		const started = Promise.withResolvers<void>();
		const deletion = Promise.withResolvers<void>();
		vi.spyOn(backend, 'clearSession').mockImplementationOnce(async () => {
			started.resolve();
			await deletion.promise;
		});
		const rejected = expect(
			owned('alice', () => harness.processor.resetSession(expiredId))
		).rejects.toBeDefined();
		await started.promise;
		deletion.reject(new Error('durable deletion failed'));
		await rejected;
		const result = await owned(owner, () =>
			harness.processor.process(createTestThought({ session_id: expiredId }))
		);
		expect(responseBody(result)).toMatchObject({ code });
	});

	it('allows both evicted names after successful durable resetAll', async () => {
		seed(harness.history);
		seed(harness.history, asSessionId('other'));
		await expire(harness.history);
		await harness.history.resetAll();
		for (const sessionId of [expiredId, asSessionId('other')]) {
			const result = await harness.processor.process(
				createTestThought({ session_id: sessionId, thought_number: 9, total_thoughts: 20 })
			);
			expect(result.isError).not.toBe(true);
			expect(harness.history.getHistoryLength(sessionId)).toBe(1);
		}
	});

	it('clears all expiry markers only after successful durable global reset', async () => {
		seed(harness.history);
		seed(harness.history, asSessionId('other'));
		await expire(harness.history);
		const started = Promise.withResolvers<void>();
		const deletion = Promise.withResolvers<void>();
		vi.spyOn(backend, 'clearAll').mockImplementationOnce(async () => {
			started.resolve();
			await deletion.promise;
		});
		const reset = harness.history.resetAll();
		const rejected = expect(reset).rejects.toBeDefined();
		await started.promise;
		deletion.reject(new Error('global durable deletion failed'));
		await rejected;
		expect(harness.lifecycle.globalPhase).toBe('reset_failed');
		expect(() => harness.history.inspectSession(expiredId)).toThrowError(
			expect.objectContaining({ code: 'SESSION_EXPIRED' })
		);
		expect(() => harness.history.inspectSession('other')).toThrowError(
			expect.objectContaining({ code: 'SESSION_EXPIRED' })
		);
		await harness.history.resetAll();
		expect(
			responseBody(
				await harness.processor.process(
					createTestThought({ session_id: expiredId, thought_number: 9, total_thoughts: 20 })
				)
			)
		).not.toHaveProperty('code');
		expect(harness.history.getHistory('other')).toEqual([]);
	});
});
