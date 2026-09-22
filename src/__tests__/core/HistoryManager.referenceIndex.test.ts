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

	it('accepts an internal branch mirror but rejects a second caller submission', () => {
		const history = manager();
		const branchId = asBranchId('mirrored');
		const thought = createTestThought({
			id: 'mirrored-id',
			session_id: SESSION_ID,
			thought_number: 1,
			branch_from_thought: 1,
			branch_id: branchId,
		});

		history.addThought(thought);

		expect(() => history.addThought({ ...thought, thought: 'external duplicate' })).toThrowError(
			"Validation failed for 'id': Thought id already exists in session: mirrored-id"
		);
		expect(history.getHistory(SESSION_ID)).toEqual([thought]);
		expect(history.getBranches(SESSION_ID)[branchId]).toEqual([thought]);
	});

	it('protects restored retained ids before direct admission', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('restored-duplicate');
		const restored = createTestThought({
			id: 'restored-id',
			session_id: sessionId,
			thought_number: 1,
		});
		await persistence.saveThoughtForSession(sessionId, restored);
		const history = manager({ persistence, persistenceFlushInterval: 60_000 });
		await history.loadFromPersistence();

		expect(() =>
			history.addThought({ ...restored, thought: 'duplicate after restore' })
		).toThrowError("Validation failed for 'id': Thought id already exists in session: restored-id");
		expect(history.getHistory(sessionId)).toEqual([restored]);
	});

	it('protects a restored branch-only identity before direct admission', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('restored-branch-duplicate');
		const branchId = asBranchId('restored-branch');
		const restored = createTestThought({
			id: 'restored-branch-id',
			session_id: sessionId,
			thought_number: 1,
			branch_id: branchId,
		});
		await persistence.saveBranchForSession(sessionId, branchId, [restored]);
		const history = manager({ persistence, persistenceFlushInterval: 60_000 });
		await history.loadFromPersistence();

		expect(() => history.addThought({ ...restored, thought: 'duplicate branch id' })).toThrowError(
			"Validation failed for 'id': Thought id already exists in session: restored-branch-id"
		);
		expect(history.getBranches(sessionId)[branchId]).toEqual([restored]);
	});

	it('protects a queued id after live retention and keeps it while durably retained', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('queued-duplicate');
		const history = manager({
			persistence,
			maxHistorySize: 1,
			persistenceFlushInterval: 60_000,
		});
		const queued = createTestThought({
			id: 'queued-id',
			session_id: sessionId,
			thought_number: 1,
		});
		history.addThought(queued);
		history.addThought(
			createTestThought({ id: 'retained-id', session_id: sessionId, thought_number: 2 })
		);

		expect(() => history.assertThoughtIdentityAvailable(queued)).toThrowError(
			"Validation failed for 'id': Thought id already exists in session: queued-id"
		);

		await history._flushBuffer();

		expect(() => history.assertThoughtIdentityAvailable(queued)).toThrowError(
			"Validation failed for 'id': Thought id already exists in session: queued-id"
		);
		expect(
			(await persistence.loadHistoryForSession(sessionId)).map((thought) => thought.id)
		).toEqual(['queued-id', 'retained-id']);
	});

	it('protects a durably retained id after persistence-backed eviction', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('durable-eviction');
		const history = manager({ persistence, persistenceFlushInterval: 60_000 });
		const persisted = createTestThought({
			id: 'durable-id',
			session_id: sessionId,
			thought_number: 1,
		});
		history.addThought(persisted);
		await history._flushBuffer();
		const internals = history as unknown as {
			_evictSessions(sessionIds: readonly SessionId[]): Promise<void>;
		};

		await internals._evictSessions([sessionId]);

		expect(() =>
			history.assertThoughtIdentityAvailable({ ...persisted, thought: 'duplicate after eviction' })
		).toThrowError("Validation failed for 'id': Thought id already exists in session: durable-id");
		expect(await persistence.loadHistoryForSession(sessionId)).toEqual([persisted]);
	});

	it('releases durable identity only after reset deletes persisted state', async () => {
		const persistence = new MemoryPersistence();
		const sessionId = asSessionId('durable-reset');
		const history = manager({ persistence, persistenceFlushInterval: 60_000 });
		const original = createTestThought({
			id: 'reset-id',
			session_id: sessionId,
			thought: 'before reset',
			thought_number: 1,
		});
		history.addThought(original);
		await history._flushBuffer();

		await history.resetSession(sessionId);
		const replacement = { ...original, thought: 'after reset' };
		history.addThought(replacement);
		await history._flushBuffer();

		expect(await persistence.loadHistoryForSession(sessionId)).toEqual([replacement]);
	});

	it('releases identity when durable history retention removes its final copy', async () => {
		const persistence = new MemoryPersistence({ maxHistorySize: 1 });
		const sessionId = asSessionId('durable-retention');
		const history = manager({
			persistence,
			maxHistorySize: 1,
			persistenceHistorySize: 1,
			persistenceFlushInterval: 60_000,
		});
		const released = createTestThought({
			id: 'released-id',
			session_id: sessionId,
			thought_number: 1,
		});
		history.addThought(released);
		history.addThought(
			createTestThought({ id: 'durable-owner', session_id: sessionId, thought_number: 2 })
		);
		await history._flushBuffer();

		expect(() => history.assertThoughtIdentityAvailable(released)).not.toThrow();
	});

	it('permits reuse after current TTL eviction removes identity membership', async () => {
		const history = manager();
		const sessionId = asSessionId('evicted-reuse');
		const thought = createTestThought({
			id: 'evicted-id',
			session_id: sessionId,
			thought_number: 1,
		});
		history.addThought(thought);
		const internals = history as unknown as {
			_sessions: Map<SessionId, { lastAccessedAt: number }>;
			_evictSessions(sessionIds: readonly SessionId[]): Promise<void>;
		};
		const state = internals._sessions.get(sessionId);
		if (state === undefined) throw new Error('expected live session state');
		state.lastAccessedAt = Date.now() - 31 * 60 * 1000;
		await internals._evictSessions([sessionId]);

		expect(() => history.addThought({ ...thought, thought: 'after eviction' })).not.toThrow();
		expect(history.getHistory(sessionId).map((item) => item.thought)).toEqual(['after eviction']);
	});
});
