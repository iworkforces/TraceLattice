import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asSessionId, type SessionId } from '../../contracts/ids.js';
import { SessionManager, type SessionLike } from '../../core/SessionManager.js';
import type { Logger } from '../../logger/StructuredLogger.js';

interface TestSession extends SessionLike {
	readonly id: string;
}

function makeLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setLevel: vi.fn(),
		getLevel: () => 'info',
	};
}

function makeManager(options?: {
	readonly maxSessions?: number;
	readonly maxSessionsPerOwner?: number;
	readonly logger?: Logger;
}): SessionManager<TestSession> {
	return new SessionManager<TestSession>({
		sessionTtlMs: 60_000,
		cleanupIntervalMs: 100,
		getMaxSessions: () => options?.maxSessions ?? 1_000,
		maxSessionsPerOwner: options?.maxSessionsPerOwner ?? 50,
		logger: options?.logger,
	});
}

function session(id: string, lastAccessedAt: number, owner?: string): TestSession {
	return { id, lastAccessedAt, owner };
}

function eligible(): boolean {
	return true;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('SessionManager prospective admission planning', () => {
	it('uses owner victims for both owner and global capacity before global alternatives', () => {
		// Given
		const manager = makeManager({ maxSessions: 3, maxSessionsPerOwner: 2 });
		const sessions = new Map<SessionId, TestSession>([
			[asSessionId('ordinary-oldest'), session('ordinary-oldest', 0)],
			[asSessionId('owner-old'), session('owner-old', 1, 'A')],
			[asSessionId('owner-new'), session('owner-new', 4, 'A')],
			[asSessionId('other-old'), session('other-old', 2, 'B')],
		]);

		// When
		const plan = manager.planProspectiveAdmission(sessions, 'A', eligible);

		// Then
		expect(plan).toEqual([asSessionId('owner-old'), asSessionId('ordinary-oldest')]);
		expect(sessions).toHaveLength(4);
	});

	it('skips a pinned oldest session for the oldest eligible alternative', () => {
		// Given
		const manager = makeManager({ maxSessions: 2 });
		const pinned = asSessionId('pinned-oldest');
		const alternative = asSessionId('eligible-next');
		const sessions = new Map<SessionId, TestSession>([
			[pinned, session('pinned-oldest', 1)],
			[alternative, session('eligible-next', 2)],
		]);

		// When
		const plan = manager.planProspectiveAdmission(
			sessions,
			undefined,
			(sessionId) => sessionId !== pinned
		);

		// Then
		expect(plan).toEqual([alternative]);
	});

	it('returns no plan and no partial victims when the complete set is infeasible', () => {
		// Given
		const manager = makeManager({ maxSessions: 1 });
		const sessions = new Map<SessionId, TestSession>([
			[asSessionId('pinned-a'), session('pinned-a', 1)],
			[asSessionId('eligible-b'), session('eligible-b', 2)],
		]);

		// When
		const plan = manager.planProspectiveAdmission(
			sessions,
			undefined,
			(sessionId) => sessionId === asSessionId('eligible-b')
		);

		// Then
		expect(plan).toBeUndefined();
		expect([...sessions.keys()]).toEqual([asSessionId('pinned-a'), asSessionId('eligible-b')]);
	});

	it('preserves stable insertion order when eligible timestamps tie', () => {
		// Given
		const manager = makeManager({ maxSessions: 1 });
		const sessions = new Map<SessionId, TestSession>([
			[asSessionId('first'), session('first', 10)],
			[asSessionId('second'), session('second', 10)],
		]);

		// When
		const plan = manager.planProspectiveAdmission(sessions, undefined, eligible);

		// Then
		expect(plan).toEqual([asSessionId('first'), asSessionId('second')]);
	});

	it('selects the sole named session when prospective admission requires capacity', () => {
		// Given
		const manager = makeManager({ maxSessions: 1 });
		const sessionId = asSessionId('ordinary-session');
		const sessions = new Map<SessionId, TestSession>([[sessionId, session('ordinary-session', 0)]]);

		// When
		const plan = manager.planProspectiveAdmission(sessions, undefined, eligible);

		// Then
		expect(plan).toEqual([sessionId]);
	});

	it('excludes restored sessions from counts and candidate selection', () => {
		// Given
		const manager = makeManager({ maxSessions: 1, maxSessionsPerOwner: 1 });
		const sessions = new Map<SessionId, TestSession>([
			[asSessionId('restored'), { ...session('restored', 0, 'A'), provenance: 'restored' }],
		]);

		// When
		const plan = manager.planProspectiveAdmission(sessions, 'A', eligible);

		// Then
		expect(plan).toEqual([]);
	});

	it('applies only global capacity to ownerless admission', () => {
		// Given
		const manager = makeManager({ maxSessions: 10, maxSessionsPerOwner: 1 });
		const sessions = new Map<SessionId, TestSession>([
			[asSessionId('stdio-a'), session('stdio-a', 1)],
			[asSessionId('stdio-b'), session('stdio-b', 2)],
		]);

		// When
		const plan = manager.planProspectiveAdmission(sessions, undefined, eligible);

		// Then
		expect(plan).toEqual([]);
	});

	it('uses the configured default owner quota of fifty for prospective admission', () => {
		// Given
		const manager = new SessionManager<TestSession>({
			sessionTtlMs: 60_000,
			cleanupIntervalMs: 100,
			getMaxSessions: () => 1_000,
		});
		const sessions = new Map<SessionId, TestSession>();
		for (let index = 0; index < 50; index += 1) {
			const sessionId = asSessionId(`owner-${index}`);
			sessions.set(sessionId, session(sessionId, index, 'A'));
		}

		// When
		const plan = manager.planProspectiveAdmission(sessions, 'A', eligible);

		// Then
		expect(plan).toEqual([asSessionId('owner-0')]);
	});

	it('does not substitute another owner when required owner victims are pinned', () => {
		// Given
		const manager = makeManager({ maxSessions: 10, maxSessionsPerOwner: 1 });
		const ownerSession = asSessionId('owner-pinned');
		const sessions = new Map<SessionId, TestSession>([
			[ownerSession, session('owner-pinned', 1, 'A')],
			[asSessionId('other-eligible'), session('other-eligible', 2, 'B')],
		]);

		// When
		const plan = manager.planProspectiveAdmission(
			sessions,
			'A',
			(sessionId) => sessionId !== ownerSession
		);

		// Then
		expect(plan).toBeUndefined();
	});
});

describe('SessionManager TTL candidates and timer', () => {
	it('uses the same restored, eligibility, and oldest-first candidate rules for TTL', () => {
		// Given
		const manager = makeManager();
		const pinned = asSessionId('pinned');
		const sessions = new Map<SessionId, TestSession>([
			[asSessionId('ordinary-oldest'), session('ordinary-oldest', 0)],
			[asSessionId('restored'), { ...session('restored', 1), provenance: 'restored' }],
			[pinned, session('pinned', 2)],
			[asSessionId('eligible-old'), session('eligible-old', 3)],
			[asSessionId('eligible-new'), session('eligible-new', 4)],
		]);

		// When
		const candidates = manager.staleSessionCandidates(
			sessions,
			(sessionId) => sessionId !== pinned,
			60_005
		);

		// Then
		expect(candidates).toEqual([
			asSessionId('ordinary-oldest'),
			asSessionId('eligible-old'),
			asSessionId('eligible-new'),
		]);
	});

	it('observes and reports asynchronous cleanup rejection without an unhandled promise', async () => {
		// Given
		const logger = makeLogger();
		const manager = makeManager({ logger });
		const sessionId = asSessionId('stale');
		const sessions = new Map<SessionId, TestSession>([[sessionId, session('stale', 0)]]);
		const failure = new Error('cleanup rejected');
		const cleanup = vi.fn(async () => Promise.reject(failure));
		manager.startCleanupTimer(sessions, eligible, cleanup);

		// When
		await vi.advanceTimersByTimeAsync(100);

		// Then
		expect(cleanup).toHaveBeenCalledWith([sessionId]);
		expect(logger.error).toHaveBeenCalledWith('Session cleanup failed', {
			error: failure,
		});
		manager.stopCleanupTimer();
	});

	it('reports synchronous cleanup failure from the timer callback', async () => {
		// Given
		const logger = makeLogger();
		const manager = makeManager({ logger });
		const sessionId = asSessionId('stale-sync-failure');
		const sessions = new Map<SessionId, TestSession>([[sessionId, session('stale', 0)]]);
		const failure = new Error('cleanup threw');
		const cleanup = vi.fn((): Promise<void> => {
			throw failure;
		});
		manager.startCleanupTimer(sessions, eligible, cleanup);

		// When
		await vi.advanceTimersByTimeAsync(100);

		// Then
		expect(logger.error).toHaveBeenCalledWith('Session cleanup failed', { error: failure });
		manager.stopCleanupTimer();
	});
});

describe('SessionManager config integration', () => {
	it('TRACELATTICE_SESSION_MAX_PER_OWNER env var flows through ConfigLoader to ServerConfig', async () => {
		// Given
		const { ConfigLoader } = await import('../../config/ConfigLoader.js');
		const { ServerConfig } = await import('../../ServerConfig.js');
		vi.stubEnv('TRACELATTICE_SESSION_MAX_PER_OWNER', '7');

		// When
		const loader = new ConfigLoader();
		const fileConfig = loader.load() ?? {};
		const config = new ServerConfig({ maxSessionsPerOwner: fileConfig.maxSessionsPerOwner });

		// Then
		expect(config.maxSessionsPerOwner).toBe(7);
	});

	it('ServerConfig validates and serializes maxSessionsPerOwner', async () => {
		// Given
		const { ServerConfig } = await import('../../ServerConfig.js');
		const { ConfigurationError } = await import('../../errors.js');

		// When
		const config = new ServerConfig({ maxSessionsPerOwner: 25 });

		// Then
		expect(config.toJSON().maxSessionsPerOwner).toBe(25);
		expect(() => new ServerConfig({ maxSessionsPerOwner: 0 })).toThrow(ConfigurationError);
		expect(() => new ServerConfig({ maxSessionsPerOwner: 10_001 })).toThrow(ConfigurationError);
		expect(() => new ServerConfig({ maxSessionsPerOwner: Number.NaN })).toThrow(ConfigurationError);
	});
});
