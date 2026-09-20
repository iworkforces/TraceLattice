import { afterEach, describe, expect, it } from 'vitest';

import { asBranchId, asSessionId, asThoughtId, type SessionId } from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought } from '../helpers/factories.js';

const managers = new Set<HistoryManager>();
const SESSION_ID = asSessionId('reference-index-session');

function manager(config: ConstructorParameters<typeof HistoryManager>[0] = {}): HistoryManager {
	const value = new HistoryManager(config);
	managers.add(value);
	return value;
}

afterEach(async () => {
	for (const value of managers) await value.shutdown();
	managers.clear();
});

describe('HistoryManager reference-index lifecycle', () => {
	it('rejects a missing direct backtrack without creating session state', () => {
		const history = manager();

		expect(() =>
			history.addThought(
				createTestThought({
					id: 'rejected-backtrack',
					session_id: 'fresh',
					thought_number: 2,
					thought_type: 'backtrack',
					backtrack_target: 1,
				})
			)
		).toThrowError('backtrack_target 1 is missing in session history');
		expect(history.getSessionIds()).toEqual([]);
	});

	it('rebuilds from retained main and branch records after persistence restore', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('restored');
		const branchId = asBranchId('branch');
		await persistence.saveThoughtForSession(
			sessionId,
			createTestThought({ id: 'trimmed-main', session_id: 'restored', thought_number: 1 })
		);
		await persistence.saveThoughtForSession(
			sessionId,
			createTestThought({ id: 'kept-main', session_id: 'restored', thought_number: 9 })
		);
		await persistence.saveBranchForSession(sessionId, branchId, [
			createTestThought({
				id: 'branch-only',
				session_id: 'restored',
				thought_number: 4,
				branch_id: branchId,
			}),
		]);
		const history = manager({ persistence, maxHistorySize: 1, maxBranchSize: 1 });

		await history.loadFromPersistence();

		expect(history.resolveThoughtReference(sessionId, 1)).toEqual({ kind: 'missing' });
		expect(history.resolveThoughtReference(sessionId, 9)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('kept-main'),
		});
		expect(history.resolveThoughtReference(sessionId, 4)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('branch-only'),
		});
	});

	it('leaves the live index unchanged when restore staging fails', async () => {
		class FailingRestorePersistence extends MemoryPersistence {
			override async loadHistoryForSession(sessionId: SessionId) {
				if (sessionId === 'broken') throw new Error('controlled restore failure');
				return await super.loadHistoryForSession(sessionId);
			}
		}
		const persistence = new FailingRestorePersistence();
		const broken = asSessionId('broken');
		await persistence.saveThoughtForSession(
			broken,
			createTestThought({ id: 'persisted', session_id: 'broken', thought_number: 8 })
		);
		const history = manager({ persistence, persistenceFlushInterval: 60_000 });
		history.addThought(createTestThought({ id: 'live', session_id: 'live', thought_number: 3 }));

		await expect(history.loadFromPersistence()).rejects.toThrow('controlled restore failure');

		expect(history.resolveThoughtReference(asSessionId('live'), 3)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('live'),
		});
	});

	it('cleans the index when current TTL eviction removes a live session', async () => {
		const history = manager();
		const sessionId = asSessionId('expired');
		history.addThought(
			createTestThought({ id: 'expired-id', session_id: 'expired', thought_number: 2 })
		);
		const internals = history as unknown as {
			_sessions: Map<SessionId, { lastAccessedAt: number }>;
			_evictSessions(sessionIds: readonly SessionId[]): Promise<void>;
		};
		const state = internals._sessions.get(sessionId);
		if (state === undefined) throw new Error('expected live session state');
		state.lastAccessedAt = Date.now() - 31 * 60 * 1000;

		await internals._evictSessions([sessionId]);

		expect(history.resolveThoughtReference(sessionId, 2)).toEqual({ kind: 'missing' });
	});

	it('retracts every retained copy selected by one unique stable id', () => {
		const history = manager();
		const branchId = asBranchId('copy');
		history.addThought(
			createTestThought({
				id: 'target',
				session_id: SESSION_ID,
				thought_number: 1,
				branch_from_thought: 1,
				branch_id: branchId,
			})
		);

		history.addThought(
			createTestThought({
				id: 'backtrack',
				session_id: SESSION_ID,
				thought_number: 2,
				thought_type: 'backtrack',
				backtrack_target: 1,
			})
		);

		expect(history.getHistory(SESSION_ID)[0]?.retracted).toBe(true);
		expect(history.getBranches(SESSION_ID)[branchId]?.[0]?.retracted).toBe(true);
		expect(history.resolveThoughtReference(SESSION_ID, 1).kind).toBe('unique');
	});
});
