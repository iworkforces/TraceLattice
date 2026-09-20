import { expect, vi } from 'vitest';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import type { DurableBackend } from './ReliabilityPersistenceScenarios.js';
import {
	createReliabilityRoot,
	runReliabilityFixture,
	spawnReliabilityFixture,
} from './ReliabilityScenarioHarness.js';

function durableConfig(backend: DurableBackend, root: string): ServerConfig {
	return new ServerConfig({
		persistence: {
			enabled: true,
			backend,
			options: backend === 'file' ? { dataDir: root } : { dbPath: `${root}/history.db` },
		},
		persistenceBufferSize: 100,
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 0,
	});
}

function thought(sessionId: string, text: string) {
	return {
		thought: text,
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		session_id: sessionId,
	};
}

function errorFrom(value: unknown, context: string): Error {
	return value instanceof Error ? value : new TypeError(context, { cause: value });
}

export async function assertVisibleDrainFailure(): Promise<void> {
	const server = await createServer({
		config: new ServerConfig({
			persistence: { enabled: true, backend: 'memory' },
			persistenceFlushInterval: 60_000,
			persistenceBufferSize: 100,
			persistenceMaxRetries: 0,
		}),
		autoDiscover: false,
		loadFromPersistence: false,
	});
	let expectedDisposeErrors: readonly unknown[] | undefined;
	let scenarioFailure: Error | undefined;
	let disposeFailure: Error | undefined;
	try {
		const persistence = server.getContainer().resolve('Persistence');
		if (!persistence) throw new TypeError('Memory persistence is unavailable');
		const diagnostic = new Error('controlled storage drain failure');
		vi.spyOn(persistence, 'saveThoughtForSession').mockRejectedValue(diagnostic);
		const close = vi.spyOn(persistence, 'close');
		await server.processThought(thought('failure', 'accepted state'));
		let rejection: unknown;
		try {
			await server.stop();
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toBeInstanceOf(AggregateError);
		if (!(rejection instanceof AggregateError)) {
			throw new TypeError('Expected aggregate stop failure');
		}
		expect(rejection.message).toBe('Failed to stop server cleanly');
		expect(rejection.errors).toEqual([
			expect.objectContaining({
				code: 'PERSISTENCE_DRAIN',
				failures: [expect.objectContaining({ cause: diagnostic })],
			}),
		]);
		expectedDisposeErrors = rejection.errors;
		expect(server.getContainer().resolve('sessionLifecycle').globalPhase).toBe('shutdown_failed');
		expect(server.history.getHistory('failure').map(({ thought: text }) => text)).toEqual([
			'accepted state',
		]);
		expect(server.history.getWriteBufferLength()).toBe(1);
		expect(close).toHaveBeenCalledOnce();
	} catch (error) {
		scenarioFailure = errorFrom(error, 'Drain-failure scenario threw a non-Error value');
	} finally {
		try {
			await server.dispose();
		} catch (error) {
			disposeFailure = errorFrom(error, 'Server disposal threw a non-Error value');
		}
	}
	if (scenarioFailure) {
		if (disposeFailure) {
			throw new AggregateError(
				[scenarioFailure, disposeFailure],
				'Drain-failure scenario and server disposal both failed'
			);
		}
		throw scenarioFailure;
	}
	if (expectedDisposeErrors === undefined) {
		if (disposeFailure) throw disposeFailure;
	} else {
		expect(disposeFailure).toBeInstanceOf(AggregateError);
		if (!(disposeFailure instanceof AggregateError)) {
			throw new TypeError('Expected aggregate dispose failure');
		}
		expect(disposeFailure.message).toBe('Failed to dispose server cleanly');
		expect(disposeFailure.errors).toEqual(expectedDisposeErrors);
	}
}

export async function assertResetJoinsQueuedWrites(backend: DurableBackend): Promise<void> {
	const root = await createReliabilityRoot(`tracelattice-reliability-${backend}-queued-reset-`);
	const server = await createServer({
		config: durableConfig(backend, root),
		autoDiscover: false,
		loadFromPersistence: false,
	});
	const persistence = server.getContainer().resolve('Persistence');
	if (!persistence) throw new TypeError(`${backend} persistence is unavailable`);
	const saveStarted = Promise.withResolvers<void>();
	const releaseSave = Promise.withResolvers<void>();
	const originalSave = persistence.saveThoughtForSession.bind(persistence);
	vi.spyOn(persistence, 'saveThoughtForSession').mockImplementation(async (sessionId, value) => {
		if (sessionId === 'A') {
			saveStarted.resolve();
			await releaseSave.promise;
		}
		await originalSave(sessionId, value);
	});
	try {
		await server.processThought(thought('A', 'A queued'));
		await server.processThought(thought('B', 'B exact'));
		let settled = false;
		const reset = server.resetSession('A').then(() => {
			settled = true;
		});
		await saveStarted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		releaseSave.resolve();
		await reset;
		expect(server.history.getHistory('A')).toEqual([]);
		expect(server.history.getHistory('B').map(({ thought: text }) => text)).toEqual(['B exact']);
		expect(server.history.getWriteBufferLength()).toBe(0);
		await server.stop();
		const restarted = await runReliabilityFixture('inspect', { backend, root });
		expect(restarted).toMatchObject({
			state: { A: [], B: [{ thought: 'B exact', number: 1 }] },
			pendingWrites: 0,
			unhandledRejections: [],
			uncaughtExceptions: [],
		});
	} finally {
		releaseSave.resolve();
		await server.dispose();
	}
}

export async function assertInitializedTransportDrain(backend: DurableBackend): Promise<void> {
	const root = await createReliabilityRoot(`tracelattice-reliability-${backend}-transport-`);
	const fixture = spawnReliabilityFixture('transport-drain', { backend, root });
	expect(await fixture.nextEvent()).toEqual({ event: 'scenario-ready' });
	const ready = await fixture.nextEvent();
	expect(ready).toMatchObject({ event: 'transport-ready', port: expect.any(Number) });
	const port = ready['port'];
	if (typeof port !== 'number') throw new TypeError('Transport fixture port is unavailable');
	const acceptedController = new AbortController();
	const accepted = fetch(`http://127.0.0.1:${port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 'accepted',
			method: 'tools/call',
			params: {
				name: 'sequentialthinking_tools',
				arguments: thought('A', 'accepted transport work'),
			},
		}),
		signal: acceptedController.signal,
	});
	let scenarioFailure: Error | undefined;
	let settlementFailure: Error | undefined;
	try {
		expect(await fixture.nextEvent()).toEqual({ event: 'work-started' });
		expect((await accepted).status).toBe(500);
		await fixture.send('begin-shutdown');
		expect(await fixture.nextEvent()).toEqual({ event: 'shutdown-started' });
		const lateAdmission = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(1_000),
		}).then(
			(response) => ({ kind: 'response' as const, status: response.status }),
			() => ({ kind: 'rejected' as const })
		);
		if (lateAdmission.kind === 'response') expect(lateAdmission.status).not.toBe(200);
		await fixture.send('observe-shutdown');
		expect(await fixture.nextEvent()).toEqual({ event: 'shutdown-pending' });
		await fixture.send('release-work');
		expect(await fixture.nextEvent()).toEqual({ event: 'work-acknowledged' });
		expect(await fixture.nextEvent()).toEqual({ event: 'persistence-write-started' });
		await fixture.send('observe-shutdown');
		expect(await fixture.nextEvent()).toEqual({ event: 'shutdown-pending' });
		await fixture.send('release-persistence');
		expect(await fixture.nextEvent()).toMatchObject({
			event: 'scenario-final',
			responseFinishes: 1,
			pendingWrites: 0,
			unhandledRejections: [],
			uncaughtExceptions: [],
		});
		expect(await fixture.exited).toEqual({ code: 0, signal: null });
		const restarted = await runReliabilityFixture('inspect', { backend, root });
		expect(restarted).toMatchObject({
			state: { A: [{ thought: 'accepted transport work', number: 1 }], B: [] },
			pendingWrites: 0,
		});
	} catch (error) {
		scenarioFailure = errorFrom(error, 'Transport-drain scenario threw a non-Error value');
	} finally {
		acceptedController.abort();
		await accepted.then(
			() => undefined,
			(error: unknown) => {
				if (!(error instanceof DOMException) || error.name !== 'AbortError') {
					settlementFailure = errorFrom(error, 'Accepted fetch threw a non-Error value');
				}
			}
		);
	}
	if (scenarioFailure && settlementFailure) {
		throw new AggregateError(
			[scenarioFailure, settlementFailure],
			'Transport-drain scenario and accepted fetch both failed'
		);
	}
	if (scenarioFailure) throw scenarioFailure;
	if (settlementFailure) throw settlementFailure;
}
