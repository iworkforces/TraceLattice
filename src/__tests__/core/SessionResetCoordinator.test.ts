import { describe, expect, it, vi } from 'vitest';

import { asSessionId } from '../../contracts/ids.js';
import { SessionResetCoordinator } from '../../core/SessionResetCoordinator.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';

interface TestSessionState {
	readonly owner: string | undefined;
}

function createCoordinator(): {
	coordinator: SessionResetCoordinator<TestSessionState>;
	persistence: MemoryPersistence;
	sessions: Map<ReturnType<typeof asSessionId>, TestSessionState>;
} {
	const persistence = new MemoryPersistence();
	const sessions = new Map<ReturnType<typeof asSessionId>, TestSessionState>();
	const coordinator = new SessionResetCoordinator({
		persistence,
		barrier: {
			withSessionResetBarrier: async (_sessionId, operation) => await operation(),
			withGlobalResetBarrier: async (operation) => await operation(),
		},
		sessions,
		createSessionState: (owner) => ({ owner }),
		logger: new NullLogger(),
	});
	return { coordinator, persistence, sessions };
}

describe('SessionResetCoordinator', () => {
	it('clears persistent and live session state through the durable barrier', async () => {
		const { coordinator, persistence, sessions } = createCoordinator();
		const sessionId = asSessionId('session-a');
		sessions.set(sessionId, { owner: 'owner-a' });
		const clearSession = vi.spyOn(persistence, 'clearSession');

		await coordinator.resetSession(sessionId, 'owner-a');

		expect(clearSession).toHaveBeenCalledWith(sessionId);
		expect(sessions.get(sessionId)).toEqual({ owner: 'owner-a' });
	});

	it('clears all persistent and live state through the durable barrier', async () => {
		const { coordinator, persistence, sessions } = createCoordinator();
		sessions.set(asSessionId('session-a'), { owner: 'owner-a' });
		const clearAll = vi.spyOn(persistence, 'clearAll');

		await coordinator.resetAll();

		expect(clearAll).toHaveBeenCalledOnce();
		expect(sessions).toHaveLength(0);
	});
});
