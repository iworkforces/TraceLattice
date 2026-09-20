import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	asBranchId,
	asSessionId,
	asSummaryId,
	asThoughtId,
	type SessionId,
} from '../../contracts/ids.js';
import type { ICalibrator } from '../../contracts/calibrator.js';
import type { IOutcomeRecorder } from '../../contracts/interfaces.js';
import type { Summary } from '../../core/compression/Summary.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { SessionLifecycleCoordinator } from '../../core/SessionLifecycleCoordinator.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { runWithContext } from '../../context/RequestContext.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { createTestThought } from '../helpers/factories.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function thought(sessionId: string, number: number, id = `${sessionId}-${number}`) {
	return createTestThought({
		id,
		session_id: sessionId,
		thought: `thought ${number}`,
		thought_number: number,
		total_thoughts: 10,
		next_thought_needed: true,
	});
}

function summary(sessionId: SessionId): Summary {
	return {
		id: asSummaryId(`${sessionId}-summary`),
		sessionId,
		rootThoughtId: asThoughtId(`${sessionId}-root`),
		coveredIds: [asThoughtId(`${sessionId}-root`)],
		coveredRange: [1, 1],
		topics: ['lifecycle'],
		aggregateConfidence: 0.8,
		createdAt: 1,
	};
}

function seedFittedCalibration(
	recorder: IOutcomeRecorder,
	calibrator: ICalibrator,
	sessionId: SessionId
): void {
	for (let index = 0; index < 10; index++) {
		recorder.recordVerification({
			thoughtId: asThoughtId(`${sessionId}-outcome-${index}`),
			sessionId,
			predicted: 0.99,
			actual: 0,
			type: 'verification',
		});
	}
	calibrator.refit(sessionId);
}

describe('session lifecycle integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('drains accepted persistence before TTL cleanup and preserves durable history', async () => {
		const sessionId = asSessionId('ttl-session');
		const persistence = new MemoryPersistence();
		const saveStarted = Promise.withResolvers<void>();
		const allowSave = Promise.withResolvers<void>();
		const originalSave = persistence.saveThoughtForSession.bind(persistence);
		vi.spyOn(persistence, 'saveThoughtForSession').mockImplementation(async (...args) => {
			saveStarted.resolve();
			await allowSave.promise;
			await originalSave(...args);
		});
		const lifecycle = new SessionLifecycleCoordinator();
		const manager = new HistoryManager({
			persistence,
			persistenceFlushInterval: 60_000_000,
			lifecycleCoordinator: lifecycle,
		});
		manager.addThought(thought(sessionId, 1));

		await vi.advanceTimersByTimeAsync(SESSION_TTL_MS + CLEANUP_INTERVAL_MS + 1);
		await saveStarted.promise;
		expect(manager.getSessionIds()).toContain(sessionId);

		allowSave.resolve();
		await vi.waitFor(() => expect(manager.getSessionIds()).not.toContain(sessionId));
		expect(await persistence.loadHistoryForSession(sessionId)).toHaveLength(1);
		await manager.shutdown();
		const restored = new HistoryManager({
			persistence,
			persistenceFlushInterval: 60_000_000,
		});
		await restored.loadFromPersistence();
		expect(restored.inspectSession(sessionId).history).toHaveLength(1);
		await restored.shutdown();
	});

	it('retains and quarantines a stale session when its persistence drain fails', async () => {
		const sessionId = asSessionId('failed-drain');
		const persistence = new MemoryPersistence();
		vi.spyOn(persistence, 'saveThoughtForSession').mockRejectedValue(new Error('write failed'));
		const lifecycle = new SessionLifecycleCoordinator();
		const manager = new HistoryManager({
			persistence,
			persistenceMaxRetries: 0,
			persistenceFlushInterval: 60_000_000,
			lifecycleCoordinator: lifecycle,
		});
		manager.addThought(thought(sessionId, 1));

		await vi.advanceTimersByTimeAsync(SESSION_TTL_MS + CLEANUP_INTERVAL_MS + 1);
		await vi.waitFor(() => expect(lifecycle.phaseFor(sessionId)).toBe('eviction_failed'));

		expect(manager.getSessionIds()).toContain(sessionId);
		expect(manager.getWriteBufferLength()).toBe(1);
		await expect(manager.shutdown()).rejects.toThrow('Persistence drain failed');
	});

	it('does not evict an active stale session', async () => {
		const sessionId = asSessionId('active-session');
		const lifecycle = new SessionLifecycleCoordinator();
		const manager = new HistoryManager({ lifecycleCoordinator: lifecycle });
		manager.addThought(thought(sessionId, 1));
		const release = Promise.withResolvers<void>();
		const active = lifecycle.runOperation(sessionId, async () => await release.promise);

		await vi.advanceTimersByTimeAsync(SESSION_TTL_MS + CLEANUP_INTERVAL_MS + 1);
		expect(manager.getSessionIds()).toContain(sessionId);

		release.resolve();
		await active;
		await manager.shutdown();
	});

	it('enforces exact history, branch, and edge retention bounds', async () => {
		const sessionId = asSessionId('retention');
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			maxHistorySize: 2,
			maxBranches: 1,
			maxBranchSize: 1,
			edgeStore,
			dagEdges: true,
		});
		manager.addThought(thought(sessionId, 1));
		manager.addThought(thought(sessionId, 2));
		manager.addThought({
			...thought(sessionId, 3),
			branch_from_thought: 2,
			branch_id: asBranchId('kept'),
		});
		manager.addThought({
			...thought(sessionId, 4),
			branch_from_thought: 3,
			branch_id: asBranchId('kept'),
		});

		expect(manager.getHistory(sessionId)).toHaveLength(2);
		expect(manager.getBranch(asBranchId('kept'), sessionId)).toHaveLength(1);
		expect(edgeStore.edgesForSession(sessionId)).toEqual([
			expect.objectContaining({ from: 'retention-3', to: 'retention-4' }),
		]);
		await manager.shutdown();
	});

	it('treats maxBranches zero as exact live retention and durably deletes the branch', async () => {
		const sessionId = asSessionId('zero-live');
		const branchId = asBranchId('removed');
		const persistence = new MemoryPersistence();
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			maxBranches: 0,
			persistence,
			edgeStore,
			dagEdges: true,
			persistenceFlushInterval: 60_000_000,
		});
		manager.addThought(thought(sessionId, 1));
		manager.addThought({
			...thought(sessionId, 2),
			branch_from_thought: 1,
			branch_id: branchId,
		});

		expect(manager.getBranchIds(sessionId)).toEqual([]);
		expect(edgeStore.edgesForSession(sessionId)).toEqual([]);
		await manager._flushBuffer();
		expect(await persistence.loadBranchForSession(sessionId, branchId)).toBeUndefined();
		await manager.shutdown();
	});

	it('excludes a registered-only branch from every public view when maxBranches is zero', async () => {
		// Given
		const sessionId = asSessionId('zero-registered');
		const branchId = asBranchId('future');
		const server = await createServer({
			config: new ServerConfig({ maxBranches: 0 }),
			autoDiscover: false,
			loadFromPersistence: false,
		});

		// When
		const result = await server.processThought({
			thought: 'registration must respect the exact zero bound',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: sessionId,
			register_branch_id: branchId,
		});

		// Then
		expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ branches: [] });
		expect(server.history.getBranchIds(sessionId)).toEqual([]);
		expect(server.history.inspectSession(sessionId).branchIds).toEqual([]);
		expect(server.history.branchExists(sessionId, branchId)).toBe(false);
		await server.dispose();
	});

	it('evicts identities by first admission across registration and thought-backed creation', async () => {
		// Given
		const sessionId = asSessionId('mixed-identity-order');
		const oldest = asBranchId('oldest');
		const second = asBranchId('second');
		const newest = asBranchId('newest');
		const manager = new HistoryManager({ maxBranches: 2 });
		manager.registerBranch(sessionId, oldest);
		manager.addThought({
			...thought(sessionId, 1),
			branch_from_thought: 1,
			branch_id: second,
		});

		// When
		manager.addThought({
			...thought(sessionId, 2),
			branch_from_thought: 1,
			branch_id: oldest,
		});
		manager.registerBranch(sessionId, newest);

		// Then
		expect(manager.getBranchIds(sessionId)).toEqual([second, newest]);
		expect(Object.keys(manager.getBranches(sessionId))).toEqual([second]);
		expect(manager.inspectSession(sessionId).branchIds).toEqual([second, newest]);
		expect(Object.keys(manager.inspectSession(sessionId).branches)).toEqual([second]);
		expect(manager.branchExists(sessionId, oldest)).toBe(false);
		expect(manager.branchExists(sessionId, second)).toBe(true);
		expect(manager.branchExists(sessionId, newest)).toBe(true);
		expect(manager.getBranch(oldest, sessionId)).toBeUndefined();
		await manager.shutdown();
	});

	it('persists the survivor before deleting the evicted branch and pruned edges', async () => {
		const sessionId = asSessionId('branch-replacement');
		const staleBranch = asBranchId('z');
		const liveBranch = asBranchId('a');
		const events: string[] = [];
		const persistence = new (class extends MemoryPersistence {
			override async saveBranchForSession(
				currentSessionId: SessionId,
				branchId: ReturnType<typeof asBranchId>,
				thoughts: readonly ReturnType<typeof thought>[]
			): Promise<void> {
				events.push(`save:${branchId}`);
				await super.saveBranchForSession(currentSessionId, branchId, thoughts);
			}

			override async deleteBranchForSession(
				currentSessionId: SessionId,
				branchId: ReturnType<typeof asBranchId>
			): Promise<void> {
				events.push(`delete:${branchId}`);
				await super.deleteBranchForSession(currentSessionId, branchId);
			}

			override async saveEdges(
				currentSessionId: SessionId,
				edges: Parameters<MemoryPersistence['saveEdges']>[1]
			): Promise<void> {
				events.push('edges');
				await super.saveEdges(currentSessionId, edges);
			}
		})();
		await persistence.saveBranchForSession(sessionId, staleBranch, [
			{ ...thought(sessionId, 1), branch_id: staleBranch },
		]);
		events.length = 0;
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			maxBranches: 1,
			persistence,
			edgeStore,
			dagEdges: true,
			persistenceFlushInterval: 60_000_000,
		});
		await manager.loadFromPersistence();
		manager.addThought({
			...thought(sessionId, 2),
			branch_from_thought: 1,
			branch_id: liveBranch,
		});

		await manager._flushBuffer();

		expect(events).toEqual(['save:a', 'delete:z', 'edges']);
		expect(await persistence.loadBranchForSession(sessionId, staleBranch)).toBeUndefined();
		expect(await persistence.loadBranchForSession(sessionId, liveBranch)).toHaveLength(1);
		await manager.shutdown();
		const restarted = new HistoryManager({ maxBranches: 1, persistence });
		await restarted.loadFromPersistence();
		expect(restarted.getBranchIds(sessionId)).toEqual([liveBranch]);
		await restarted.shutdown();
	});

	it('keeps an edge when both endpoints survive in the main and branch retained union', async () => {
		const sessionId = asSessionId('retained-union');
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			maxHistorySize: 1,
			maxBranchSize: 2,
			edgeStore,
			dagEdges: true,
		});
		manager.addThought({
			...thought(sessionId, 1),
			branch_from_thought: 1,
			branch_id: asBranchId('alternate'),
		});
		manager.addThought({
			...thought(sessionId, 2),
			branch_from_thought: 1,
			branch_id: asBranchId('alternate'),
		});

		expect(manager.getHistory(sessionId).map((entry) => entry.id)).toEqual(['retained-union-2']);
		expect(manager.getBranch(asBranchId('alternate'), sessionId)?.map((entry) => entry.id)).toEqual(
			['retained-union-1', 'retained-union-2']
		);
		expect(edgeStore.edgesForSession(sessionId)).toEqual([
			expect.objectContaining({ from: 'retained-union-1', to: 'retained-union-2' }),
		]);
		await manager.shutdown();
	});

	it('prunes persisted edges even when pruning leaves an empty snapshot', async () => {
		const sessionId = asSessionId('empty-edges');
		const persistence = new MemoryPersistence();
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			maxHistorySize: 1,
			edgeStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000_000,
		});
		manager.addThought(thought(sessionId, 1));
		manager.addThought(thought(sessionId, 2));
		await manager._flushBuffer();

		expect(edgeStore.size(sessionId)).toBe(0);
		expect(await persistence.loadEdges(sessionId)).toEqual([]);
		await manager.shutdown();
	});

	it('cleans every registered live auxiliary when TTL evicts a session', async () => {
		const sessionId: SessionId = asSessionId('auxiliary-session');
		const clearAuxiliaryState = vi.fn();
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			edgeStore,
			lifecycleCoordinator: new SessionLifecycleCoordinator(),
			clearSessionAuxiliaryState: clearAuxiliaryState,
		});
		manager.addThought(thought(sessionId, 1));
		manager.addThought(thought(sessionId, 2));

		await vi.advanceTimersByTimeAsync(SESSION_TTL_MS + CLEANUP_INTERVAL_MS + 1);
		await vi.waitFor(() => expect(manager.getSessionIds()).not.toContain(sessionId));

		expect(clearAuxiliaryState).toHaveBeenCalledExactlyOnceWith(sessionId);
		expect(edgeStore.size(sessionId)).toBe(0);
		await manager.shutdown();
	});

	it('clears recorded outcomes, duplicate keys, and fitted temperature on TTL eviction', async () => {
		const sessionId = asSessionId('ttl-calibration');
		const server = await createServer({
			config: new ServerConfig({
				features: { outcomeRecording: true, calibration: true },
			}),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const recorder = server.getContainer().resolve('outcomeRecorder');
		const calibrator = server.getContainer().resolve('calibrator');
		server.history.addThought(thought(sessionId, 1));
		seedFittedCalibration(recorder, calibrator, sessionId);
		expect(calibrator.calibrate(0.9, 'verification', sessionId).temperature).toBeGreaterThan(1);

		await vi.advanceTimersByTimeAsync(SESSION_TTL_MS + CLEANUP_INTERVAL_MS + 1);
		await vi.waitFor(() => expect(server.history.getSessionIds()).not.toContain(sessionId));

		expect(recorder.getOutcomes(sessionId)).toEqual([]);
		expect(() =>
			recorder.assertCanRecord(sessionId, asThoughtId(`${sessionId}-outcome-0`))
		).not.toThrow();
		expect(calibrator.calibrate(0.9, 'verification', sessionId).temperature).toBe(1);
		await server.stop();
	});

	it('clears calibration state when owner capacity removes the least-recent session', async () => {
		const removedSession = asSessionId('owner-removed');
		const retainedSession = asSessionId('owner-retained');
		const server = await createServer({
			config: new ServerConfig({
				maxSessionsPerOwner: 1,
				features: { outcomeRecording: true, calibration: true },
			}),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const recorder = server.getContainer().resolve('outcomeRecorder');
		const calibrator = server.getContainer().resolve('calibrator');
		await runWithContext({ requestId: 'first', owner: 'owner' }, () =>
			server.processThought({
				thought: 'first owner session',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: removedSession,
			})
		);
		seedFittedCalibration(recorder, calibrator, removedSession);

		await runWithContext({ requestId: 'second', owner: 'owner' }, () =>
			server.processThought({
				thought: 'replacement owner session',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: retainedSession,
			})
		);

		expect(server.history.getSessionIds()).not.toContain(removedSession);
		expect(server.history.getSessionIds()).toContain(retainedSession);
		expect(recorder.getOutcomes(removedSession)).toEqual([]);
		expect(() =>
			recorder.assertCanRecord(removedSession, asThoughtId(`${removedSession}-outcome-0`))
		).not.toThrow();
		expect(calibrator.calibrate(0.9, 'verification', removedSession).temperature).toBe(1);
		await server.stop();
	});

	it('uses deterministic owner LRU and rejects admission when the required victim is active', async () => {
		const lifecycle = new SessionLifecycleCoordinator();
		const clearAuxiliaryState = vi.fn();
		const manager = new HistoryManager({
			maxSessionsPerOwner: 2,
			lifecycleCoordinator: lifecycle,
			clearSessionAuxiliaryState: clearAuxiliaryState,
		});
		const add = (sessionId: string, number: number): void =>
			runWithContext({ requestId: sessionId, owner: 'owner-a' }, () =>
				manager.addThought(thought(sessionId, number))
			);
		add('owner-old', 1);
		vi.setSystemTime(1);
		add('owner-new', 1);
		vi.setSystemTime(2);
		add('owner-third', 1);

		expect(manager.getSessionIds()).toEqual(['owner-new', 'owner-third']);
		expect(clearAuxiliaryState).toHaveBeenCalledExactlyOnceWith(asSessionId('owner-old'));

		const release = Promise.withResolvers<void>();
		const activeNew = lifecycle.runOperation(
			asSessionId('owner-new'),
			async () => await release.promise
		);
		const activeThird = lifecycle.runOperation(
			asSessionId('owner-third'),
			async () => await release.promise
		);
		expect(() => add('owner-rejected', 1)).toThrow('Max sessions');
		expect(manager.getSessionIds()).toEqual(['owner-new', 'owner-third']);
		release.resolve();
		await Promise.all([activeNew, activeThird]);
		await manager.shutdown();
	});

	it('enforces the global bound without transiently exceeding it', async () => {
		const originalMaxSessions = (HistoryManager as unknown as { MAX_SESSIONS: number })
			.MAX_SESSIONS;
		Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
			value: 2,
			writable: true,
			configurable: true,
		});
		try {
			const manager = new HistoryManager();
			manager.addThought(thought('global-old', 1));
			vi.setSystemTime(1);
			manager.addThought(thought('global-new', 1));
			vi.setSystemTime(2);
			manager.addThought(thought('global-third', 1));

			expect(manager.getSessionIds()).toEqual(['global-new', 'global-third']);
			expect(manager.getSessionCount()).toBe(2);
			await manager.shutdown();
		} finally {
			Object.defineProperty(HistoryManager, 'MAX_SESSIONS', {
				value: originalMaxSessions,
				writable: true,
				configurable: true,
			});
		}
	});

	it('cleans scoped auxiliary state during explicit reset', async () => {
		const sessionId = asSessionId('explicit-reset');
		const clearAuxiliaryState = vi.fn();
		const edgeStore = new EdgeStore();
		const manager = new HistoryManager({
			edgeStore,
			lifecycleCoordinator: new SessionLifecycleCoordinator(),
			clearSessionAuxiliaryState: clearAuxiliaryState,
		});
		manager.addThought(thought(sessionId, 1));
		manager.addThought(thought(sessionId, 2));

		await manager.resetSession(sessionId);

		expect(manager.getHistory(sessionId)).toEqual([]);
		expect(edgeStore.size(sessionId)).toBe(0);
		expect(clearAuxiliaryState).toHaveBeenCalledExactlyOnceWith(sessionId);
		await manager.shutdown();
	});

	it('memoizes shutdown, waits for admitted work, and clears live auxiliaries on success', async () => {
		const sessionId = asSessionId('shutdown-session');
		const lifecycle = new SessionLifecycleCoordinator();
		const clearAllAuxiliaryState = vi.fn();
		const manager = new HistoryManager({
			lifecycleCoordinator: lifecycle,
			clearAllAuxiliaryState,
		});
		manager.addThought(thought(sessionId, 1));
		const release = Promise.withResolvers<void>();
		const active = lifecycle.runOperation(sessionId, async () => await release.promise);
		let settled = false;

		const first = manager.shutdown();
		expect(() => manager.addThought(thought(sessionId, 2))).toThrow(
			expect.objectContaining({
				code: 'SESSION_LIFECYCLE_CLOSED',
				phase: 'shutting_down',
			})
		);
		expect(manager.getHistory(sessionId)).toHaveLength(1);
		void first.then(() => {
			settled = true;
		});
		const second = manager.shutdown();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(second).toBe(first);

		release.resolve();
		await active;
		await first;
		expect(manager.getSessionIds()).toEqual([]);
		expect(clearAllAuxiliaryState).toHaveBeenCalledOnce();
		expect(lifecycle.globalPhase).toBe('stopped');
	});

	it('binds one shutdown owner without replacing it', async () => {
		// Given
		const manager = new HistoryManager();
		const ownerSettlement = Promise.withResolvers<void>();
		const firstOwner = vi.fn(() => ownerSettlement.promise);
		const rejectedOwner = vi.fn(async () => undefined);
		manager.bindShutdownOwner(firstOwner);

		// When
		expect(() => manager.bindShutdownOwner(rejectedOwner)).toThrow(TypeError);
		const first = manager.shutdown();
		const repeated = manager.shutdown();

		// Then
		expect(first).toBe(ownerSettlement.promise);
		expect(repeated).toBe(first);
		expect(rejectedOwner).not.toHaveBeenCalled();
		ownerSettlement.resolve();
		await first;
		expect(manager.shutdown()).toBe(first);
		expect(rejectedOwner).not.toHaveBeenCalled();
	});

	it('cleans DI-owned session auxiliaries after successful server shutdown', async () => {
		const sessionId = asSessionId('server-shutdown');
		const server = await createServer({
			config: new ServerConfig({
				persistence: { enabled: true, backend: 'memory' },
				features: { toolInterleave: true, outcomeRecording: true, calibration: true },
			}),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const container = server.getContainer();
		const suspensionStore = container.resolve('suspensionStore');
		const outcomeRecorder = container.resolve('outcomeRecorder');
		const calibrator = container.resolve('calibrator');
		const edgeStore = container.resolve('EdgeStore');
		server.history.addThought(thought(sessionId, 1));
		server.history.addThought(thought(sessionId, 2));
		suspensionStore.suspend({
			sessionId,
			toolCallThoughtNumber: 2,
			toolCallThoughtId: asThoughtId('server-shutdown-2'),
			toolName: 'test-tool',
			toolArguments: {},
			expiresAt: 0,
		});
		seedFittedCalibration(outcomeRecorder, calibrator, sessionId);
		expect(calibrator.calibrate(0.9, 'verification', sessionId).temperature).toBeGreaterThan(1);

		await server.stop();

		expect(server.history.getSessionIds()).toEqual([]);
		expect(edgeStore.size()).toBe(0);
		expect(suspensionStore.size()).toBe(0);
		expect(outcomeRecorder.getAllOutcomes()).toEqual([]);
		expect(() =>
			outcomeRecorder.assertCanRecord(sessionId, asThoughtId(`${sessionId}-outcome-0`))
		).not.toThrow();
		expect(calibrator.metrics(sessionId).sampleCount).toBe(0);
		expect(calibrator.calibrate(0.9, 'verification', sessionId).temperature).toBe(1);
		await server.dispose();
	});

	it('rejects summary persistence synchronously after server stop without queue mutation', async () => {
		const sessionId = asSessionId('summary-after-stop');
		const server = await createServer({
			config: new ServerConfig({ persistence: { enabled: true, backend: 'memory' } }),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const persistence = server.history.getPersistenceBackend();

		await server.stop();

		expect(() => server.history.bufferSummaries(sessionId, [summary(sessionId)])).toThrow(
			expect.objectContaining({ code: 'SESSION_LIFECYCLE_CLOSED', phase: 'stopped' })
		);
		expect(server.history.getWriteBufferLength()).toBe(0);
		expect(await persistence?.loadSummaries(sessionId)).toEqual([]);
		await server.dispose();
	});
});
