import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIALIZE_PARAMS } from './ProtocolHarness.js';
import {
	cleanupShutdownFixtures,
	closeServer,
	createTemporaryDirectory,
	listenOnEphemeralPort,
	postJson,
	requireNumber,
	spawnCli,
	spawnFixture,
	stopChild,
	withDeadline,
} from './ShutdownContractHarness.js';

afterEach(async () => {
	await cleanupShutdownFixtures();
}, 30_000);

async function startAdmittedRace(order: 'reset-first' | 'shutdown-first' | 'clear-failure') {
	const dataDir = await createTemporaryDirectory('tracelattice-reset-shutdown-race-');
	const running = spawnFixture('reset-shutdown-race');
	await running.send('configure', { dataDir, order });
	const ready = await running.nextEvent();
	expect(ready).toMatchObject({ event: 'race-ready' });
	const response = postJson(`http://127.0.0.1:${requireNumber(ready, 'port')}/mcp`, {
		jsonrpc: '2.0',
		id: 'admitted-race-call',
		method: 'tools/call',
		params: {
			name: 'sequentialthinking_tools',
			arguments: {
				thought: 'admitted race thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: 'shutdown-race-session',
			},
		},
	});
	expect(await running.nextEvent()).toEqual({ event: 'core-admitted', phase: 'open', idle: false });
	expect(await response).toEqual({
		status: 500,
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32603, message: 'Request timeout' },
		}),
	});
	return { running, dataDir };
}

async function reloadRaceHistory(dataDir: string): Promise<readonly { readonly thought: string }[]> {
	const reload = spawnFixture('reload-file');
	try {
		await reload.send('configure', { dataDir, sessionId: 'shutdown-race-session' });
		const result = await reload.nextEvent();
		expect(result.event).toBe('reload-final');
		expect(await reload.exited).toEqual({ code: 0, signal: null });
		expect(reload.stdout()).toBe('');
		const thoughts = result.thoughts;
		if (!Array.isArray(thoughts)) throw new TypeError('reload thoughts must be an array');
		return thoughts.map((thought: unknown) => {
			if (typeof thought !== 'object' || thought === null || !('thought' in thought)) {
				throw new TypeError('reloaded thought is invalid');
			}
			if (typeof thought.thought !== 'string') throw new TypeError('reloaded thought text is invalid');
			return { thought: thought.thought };
		});
	} finally {
		await stopChild(reload);
	}
}

describe('built CLI shutdown contract', () => {
	it('drains stdio through the shared SIGTERM owner', async () => {
		// Given
		const running = spawnCli({ TRACELATTICE_TRANSPORT_TYPE: 'stdio' });
		const lines = createInterface({ input: running.child.stdout });
		const responses = lines[Symbol.asyncIterator]();

		try {
			await withDeadline(running.waitForStderr('running on stdio'), 5_000, 'stdio readiness');
			running.child.stdin.write(
				`${JSON.stringify({
					jsonrpc: '2.0',
					id: 'shutdown-stdio',
					method: 'initialize',
					params: INITIALIZE_PARAMS,
				})}\n`
			);
			const response = await withDeadline(responses.next(), 5_000, 'stdio initialize response');
			expect(response.done).toBe(false);
			expect(response.value).toContain('shutdown-stdio');

			// When
			running.child.kill('SIGTERM');
			running.child.kill('SIGINT');
			const outcome = await withDeadline(running.exited, 5_000, 'stdio shutdown');

			// Then
			expect(outcome).toEqual({ code: 0, signal: null });
			expect(running.stderr()).not.toContain('CLI shutdown failed');
		} finally {
			lines.close();
			await stopChild(running);
		}
	});

	it('drains Streamable HTTP after accepted health work', async () => {
		// Given
		const reservation = createServer();
		const port = await listenOnEphemeralPort(reservation);
		await closeServer(reservation);
		const running = spawnCli({
			TRACELATTICE_TRANSPORT_TYPE: 'streamable-http',
			TRACELATTICE_STREAMABLE_HTTP_HOST: '127.0.0.1',
			TRACELATTICE_STREAMABLE_HTTP_PORT: String(port),
		});

		try {
			await withDeadline(running.waitForStderr('running on'), 5_000, 'Streamable HTTP readiness');
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(5_000),
			});
			expect(response.status).toBe(200);

			// When
			running.child.kill('SIGTERM');
			running.child.kill('SIGINT');
			const outcome = await withDeadline(running.exited, 5_000, 'Streamable HTTP shutdown');

			// Then
			expect(outcome).toEqual({ code: 0, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).not.toContain('CLI shutdown failed');
		} finally {
			await stopChild(running);
		}
	});

	it('rolls back acquired resources when Streamable HTTP startup fails', async () => {
		// Given
		const occupied = createServer();
		const port = await listenOnEphemeralPort(occupied);
		const running = spawnCli({
			TRACELATTICE_TRANSPORT_TYPE: 'streamable-http',
			TRACELATTICE_STREAMABLE_HTTP_HOST: '127.0.0.1',
			TRACELATTICE_STREAMABLE_HTTP_PORT: String(port),
		});

		try {
			// When
			const outcome = await withDeadline(running.exited, 5_000, 'startup rollback');

			// Then
			expect(outcome).toEqual({ code: 1, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).toContain('Fatal error running server');
			expect(running.stderr()).toContain('EADDRINUSE');
		} finally {
			await stopChild(running);
			await closeServer(occupied);
		}
	});
});

describe('built shutdown lifecycle evidence fixtures', () => {
	it('reports a typed outer deadline without abandoning late ordered cleanup', async () => {
		// Given
		const running = spawnFixture('deadline');

		try {
			// When
			const deadline = await running.nextEvent();

			// Then
			expect(deadline).toEqual({
				event: 'deadline-observed',
				transportStops: 1,
				serverStops: 0,
				samePromise: true,
				reportCount: 1,
				exits: [1],
				error: {
					name: 'CliShutdownTimeoutError',
					code: 'CLI_SHUTDOWN_TIMEOUT',
					message: 'CLI shutdown timed out after 25ms',
					timeoutMs: 25,
				},
			});
			await running.send('release-transport');
			const final = await running.nextEvent();
			expect(final).toEqual({
				event: 'deadline-final',
				transportStops: 1,
				serverStops: 1,
				reportCount: 1,
				exits: [1],
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 1, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).toBe(
				'{"code":"CLI_SHUTDOWN_TIMEOUT","message":"CLI shutdown timed out after 25ms","name":"CliShutdownTimeoutError","timeoutMs":25}\n'
			);
		} finally {
			await stopChild(running);
		}
	});

	it('flattens nested cleanup rejections while attempting every owned stop once', async () => {
		// Given
		const running = spawnFixture('cleanup-rejection');

		try {
			// When
			const final = await running.nextEvent();

			// Then
			expect(final).toEqual({
				event: 'cleanup-rejection-final',
				transportStops: 1,
				serverStops: 1,
				samePromise: true,
				reportCount: 1,
				exits: [1],
				causes: ['transport first', 'transport second', 'server failure'],
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 1, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).toBe(
				'{"causes":["transport first","transport second","server failure"],"message":"CLI shutdown did not complete cleanly","name":"AggregateError"}\n'
			);
		} finally {
			await stopChild(running);
		}
	});

	it('drains durable Streamable work across reload', async () => {
		const dataDir = await createTemporaryDirectory('tracelattice-shutdown-contract-');
		const streamable = spawnFixture('streamable-file');
		try {
			await streamable.send('configure', { dataDir });
			const ready = await streamable.nextEvent();
			expect(ready).toMatchObject({ event: 'streamable-ready' });
			const request = postJson(`http://127.0.0.1:${requireNumber(ready, 'port')}/mcp`, {
				jsonrpc: '2.0',
				id: 'durable-timeout-call',
				method: 'tools/call',
				params: {
					name: 'sequentialthinking_tools',
					arguments: {
						thought: 'durable accepted thought',
						thought_number: 1,
						total_thoughts: 1,
						next_thought_needed: false,
						session_id: 'shutdown-durable-session',
					},
				},
			});
			expect(await streamable.nextEvent()).toEqual({ event: 'work-started' });
			const timeoutResponse = await request;
			expect(timeoutResponse.status).toBe(500);
			expect(JSON.parse(timeoutResponse.body)).toEqual({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32603, message: 'Request timeout' },
			});

			await streamable.send('begin-shutdown');
			expect(await streamable.nextEvent()).toEqual({ event: 'shutdown-started' });
			await streamable.send('observe-shutdown');
			expect(await streamable.nextEvent()).toEqual({ event: 'shutdown-pending' });
			await streamable.send('release-work');
			expect(await streamable.nextEvent()).toEqual({ event: 'work-acknowledged' });
			expect(await streamable.nextEvent()).toEqual({ event: 'persistence-write-started' });
			await streamable.send('observe-shutdown');
			expect(await streamable.nextEvent()).toEqual({ event: 'shutdown-pending' });
			await streamable.send('release-persistence');
			expect(await streamable.nextEvent()).toEqual({
				event: 'streamable-final',
				exits: [0],
				responseFinishes: 1,
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			expect(await streamable.exited).toEqual({ code: 0, signal: null });
			expect(streamable.stdout()).toBe('');
		} finally {
			await stopChild(streamable);
		}

		const reload = spawnFixture('reload-file');
		try {
			await reload.send('configure', {
				dataDir,
				sessionId: 'shutdown-durable-session',
			});
			expect(await reload.nextEvent()).toEqual({
				event: 'reload-final',
				thoughts: [
					{
						thought: 'durable accepted thought',
						thought_number: 1,
						total_thoughts: 1,
						next_thought_needed: false,
						session_id: 'shutdown-durable-session',
					},
				],
			});
			expect(await reload.exited).toEqual({ code: 0, signal: null });
			expect(reload.stdout()).toBe('');
		} finally {
			await stopChild(reload);
		}
	});
});

describe('admitted thought versus global reset and shutdown', () => {
	it('keeps the public stop rejection cached when reset claims first, then deletes durable state', async () => {
		const { running, dataDir } = await startAdmittedRace('reset-first');
		try {
			await running.send('begin-claim');
			expect(await running.nextEvent()).toEqual({ event: 'reset-claimed', phase: 'resetting' });
			await running.send('attempt-stop');
			expect(await running.nextEvent()).toEqual({
				event: 'stop-rejected',
				phase: 'resetting',
				samePromise: true,
				error: 'SessionLifecycleClosedError',
			});
			await running.send('release-work');
			expect(await running.nextEvent()).toEqual({ event: 'work-acknowledged' });
			expect(await running.nextEvent()).toEqual({ event: 'clear-started' });
			await running.send('release-clear');
			expect(await running.nextEvent()).toEqual({
				event: 'reset-first-final', phase: 'open', liveThoughts: 0,
				outcomes: 0, sameStopPromise: true, responseFinishes: 1,
				unhandledRejections: [], uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 0, signal: null });
			expect(running.stdout()).toBe('');
			expect(await reloadRaceHistory(dataDir)).toEqual([]);
		} finally {
			await stopChild(running);
		}
	}, 30_000);

	it('rejects reset when shutdown claims first and drains admitted work', async () => {
		const { running, dataDir } = await startAdmittedRace('shutdown-first');
		try {
			await running.send('begin-claim');
			expect(await running.nextEvent()).toEqual({ event: 'shutdown-claimed', phase: 'shutting_down' });
			await running.send('attempt-reset');
			expect(await running.nextEvent()).toEqual({
				event: 'reset-rejected', phase: 'shutting_down', error: 'SessionLifecycleClosedError',
			});
			await running.send('release-work');
			expect(await running.nextEvent()).toEqual({ event: 'work-acknowledged' });
			expect(await running.nextEvent()).toEqual({
				event: 'shutdown-first-final', phase: 'stopped',
				responseFinishes: 1, unhandledRejections: [], uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 0, signal: null });
			expect(running.stdout()).toBe('');
			expect((await reloadRaceHistory(dataDir)).map((thought) => thought.thought))
				.toEqual(['durable race seed', 'admitted race thought']);
		} finally {
			await stopChild(running);
		}
	}, 30_000);

	it('retains state when clear fails before mutation and permits shutdown from reset_failed', async () => {
		const { running, dataDir } = await startAdmittedRace('clear-failure');
		try {
			await running.send('begin-claim');
			expect(await running.nextEvent()).toEqual({ event: 'reset-claimed', phase: 'resetting' });
			await running.send('release-work');
			expect(await running.nextEvent()).toEqual({ event: 'work-acknowledged' });
			expect(await running.nextEvent()).toEqual({ event: 'clear-started' });
			await running.send('release-clear');
			expect(await running.nextEvent()).toEqual({
				event: 'clear-failed', phase: 'reset_failed', error: 'controlled clear before mutation',
				liveThoughts: 2, outcomes: 1, admissionRejected: true,
			});
			await running.send('begin-shutdown');
			expect(await running.nextEvent()).toEqual({ event: 'transport-stopped' });
			expect(await running.nextEvent()).toEqual({ event: 'server-stop-started' });
			expect(await running.nextEvent()).toEqual({
				event: 'clear-failure-final', phase: 'stopped', exits: [0], responseFinishes: 1,
				unhandledRejections: [], uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 0, signal: null });
			expect(running.stdout()).toBe('');
			expect((await reloadRaceHistory(dataDir)).map((thought) => thought.thought))
				.toEqual(['durable race seed', 'admitted race thought']);
		} finally {
			await stopChild(running);
		}
	}, 30_000);
});
