import { afterEach, describe, expect, it, vi } from 'vitest';

import { asSessionId } from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought, SignalingLogger } from '../helpers/factories.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';
import { advanceTimeAsync, useFakeTimers, useRealTimers } from '../helpers/timers.js';

const managers = new Set<HistoryManager>();

function manager(config: ConstructorParameters<typeof HistoryManager>[0] = {}): HistoryManager {
	const value = new HistoryManager(config);
	managers.add(value);
	return value;
}

afterEach(async () => {
	for (const value of managers) await value.shutdown();
	managers.clear();
});

describe('HistoryManager persistence backlog view', () => {
	it('is null when persistence is disabled', () => {
		const history = manager();
		history.addThought(createTestThought({ id: 'unpersisted', session_id: 'view-off' }));

		expect(history.getPersistenceBacklogView()).toBeNull();
	});

	it('reports thoughts accepted for persistence as pending', () => {
		const history = manager({
			persistence: new MemoryPersistence(),
			persistenceFlushInterval: 60_000,
		});
		history.addThought(createTestThought({ id: 'pending', session_id: 'view-on' }));

		expect(history.getPersistenceBacklogView()).toEqual({
			globalQuarantined: false,
			quarantinedSessionCount: 0,
			evictionRetrySessionCount: 0,
			blockedSessionCount: 0,
			retainedFailureCount: 0,
			pendingThoughtCount: 1,
		});
	});
});

describe('HistoryManager backlog view of a failed TTL eviction', () => {
	const SESSION_TTL_MS = 30 * 60 * 1000;
	const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
	const FLUSH_INTERVAL_MS = 60_000;

	afterEach(() => {
		useRealTimers();
	});

	it('counts the session awaiting eviction retry until a sweep evicts it, not when a drain recovers', async () => {
		// Given
		useFakeTimers();
		vi.setSystemTime(0);
		const sessionId = asSessionId('view-eviction-retry');
		const persistence = new StallingPersistence();
		persistence.holdWrites = true;
		const logger = new SignalingLogger();
		const history = manager({
			persistence,
			logger,
			persistenceFlushInterval: FLUSH_INTERVAL_MS,
			persistenceMaxRetries: 0,
		});
		history.addThought(createTestThought({ id: 'retry-1', session_id: sessionId }));
		await advanceTimeAsync(SESSION_TTL_MS + CLEANUP_INTERVAL_MS);
		const evictionFailed = logger.next('Session cleanup failed');
		persistence.holdWrites = false;
		persistence.releaseHeldCall(new Error('slow disk'));
		await evictionFailed;
		const afterFailure = history.getPersistenceBacklogView();

		// When
		await advanceTimeAsync(3 * FLUSH_INTERVAL_MS);
		const afterBackgroundRecovery = history.getPersistenceBacklogView();
		const retried = logger.next('Retried failed session eviction');
		await advanceTimeAsync(CLEANUP_INTERVAL_MS);
		await retried;

		// Then
		expect(afterFailure).toMatchObject({
			evictionRetrySessionCount: 1,
			quarantinedSessionCount: 0,
			retainedFailureCount: 1,
		});
		expect(afterBackgroundRecovery).toMatchObject({
			evictionRetrySessionCount: 1,
			quarantinedSessionCount: 0,
			retainedFailureCount: 0,
			pendingThoughtCount: 0,
		});
		expect(history.getPersistenceBacklogView()).toMatchObject({
			evictionRetrySessionCount: 0,
			quarantinedSessionCount: 0,
		});
		expect(() => history.getHistory(sessionId)).toThrow(
			expect.objectContaining({ code: 'SESSION_EXPIRED' })
		);
		await history.shutdown();
	});
});
