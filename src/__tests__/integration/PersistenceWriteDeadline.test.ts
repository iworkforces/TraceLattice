import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PersistenceDrainError,
	PersistenceWriteTimeoutError,
} from '../../core/PersistenceBufferErrors.js';
import { createServer, type ToolAwareSequentialThinkingServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { StallingPersistence } from '../helpers/StallingPersistence.js';

const TIMEOUT_MS = 1000;
const SESSION_ID = 'write-deadline-session';

type TrackedStop = {
	readonly result: Promise<unknown>;
	readonly isSettled: () => boolean;
};

const backends = new Set<StallingPersistence>();

function deadlineConfig(): ServerConfig {
	return new ServerConfig({
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 3,
		persistenceWriteTimeout: TIMEOUT_MS,
		features: { toolInterleave: false },
	});
}

async function createDeadlineServer(
	persistence: StallingPersistence
): Promise<ToolAwareSequentialThinkingServer> {
	backends.add(persistence);
	return createServer({
		config: deadlineConfig(),
		persistenceBackend: persistence,
		autoDiscover: false,
		loadFromPersistence: false,
		enableWatcher: false,
	});
}

function trackStop(server: ToolAwareSequentialThinkingServer): TrackedStop {
	let settled = false;
	const result = server.stop().then(
		() => undefined,
		(error: unknown) => error
	);
	void result.then(() => {
		settled = true;
	});
	return { result, isSettled: () => settled };
}

function thoughtInput(thoughtNumber: number) {
	return {
		thought: `deadline thought ${thoughtNumber}`,
		thought_number: thoughtNumber,
		total_thoughts: 2,
		next_thought_needed: true,
		session_id: SESSION_ID,
	};
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
	for (const backend of backends) {
		backend.holdWrites = false;
		backend.holdClose = false;
		while (backend.heldCallCount > 0) backend.releaseHeldCall();
	}
	backends.clear();
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('server persistence write deadline', () => {
	it('ends a stalled shutdown flush at the configured persistenceWriteTimeout', async () => {
		// Given
		const persistence = new StallingPersistence();
		const server = await createDeadlineServer(persistence);
		await server.processThought(thoughtInput(1));
		persistence.holdWrites = true;

		// When
		const stopping = trackStop(server);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
		const settledBeforeDeadline = stopping.isSettled();
		await vi.advanceTimersByTimeAsync(1);
		const error = await stopping.result;

		// Then
		expect(settledBeforeDeadline).toBe(false);
		expect(error).toBeInstanceOf(AggregateError);
		const [drainError] = error instanceof AggregateError ? error.errors : [];
		expect(drainError).toBeInstanceOf(PersistenceDrainError);
		const failures = drainError instanceof PersistenceDrainError ? drainError.failures : [];
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ kind: 'thought', attempts: 1 });
		expect(failures[0]?.cause).toBeInstanceOf(PersistenceWriteTimeoutError);
		expect(failures[0]?.cause).toMatchObject({ timeoutMs: TIMEOUT_MS });
		expect(persistence.thoughtAttempts).toBe(1);
		expect(persistence.closeCalls).toBe(0);
	});
});
