import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSessionId } from '../../contracts/ids.js';
import { PersistenceWriteTimeoutError } from '../../core/PersistenceBufferErrors.js';
import { SessionLifecycleClosedError } from '../../core/SessionErrors.js';
import { remainingUntil, serverStopDeadlines } from '../../core/ServerStopBudget.js';
import { ServerStopTimeoutError } from '../../errors.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { SkillWatcher } from '../../watchers/SkillWatcher.js';
import { ToolWatcher } from '../../watchers/ToolWatcher.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';

const ownedBackend = vi.hoisted(() => ({ current: null as StallingPersistence | null }));

vi.mock('../../persistence/PersistenceFactory.js', () => ({
	createPersistenceBackend: async () => ownedBackend.current,
}));

const WRITE_TIMEOUT_MS = 1500;
const BUDGET_MS = 3000;
const IDLE_MS = 1000;
/** With a 1200 ms budget and a 1500 ms write timeout: idle ends at 400 ms, flush at 800 ms. */
const SHORT_BUDGET_MS = 1200;
const SHORT_FLUSH_END_MS = 800;
const HELD = 'stop-budget-held';
const OTHER = 'stop-budget-other';

type TrackedStop = { readonly result: Promise<unknown>; readonly isSettled: () => boolean };

const backends = new Set<StallingPersistence>();
const gates = new Set<PromiseWithResolvers<void>>();

function budgetConfig(): ServerConfig {
	return new ServerConfig({
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 0,
		persistenceWriteTimeout: WRITE_TIMEOUT_MS,
		features: { toolInterleave: false },
	});
}

async function createOwnedServer(
	persistence: StallingPersistence
): Promise<ToolAwareSequentialThinkingServer> {
	backends.add(persistence);
	ownedBackend.current = persistence;
	return createServer({
		config: budgetConfig(),
		autoDiscover: false,
		loadFromPersistence: false,
		enableWatcher: false,
	});
}

/** Holds every admitted operation of `sessionId` before its body runs, until the gate opens. */
function holdOperations(
	server: ToolAwareSequentialThinkingServer,
	sessionId: string
): PromiseWithResolvers<void> {
	const gate = Promise.withResolvers<void>();
	gates.add(gate);
	const lifecycle = server.getContainer().resolve('sessionLifecycle');
	const originalRun = lifecycle.runOperation.bind(lifecycle);
	lifecycle.runOperation = (candidate, operation) =>
		originalRun(candidate, async () => {
			if (candidate === sessionId) await gate.promise;
			return operation();
		});
	return gate;
}

function thoughtInput(sessionId: string, thoughtNumber = 1) {
	return {
		thought: `${sessionId} thought ${thoughtNumber}`,
		thought_number: thoughtNumber,
		total_thoughts: 3,
		next_thought_needed: true,
		session_id: sessionId,
	};
}

function trackStop(stopping: Promise<void>): TrackedStop {
	let settled = false;
	const result = stopping.then(
		() => undefined,
		(error: unknown) => error
	);
	void result.then(() => {
		settled = true;
	});
	return { result, isSettled: () => settled };
}

function aggregatedErrors(error: unknown): readonly unknown[] {
	return error instanceof AggregateError ? error.errors : [];
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
	for (const gate of gates) gate.resolve();
	gates.clear();
	for (const backend of backends) {
		backend.holdWrites = false;
		backend.holdClears = false;
		backend.holdClose = false;
		while (backend.heldCallCount > 0) backend.releaseHeldCall();
	}
	backends.clear();
	ownedBackend.current = null;
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('server stop deadlines', () => {
	it('splits the budget into idle, flush and close phases from one start', () => {
		expect(serverStopDeadlines(0, 14_000, 5000)).toEqual({
			idleMs: 4668,
			flushDeadline: 9334,
			closeDeadline: 14_000,
		});
		expect(serverStopDeadlines(100, 1200, 500)).toEqual({
			idleMs: 400,
			flushDeadline: 900,
			closeDeadline: 1300,
		});
		expect(serverStopDeadlines(0, 30_000, 2000)).toEqual({
			idleMs: 26_000,
			flushDeadline: 28_000,
			closeDeadline: 30_000,
		});
		expect(serverStopDeadlines(0, 1, 5000)).toEqual({
			idleMs: 1,
			flushDeadline: 2,
			closeDeadline: 3,
		});
		expect(remainingUntil(10, 4)).toBe(6);
		expect(remainingUntil(10, 12)).toBe(1);
	});
});

describe('bounded server stop', () => {
	it('abandons a held operation at the idle deadline and still flushes and closes', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		await server.processThought(thoughtInput(OTHER));
		const gate = holdOperations(server, HELD);
		const held = server.processThought(thoughtInput(HELD));
		await vi.advanceTimersByTimeAsync(0);

		// When
		const stopping = trackStop(server.stop(BUDGET_MS));
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		const settledBeforeIdle = stopping.isSettled();
		await vi.advanceTimersByTimeAsync(1);
		const errors = aggregatedErrors(await stopping.result);
		const timersAfterStop = vi.getTimerCount();
		gate.resolve();
		const heldResult = await held;

		// Then
		expect(settledBeforeIdle).toBe(false);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(ServerStopTimeoutError);
		expect(errors[0]).toMatchObject({ phase: 'operations', timeoutMs: IDLE_MS, pending: 1 });
		expect(await persistence.loadHistoryForSession(asSessionId(OTHER))).toHaveLength(1);
		expect(persistence.closeCalls).toBe(1);
		expect(timersAfterStop).toBe(0);
		expect(heldResult.isError).toBe(true);
		expect(heldResult.content[0]?.text).toContain('SESSION_LIFECYCLE_CLOSED');
		expect(await persistence.loadHistoryForSession(asSessionId(HELD))).toEqual([]);
		expect(server.history.getWriteBufferLength()).toBe(0);
	});

	it('settles by the budget when every backend call stalls and a reset is in flight', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		await server.processThought(thoughtInput(OTHER));
		persistence.holdWrites = true;
		persistence.holdClears = true;
		persistence.holdClose = true;
		const gate = holdOperations(server, HELD);
		const held = server.processThought(thoughtInput(HELD)).catch(() => undefined);
		await vi.advanceTimersByTimeAsync(0);
		const reset = server.resetSession(HELD).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);

		// When
		const stopping = trackStop(server.stop(BUDGET_MS));
		await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
		const settledBeforeBudget = stopping.isSettled();
		await vi.advanceTimersByTimeAsync(1);
		const settledAtBudget = stopping.isSettled();
		const errors = aggregatedErrors(await stopping.result);

		// Then
		expect(settledBeforeBudget).toBe(false);
		expect(settledAtBudget).toBe(true);
		expect(errors).toHaveLength(3);
		expect(errors[0]).toMatchObject({
			code: 'SERVER_STOP_TIMEOUT',
			phase: 'operations',
			pending: 2,
		});
		expect(errors[1]).toMatchObject({ code: 'SERVER_STOP_TIMEOUT', phase: 'flush', pending: 1 });
		expect(errors[1]).toMatchObject({ timeoutMs: BUDGET_MS / 3 });
		expect(errors[2]).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(errors[2]).toMatchObject({ timeoutMs: BUDGET_MS / 3, call: { kind: 'close' } });
		gate.resolve();
		await held;
		expect(await reset).toBeInstanceOf(SessionLifecycleClosedError);
		await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
		expect(persistence.thoughtAttempts).toBe(1);
		expect(persistence.clearCalls).toBe(0);
		expect(persistence.closeCalls).toBe(1);
		expect(persistence.maxConcurrentCalls).toBe(1);
	});

	it('rejects a reset abandoned by an overrun stop and refuses the reset queued behind it', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		await server.processThought(thoughtInput(HELD));
		await server.processThought(thoughtInput(OTHER));
		persistence.holdClears = true;
		const first = server.resetSession(HELD).then(
			() => 'fulfilled',
			() => 'rejected'
		);
		const second = server.resetSession(OTHER).then(
			() => 'fulfilled',
			() => 'rejected'
		);
		await vi.advanceTimersByTimeAsync(0);

		// When
		const stopping = trackStop(server.stop(SHORT_BUDGET_MS));
		await vi.advanceTimersByTimeAsync(SHORT_FLUSH_END_MS);
		const settledAtFlushEnd = stopping.isSettled();
		persistence.releaseHeldCall();
		await vi.advanceTimersByTimeAsync(0);

		// Then
		expect(settledAtFlushEnd).toBe(true);
		expect(persistence.clearCalls).toBe(1);
		expect(await first).toBe('rejected');
		expect(await second).toBe('rejected');
		expect(server.history.getHistoryLength(HELD)).toBe(1);
		expect(server.history.getHistoryLength(OTHER)).toBe(1);
	});

	it('does not apply the reset half of a reset_state thought abandoned by an overrun stop', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		await server.processThought(thoughtInput(HELD, 1));
		await server.processThought(thoughtInput(HELD, 2));
		persistence.holdClears = true;
		const fresh = server.processThought({ ...thoughtInput(HELD, 1), reset_state: true });
		await vi.advanceTimersByTimeAsync(0);

		// When
		const stopping = trackStop(server.stop(SHORT_BUDGET_MS));
		await vi.advanceTimersByTimeAsync(SHORT_FLUSH_END_MS);
		const settledAtFlushEnd = stopping.isSettled();
		persistence.releaseHeldCall();
		await vi.advanceTimersByTimeAsync(0);
		const result = await fresh;

		// Then
		expect(settledAtFlushEnd).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain('SESSION_LIFECYCLE_CLOSED');
		expect(server.history.getHistoryLength(HELD)).toBe(2);
	});

	it('reports a hung discovery teardown and still flushes and closes', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		const refresh = Promise.withResolvers<number>();
		vi.spyOn(server.tools, 'refreshAsync').mockReturnValue(refresh.promise);
		vi.spyOn(server.skills, 'refreshAsync').mockResolvedValue(0);
		await server.processThought(thoughtInput(OTHER));
		const accepted = server.refreshDiscovery().catch(() => undefined);

		try {
			// When
			const stopping = trackStop(server.stop(BUDGET_MS));
			await vi.advanceTimersByTimeAsync(IDLE_MS);
			const errors = aggregatedErrors(await stopping.result);

			// Then
			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(ServerStopTimeoutError);
			expect(errors[0]).toMatchObject({ phase: 'discovery', timeoutMs: IDLE_MS, pending: null });
			expect(await persistence.loadHistoryForSession(asSessionId(OTHER))).toHaveLength(1);
			expect(persistence.closeCalls).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			refresh.resolve(0);
			await accepted;
		}
	});

	it('keeps a stop without a budget unbounded until the held operation releases', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		await server.processThought(thoughtInput(OTHER));
		const gate = holdOperations(server, HELD);
		const held = server.processThought(thoughtInput(HELD));
		await vi.advanceTimersByTimeAsync(0);

		// When
		const stopping = trackStop(server.stop());
		await vi.advanceTimersByTimeAsync(60_000);
		const settledWhileHeld = stopping.isSettled();
		gate.resolve();
		await held;
		await vi.advanceTimersByTimeAsync(0);

		// Then
		expect(settledWhileHeld).toBe(false);
		expect(await stopping.result).toBeUndefined();
		expect(persistence.closeCalls).toBe(1);
		expect(server.history.getSessionIds()).toEqual([]);
		expect(await persistence.loadHistoryForSession(asSessionId(HELD))).toHaveLength(1);
	});

	it.each([
		{ first: BUDGET_MS, later: undefined },
		{ first: undefined, later: 10 },
	])('returns the first call $first to a later call $later', async ({ first, later }) => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createOwnedServer(persistence);
		const gate = holdOperations(server, HELD);
		const held = server.processThought(thoughtInput(HELD));
		await vi.advanceTimersByTimeAsync(0);

		// When
		const firstStop = server.stop(first);
		const laterStop = server.stop(later);
		const stopping = trackStop(firstStop);
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		const settledAtIdle = stopping.isSettled();
		gate.resolve();
		await held;
		await vi.advanceTimersByTimeAsync(0);
		await stopping.result;

		// Then
		expect(laterStop).toBe(firstStop);
		expect(settledAtIdle).toBe(first !== undefined);
	});

	it('rejects a budgeted stop during resetAll at once without stopping the watchers', async () => {
		// Given
		vi.useRealTimers();
		const watchers: { stop(): Promise<void> }[] = [];
		for (const prototype of [SkillWatcher.prototype, ToolWatcher.prototype]) {
			const originalReady = prototype.ready;
			vi.spyOn(prototype, 'ready').mockImplementation(function (this: SkillWatcher | ToolWatcher) {
				watchers.push(this);
				return originalReady.call(this);
			});
		}
		const skillStop = vi.spyOn(SkillWatcher.prototype, 'stop');
		const toolStop = vi.spyOn(ToolWatcher.prototype, 'stop');
		const persistence = new StallingPersistence();
		backends.add(persistence);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [],
				toolDirs: [],
				features: { toolInterleave: false },
			}),
			persistenceBackend: persistence,
			enableWatcher: true,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		persistence.holdClears = true;
		const reset = server.resetAll();
		const lifecycle = server.getContainer().resolve('sessionLifecycle');

		try {
			// When
			const phaseAtStop = lifecycle.globalPhase;
			const stopError = await server.stop(BUDGET_MS).then(
				() => null,
				(error: unknown) => error
			);

			// Then
			expect(phaseAtStop).toBe('resetting');
			expect(stopError).toBeInstanceOf(SessionLifecycleClosedError);
			expect(stopError).toMatchObject({ phase: 'resetting' });
			expect(skillStop).not.toHaveBeenCalled();
			expect(toolStop).not.toHaveBeenCalled();
			expect(watchers).toHaveLength(2);
		} finally {
			persistence.holdClears = false;
			while (persistence.heldCallCount > 0) persistence.releaseHeldCall();
			await reset;
			await Promise.all(watchers.map((watcher) => watcher.stop()));
			await server.history.shutdownWithinLifecycle();
		}
	});
});
