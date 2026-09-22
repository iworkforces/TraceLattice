import { asSessionId, type ThoughtId } from '../contracts/ids.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ABSOLUTE_MAX_HISTORY_SIZE, HistoryManager } from '../core/HistoryManager.js';
import { EdgeStore } from '../core/graph/EdgeStore.js';
import { SessionLock } from '../core/SessionLock.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import { createTestThought } from './helpers/factories.js';
import { useFakeTimers, useRealTimers } from './helpers/timers.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceDrainError } from '../core/PersistenceBufferErrors.js';
import { PersistenceUnavailableError, ValidationError } from '../errors.js';
import { stageBacktrackPersistence } from '../persistence/BacktrackPersistence.js';

import { asBranchId, type BranchId } from '../contracts/ids.js';
import type { SessionId } from '../contracts/ids.js';

const SESSION_ID = asSessionId('test-session');
/** Test-only interface to access private fields of HistoryManager. */
interface HistoryManagerTestAccess {
	_maxHistorySize: number;
}

class MockPersistence implements PersistenceBackend {
	private readonly _sessionHistory = new Map<SessionId, ThoughtData[]>();
	private readonly _sessionBranches = new Map<SessionId, Map<BranchId, ThoughtData[]>>();
	saveThoughtFailCount = 0;
	healthyResult = true;
	clearFail = false;
	saveBranchFailCount = 0;

	async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		if (this.saveThoughtFailCount > 0) {
			this.saveThoughtFailCount--;
			throw new Error('Persistence save failed');
		}
		const history = this._sessionHistory.get(sessionId) ?? [];
		history.push(thought);
		this._sessionHistory.set(sessionId, history);
	}

	async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		const branches = this._sessionBranches.get(sessionId) ?? new Map();
		const staged = stageBacktrackPersistence(
			sessionId,
			this._sessionHistory.get(sessionId) ?? [],
			[...branches].map(([branchId, thoughts]) => ({ branchId, thoughts })),
			thought,
			targetThoughtId,
			0
		);
		this._sessionHistory.set(sessionId, [...staged.history]);
		this._sessionBranches.set(
			sessionId,
			new Map(staged.branches.map((branch) => [branch.branchId, [...branch.thoughts]]))
		);
	}

	async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		return [...(this._sessionHistory.get(sessionId) ?? [])];
	}

	async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		if (this.saveBranchFailCount > 0) {
			this.saveBranchFailCount--;
			throw new Error('Branch save failed');
		}
		const branches = this._sessionBranches.get(sessionId) ?? new Map<BranchId, ThoughtData[]>();
		branches.set(branchId, [...thoughts]);
		this._sessionBranches.set(sessionId, branches);
	}

	async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		const branches = this._sessionBranches.get(sessionId);
		branches?.delete(branchId);
		if (branches?.size === 0) this._sessionBranches.delete(sessionId);
	}

	async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		const branch = this._sessionBranches.get(sessionId)?.get(branchId);
		return branch === undefined ? undefined : [...branch];
	}

	async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		const branches = this._sessionBranches.get(sessionId);
		return branches === undefined ? [] : Array.from(branches.keys());
	}

	async listSessions(): Promise<SessionId[]> {
		const sessions = new Set<SessionId>([
			...this._sessionHistory.keys(),
			...this._sessionBranches.keys(),
		]);
		return Array.from(sessions);
	}

	async clearAll(): Promise<void> {
		if (this.clearFail) {
			throw new Error('Clear failed');
		}
		this._sessionHistory.clear();
		this._sessionBranches.clear();
	}

	async clearSession(sessionId: SessionId): Promise<void> {
		this._sessionHistory.delete(sessionId);
		this._sessionBranches.delete(sessionId);
	}

	async healthy(): Promise<boolean> {
		return this.healthyResult;
	}

	async close(): Promise<void> {}

	async saveEdges(): Promise<void> {}

	async loadEdges(): Promise<never[]> {
		return [];
	}

	async listEdgeSessions(): Promise<SessionId[]> {
		return [];
	}

	async saveSummaries(): Promise<void> {}

	async loadSummaries(): Promise<never[]> {
		return [];
	}
}

describe('HistoryManager', () => {
	afterEach(() => {
		useRealTimers();
	});

	describe('Basic operations', () => {
		it('should add thoughts and track length', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));

			expect(manager.getHistoryLength(SESSION_ID)).toBe(2);
			expect(manager.getHistory(SESSION_ID)).toHaveLength(2);
			expect(manager.getHistory(SESSION_ID)[1]!.thought_number).toBe(2);
		});

		it('should reset all state', async () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));
			await manager.resetAll();

			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
			expect(manager.getBranches(SESSION_ID)).toEqual({});
			expect(manager.getBranchIds(SESSION_ID)).toHaveLength(0);
		});

		it('should return empty branches record initially', () => {
			const manager = new HistoryManager();
			expect(manager.getBranches(SESSION_ID)).toEqual({});
			expect(manager.getBranchIds(SESSION_ID)).toEqual([]);
		});
	});

	describe('History trimming', () => {
		it('should trim history when maxHistorySize is exceeded', () => {
			const manager = new HistoryManager({ maxHistorySize: 3 });
			for (let i = 1; i <= 4; i++) {
				manager.addThought(createTestThought({ thought_number: i }));
			}

			expect(manager.getHistoryLength(SESSION_ID)).toBe(3);
			expect(manager.getHistory(SESSION_ID)[0]!.thought_number).toBe(2);
			expect(manager.getHistory(SESSION_ID)[2]!.thought_number).toBe(4);
		});

		it('should not trim when exactly at maxHistorySize', () => {
			const manager = new HistoryManager({ maxHistorySize: 3 });
			for (let i = 1; i <= 3; i++) {
				manager.addThought(createTestThought({ thought_number: i }));
			}

			expect(manager.getHistoryLength(SESSION_ID)).toBe(3);
			expect(manager.getHistory(SESSION_ID)[0]!.thought_number).toBe(1);
		});
	});

	describe('Branch management', () => {
		it('should create branch when branch_from_thought and branch_id are set', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: asBranchId('alt-1'),
				})
			);

			expect(manager.getBranchIds(SESSION_ID)).toEqual(['alt-1']);
			expect(manager.getBranch(asBranchId('alt-1'), SESSION_ID)).toHaveLength(1);
		});

		it('should add multiple thoughts to the same branch', () => {
			const manager = new HistoryManager();
			for (let i = 1; i <= 3; i++) {
				manager.addThought(
					createTestThought({
						thought_number: i,
						branch_from_thought: 1,
						branch_id: asBranchId('alt-1'),
					})
				);
			}

			expect(manager.getBranch(asBranchId('alt-1'), SESSION_ID)).toHaveLength(3);
		});

		it('should trim branch when maxBranchSize is exceeded', () => {
			const manager = new HistoryManager({ maxBranchSize: 2 });
			for (let i = 1; i <= 4; i++) {
				manager.addThought(
					createTestThought({
						thought_number: i,
						branch_from_thought: 1,
						branch_id: asBranchId('alt-1'),
					})
				);
			}

			expect(manager.getBranch(asBranchId('alt-1'), SESSION_ID)).toHaveLength(2);
			expect(manager.getBranch(asBranchId('alt-1'), SESSION_ID)?.[0]?.thought_number).toBe(3);
		});

		it('should remove oldest branches when maxBranches is exceeded', () => {
			const manager = new HistoryManager({ maxBranches: 2 });
			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-a'),
				})
			);
			manager.addThought(
				createTestThought({
					thought_number: 2,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-b'),
				})
			);
			manager.addThought(
				createTestThought({
					thought_number: 3,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-c'),
				})
			);

			expect(manager.getBranchIds(SESSION_ID)).toHaveLength(2);
			expect(manager.getBranchIds(SESSION_ID)).not.toContain('branch-a');
			expect(manager.getBranchIds(SESSION_ID)).toContain('branch-c');
		});

		it('should return undefined for non-existent branch', () => {
			const manager = new HistoryManager();
			expect(manager.getBranch(asBranchId('non-existent'), SESSION_ID)).toBeUndefined();
		});
	});

	describe('available_mcp_tools / available_skills caching', () => {
		it('should cache available_mcp_tools from added thoughts', () => {
			const manager = new HistoryManager();
			expect(manager.getAvailableMcpTools(SESSION_ID)).toBeUndefined();

			manager.addThought(createTestThought({ available_mcp_tools: ['Read', 'Grep'] }));
			expect(manager.getAvailableMcpTools(SESSION_ID)).toEqual(['Read', 'Grep']);
		});

		it('should update cached tools when new thought provides them', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ available_mcp_tools: ['Read'] }));
			manager.addThought(createTestThought({ available_mcp_tools: ['Read', 'Write', 'Grep'] }));

			expect(manager.getAvailableMcpTools(SESSION_ID)).toEqual(['Read', 'Write', 'Grep']);
		});

		it('should cache available_skills from added thoughts', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ available_skills: ['commit'] }));
			expect(manager.getAvailableSkills(SESSION_ID)).toEqual(['commit']);
		});

		it('should clear cached tools and skills on resetAll()', async () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					available_mcp_tools: ['Read'],
					available_skills: ['commit'],
				})
			);
			await manager.resetAll();

			expect(manager.getAvailableMcpTools(SESSION_ID)).toBeUndefined();
			expect(manager.getAvailableSkills(SESSION_ID)).toBeUndefined();
		});
	});

	describe('Flush buffer pipeline', () => {
		it('should buffer thoughts and flush to persistence', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceFlushInterval: 1000,
				persistenceBufferSize: 100,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			expect(await persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(manager.getWriteBufferLength()).toBe(0));
		});

		it('should trigger immediate flush when buffer reaches capacity', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 2,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			expect(manager.getWriteBufferLength()).toBe(1);

			manager.addThought(createTestThought({ thought_number: 2 }));
			await vi.waitFor(() => expect(manager.getWriteBufferLength()).toBe(0));
			await vi.advanceTimersByTimeAsync(0);
			expect(await persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(2);
		});

		it('should skip flush when buffer is empty', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });

			await manager._flushBuffer();
			expect(await persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(0);
		});

		it('should expose the shared coordinator promise to concurrent flush joiners', async () => {
			const persistence = new MockPersistence();
			let releaseWrite: (() => void) | undefined;
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			persistence.saveThoughtForSession = async () => writeGate;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			const flush1 = manager._flushBuffer();
			const flush2 = manager._flushBuffer();

			expect(flush2).toBe(flush1);
			releaseWrite?.();
			await Promise.all([flush1, flush2]);
		});
	});

	describe('Flush retry with backoff', () => {
		it('should retry on persistence failure', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 1;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(200);
			await vi.waitFor(() => expect(manager.getWriteBufferLength()).toBe(0));
			expect(await persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(1);
		});

		it('should surface attributable terminal failures after exhausting retries', async () => {
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 999;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});
			const sessionId = SESSION_ID;

			manager.addThought(createTestThought({ thought_number: 1 }));

			await expect(manager.drainSession(sessionId)).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [{ kind: 'thought', sessionId, attempts: 1 }],
			});
		});

		it('should emit persistenceError event on exhausted retries', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 999;
			const events: Array<{ operation: string; error: Error }> = [];
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});

			manager.setEventEmitter({
				emit(_event, payload) {
					events.push(payload);
					return true;
				},
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() => expect(events).toHaveLength(1));

			expect(events[0]).toMatchObject({
				operation: 'flushBuffer',
				error: {
					name: 'PersistenceDrainError',
					failures: [{ kind: 'thought', sessionId: SESSION_ID, attempts: 1 }],
				},
			});
			expect(events[0]?.error).toBeInstanceOf(PersistenceDrainError);
		});
	});

	describe('Backpressure', () => {
		it('should retain work accepted while a capacity flush is blocked', async () => {
			const persistence = new MockPersistence();
			let releaseWrite: (() => void) | undefined;
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			persistence.saveThoughtForSession = async () => writeGate;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));
			manager.addThought(createTestThought({ thought_number: 3 }));

			expect(manager.getHistoryLength(SESSION_ID)).toBe(3);
			expect(manager.getWriteBufferLength()).toBe(3);
			releaseWrite?.();
			await manager.shutdown();
		});
	});

	describe('Branch persistence', () => {
		it('should persist branches through the coordinator drain', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });

			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-1'),
				})
			);

			await manager.drainSession(SESSION_ID);
			const loaded = await persistence.loadBranchForSession(SESSION_ID, asBranchId('branch-1'));
			expect(loaded).toBeDefined();
			expect(loaded).toHaveLength(1);
		});

		it('should attribute terminal branch persistence failures to the owning session', async () => {
			const persistence = new MockPersistence();
			persistence.saveBranchFailCount = 999;
			const manager = new HistoryManager({ persistence, persistenceMaxRetries: 0 });
			const sessionId = SESSION_ID;
			const branchId = asBranchId('branch-1');

			manager.addThought(
				createTestThought({
					thought_number: 1,
					branch_from_thought: 1,
					branch_id: branchId,
				})
			);

			expect(manager.getBranch(branchId, SESSION_ID)).toHaveLength(1);
			await expect(manager.drainSession(sessionId)).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [{ kind: 'branch', sessionId, key: branchId, attempts: 1 }],
			});
		});
	});

	describe('loadFromPersistence', () => {
		it('should load history and branches from persistence', async () => {
			const persistence = new MockPersistence();
			await persistence.saveThoughtForSession(
				SESSION_ID,
				createTestThought({ id: 'restored-main', thought_number: 1 })
			);
			await persistence.saveBranchForSession(SESSION_ID, asBranchId('branch-1'), [
				createTestThought({ id: 'restored-branch', thought_number: 1 }),
			]);

			const manager = new HistoryManager({ persistence });
			await manager.loadFromPersistence();

			expect(manager.getHistoryLength(SESSION_ID)).toBe(1);
			expect(manager.getBranchIds(SESSION_ID)).toContain('branch-1');
		});

		it('T10-L03 should reject load when persistence backend is unhealthy', async () => {
			const persistence = new MockPersistence();
			persistence.healthyResult = false;
			await persistence.saveThoughtForSession(SESSION_ID, createTestThought({ thought_number: 1 }));

			const manager = new HistoryManager({ persistence });
			await expect(manager.loadFromPersistence()).rejects.toBeInstanceOf(
				PersistenceUnavailableError
			);
			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
		});

		it('should skip load when persistence is not enabled', async () => {
			const manager = new HistoryManager({ persistence: null });
			await manager.loadFromPersistence();
			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
		});

		it('should trim loaded history to maxHistorySize', async () => {
			const persistence = new MockPersistence();
			for (let i = 0; i < 10; i++) {
				await persistence.saveThoughtForSession(
					SESSION_ID,
					createTestThought({ id: `restored-${i + 1}`, thought_number: i + 1 })
				);
			}

			const manager = new HistoryManager({ persistence, maxHistorySize: 5 });
			await manager.loadFromPersistence();

			expect(manager.getHistoryLength(SESSION_ID)).toBe(5);
			expect(manager.getHistory(SESSION_ID)[0]!.thought_number).toBe(6);
		});

		it('T10-L04 should propagate unhealthy persistence without mutation', async () => {
			const persistence = new MockPersistence();
			persistence.healthyResult = false;

			const manager = new HistoryManager({ persistence });
			await expect(manager.loadFromPersistence()).rejects.toBeInstanceOf(
				PersistenceUnavailableError
			);
			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
		});
	});

	describe('reset with persistence', () => {
		it('awaitably resets durable and live state', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });

			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(1100);
			expect(manager.getWriteBufferLength()).toBe(0);

			await manager.resetAll();
			expect(await persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(0);
		});

		it('surfaces persistence reset failure without clearing live state', async () => {
			const persistence = new MockPersistence();
			persistence.clearFail = true;
			const manager = new HistoryManager({ persistence });

			manager.addThought(createTestThought({ thought_number: 1 }));
			await expect(manager.resetAll()).rejects.toThrow('Clear failed');
			expect(manager.getHistoryLength(SESSION_ID)).toBe(1);
		});
	});

	describe('reset with active operations', () => {
		it('waits to reset a session while that session is active', async () => {
			const sessionLock = new SessionLock();
			const manager = new HistoryManager({ sessionLock });
			const sessionId = asSessionId('active-session');
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			manager.addThought(createTestThought({ thought: 'keep', session_id: sessionId }));
			const activeOperation = sessionLock.withLock(sessionId, async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;

			const reset = manager.resetSession(sessionId);
			expect(manager.getHistory(sessionId).map((thought) => thought.thought)).toEqual(['keep']);

			release.resolve();
			await activeOperation;
			await reset;
			expect(manager.getHistory(sessionId)).toEqual([]);
		});

		it('resets an idle session while another session is active', async () => {
			const sessionLock = new SessionLock();
			const manager = new HistoryManager({ sessionLock });
			const activeSessionId = asSessionId('active-session');
			const idleSessionId = asSessionId('idle-session');
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			manager.addThought(createTestThought({ thought: 'remove', session_id: idleSessionId }));
			const activeOperation = sessionLock.withLock(activeSessionId, async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;

			await manager.resetSession(idleSessionId);

			expect(manager.getHistory(idleSessionId)).toEqual([]);
			release.resolve();
			await activeOperation;
		});
	});

	describe('shutdown', () => {
		it('should flush remaining buffer on shutdown', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));
			expect(manager.getWriteBufferLength()).toBe(2);

			await manager.shutdown();
			expect(manager.getWriteBufferLength()).toBe(0);
			expect(await persistence.loadHistoryForSession(SESSION_ID)).toHaveLength(2);
		});
	});

	describe('Utility methods', () => {
		it('should report persistence enabled state', () => {
			const withP = new HistoryManager({ persistence: new MockPersistence() });
			expect(withP.isPersistenceEnabled()).toBe(true);

			const withoutP = new HistoryManager({ persistence: null });
			expect(withoutP.isPersistenceEnabled()).toBe(false);
		});

		it('should expose the persistence backend', () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({ persistence });
			expect(manager.getPersistenceBackend()).toBe(persistence);
		});

		it('should expose write buffer length for monitoring', () => {
			const manager = new HistoryManager({
				persistence: new MockPersistence(),
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			expect(manager.getWriteBufferLength()).toBe(0);
			manager.addThought(createTestThought({ thought_number: 1 }));
			expect(manager.getWriteBufferLength()).toBe(1);
		});

		it('should register summary snapshots with the session drain coordinator', async () => {
			const persistence = new MockPersistence();
			const saveSummaries = vi.spyOn(persistence, 'saveSummaries');
			const manager = new HistoryManager({ persistence });
			const sessionId = asSessionId('summary-session');

			manager.bufferSummaries(sessionId, []);
			await manager.drainSession(sessionId);

			expect(saveSummaries).toHaveBeenCalledWith(sessionId, []);
		});
	});

	describe('merge topology tracking', () => {
		it('should store thoughts with merge metadata', () => {
			const manager = new HistoryManager();
			const thought = createTestThought({
				merge_from_thoughts: [1, 3],
				merge_branch_ids: ['branch-a', 'branch-b'].map(asBranchId),
			});
			manager.addThought(thought);

			const history = manager.getHistory(SESSION_ID);
			expect(history[history.length - 1]?.merge_from_thoughts).toEqual([1, 3]);
			expect(history[history.length - 1]?.merge_branch_ids).toEqual(['branch-a', 'branch-b']);
		});

		it('should store thoughts without merge metadata normally', () => {
			const manager = new HistoryManager();
			const thought = createTestThought();
			manager.addThought(thought);

			const history = manager.getHistory(SESSION_ID);
			expect(history[history.length - 1]?.merge_from_thoughts).toBeUndefined();
			expect(history[history.length - 1]?.merge_branch_ids).toBeUndefined();
		});
	});

	describe('session partitioning', () => {
		it('rejects a runtime thought with an omitted session_id before creating history', () => {
			const manager = new HistoryManager();
			const thought = createTestThought();
			Reflect.deleteProperty(thought, 'session_id');

			expect(() => manager.addThought(thought)).toThrow(ValidationError);
			expect(manager.getSessionIds()).toEqual([]);
			expect(manager.getHistory(SESSION_ID)).toEqual([]);
		});

		it('rejects the retired runtime global session_id before creating history', () => {
			const manager = new HistoryManager();
			const thought = createTestThought();
			Reflect.set(thought, 'session_id', '__global__');

			expect(() => manager.addThought(thought)).toThrow(ValidationError);
			expect(manager.getSessionIds()).toEqual([]);
			expect(manager.getHistory(SESSION_ID)).toEqual([]);
		});

		it('creates isolated sessions with different session_ids', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'session-a' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'session-b' }));

			expect(manager.getHistoryLength(asSessionId('session-a'))).toBe(1);
			expect(manager.getHistoryLength(asSessionId('session-b'))).toBe(1);
		});

		it('uses the thought factory named session explicitly', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));

			expect(manager.getHistoryLength(SESSION_ID)).toBe(1);
		});

		it('returns empty history for new session', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1 }));

			expect(manager.getHistoryLength(asSessionId('new-session'))).toBe(0);
		});

		it('does not leak thoughts between sessions', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a', thought: 'A1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'a', thought: 'A2' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b', thought: 'B1' }));

			const historyA = manager.getHistory(asSessionId('a'));
			const historyB = manager.getHistory(asSessionId('b'));

			expect(historyA).toHaveLength(2);
			expect(historyB).toHaveLength(1);
			expect(historyA[0]!.thought).toBe('A1');
			expect(historyB[0]!.thought).toBe('B1');
		});

		it('does not leak branches between sessions', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'a',
					branch_from_thought: 1,
					branch_id: asBranchId('branch-a'),
				})
			);
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			expect(manager.getBranchIds(asSessionId('a'))).toContain('branch-a');
			expect(manager.getBranchIds(asSessionId('b'))).toHaveLength(0);
		});

		it('tracks available_mcp_tools per session', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'a',
					available_mcp_tools: ['tool-a'],
				})
			);
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'b',
					available_mcp_tools: ['tool-b'],
				})
			);

			expect(manager.getAvailableMcpTools(asSessionId('a'))).toEqual(['tool-a']);
			expect(manager.getAvailableMcpTools(asSessionId('b'))).toEqual(['tool-b']);
		});

		it('tracks available_skills per session', () => {
			const manager = new HistoryManager();
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'a',
					available_skills: ['skill-a'],
				})
			);
			manager.addThought(
				createTestThought({
					thought_number: 1,
					session_id: 'b',
					available_skills: ['skill-b'],
				})
			);

			expect(manager.getAvailableSkills(asSessionId('a'))).toEqual(['skill-a']);
			expect(manager.getAvailableSkills(asSessionId('b'))).toEqual(['skill-b']);
		});

		it('resets only the target session', async () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			await manager.resetSession('a');

			expect(manager.getHistoryLength(asSessionId('a'))).toBe(0);
			expect(manager.getHistoryLength(asSessionId('b'))).toBe(1);
		});

		it('resets all sessions', async () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));
			manager.addThought(createTestThought({ thought_number: 1 }));

			await manager.resetAll();

			expect(manager.getHistoryLength(asSessionId('a'))).toBe(0);
			expect(manager.getHistoryLength(asSessionId('b'))).toBe(0);
			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
		});

		it('getSessionIds() returns all active session IDs', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			const ids = manager.getSessionIds();
			expect(ids).toContain('a');
			expect(ids).toContain('b');
		});

		it('getSessionCount() returns correct count', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			expect(manager.getSessionCount()).toBe(2);
		});
	});

	describe('session TTL eviction', () => {
		it('evicts sessions inactive longer than TTL', async () => {
			useFakeTimers();
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'old' }));
			expect(manager.getHistoryLength(asSessionId('old'))).toBe(1);

			// Advance past TTL (30 minutes) + cleanup interval (5 minutes)
			await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

			// Trigger the 5-minute cleanup timer
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			// The 'old' session should have been cleaned up
			expect(manager.getSessionIds()).not.toContain('old');
		});

		it('evicts every stale named session under the uniform TTL policy', async () => {
			useFakeTimers();
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1 }));

			// Advance well past TTL + cleanup interval
			await vi.advanceTimersByTimeAsync(36 * 60 * 1000);

			expect(manager.getSessionIds()).not.toContain(SESSION_ID);
		});

		it('does not evict recently accessed sessions', () => {
			useFakeTimers();
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'active' }));

			// Advance 20 minutes, then access the session
			vi.advanceTimersByTime(20 * 60 * 1000);
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'active' }));

			// Advance another 20 minutes (40 total, but only 20 since last access)
			vi.advanceTimersByTime(20 * 60 * 1000);

			// Trigger cleanup
			vi.advanceTimersByTime(5 * 60 * 1000);

			expect(manager.getHistoryLength(asSessionId('active'))).toBe(2);
		});
	});

	describe('session LRU eviction', () => {
		it('does not break when creating many sessions', () => {
			const manager = new HistoryManager();

			for (let i = 0; i < 10; i++) {
				manager.addThought(createTestThought({ thought_number: 1, session_id: `session-${i}` }));
			}

			expect(manager.getSessionCount()).toBe(10);
		});

		it('evicts oldest session when MAX_SESSIONS exceeded', () => {
			useFakeTimers();
			const manager = new HistoryManager();

			// MAX_SESSIONS is 100. Create 100 sessions.
			for (let i = 0; i < 100; i++) {
				manager.addThought(createTestThought({ thought_number: 1, session_id: `s-${i}` }));
				// Small time advance to ensure distinct lastAccessedAt
				vi.advanceTimersByTime(1);
			}

			expect(manager.getSessionCount()).toBe(100);

			// Creating the 101st session should evict the oldest (s-0)
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'overflow' }));

			expect(manager.getSessionCount()).toBe(100);
			expect(manager.getSessionIds()).not.toContain('s-0');
			expect(manager.getSessionIds()).toContain('overflow');
		});
	});

	describe('session persistence', () => {
		it('awaitably resets only the requested durable and live session', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});
			manager.addThought(createTestThought({ thought: 'a-old', session_id: 'a' }));
			manager.addThought(createTestThought({ thought: 'b-keep', session_id: 'b' }));
			await manager._flushBuffer();

			await manager.resetSession('a');

			expect(manager.getHistoryLength('a')).toBe(0);
			expect(manager.getHistory('b').map((thought) => thought.thought)).toEqual(['b-keep']);
			expect(await persistence.loadHistoryForSession(asSessionId('a'))).toEqual([]);
			expect(await persistence.loadHistoryForSession(asSessionId('b'))).toHaveLength(1);
			await manager.shutdown();
		});

		it('buffers writes per session', () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			expect(manager.getWriteBufferLength()).toBe(2);
		});

		it('flushes all session buffers on shutdown', async () => {
			const persistence = new MockPersistence();
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
			});

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b' }));

			await manager.shutdown();

			expect(manager.getWriteBufferLength()).toBe(0);
			expect(await persistence.loadHistoryForSession(asSessionId('a'))).toHaveLength(1);
			expect(await persistence.loadHistoryForSession(asSessionId('b'))).toHaveLength(1);
		});

		it('resetSession removes specific session data', async () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'x' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'y' }));

			await manager.resetSession('x');

			expect(manager.getHistoryLength(asSessionId('x'))).toBe(0);
			expect(manager.getHistoryLength(asSessionId('y'))).toBe(1);
		});
	});

	describe('explicit named session', () => {
		it('all session-scoped operations use the named identity', async () => {
			const manager = new HistoryManager();

			manager.addThought(createTestThought({ thought_number: 1 }));
			manager.addThought(createTestThought({ thought_number: 2 }));

			expect(manager.getHistoryLength(SESSION_ID)).toBe(2);
			expect(manager.getHistory(SESSION_ID)).toHaveLength(2);
			expect(manager.getBranchIds(SESSION_ID)).toEqual([]);

			await manager.resetAll();
			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
		});

		it('getBranch returns undefined for non-existent branch across sessions', () => {
			const manager = new HistoryManager();
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a' }));

			expect(manager.getBranch(asBranchId('non-existent'), asSessionId('a'))).toBeUndefined();
			expect(manager.getBranch(asBranchId('non-existent'), asSessionId('b'))).toBeUndefined();
		});

		it('getAvailableMcpTools returns undefined for fresh session', () => {
			const manager = new HistoryManager();

			expect(manager.getAvailableMcpTools(asSessionId('nonexistent'))).toBeUndefined();
			expect(manager.getAvailableSkills(asSessionId('nonexistent'))).toBeUndefined();
		});
	});
});

describe('ABSOLUTE_MAX_HISTORY_SIZE cap', () => {
	it('should export ABSOLUTE_MAX_HISTORY_SIZE as 10000', () => {
		expect(ABSOLUTE_MAX_HISTORY_SIZE).toBe(10_000);
	});

	it('should cap maxHistorySize to ABSOLUTE_MAX_HISTORY_SIZE when config exceeds it', () => {
		const manager = new HistoryManager({ maxHistorySize: 50_000 });
		expect((manager as unknown as HistoryManagerTestAccess)._maxHistorySize).toBe(10_000);
	});

	it('should not alter maxHistorySize when within cap', () => {
		const manager = new HistoryManager({ maxHistorySize: 500 });
		expect((manager as unknown as HistoryManagerTestAccess)._maxHistorySize).toBe(500);
	});

	it('should use default 10000 when no config provided', () => {
		const manager = new HistoryManager({});
		expect((manager as unknown as HistoryManagerTestAccess)._maxHistorySize).toBe(10_000);
	});

	it('should log warning when capping occurs', () => {
		const mockLogger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			setLevel: vi.fn(),
			getLevel: vi.fn(),
		} as Logger;
		new HistoryManager({ maxHistorySize: 50_000, logger: mockLogger });
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'maxHistorySize exceeds absolute maximum, capped',
			expect.objectContaining({ requested: 50_000, applied: 10_000 })
		);
	});
});

describe('HistoryManager — uncovered branches', () => {
	afterEach(() => {
		useRealTimers();
	});

	describe('backpressure logging (line 382)', () => {
		it('should log backpressure warning when buffer is full and flush is in progress', async () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			// Hold the first write so the coordinator keeps one drain generation active.
			let resolveSave!: () => void;
			const savePromise = new Promise<void>((resolve) => {
				resolveSave = resolve;
			});
			persistence.saveThoughtForSession = async () => {
				await savePromise;
			};
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			} as Logger;
			const manager = new HistoryManager({
				persistence,
				persistenceBufferSize: 1,
				persistenceFlushInterval: 60000,
				logger: mockLogger,
			});

			// Thought 1 reaches capacity and starts the blocked generation.
			manager.addThought(createTestThought({ thought_number: 1 }));
			await vi.advanceTimersByTimeAsync(0);

			// Later capacity triggers join that generation while accepted work remains queued.
			manager.addThought(createTestThought({ thought_number: 2 }));

			// The next acceptance observes a full coordinator-owned queue and logs backpressure.
			manager.addThought(createTestThought({ thought_number: 3 }));

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Write buffer full and flush in progress, applying backpressure',
				expect.objectContaining({
					bufferSize: expect.any(Number),
					maxSize: 1,
				})
			);

			// Unblock the joined generation.
			resolveSave();
			await vi.advanceTimersByTimeAsync(0);
			await manager.shutdown();
		});
	});

	describe('loadFromPersistence failure propagation', () => {
		it('T10-I05 should propagate Error failures during scoped load', async () => {
			const persistence = new MockPersistence();
			// healthy returns true, but loadHistory throws
			persistence.listSessions = async () => [SESSION_ID];
			persistence.loadHistoryForSession = async () => {
				throw new Error('Disk I/O error');
			};
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			} as Logger;
			const manager = new HistoryManager({ persistence, logger: mockLogger });

			await expect(manager.loadFromPersistence()).rejects.toThrow('Disk I/O error');
			expect(mockLogger.info).not.toHaveBeenCalled();
			expect(manager.getHistoryLength(SESSION_ID)).toBe(0);
		});

		it('T10-I06 should propagate non-Error failures during scoped load', async () => {
			const persistence = new MockPersistence();
			persistence.listSessions = async () => [SESSION_ID];
			persistence.loadHistoryForSession = async () => {
				throw 'string error';
			};
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			} as Logger;
			const manager = new HistoryManager({ persistence, logger: mockLogger });

			await expect(manager.loadFromPersistence()).rejects.toBe('string error');
			expect(mockLogger.info).not.toHaveBeenCalled();
		});
	});

	describe('_startFlushTimer early return (line 745)', () => {
		it('should not create a second flush timer if one already exists', () => {
			useFakeTimers();
			const persistence = new MockPersistence();
			// Constructor starts flush timer when persistence is enabled
			const manager = new HistoryManager({ persistence });

			// Access private _flushTimer to verify it's set
			const timer1 = (manager as unknown as { _flushTimer: ReturnType<typeof setInterval> | null })
				._flushTimer;
			expect(timer1).not.toBeNull();

			// Calling _startFlushTimer again should be a no-op
			(manager as unknown as { _startFlushTimer: () => void })._startFlushTimer();

			const timer2 = (manager as unknown as { _flushTimer: ReturnType<typeof setInterval> | null })
				._flushTimer;
			expect(timer2).toBe(timer1);

			manager.shutdown();
		});
	});

	describe('infeasible admission', () => {
		it('rejects without exceeding capacity when no complete named-session victim set exists', () => {
			const manager = new HistoryManager({});

			// Access private _sessions map directly
			const sessions = (manager as unknown as { _sessions: Map<string, unknown> })._sessions;

			manager.addThought(createTestThought({ thought_number: 1 }));

			const originalMaxSessions = (HistoryManager as unknown as { MAX_SESSIONS: number })
				.MAX_SESSIONS;
			Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
				value: 0,
				writable: true,
				configurable: true,
			});

			try {
				expect(() =>
					manager.addThought(createTestThought({ thought_number: 2, session_id: 'trigger' }))
				).toThrow('Max sessions');
				expect([...sessions.keys()]).toEqual([SESSION_ID]);
			} finally {
				Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
					value: originalMaxSessions,
					writable: true,
					configurable: true,
				});
			}
		});
	});

	describe('session eviction interactions with EdgeStore', () => {
		it('TTL eviction clears matching EdgeStore entries', async () => {
			useFakeTimers();
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore, dagEdges: true });

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'old', id: 'old-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'old', id: 'old-2' }));
			const sizeBefore = edgeStore.size(asSessionId('old'));
			expect(sizeBefore).toBeGreaterThan(0);

			// Trigger TTL eviction
			await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			// Session is gone from manager...
			expect(manager.getSessionIds()).not.toContain('old');
			expect(edgeStore.size(asSessionId('old'))).toBe(0);
		});

		it('LRU eviction clears matching EdgeStore entries', () => {
			useFakeTimers();
			// MAX_SESSIONS is private — override via defineProperty (default is 100)
			Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
				value: 2,
				writable: true,
				configurable: true,
			});
			try {
				const edgeStore = new EdgeStore();
				const manager = new HistoryManager({ edgeStore, dagEdges: true });

				manager.addThought(createTestThought({ thought_number: 1, session_id: 's1', id: 's1-1' }));
				vi.advanceTimersByTime(1);
				manager.addThought(createTestThought({ thought_number: 2, session_id: 's1', id: 's1-2' }));
				vi.advanceTimersByTime(1);
				manager.addThought(createTestThought({ thought_number: 1, session_id: 's2', id: 's2-1' }));
				vi.advanceTimersByTime(1);

				const s1EdgesBefore = edgeStore.size(asSessionId('s1'));
				expect(s1EdgesBefore).toBeGreaterThan(0);

				manager.addThought(createTestThought({ thought_number: 1, session_id: 's3', id: 's3-1' }));

				expect(manager.getSessionIds()).not.toContain('s1');
				expect(edgeStore.size(asSessionId('s1'))).toBe(0);
			} finally {
				Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
					value: 100,
					writable: true,
					configurable: true,
				});
			}
		});

		it('resetSession() actively clears the EdgeStore for that session', async () => {
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore, dagEdges: true });

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'a', id: 'a-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'a', id: 'a-2' }));
			manager.addThought(createTestThought({ thought_number: 1, session_id: 'b', id: 'b-1' }));
			expect(edgeStore.size(asSessionId('a'))).toBeGreaterThan(0);

			await manager.resetSession('a');

			expect(edgeStore.size(asSessionId('a'))).toBe(0);
			// Other session edges untouched
			expect(edgeStore.size(asSessionId('b'))).toBeGreaterThanOrEqual(0);
		});
	});

	describe('persistence saveEdges failure isolation', () => {
		it('surfaces edge failure after independent thought writes succeed', async () => {
			const persistence = new MockPersistence();
			// Override saveEdges to always throw
			let edgeSaveAttempts = 0;
			persistence.saveEdges = async (): Promise<void> => {
				edgeSaveAttempts++;
				throw new Error('Edge save failed');
			};
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({
				persistence,
				edgeStore,
				dagEdges: true,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});
			const sessionId = asSessionId('x');

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'x', id: 'x-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'x', id: 'x-2' }));
			await expect(manager.shutdown()).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [{ kind: 'edge', sessionId, attempts: 1 }],
			});

			const persisted = await persistence.loadHistoryForSession(sessionId);
			expect(persisted).toHaveLength(2);
			expect(edgeSaveAttempts).toBe(1);
		});

		it('saveThought failure does not block subsequent edge save attempts', async () => {
			const persistence = new MockPersistence();
			persistence.saveThoughtFailCount = 100; // fail all retries
			let edgeAttempts = 0;
			persistence.saveEdges = async (): Promise<void> => {
				edgeAttempts++;
			};
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({
				persistence,
				edgeStore,
				dagEdges: true,
				persistenceBufferSize: 100,
				persistenceFlushInterval: 60000,
				persistenceMaxRetries: 0,
			});
			const sessionId = asSessionId('y');

			manager.addThought(createTestThought({ thought_number: 1, session_id: 'y', id: 'y-1' }));
			manager.addThought(createTestThought({ thought_number: 2, session_id: 'y', id: 'y-2' }));
			await expect(manager.shutdown()).rejects.toMatchObject({
				name: 'PersistenceDrainError',
				failures: [
					{ kind: 'thought', sessionId, attempts: 1 },
					{ kind: 'thought', sessionId, attempts: 1 },
				],
			});

			expect(edgeAttempts).toBe(1);
		});
	});
});

describe('HistoryManager — declarative branch registration', () => {
	afterEach(() => {
		useRealTimers();
	});

	it('registerBranch creates an empty branch that branchExists detects', () => {
		const manager = new HistoryManager();
		expect(manager.branchExists(SESSION_ID, asBranchId('alt-1'))).toBe(false);

		manager.registerBranch(SESSION_ID, asBranchId('alt-1'));

		expect(manager.branchExists(SESSION_ID, asBranchId('alt-1'))).toBe(true);
		expect(manager.getBranchIds(SESSION_ID)).toContain('alt-1');
		// Registered-only branches do not have thoughts attached
		expect(manager.getBranch(asBranchId('alt-1'), SESSION_ID)).toBeUndefined();
	});

	it('branchExists returns true for branches created via addThought', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({
				thought_number: 1,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-2'),
			})
		);
		expect(manager.branchExists(SESSION_ID, asBranchId('alt-2'))).toBe(true);
	});

	it('registerBranch throws ValidationError on duplicate (existing thought-backed branch)', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({ thought_number: 1, branch_from_thought: 1, branch_id: asBranchId('dup') })
		);

		expect(() => manager.registerBranch(SESSION_ID, asBranchId('dup'))).toThrowError(
			/Branch already exists: dup/
		);
	});

	it('registerBranch throws ValidationError on duplicate (already registered)', () => {
		const manager = new HistoryManager();
		manager.registerBranch(SESSION_ID, asBranchId('alt-3'));

		expect(() => manager.registerBranch(SESSION_ID, asBranchId('alt-3'))).toThrowError(
			/Branch already exists: alt-3/
		);
	});

	it('registerBranch throws ValidationError on empty branchId', () => {
		const manager = new HistoryManager();
		expect(() => manager.registerBranch(SESSION_ID, asBranchId(''))).toThrowError(
			/branch_id must be a non-empty string/
		);
	});

	it('registerBranch is session-scoped (independent across sessions)', () => {
		const manager = new HistoryManager();
		manager.registerBranch(asSessionId('session-a'), asBranchId('shared-name'));

		expect(manager.branchExists(asSessionId('session-a'), asBranchId('shared-name'))).toBe(true);
		expect(manager.branchExists(asSessionId('session-b'), asBranchId('shared-name'))).toBe(false);

		// Same name can be registered in a different session without conflict
		expect(() =>
			manager.registerBranch(asSessionId('session-b'), asBranchId('shared-name'))
		).not.toThrow();
		expect(manager.branchExists(asSessionId('session-b'), asBranchId('shared-name'))).toBe(true);
	});

	it('getBranchIds merges thought-backed and registered branches without duplicates', () => {
		const manager = new HistoryManager();
		manager.addThought(
			createTestThought({
				thought_number: 1,
				branch_from_thought: 1,
				branch_id: asBranchId('with-thoughts'),
			})
		);
		manager.registerBranch(SESSION_ID, asBranchId('registered-only'));

		const ids = manager.getBranchIds(SESSION_ID);
		expect(ids).toContain('with-thoughts');
		expect(ids).toContain('registered-only');
		expect(new Set(ids).size).toBe(ids.length);
	});
});
