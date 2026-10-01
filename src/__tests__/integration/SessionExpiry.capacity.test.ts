import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSessionId } from '../../contracts/ids.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { expiryHarness, owned } from './SessionExpiryHarness.js';

describe('reset replacement capacity admission', () => {
	let harness: ReturnType<typeof expiryHarness>;
	let backend: MemoryPersistence;
	beforeEach(() => {
		backend = new MemoryPersistence();
		harness = expiryHarness({ persistence: backend, maxSessionsPerOwner: 1 });
	});
	afterEach(async () => {
		await harness.history.shutdown();
	});

	it('rejects infeasible reset before deleting durable data', async () => {
		const liveId = asSessionId('live');
		owned('alice', () => harness.history.getHistory(liveId));
		const clear = vi.spyOn(backend, 'clearSession');
		const release = Promise.withResolvers<void>();
		const active = harness.lifecycle.runOperation(liveId, async () => await release.promise);
		const rejected = expect(
			owned('alice', () => harness.history.resetSession('absent'))
		).rejects.toMatchObject({
			code: 'MAX_SESSIONS_REACHED',
		});
		try {
			await rejected;
		} finally {
			release.resolve();
			await active;
		}
		expect(clear).not.toHaveBeenCalled();
		expect(harness.history.getSessionIds()).toEqual(['live']);
	});

	it('rechecks admission after deferred deletion and concurrent creation', async () => {
		const started = Promise.withResolvers<void>();
		const deletion = Promise.withResolvers<void>();
		vi.spyOn(backend, 'clearSession').mockImplementationOnce(async () => {
			started.resolve();
			await deletion.promise;
		});
		const reset = owned('alice', () => harness.history.resetSession('absent'));
		await started.promise;
		owned('alice', () => harness.history.getHistory('concurrent'));
		deletion.resolve();
		await reset;
		expect(harness.history.getSessionIds()).toEqual(['absent']);
	});

	it('does not evict another name when replacing an already live session', async () => {
		owned('alice', () => harness.history.getHistory('live'));
		await owned('alice', () => harness.history.resetSession('live'));
		expect(harness.history.getSessionIds()).toEqual(['live']);
	});
});
