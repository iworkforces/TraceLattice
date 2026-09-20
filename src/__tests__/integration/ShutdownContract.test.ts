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
});

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
