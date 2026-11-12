import { afterEach, describe, expect, it } from 'vitest';

import { HistoryManager } from '../../core/HistoryManager.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought } from '../helpers/factories.js';

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
			retainedFailureCount: 0,
			pendingThoughtCount: 1,
		});
	});
});
