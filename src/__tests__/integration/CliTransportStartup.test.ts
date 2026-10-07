import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIALIZE_PARAMS, postJson } from './ProtocolHarness.js';
import {
	cleanupShutdownFixtures,
	closeServer,
	createTemporaryDirectory,
	listenOnEphemeralPort,
	spawnCli,
	stopChild,
	withDeadline,
} from './ShutdownContractHarness.js';

const retention = {
	TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS: '1',
	TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS: '300',
	TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS: '50',
};

afterEach(async () => {
	await cleanupShutdownFixtures();
}, 30_000);

async function cliEnvironment() {
	const reservation = createServer();
	const port = await listenOnEphemeralPort(reservation);
	await closeServer(reservation);
	const directory = await createTemporaryDirectory('tracelattice-cli-retention-');
	return {
		port,
		env: {
			TRACELATTICE_CONFIG: join(directory, 'absent.json'),
			TRACELATTICE_TRANSPORT_TYPE: 'streamable-http',
			TRACELATTICE_STREAMABLE_HTTP_HOST: '127.0.0.1',
			TRACELATTICE_STREAMABLE_HTTP_PORT: String(port),
			TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS: undefined,
			TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS: undefined,
			TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS: undefined,
			TRACELATTICE_STREAMABLE_HTTP_STATEFUL: undefined,
		},
	};
}

describe('built CLI invalid transport configuration rollback', () => {
	it.each([
		{ TRACELATTICE_STREAMABLE_HTTP_PORT: '9007oops' },
		{ TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS: '1' },
		{ TRACELATTICE_TRANSPORT_TYPE: 'streamble-http' },
		{ ...retention, TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS: '0' },
		{ ...retention, TRACELATTICE_STREAMABLE_HTTP_STATEFUL: 'false' },
		{ ...retention, TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS: '2147483648' },
	])('stops the initialized server before rejecting %j', async (invalid) => {
		const { port, env } = await cliEnvironment();
		const running = spawnCli({ ...env, ...invalid });
		const outcome = await withDeadline(running.exited, 5000, 'invalid CLI exit');
		expect(outcome).toEqual({ code: 1, signal: null });
		expect(running.stderr()).toContain('Fatal error running server');
		expect(running.stderr()).toContain('Server stopped, watchers cleaned up');
		expect(running.stdout()).toBe('');
		await expect(
			fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
		).rejects.toThrow();
	});
});

describe('built CLI transport retention', () => {
	it('enforces capacity and releases idle transport sessions', async () => {
		const { port, env } = await cliEnvironment();
		const running = spawnCli({ ...env, ...retention });
		await withDeadline(running.waitForStderr('running on Streamable HTTP'), 5000, 'HTTP readiness');
		const url = `http://127.0.0.1:${port}/mcp`;
		const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS };
		const first = await postJson(url, request);
		expect(first.status).toBe(200);
		const session = first.headers.get('mcp-session-id');
		if (session === null) throw new Error('Missing CLI transport session');
		const full = await postJson(url, { ...request, id: 2 });
		expect(full.status).toBe(503);
		expect(full.body?.error?.code).toBe(-32000);
		// Headerless admission probes do not refresh the old session's idle clock.
		await vi.waitFor(
			async () => {
				expect((await postJson(url, { ...request, id: 3 })).status).toBe(200);
			},
			{ timeout: 3000, interval: 25 }
		);
		const expired = await postJson(
			url,
			{ jsonrpc: '2.0', id: 4, method: 'tools/list' },
			{ 'mcp-session-id': session }
		);
		expect(expired.status).toBe(404);
		expect(expired.body?.error?.code).toBe(-32001);
		running.child.kill('SIGTERM');
		expect(await withDeadline(running.exited, 5000, 'valid CLI shutdown')).toEqual({
			code: 0,
			signal: null,
		});
		expect(running.stdout()).toBe('');
	});

	it('starts stdio while ignoring garbage HTTP-only variables', async () => {
		const { env } = await cliEnvironment();
		const running = spawnCli({
			...env,
			TRACELATTICE_TRANSPORT_TYPE: 'stdio',
			TRACELATTICE_STREAMABLE_HTTP_PORT: 'garbage',
			TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS: '0',
			TRACELATTICE_STREAMABLE_HTTP_STATEFUL: 'false',
		});
		await withDeadline(running.waitForStderr('running on stdio'), 5000, 'stdio readiness');
		expect(running.stderr()).not.toContain('Fatal error running server');
		expect(running.stdout()).toBe('');
		await stopChild(running);
	});
});
