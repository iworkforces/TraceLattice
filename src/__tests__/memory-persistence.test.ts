import { describe, it, expect, beforeEach } from 'vitest';
import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import {
	createTestEdgeId,
	createTestSessionId,
	createTestThought as createBaseTestThought,
	createTestThoughtId,
} from './helpers/factories.js';
import { MemoryPersistence } from '../persistence/MemoryPersistence.js';

import { asBranchId } from '../contracts/ids.js';

let persistentThoughtSequence = 0;
function createTestThought(overrides: Parameters<typeof createBaseTestThought>[0] = {}) {
	persistentThoughtSequence += 1;
	return createBaseTestThought({ id: `memory-${persistentThoughtSequence}`, ...overrides });
}

const TEST_SESSION_ID = createTestSessionId();

describe('MemoryPersistence', () => {
	let backend: MemoryPersistence;

	beforeEach(() => {
		backend = new MemoryPersistence();
	});

	describe('constructor', () => {
		it('should create with default options (unlimited)', async () => {
			const mp = new MemoryPersistence();
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toEqual([]);
			expect(await mp.listBranchesForSession(TEST_SESSION_ID)).toEqual([]);
		});

		it('should create with empty options object', async () => {
			const mp = new MemoryPersistence({});
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toEqual([]);
		});

		it('should accept a positive maxSize', async () => {
			const mp = new MemoryPersistence({ maxSize: 5 });
			// Save 3 — all should be retained
			for (let i = 0; i < 3; i++) {
				await mp.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i + 1 })
				);
			}
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(3);
		});

		it('should treat maxSize of 0 as unlimited', async () => {
			const mp = new MemoryPersistence({ maxSize: 0 });
			for (let i = 0; i < 20; i++) {
				await mp.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i + 1 })
				);
			}
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(20);
		});

		it('should treat undefined maxSize as unlimited', async () => {
			const mp = new MemoryPersistence({ maxSize: undefined });
			for (let i = 0; i < 15; i++) {
				await mp.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i + 1 })
				);
			}
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(15);
		});

		it('should treat negative maxSize as unlimited', async () => {
			const mp = new MemoryPersistence({ maxSize: -5 });
			for (let i = 0; i < 10; i++) {
				await mp.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i + 1 })
				);
			}
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(10);
		});
	});

	describe('saveThought', () => {
		it('should save a single thought', async () => {
			const thought = createTestThought({ thought: 'alpha' });
			await backend.saveThoughtForSession(TEST_SESSION_ID, thought);

			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(1);
			expect(history[0]).toEqual(thought);
		});

		it('should save multiple thoughts preserving order', async () => {
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 1, thought: 'A' })
			);
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 2, thought: 'B' })
			);
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 3, thought: 'C' })
			);

			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(3);
			expect(history.map((t) => t.thought)).toEqual(['A', 'B', 'C']);
		});

		it('rejects duplicate history IDs without mutating admitted history', async () => {
			// Given
			const thought = createTestThought({ id: 'duplicate-history' });
			await backend.saveThoughtForSession(TEST_SESSION_ID, thought);

			// When
			const outcomes = await Promise.allSettled([
				backend.saveThoughtForSession(TEST_SESSION_ID, thought),
			]);
			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);

			// Then
			expect({ outcome: outcomes[0], history }).toMatchObject({
				outcome: {
					status: 'rejected',
					reason: { code: 'PERSISTENCE_COMPATIBILITY' },
				},
				history: [thought],
			});
		});

		it('preserves admission order when thought numbers are non-monotonic', async () => {
			// Given
			const thoughts = [30, 10, 20].map((thoughtNumber) =>
				createTestThought({ id: `admitted-${thoughtNumber}`, thought_number: thoughtNumber })
			);

			// When
			for (const thought of thoughts) await backend.saveThoughtForSession(TEST_SESSION_ID, thought);

			// Then
			expect((await backend.loadHistoryForSession(TEST_SESSION_ID)).map(({ id }) => id)).toEqual([
				'admitted-30',
				'admitted-10',
				'admitted-20',
			]);
		});

		it('should trim oldest thoughts when maxSize exceeded', async () => {
			const mp = new MemoryPersistence({ maxSize: 3 });

			for (let i = 1; i <= 5; i++) {
				await mp.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i, thought: `T${i}` })
				);
			}

			const history = await mp.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(3);
			// Should keep the last 3 (T3, T4, T5)
			expect(history[0]!.thought).toBe('T3');
			expect(history[1]!.thought).toBe('T4');
			expect(history[2]!.thought).toBe('T5');
		});

		it('should trim correctly with maxSize of 1', async () => {
			const mp = new MemoryPersistence({ maxSize: 1 });

			await mp.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 1, thought: 'first' })
			);
			await mp.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 2, thought: 'second' })
			);

			const history = await mp.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(1);
			expect(history[0]!.thought).toBe('second');
		});

		it('should not trim when exactly at maxSize', async () => {
			const mp = new MemoryPersistence({ maxSize: 3 });

			for (let i = 1; i <= 3; i++) {
				await mp.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i, thought: `T${i}` })
				);
			}

			const history = await mp.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(3);
			expect(history[0]!.thought).toBe('T1');
		});

		it('should not trim when no maxSize set', async () => {
			for (let i = 0; i < 100; i++) {
				await backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ thought_number: i + 1 })
				);
			}
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(100);
		});
	});

	describe('loadHistory', () => {
		it('should return empty array when no thoughts saved', async () => {
			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toEqual([]);
		});

		it('should return populated history', async () => {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ thought: 'one' }));
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ thought: 'two' }));

			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(2);
			expect(history[0]!.thought).toBe('one');
			expect(history[1]!.thought).toBe('two');
		});

		it('should return a copy (not internal reference)', async () => {
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought: 'original' })
			);

			const history1 = await backend.loadHistoryForSession(TEST_SESSION_ID);
			const history2 = await backend.loadHistoryForSession(TEST_SESSION_ID);

			// Mutate first copy
			history1.push(createTestThought({ thought: 'injected' }));

			// Second copy unaffected
			expect(history2).toHaveLength(1);
			// Internal state unaffected
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(1);
		});
	});

	describe('saveBranch', () => {
		it('should save a branch', async () => {
			const thoughts = [
				createTestThought({ thought: 'branch-t1', thought_number: 1 }),
				createTestThought({ thought: 'branch-t2', thought_number: 2 }),
			];
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), thoughts);

			const loaded = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));
			expect(loaded).toEqual(thoughts);
		});

		it('should overwrite an existing branch', async () => {
			const original = [createTestThought({ thought: 'old' })];
			const updated = [createTestThought({ thought: 'new' })];

			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), original);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), updated);

			const loaded = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));
			expect(loaded).toEqual(updated);
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toHaveLength(1);
		});

		it('should store a copy of thoughts (not reference)', async () => {
			const thoughts = [createTestThought({ thought: 'snap' })];
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), thoughts);

			// Mutate original array
			thoughts.push(createTestThought({ thought: 'extra' }));

			const loaded = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));
			expect(loaded).toHaveLength(1);
		});

		it('rejects duplicate IDs within one branch candidate', async () => {
			// Given
			const branchId = asBranchId('duplicate-branch');
			const thought = createTestThought({ id: 'duplicate-branch-thought', branch_id: branchId });

			// When / Then
			await expect(
				backend.saveBranchForSession(TEST_SESSION_ID, branchId, [thought, thought])
			).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
		});

		it('allows the same ID across history and branch when payloads are deeply equal', async () => {
			// Given
			const branchId = asBranchId('shared-equal');
			const thought = createTestThought({ id: 'shared-equal-id', branch_id: branchId });
			await backend.saveThoughtForSession(TEST_SESSION_ID, thought);

			// When
			await backend.saveBranchForSession(TEST_SESSION_ID, branchId, [thought]);

			// Then
			expect(await backend.loadBranchForSession(TEST_SESSION_ID, branchId)).toEqual([thought]);
		});

		it('rejects conflicting ID reuse when history is admitted before branch', async () => {
			// Given
			const branchId = asBranchId('history-first');
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ id: 'history-first-id', branch_id: branchId, thought: 'history' })
			);

			// When / Then
			await expect(
				backend.saveBranchForSession(TEST_SESSION_ID, branchId, [
					createTestThought({ id: 'history-first-id', branch_id: branchId, thought: 'branch' }),
				])
			).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		});

		it('rejects conflicting ID reuse when branch is admitted before history', async () => {
			// Given
			const branchId = asBranchId('branch-first');
			await backend.saveBranchForSession(TEST_SESSION_ID, branchId, [
				createTestThought({ id: 'branch-first-id', branch_id: branchId, thought: 'branch' }),
			]);

			// When / Then
			await expect(
				backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'branch-first-id', branch_id: branchId, thought: 'history' })
				)
			).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		});
	});

	describe('loadBranch', () => {
		it('should load an existing branch', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [
				createTestThought({ thought: 'x' }),
			]);
			const loaded = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));
			expect(loaded).toBeDefined();
			expect(loaded).toHaveLength(1);
			expect(loaded![0]!.thought).toBe('x');
		});

		it('should return undefined for non-existent branch', async () => {
			const loaded = await backend.loadBranchForSession(
				TEST_SESSION_ID,
				asBranchId('no-such-branch')
			);
			expect(loaded).toBeUndefined();
		});

		it("should return a copy (mutations don't affect internal state)", async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [
				createTestThought({ thought: 'data' }),
			]);

			const loaded1 = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));
			const loaded2 = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));

			loaded1!.push(createTestThought({ thought: 'injected' }));

			expect(loaded2).toHaveLength(1);
			expect(await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'))).toHaveLength(1);
		});
	});

	describe('listBranches', () => {
		it('should return empty array when no branches', async () => {
			const branches = await backend.listBranchesForSession(TEST_SESSION_ID);
			expect(branches).toEqual([]);
		});

		it('should return all branch IDs', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('alpha'), [
				createTestThought(),
			]);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('beta'), [
				createTestThought(),
			]);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('gamma'), [
				createTestThought(),
			]);

			const branches = await backend.listBranchesForSession(TEST_SESSION_ID);
			expect(branches).toHaveLength(3);
			expect(branches).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
		});
	});

	describe('healthy', () => {
		it('should always return true', async () => {
			expect(await backend.healthy()).toBe(true);
		});

		it('should return true even after data operations', async () => {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought());
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b'), [createTestThought()]);
			await backend.clearAll();
			expect(await backend.healthy()).toBe(true);
		});
	});

	describe('clear', () => {
		it('should clear all history and branches', async () => {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought());
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 2 })
			);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [createTestThought()]);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b2'), [createTestThought()]);

			await backend.clearAll();

			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toEqual([]);
			expect(await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'))).toBeUndefined();
			expect(await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b2'))).toBeUndefined();
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toEqual([]);
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toEqual([]);
		});

		it('should be safe to call on empty backend', async () => {
			await backend.clearAll();
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toEqual([]);
		});

		it('should be safe to call multiple times', async () => {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought());
			await backend.clearAll();
			await backend.clearAll();
			await backend.clearAll();
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(0);
		});

		it('should allow new data after clear', async () => {
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought: 'before' })
			);
			await backend.clearAll();
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ thought: 'after' }));

			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(1);
			expect(history[0]!.thought).toBe('after');
		});
	});

	describe('close', () => {
		it('should be a no-op and resolve without error', async () => {
			await expect(backend.close()).resolves.toBeUndefined();
		});

		it('should not affect data', async () => {
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought: 'persisted' })
			);
			await backend.close();

			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			expect(history).toHaveLength(1);
			expect(history[0]!.thought).toBe('persisted');
		});
	});

	describe('edge persistence', () => {
		it('rejects duplicate edge IDs without replacing the admitted collection', async () => {
			const sessionId = createTestSessionId('duplicate-edge-session');
			const seededEdges: Edge[] = [
				{
					id: createTestEdgeId('seed-edge-1'),
					from: createTestThoughtId('seed-edge-from-1'),
					to: createTestThoughtId('seed-edge-to-1'),
					kind: 'sequence',
					sessionId,
					createdAt: 10,
				},
				{
					id: createTestEdgeId('seed-edge-2'),
					from: createTestThoughtId('seed-edge-from-2'),
					to: createTestThoughtId('seed-edge-to-2'),
					kind: 'branch',
					sessionId,
					createdAt: 20,
				},
			];
			const duplicateId = createTestEdgeId('duplicate-edge');
			const duplicateEdges: Edge[] = [
				{
					id: duplicateId,
					from: createTestThoughtId('duplicate-edge-from-1'),
					to: createTestThoughtId('duplicate-edge-to-1'),
					kind: 'sequence',
					sessionId,
					createdAt: 30,
				},
				{
					id: duplicateId,
					from: createTestThoughtId('duplicate-edge-from-2'),
					to: createTestThoughtId('duplicate-edge-to-2'),
					kind: 'critiques',
					sessionId,
					createdAt: 40,
				},
			];
			await backend.saveEdges(sessionId, seededEdges);

			const outcomes = await Promise.allSettled([backend.saveEdges(sessionId, duplicateEdges)]);
			const persisted = await backend.loadEdges(sessionId);

			expect(persisted).toEqual(seededEdges);
			expect(outcomes[0]).toMatchObject({
				status: 'rejected',
				reason: {
					code: 'PERSISTENCE_COMPATIBILITY',
					sourcePath: 'duplicate-edge-session/edges',
					detail: "duplicate edge id 'duplicate-edge'",
				},
			});
		});
	});

	describe('summary persistence', () => {
		it('rejects duplicate summary IDs without replacing the admitted collection', async () => {
			const sessionId = createTestSessionId('duplicate-summary-session');
			const seededSummaries: Summary[] = [
				{
					id: 'seed-summary-1',
					sessionId,
					rootThoughtId: createTestThoughtId('seed-summary-root-1'),
					coveredIds: [createTestThoughtId('seed-summary-covered-1')],
					coveredRange: [1, 1],
					topics: ['seed-one'],
					aggregateConfidence: 0.7,
					createdAt: 10,
				},
				{
					id: 'seed-summary-2',
					sessionId,
					rootThoughtId: createTestThoughtId('seed-summary-root-2'),
					coveredIds: [createTestThoughtId('seed-summary-covered-2')],
					coveredRange: [2, 2],
					topics: ['seed-two'],
					aggregateConfidence: 0.8,
					createdAt: 20,
				},
			];
			const duplicateSummaries: Summary[] = [
				{
					id: 'duplicate-summary',
					sessionId,
					rootThoughtId: createTestThoughtId('duplicate-summary-root-1'),
					coveredIds: [createTestThoughtId('duplicate-summary-covered-1')],
					coveredRange: [3, 3],
					topics: ['candidate-one'],
					aggregateConfidence: 0.6,
					createdAt: 30,
				},
				{
					id: 'duplicate-summary',
					sessionId,
					rootThoughtId: createTestThoughtId('duplicate-summary-root-2'),
					coveredIds: [createTestThoughtId('duplicate-summary-covered-2')],
					coveredRange: [4, 4],
					topics: ['candidate-two'],
					aggregateConfidence: 0.5,
					createdAt: 40,
				},
			];
			await backend.saveSummaries(sessionId, seededSummaries);

			const outcomes = await Promise.allSettled([
				backend.saveSummaries(sessionId, duplicateSummaries),
			]);
			const persisted = await backend.loadSummaries(sessionId);

			expect(persisted).toEqual(seededSummaries);
			expect(outcomes[0]).toMatchObject({
				status: 'rejected',
				reason: {
					code: 'PERSISTENCE_COMPATIBILITY',
					sourcePath: 'duplicate-summary-session/summaries',
					detail: "duplicate summary id 'duplicate-summary'",
				},
			});
		});
	});

	describe('scoped history size', () => {
		it('should return 0 for empty backend', async () => {
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(0);
		});

		it('should track count after saves', async () => {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought());
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(1);

			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought_number: 2 })
			);
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(2);
		});

		it('should reflect trimming when maxSize set', async () => {
			const mp = new MemoryPersistence({ maxSize: 2 });

			await mp.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ thought_number: 1 }));
			await mp.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ thought_number: 2 }));
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(2);

			await mp.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ thought_number: 3 }));
			expect(await mp.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(2);
		});

		it('should return 0 after clear', async () => {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought());
			await backend.clearAll();
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(0);
		});
	});

	describe('scoped branch count', () => {
		it('should return 0 when no branches', async () => {
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toHaveLength(0);
		});

		it('should track branch count', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [createTestThought()]);
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toHaveLength(1);

			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b2'), [createTestThought()]);
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toHaveLength(2);
		});

		it('should not increment on overwrite', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [createTestThought()]);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [
				createTestThought({ thought: 'updated' }),
			]);
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toHaveLength(1);
		});

		it('should return 0 after clear', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [createTestThought()]);
			await backend.clearAll();
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toHaveLength(0);
		});
	});

	describe('listBranchesForSession', () => {
		it('should return empty array when no branches', async () => {
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toEqual([]);
		});

		it('should return all branch IDs', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('first'), [
				createTestThought(),
			]);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('second'), [
				createTestThought(),
			]);

			const ids = await backend.listBranchesForSession(TEST_SESSION_ID);
			expect(ids).toHaveLength(2);
			expect(ids).toEqual(expect.arrayContaining(['first', 'second']));
		});

		it('should not include duplicates on overwrite', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('same'), [
				createTestThought(),
			]);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('same'), [
				createTestThought({ thought: 'v2' }),
			]);

			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toEqual(['same']);
		});

		it('should return empty after clear', async () => {
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [createTestThought()]);
			await backend.clearAll();
			expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toEqual([]);
		});
	});

	describe('isolation', () => {
		it('should isolate history from branches', async () => {
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought: 'history-only' })
			);
			await backend.saveBranchForSession(TEST_SESSION_ID, asBranchId('b1'), [
				createTestThought({ thought: 'branch-only' }),
			]);

			const history = await backend.loadHistoryForSession(TEST_SESSION_ID);
			const branch = await backend.loadBranchForSession(TEST_SESSION_ID, asBranchId('b1'));

			expect(history).toHaveLength(1);
			expect(history[0]!.thought).toBe('history-only');
			expect(branch).toHaveLength(1);
			expect(branch![0]!.thought).toBe('branch-only');
		});

		it('should handle concurrent saves', async () => {
			const thoughts = Array.from({ length: 50 }, (_, i) =>
				createTestThought({ thought_number: i + 1, thought: `T${i + 1}` })
			);

			await Promise.all(
				thoughts.map((thought) => backend.saveThoughtForSession(TEST_SESSION_ID, thought))
			);

			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(50);
		});
	});
});
