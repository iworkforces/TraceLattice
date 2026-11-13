import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSessionId, type SessionId } from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import type { ThoughtData } from '../../core/thought.js';
import { TransportStopTimeoutError } from '../../errors.js';
import { HealthChecker, type HealthCheckResult } from '../../health/HealthChecker.js';
import type { Logger } from '../../logger/StructuredLogger.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { HttpTransport } from '../../transport/HttpTransport.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';
import { createTestThought } from '../helpers/factories.js';
import {
	INITIALIZE_PARAMS,
	createProtocolServer,
	getListeningPort,
	postJson,
} from './ProtocolHarness.js';
import {
	activeRequestCount,
	controlledCallBody,
	createControlledProtocolServer,
	createDeferred,
	getTransportServer,
	lifecycleReportingFailureCount,
	makeServerNotReady,
	nextEventLoopTurn,
	observeNextResponse,
	observeNextRequestResponse,
	outstandingWorkCount,
	startIncompleteWireRequest,
	startWireRequest,
	LifecycleFixtureError,
	type LifecycleTransport,
	type ResponseWriterMethod,
} from './TransportLifecycleHarness.js';

type TransportName = 'HTTP' | 'Streamable HTTP';

type LifecycleOptions = {
	readonly healthChecker?: HealthChecker;
	readonly logger?: Logger;
	readonly maxBodySize?: number;
	readonly port?: number;
	readonly requestTimeout?: number;
	readonly sessionIdGenerator?: () => string;
	readonly stateful?: boolean;
};

type LifecycleCase = {
	readonly name: TransportName;
	readonly path: string;
	readonly notificationStatus: number;
	readonly stateful: boolean;
	readonly writerFailureMethod: ResponseWriterMethod;
	readonly expectedWriterCalls: { readonly writeHead: number; readonly end: number };
	readonly create: (options?: LifecycleOptions) => LifecycleTransport;
};

const LIFECYCLE_CASES = [
	{
		name: 'HTTP',
		path: '/messages',
		notificationStatus: 204,
		stateful: false,
		writerFailureMethod: 'writeHead',
		expectedWriterCalls: { writeHead: 1, end: 0 },
		create: (options = {}) =>
			new HttpTransport({
				port: options.port ?? 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				requestTimeout: options.requestTimeout,
				maxBodySize: options.maxBodySize ?? 256,
				...(options.healthChecker ? { healthChecker: options.healthChecker } : {}),
				...(options.logger ? { logger: options.logger } : {}),
			}),
	},
	{
		name: 'Streamable HTTP',
		path: '/mcp',
		notificationStatus: 202,
		stateful: true,
		writerFailureMethod: 'end',
		expectedWriterCalls: { writeHead: 1, end: 1 },
		create: (options = {}) =>
			new StreamableHttpTransport({
				port: options.port ?? 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: options.stateful ?? true,
				requestTimeout: options.requestTimeout,
				maxBodySize: options.maxBodySize ?? 256,
				...(options.sessionIdGenerator
					? { sessionIdGenerator: options.sessionIdGenerator }
					: {}),
				...(options.healthChecker ? { healthChecker: options.healthChecker } : {}),
				...(options.logger ? { logger: options.logger } : {}),
			}),
	},
] satisfies readonly LifecycleCase[];

describe.each(LIFECYCLE_CASES)('$name lifecycle characterization', (transportCase) => {
	it('preserves normal, notification, status, and correlation behavior', async () => {
		const harness = createProtocolServer();
		const transport = transportCase.create();
		await transport.connect(harness.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;

		try {
			const initialized = await postJson(endpoint, {
				jsonrpc: '2.0',
				id: 'lifecycle-initialize',
				method: 'initialize',
				params: INITIALIZE_PARAMS,
			});
			expect(initialized.status).toBe(200);
			expect(initialized.body?.id).toBe('lifecycle-initialize');

			const sessionId = initialized.headers.get('mcp-session-id');
			const headers: Readonly<Record<string, string>> =
				transportCase.stateful && sessionId ? { 'mcp-session-id': sessionId } : {};
			const notification = await postJson(
				endpoint,
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				headers
			);
			expect(notification.status).toBe(transportCase.notificationStatus);
			expect(notification.body).toBeUndefined();

			const response = await postJson(
				endpoint,
				{ jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} },
				headers
			);
			expect(response.status).toBe(200);
			expect(response.body?.id).toBe(14);
		} finally {
			await transport.stop(1_000);
		}
	});
});

const EARLY_EXIT_CASES = [
	{
		name: 'malformed JSON',
		body: '{ malformed',
		expectedStatus: { HTTP: 200, 'Streamable HTTP': 200 },
		expectedCode: -32700,
		prepare: (_transport: LifecycleTransport) => undefined,
	},
	{
		name: 'invalid JSON-RPC',
		body: JSON.stringify({ method: 'tools/list', id: 'invalid' }),
		expectedStatus: { HTTP: 200, 'Streamable HTTP': 200 },
		expectedCode: -32600,
		prepare: (_transport: LifecycleTransport) => undefined,
	},
	{
		name: 'oversized body',
		body: 'x'.repeat(512),
		expectedStatus: { HTTP: 413, 'Streamable HTTP': 413 },
		expectedCode: -32000,
		prepare: (_transport: LifecycleTransport) => undefined,
	},
	{
		name: 'server not ready',
		body: JSON.stringify({ jsonrpc: '2.0', id: 'not-ready', method: 'tools/list', params: {} }),
		expectedStatus: { HTTP: 200, 'Streamable HTTP': 503 },
		expectedCode: -32603,
		prepare: makeServerNotReady,
	},
] as const;

type RunningLifecycle = {
	readonly transport: LifecycleTransport;
	readonly endpoint: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly started: Promise<void>;
	readonly release: () => void;
};

type RetainedLifecycle = RunningLifecycle & {
	readonly transport: StreamableHttpTransport;
};

async function startControlledLifecycle(
	transportCase: LifecycleCase,
	failsAfterRelease: boolean,
	requestTimeout: number,
	logger?: Logger
): Promise<RunningLifecycle> {
	const controlled = createControlledProtocolServer();
	const transport = transportCase.create({ requestTimeout, ...(logger ? { logger } : {}) });
	await transport.connect(controlled.server);
	const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
	const initialized = await postJson(endpoint, {
		jsonrpc: '2.0',
		id: 'controlled-initialize',
		method: 'initialize',
		params: INITIALIZE_PARAMS,
	});
	if (failsAfterRelease) controlled.rejectReceiveAfterRelease();
	const sessionId = initialized.headers.get('mcp-session-id');
	const headers: Readonly<Record<string, string>> =
		transportCase.stateful && sessionId ? { 'mcp-session-id': sessionId } : {};
	return {
		transport,
		endpoint,
		headers,
		started: controlled.started,
		release: controlled.release,
	};
}

async function startRetainedStreamableLifecycle(
	requestTimeout: number
): Promise<RetainedLifecycle> {
	const controlled = createControlledProtocolServer();
	const transport = new StreamableHttpTransport({
		port: 0,
		host: '127.0.0.1',
		enableRateLimit: false,
		stateful: true,
		requestTimeout,
		maxSessions: 1,
		sessionIdleTimeoutMs: 10,
		sessionSweepIntervalMs: 5,
	});
	await transport.connect(controlled.server);
	const endpoint = `http://127.0.0.1:${getListeningPort(transport)}/mcp`;
	const initialized = await postJson(endpoint, {
		jsonrpc: '2.0',
		id: 'retained-initialize',
		method: 'initialize',
		params: INITIALIZE_PARAMS,
	});
	const sessionId = initialized.headers.get('mcp-session-id');
	if (!sessionId) throw new LifecycleFixtureError('Retained session ID was not returned');
	return {
		transport,
		endpoint,
		headers: { 'mcp-session-id': sessionId },
		started: controlled.started,
		release: controlled.release,
	};
}

function startDelayedBodyRequest(
	endpoint: string,
	body: string
): { readonly request: ClientRequest; readonly response: Promise<{ status: number; body: string }> } {
	const target = new URL(endpoint);
	const response = Promise.withResolvers<{ status: number; body: string }>();
	const request = httpRequest(
		{
			hostname: target.hostname,
			port: Number(target.port),
			path: target.pathname,
			method: 'POST',
			headers: { 'content-type': 'application/json' },
		},
		(incoming) => {
			let responseBody = '';
			incoming.on('data', (chunk: Buffer) => {
				responseBody += chunk.toString();
			});
			incoming.once('end', () => {
				response.resolve({ status: incoming.statusCode ?? 0, body: responseBody });
			});
		}
	);
	request.once('error', response.reject);
	request.flushHeaders();
	request.write(body.slice(0, -1));
	return { request, response: response.promise };
}

function predispatchBody(): Buffer {
	return Buffer.from(
		JSON.stringify({
			jsonrpc: '2.0',
			id: 'predispatch-💡',
			method: 'tools/list',
			params: {},
		})
	);
}

describe.each(LIFECYCLE_CASES)('$name accepted-work transfer', (transportCase) => {
	it('keeps shutdown pending when the handler starts it synchronously', async () => {
		let transport: LifecycleTransport | null = null;
		const stopState: { promise: Promise<void> | null } = { promise: null };
		const controlled = createControlledProtocolServer(() => {
			if (!transport) throw new LifecycleFixtureError('Transport is not initialized');
			stopState.promise = transport.stop(1_000);
		});
		transport = transportCase.create({ requestTimeout: 1_000, stateful: false });
		await transport.connect(controlled.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const server = getTransportServer(transport);
		const pending = startWireRequest(endpoint, controlledCallBody());

		try {
			await controlled.started;
			const capturedStop = stopState.promise;
			if (!capturedStop) throw new LifecycleFixtureError('Handler did not start shutdown');
			pending.disconnect();
			await expect(pending.outcome).resolves.toEqual({ kind: 'closed' });
			expect(server.listening).toBe(false);
			await nextEventLoopTurn();

			expect(
				await Promise.race([
					capturedStop.then(() => 'stopped' as const),
					nextEventLoopTurn().then(() => 'pending' as const),
				])
			).toBe('pending');
			expect(activeRequestCount(transport)).toBe(1);
			expect(outstandingWorkCount(transport)).toBe(1);

			controlled.release();
			await controlled.settled;
			await capturedStop;
			await nextEventLoopTurn();

			expect(activeRequestCount(transport)).toBe(0);
			expect(outstandingWorkCount(transport)).toBe(0);
		} finally {
			controlled.release();
			pending.disconnect();
			await (stopState.promise ?? transport.stop(1_000));
		}
	});

	it('does not dispatch when a later request end listener starts shutdown', async () => {
		const controlled = createControlledProtocolServer();
		const receive = vi.spyOn(controlled.server, 'receive');
		const transport = transportCase.create({ requestTimeout: 1_000, stateful: false });
		const endListenerRan = createDeferred<void>();
		const stopState: { promise: Promise<void> | null } = { promise: null };
		await transport.connect(controlled.server);
		const server = getTransportServer(transport);
		server.once('request', (request) => {
			request.once('end', () => {
				stopState.promise = transport.stop(1_000);
				endListenerRan.resolve(undefined);
			});
		});
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const pending = startWireRequest(endpoint, controlledCallBody());

		try {
			await endListenerRan.promise;
			const capturedStop = stopState.promise;
			if (!capturedStop) throw new LifecycleFixtureError('End listener did not start shutdown');
			const stateAtStop = capturedStop.then(() => ({
				receiveCount: receive.mock.calls.length,
				activeRequests: activeRequestCount(transport),
				acceptedWork: outstandingWorkCount(transport),
			}));
			pending.disconnect();
			await pending.outcome;

			expect(await stateAtStop).toEqual({
				receiveCount: 0,
				activeRequests: 0,
				acceptedWork: 0,
			});
		} finally {
			controlled.release();
			pending.disconnect();
			await (stopState.promise ?? transport.stop(1_000));
			if (receive.mock.calls.length > 0) {
				await controlled.settled;
				await nextEventLoopTurn();
			}
		}
	});
});

describe.each(LIFECYCLE_CASES)('$name pre-dispatch request lifecycle', (transportCase) => {
	it('returns one 413 before a chunked oversized upload ends and never dispatches it', async () => {
		const protocol = createProtocolServer();
		const receive = vi.spyOn(protocol.server, 'receive');
		const sessionIdGenerator = vi.fn(() => 'oversized-session');
		const body = predispatchBody();
		const transport = transportCase.create({
			maxBodySize: body.length - 1,
			requestTimeout: 1_000,
			sessionIdGenerator,
		});
		await transport.connect(protocol.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const exchangePromise = observeNextRequestResponse(transport);
		const pending = startIncompleteWireRequest(endpoint, body);

		try {
			const exchange = await exchangePromise;
			await exchange.firstData;
			await nextEventLoopTurn();

			expect(exchange.request.headers['transfer-encoding']).toBe('chunked');
			expect(exchange.request.headers['content-length']).toBeUndefined();
			expect(exchange.response.writeHeadCount).toBe(1);
			expect(exchange.response.endCount).toBe(1);
			await expect(pending.outcome).resolves.toMatchObject({
				kind: 'response',
				status: 413,
				body: expect.stringContaining('"code":-32000'),
			});
			pending.complete();
			await exchange.requestSettled;
			await nextEventLoopTurn();
			expect(receive).not.toHaveBeenCalled();
			expect(activeRequestCount(transport)).toBe(0);
			expect(outstandingWorkCount(transport)).toBe(0);
			if (transportCase.stateful) {
				expect(sessionIdGenerator).not.toHaveBeenCalled();
				expect(transport.clientCount).toBe(0);
			}
		} finally {
			pending.complete();
			pending.disconnect();
			await transport.stop(1_000);
		}
	});

	it('cancels a timed-out upload before dispatch and ignores a later body tail', async () => {
		const protocol = createProtocolServer();
		const receive = vi.spyOn(protocol.server, 'receive');
		const sessionIdGenerator = vi.fn(() => 'timeout-session');
		const body = predispatchBody();
		const transport = transportCase.create({ requestTimeout: 20, sessionIdGenerator });
		await transport.connect(protocol.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const exchangePromise = observeNextRequestResponse(transport);
		const pending = startIncompleteWireRequest(endpoint, body.subarray(0, -1));

		try {
			const exchange = await exchangePromise;
			await exchange.firstData;
			await expect(pending.outcome).resolves.toMatchObject({ kind: 'response', status: 500 });
			expect(exchange.response.writeHeadCount).toBe(1);
			expect(exchange.response.endCount).toBe(1);

			pending.complete(body.subarray(-1));
			await exchange.requestSettled;
			await nextEventLoopTurn();
			expect(receive).not.toHaveBeenCalled();
			expect(activeRequestCount(transport)).toBe(0);
			expect(outstandingWorkCount(transport)).toBe(0);
			if (transportCase.stateful) {
				expect(sessionIdGenerator).not.toHaveBeenCalled();
				expect(transport.clientCount).toBe(0);
			}
		} finally {
			pending.complete(body.subarray(-1));
			pending.disconnect();
			await transport.stop(1_000);
		}
	});

	it('cleans up an aborted upload without dispatch or stranded tracked work', async () => {
		const protocol = createProtocolServer();
		const receive = vi.spyOn(protocol.server, 'receive');
		const sessionIdGenerator = vi.fn(() => 'aborted-session');
		const body = predispatchBody();
		const transport = transportCase.create({ requestTimeout: 1_000, sessionIdGenerator });
		await transport.connect(protocol.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const exchangePromise = observeNextRequestResponse(transport);
		const pending = startIncompleteWireRequest(endpoint, body.subarray(0, -1));

		try {
			const exchange = await exchangePromise;
			await exchange.firstData;
			const trackedBeforeAbort = outstandingWorkCount(transport);
			pending.disconnect();
			await expect(pending.outcome).resolves.toEqual({ kind: 'closed' });
			await exchange.response.closed;
			await nextEventLoopTurn();

			expect(exchange.request.readableAborted).toBe(true);
			expect(trackedBeforeAbort).toBe(0);
			expect(receive).not.toHaveBeenCalled();
			expect(activeRequestCount(transport)).toBe(0);
			expect(outstandingWorkCount(transport)).toBe(0);
			if (transportCase.stateful) {
				expect(sessionIdGenerator).not.toHaveBeenCalled();
				expect(transport.clientCount).toBe(0);
			}
		} finally {
			pending.disconnect();
			await transport.stop(1_000);
		}
	});

	it(
		'settles pre-dispatch body work when shutdown starts and never dispatches the late tail',
		async () => {
			const protocol = createProtocolServer();
			const receive = vi.spyOn(protocol.server, 'receive');
			const sessionIdGenerator = vi.fn(() => 'shutdown-session');
			const body = predispatchBody();
			const transport = transportCase.create({ requestTimeout: 1_000, sessionIdGenerator });
			await transport.connect(protocol.server);
			const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
			const exchangePromise = observeNextRequestResponse(transport);
			const pending = startIncompleteWireRequest(endpoint, body.subarray(0, -1));
			let stopPromise: Promise<void> | null = null;

			try {
				const exchange = await exchangePromise;
				await exchange.firstData;
				stopPromise = transport.stop(1_000);
				await nextEventLoopTurn();
				const activeBeforeTail = activeRequestCount(transport);
				const trackedBeforeTail = outstandingWorkCount(transport);

				pending.complete(body.subarray(-1));
				await exchange.requestSettled;
				await nextEventLoopTurn();
				pending.disconnect();
				await stopPromise;

				expect(activeBeforeTail).toBe(0);
				expect(trackedBeforeTail).toBe(0);
				expect(receive).not.toHaveBeenCalled();
				expect(activeRequestCount(transport)).toBe(0);
				expect(outstandingWorkCount(transport)).toBe(0);
				if (transportCase.stateful) {
					expect(sessionIdGenerator).not.toHaveBeenCalled();
					expect(transport.clientCount).toBe(0);
				}
			} finally {
				pending.complete(body.subarray(-1));
				pending.disconnect();
				await (stopPromise ?? transport.stop(1_000));
			}
		}
	);
});

describe('Streamable HTTP retained session lifecycle', () => {
	it('rejects a delayed headerless POST that completes after shutdown begins', async () => {
		const sessionIdGenerator = vi.fn(() => 'delayed-body-session');
		const protocol = createProtocolServer();
		const receive = vi.spyOn(protocol.server, 'receive');
		const transport = new StreamableHttpTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
			stateful: true,
			maxSessions: 1,
			sessionIdleTimeoutMs: 1_000,
			sessionSweepIntervalMs: 100,
			sessionIdGenerator,
		});
		await transport.connect(protocol.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}/mcp`;
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 'delayed-body',
			method: 'tools/list',
			params: {},
		});
		const responseProbe = observeNextResponse(transport);
		const delayed = startDelayedBodyRequest(endpoint, body);

		try {
			await responseProbe;
			const firstStop = transport.stop(1_000);
			const secondStop = transport.stop(1_000);
			expect(secondStop).toBe(firstStop);

			delayed.request.end(body.slice(-1));
			await expect(delayed.response).resolves.toMatchObject({
				status: 503,
				body: expect.stringContaining('Server is shutting down'),
			});
			await Promise.all([firstStop, secondStop]);

			expect(sessionIdGenerator).not.toHaveBeenCalled();
			expect(receive).not.toHaveBeenCalled();
			expect(transport.clientCount).toBe(0);
			expect(outstandingWorkCount(transport)).toBe(0);
			expect(Reflect.get(transport, '_sessionSweepIntervalId')).toBeNull();
			expect(getTransportServer(transport).listening).toBe(false);
		} finally {
			delayed.request.destroy();
			await transport.stop(1_000);
		}
	});

	it('pins a timed-out POST until settlement and expires without a completion refresh', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
		const lifecycle = await startRetainedStreamableLifecycle(20);
		await vi.advanceTimersByTimeAsync(5);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);

		try {
			await lifecycle.started;
			await vi.advanceTimersByTimeAsync(20);
			expect(await pending.outcome).toMatchObject({ kind: 'response', status: 500 });
			expect(lifecycle.transport.clientCount).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();
			await vi.advanceTimersByTimeAsync(5);
			expect(lifecycle.transport.clientCount).toBe(0);

			const expired = await postJson(
				lifecycle.endpoint,
				{ jsonrpc: '2.0', id: 'expired-timeout', method: 'tools/list', params: {} },
				lifecycle.headers
			);
			expect(expired.status).toBe(404);
		} finally {
			lifecycle.release();
			pending.disconnect();
			await lifecycle.transport.stop(1_000);
			vi.useRealTimers();
		}
	});

	it('keeps a disconnected POST pinned until its handler settles', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
		const lifecycle = await startRetainedStreamableLifecycle(1_000);
		await vi.advanceTimersByTimeAsync(5);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);

		try {
			await lifecycle.started;
			pending.disconnect();
			expect(await pending.outcome).toEqual({ kind: 'closed' });
			await vi.advanceTimersByTimeAsync(20);
			expect(lifecycle.transport.clientCount).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();
			await vi.advanceTimersByTimeAsync(5);
			expect(lifecycle.transport.clientCount).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
			vi.useRealTimers();
		}
	});

	it('clears retained sessions and joins accepted work across repeated stop calls', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		const lifecycle = await startRetainedStreamableLifecycle(1_000);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);

		try {
			await lifecycle.started;
			const firstStop = lifecycle.transport.stop(1_000);
			const secondStop = lifecycle.transport.stop(1_000);
			expect(secondStop).toBe(firstStop);
			expect(lifecycle.transport.clientCount).toBe(0);
			expect(
				await Promise.race([
					firstStop.then(() => 'stopped'),
					nextEventLoopTurn().then(() => 'pending'),
				])
			).toBe('pending');

			lifecycle.release();
			await Promise.all([firstStop, secondStop]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			lifecycle.release();
			pending.disconnect();
			await lifecycle.transport.stop(1_000);
			vi.useRealTimers();
		}
	});
});

describe.each(LIFECYCLE_CASES)('$name late request lifecycle', (transportCase) => {
	it(`contains a synchronous ${transportCase.writerFailureMethod} failure from timeout finalization`, async () => {
		const logger = new NullLogger();
		const lifecycleFailure = vi.spyOn(logger, 'error').mockImplementation(() => {
			throw new LifecycleFixtureError('injected lifecycle reporter failure');
		});
		const lifecycle = await startControlledLifecycle(transportCase, false, 20, logger);
		const uncaughtExceptions: unknown[] = [];
		const unhandledRejections: unknown[] = [];
		const onUncaughtException = (error: unknown): void => {
			uncaughtExceptions.push(error);
		};
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('uncaughtException', onUncaughtException);
		process.on('unhandledRejection', onUnhandledRejection);
		const responseProbe = observeNextResponse(
			lifecycle.transport,
			transportCase.writerFailureMethod
		);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			await probe.writerFailure;
			await nextEventLoopTurn();

			expect(uncaughtExceptions).toEqual([]);
			expect(unhandledRejections).toEqual([]);
			expect(await pending.outcome).toEqual({ kind: 'closed' });
			await probe.closed;
			expect(probe.writerFailureCount).toBe(1);
			expect(probe.writeHeadCount).toBe(transportCase.expectedWriterCalls.writeHead);
			expect(probe.endCount).toBe(transportCase.expectedWriterCalls.end);
			expect(probe.closeCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			const firstStop = lifecycle.transport.stop(1_000);
			const secondStop = lifecycle.transport.stop(1_000);
			expect(secondStop).toBe(firstStop);
			const stateBeforeRelease = await Promise.race([
				firstStop.then(() => 'stopped' as const),
				new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
			]);
			expect(stateBeforeRelease).toBe('pending');

			lifecycle.release();
			await Promise.all([firstStop, secondStop]);
			await nextEventLoopTurn();

			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(probe.writerFailureCount).toBe(1);
			expect(probe.writeHeadCount).toBe(transportCase.expectedWriterCalls.writeHead);
			expect(probe.endCount).toBe(transportCase.expectedWriterCalls.end);
			expect(lifecycleFailure).toHaveBeenCalledTimes(1);
			expect(lifecycleFailure).toHaveBeenCalledWith(
				`${transportCase.name} request lifecycle failed`,
				{ error: `injected ${transportCase.writerFailureMethod} failure` }
			);
			expect(lifecycleReportingFailureCount(lifecycle.transport)).toBe(1);
			expect(uncaughtExceptions).toEqual([]);
			expect(unhandledRejections).toEqual([]);
		} finally {
			lifecycle.release();
			pending.disconnect();
			process.off('uncaughtException', onUncaughtException);
			process.off('unhandledRejection', onUnhandledRejection);
			await lifecycle.transport.stop(1_000);
		}
	});

	it(`contains a synchronous ${transportCase.writerFailureMethod} failure from normal finalization`, async () => {
		const logger = new NullLogger();
		const lifecycleFailure = vi.spyOn(logger, 'error');
		const lifecycle = await startControlledLifecycle(transportCase, false, 1_000, logger);
		const uncaughtExceptions: unknown[] = [];
		const unhandledRejections: unknown[] = [];
		const onUncaughtException = (error: unknown): void => {
			uncaughtExceptions.push(error);
		};
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('uncaughtException', onUncaughtException);
		process.on('unhandledRejection', onUnhandledRejection);
		const responseProbe = observeNextResponse(
			lifecycle.transport,
			transportCase.writerFailureMethod
		);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			lifecycle.release();
			await probe.writerFailure;
			await probe.closed;
			await nextEventLoopTurn();

			expect(await pending.outcome).toEqual({ kind: 'closed' });
			expect(probe.writerFailureCount).toBe(1);
			expect(probe.writeHeadCount).toBe(transportCase.expectedWriterCalls.writeHead);
			expect(probe.endCount).toBe(transportCase.expectedWriterCalls.end);
			expect(probe.closeCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(lifecycleFailure).toHaveBeenCalledTimes(1);
			expect(lifecycleReportingFailureCount(lifecycle.transport)).toBe(0);
			expect(uncaughtExceptions).toEqual([]);
			expect(unhandledRejections).toEqual([]);
		} finally {
			lifecycle.release();
			pending.disconnect();
			process.off('uncaughtException', onUncaughtException);
			process.off('unhandledRejection', onUnhandledRejection);
			await lifecycle.transport.stop(1_000);
		}
	});

	it('keeps accepted work active and finalizes once when success arrives after timeout', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, false, 20);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({ kind: 'response', status: 500 });
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();

			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(probe.finishCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(unhandled).toEqual([]);
		} finally {
			lifecycle.release();
			process.off('unhandledRejection', onUnhandled);
			await lifecycle.transport.stop(1_000);
		}
	});

	it('contains a handler rejection that arrives after timeout', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, true, 20);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({ kind: 'response', status: 500 });
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();

			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(unhandled).toEqual([]);
		} finally {
			lifecycle.release();
			process.off('unhandledRejection', onUnhandled);
			await lifecycle.transport.stop(1_000);
		}
	});

	it('does not write after disconnect while accepted work continues', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, false, 1_000);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			pending.disconnect();
			expect(await pending.outcome).toEqual({ kind: 'closed' });
			await probe.closed;
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();

			expect(probe.writeHeadCount).toBe(0);
			expect(probe.endCount).toBe(0);
			expect(probe.closeCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
		}
	});

	it('joins timed-out accepted work across concurrent stop calls', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, false, 20);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			expect(await pending.outcome).toMatchObject({ kind: 'response', status: 500 });

			const firstStop = lifecycle.transport.stop(1_000);
			const secondStop = lifecycle.transport.stop(1_000);
			const stateBeforeRelease = await Promise.race([
				firstStop.then(() => 'stopped' as const),
				new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
			]);
			expect(stateBeforeRelease).toBe('pending');

			lifecycle.release();
			await Promise.all([firstStop, secondStop]);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
		}
	});

	it('finalizes a handler error once before the timeout', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, true, 1_000);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			lifecycle.release();
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({ kind: 'response', status: 200 });
			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			await nextEventLoopTurn();
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
		}
	});

	it.each(EARLY_EXIT_CASES)('settles $name exactly once', async (earlyExit) => {
		const controlled = createControlledProtocolServer();
		const transport = transportCase.create({ requestTimeout: 1_000 });
		await transport.connect(controlled.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const responseProbe = observeNextResponse(transport);
		earlyExit.prepare(transport);
		const pending = startWireRequest(endpoint, earlyExit.body);
		try {
			const probe = await responseProbe;
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({
				kind: 'response',
				status: earlyExit.expectedStatus[transportCase.name],
			});
			if (outcome.kind === 'response') {
				expect(outcome.body).toContain(`"code":${earlyExit.expectedCode}`);
			}
			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(activeRequestCount(transport)).toBe(0);
			await nextEventLoopTurn();
			expect(outstandingWorkCount(transport)).toBe(0);
		} finally {
			await transport.stop(1_000);
		}
	});
});

type CloseCallback = (error?: Error) => void;

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

describe.each(LIFECYCLE_CASES)('$name fresh lifecycle repair', (transportCase) => {
	it('rejects occupied-port connect promptly without an uncaught exception', async () => {
		const occupiedServer = createServer();
		await new Promise<void>((resolve, reject) => {
			occupiedServer.once('error', reject);
			occupiedServer.listen(0, '127.0.0.1', resolve);
		});
		const address = occupiedServer.address();
		if (address === null || typeof address === 'string') {
			throw new LifecycleFixtureError('Occupied server port is unavailable');
		}
		const transport = transportCase.create({ port: address.port });
		const uncaughtExceptions: unknown[] = [];
		const onUncaughtException = (error: unknown): void => {
			uncaughtExceptions.push(error);
		};
		process.on('uncaughtException', onUncaughtException);

		try {
			const outcome = await Promise.race([
				transport.connect(createProtocolServer().server).then(
					() => ({ kind: 'resolved' as const }),
					(error: unknown) => ({ kind: 'rejected' as const, error })
				),
				new Promise<{ readonly kind: 'timeout' }>((resolve) => {
					setTimeout(() => resolve({ kind: 'timeout' }), 100);
				}),
			]);
			await nextEventLoopTurn();

			expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'EADDRINUSE' } });
			expect(uncaughtExceptions).toEqual([]);
			await expect(transport.stop(20)).resolves.toBeUndefined();
		} finally {
			process.off('uncaughtException', onUncaughtException);
			await transport.stop(20);
			await closeServer(occupiedServer);
		}
	});

	it('shares a rejecting close callback failure and retries only the failed cache', async () => {
		const transport = transportCase.create();
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const originalClose = server.close.bind(server);
		const closeFailure = new LifecycleFixtureError('injected close callback failure');
		const closeSpy = vi.spyOn(server, 'close');
		closeSpy.mockImplementationOnce((callback) => {
			queueMicrotask(() => callback?.(closeFailure));
			return server;
		});
		closeSpy.mockImplementation((callback) => originalClose(callback));

		try {
			const firstStop = transport.stop(1_000);
			const concurrentStop = transport.stop(1_000);
			expect(concurrentStop).toBe(firstStop);
			const failures = await Promise.allSettled([firstStop, concurrentStop]);
			expect(failures).toEqual([
				{ status: 'rejected', reason: closeFailure },
				{ status: 'rejected', reason: closeFailure },
			]);
			expect(closeSpy).toHaveBeenCalledTimes(1);

			const retryStop = transport.stop(1_000);
			expect(retryStop).not.toBe(firstStop);
			await expect(retryStop).resolves.toBeUndefined();
			expect(closeSpy).toHaveBeenCalledTimes(2);
			expect(transport.stop(1_000)).toBe(retryStop);
		} finally {
			closeSpy.mockRestore();
			if (server.listening) await closeServer(server);
		}
	});

	it('converts a synchronous close throw into a shared rejection and permits retry', async () => {
		const transport = transportCase.create();
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const originalClose = server.close.bind(server);
		const closeFailure = new LifecycleFixtureError('injected synchronous close failure');
		const closeSpy = vi.spyOn(server, 'close');
		closeSpy.mockImplementationOnce(() => {
			throw closeFailure;
		});
		closeSpy.mockImplementation((callback) => originalClose(callback));
		let firstStop: Promise<void> | null = null;

		try {
			expect(() => {
				firstStop = transport.stop(1_000);
			}).not.toThrow();
			if (!firstStop) throw new LifecycleFixtureError('Stop promise was not returned');
			const concurrentStop = transport.stop(1_000);
			expect(concurrentStop).toBe(firstStop);
			const failures = await Promise.allSettled([firstStop, concurrentStop]);
			expect(failures).toEqual([
				{ status: 'rejected', reason: closeFailure },
				{ status: 'rejected', reason: closeFailure },
			]);

			const retryStop = transport.stop(1_000);
			expect(retryStop).not.toBe(firstStop);
			await expect(retryStop).resolves.toBeUndefined();
			expect(transport.stop(1_000)).toBe(retryStop);
		} finally {
			closeSpy.mockRestore();
			if (server.listening) await closeServer(server);
		}
	});

	it('finalizes a rejected readiness check once without an unhandled rejection', async () => {
		const logger = new NullLogger();
		const lifecycleFailure = vi.spyOn(logger, 'error');
		const healthChecker = new HealthChecker();
		vi.spyOn(healthChecker, 'checkReadiness').mockRejectedValue(
			new LifecycleFixtureError('injected readiness failure')
		);
		const transport = transportCase.create({ healthChecker, logger });
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('unhandledRejection', onUnhandledRejection);
		const responseProbe = observeNextResponse(transport);

		try {
			const response = await fetch(`http://127.0.0.1:${getListeningPort(transport)}/ready`, {
				signal: AbortSignal.timeout(100),
			});
			const body: unknown = await response.json();
			const probe = await responseProbe;
			await nextEventLoopTurn();

			expect(response.status).toBe(500);
			expect(body).toEqual({
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32603,
					message: 'Internal error',
					data: 'injected readiness failure',
				},
			});
			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(lifecycleFailure).toHaveBeenCalledTimes(1);
			expect(lifecycleFailure).toHaveBeenCalledWith(
				`${transportCase.name} request lifecycle failed`,
				{ error: 'injected readiness failure' }
			);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
			await transport.stop(1_000);
			if (server.listening) await closeServer(server);
		}
	});
});

describe('Streamable HTTP fresh lifecycle repair', () => {
	it('settles a timeout-first close once and ignores a late callback error', async () => {
		const transport = new StreamableHttpTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
		});
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const originalClose = server.close.bind(server);
		const closeCallback: { current: CloseCallback | null } = { current: null };
		const closeSpy = vi.spyOn(server, 'close').mockImplementation((callback) => {
			closeCallback.current = callback ?? null;
			return server;
		});
		const forceClose = vi.spyOn(server, 'closeAllConnections').mockImplementation(() => undefined);
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('unhandledRejection', onUnhandledRejection);

		try {
			const firstStop = transport.stop(10);
			expect(transport.stop(10)).toBe(firstStop);
			await expect(firstStop).resolves.toBeUndefined();
			expect(forceClose).toHaveBeenCalledTimes(1);
			const capturedCloseCallback = closeCallback.current;
			if (!capturedCloseCallback)
				throw new LifecycleFixtureError('Close callback was not captured');
			capturedCloseCallback(new LifecycleFixtureError('late close callback failure'));
			await nextEventLoopTurn();

			expect(forceClose).toHaveBeenCalledTimes(1);
			expect(transport.stop(10)).toBe(firstStop);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
			closeSpy.mockRestore();
			forceClose.mockRestore();
			if (server.listening)
				await new Promise<void>((resolve, reject) => {
					originalClose((error) => (error ? reject(error) : resolve()));
				});
		}
	});
});

describe.each(LIFECYCLE_CASES)('$name bounded stop', (transportCase) => {
	afterEach(() => {
		vi.useRealTimers();
	});

	async function startGatedRequest() {
		const lifecycle = await startControlledLifecycle(transportCase, false, 120_000);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), {
			...lifecycle.headers,
			connection: 'close',
		});
		await lifecycle.started;
		return { ...lifecycle, pending };
	}

	function recordSettlement(stopping: Promise<void>): unknown[] {
		const settled: unknown[] = [];
		void stopping.then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error)
		);
		return settled;
	}

	it('rejects from its own timer with the abandoned count even when closeAllConnections tears nothing down', async () => {
		// Given
		const gated = await startGatedRequest();
		const server = getTransportServer(gated.transport);
		const forceClose = vi.spyOn(server, 'closeAllConnections').mockImplementation(() => undefined);
		const stopping = gated.transport.stop(5_000);
		const settled = recordSettlement(stopping);

		// When
		await vi.advanceTimersByTimeAsync(4_999);
		const settledBeforeTimeout = [...settled];
		await vi.advanceTimersByTimeAsync(1);
		await stopping.catch(() => undefined);

		// Then
		expect(settledBeforeTimeout).toEqual([]);
		expect(settled).toHaveLength(1);
		expect(settled[0]).toBeInstanceOf(TransportStopTimeoutError);
		expect(settled[0]).toMatchObject({
			code: 'TRANSPORT_STOP_TIMEOUT',
			timeoutMs: 5_000,
			abandonedRequests: 1,
		});
		expect(forceClose).toHaveBeenCalledTimes(1);
		expect(outstandingWorkCount(gated.transport)).toBe(1);
		forceClose.mockRestore();
		gated.release();
		await gated.pending.outcome;
		server.closeAllConnections();
		await gated.transport.stop(1_000);
	});

	it('lets a later stop() start a new bounded join that settles once the abandoned work does', async () => {
		// Given
		const gated = await startGatedRequest();
		const first = gated.transport.stop(5_000);
		const firstOutcome = first.then(
			() => null,
			(error: unknown) => error
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await firstOutcome).toBeInstanceOf(TransportStopTimeoutError);
		expect(await gated.pending.outcome).toEqual({ kind: 'closed' });

		// When
		const second = gated.transport.stop(5_000);
		const settled = recordSettlement(second);
		await vi.advanceTimersByTimeAsync(4_999);
		const settledBeforeRelease = [...settled];
		gated.release();
		await second;

		// Then
		expect(second).not.toBe(first);
		expect(settledBeforeRelease).toEqual([]);
		expect(settled).toEqual(['resolved']);
		expect(outstandingWorkCount(gated.transport)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('joins accepted work that finishes inside the timeout without force-closing', async () => {
		// Given
		const gated = await startGatedRequest();
		const forceClose = vi.spyOn(getTransportServer(gated.transport), 'closeAllConnections');
		const stopping = gated.transport.stop(5_000);

		// When
		await vi.advanceTimersByTimeAsync(4_999);
		gated.release();
		await stopping;

		// Then
		expect(forceClose).not.toHaveBeenCalled();
		expect(outstandingWorkCount(gated.transport)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(await gated.pending.outcome).toMatchObject({ kind: 'response', status: 200 });
	});

	it('defaults to a 30000 ms timeout when stop() receives no argument', async () => {
		// Given
		const gated = await startGatedRequest();
		const stopping = gated.transport.stop();
		const settled = recordSettlement(stopping);

		// When
		await vi.advanceTimersByTimeAsync(29_999);
		const settledBeforeDefault = [...settled];
		await vi.advanceTimersByTimeAsync(1);
		await stopping.catch(() => undefined);

		// Then
		expect(settledBeforeDefault).toEqual([]);
		expect(settled[0]).toMatchObject({ timeoutMs: 30_000, abandonedRequests: 1 });
		gated.release();
		await gated.pending.outcome;
		await gated.transport.stop(1_000);
	});
});

class ControlledPersistence extends MemoryPersistence {
	public probe: () => Promise<boolean> = async () => true;
	public failThoughtWrites = false;
	public failClearSession = false;
	public failClearAll = false;

	public override healthy(): Promise<boolean> {
		return this.probe();
	}

	public override async saveThoughtForSession(
		sessionId: SessionId,
		thought: ThoughtData
	): Promise<void> {
		if (this.failThoughtWrites) throw new LifecycleFixtureError('thought write failed');
		await super.saveThoughtForSession(sessionId, thought);
	}

	public override async clearSession(sessionId: SessionId): Promise<void> {
		if (this.failClearSession) throw new LifecycleFixtureError('session reset failed');
		await super.clearSession(sessionId);
	}

	public override async clearAll(): Promise<void> {
		if (this.failClearAll) throw new LifecycleFixtureError('global reset failed');
		await super.clearAll();
	}
}

describe.each(LIFECYCLE_CASES)('$name readiness from persistence state', (transportCase) => {
	const histories: HistoryManager[] = [];
	const transports: LifecycleTransport[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		await Promise.all(transports.splice(0).map((transport) => transport.stop(1_000)));
		await Promise.all(histories.splice(0).map((history) => history.shutdown()));
	});

	async function startReady(persistence: ControlledPersistence) {
		const history = new HistoryManager({
			persistence,
			persistenceFlushInterval: 60_000,
			persistenceMaxRetries: 0,
		});
		histories.push(history);
		const healthChecker = new HealthChecker({ persistence, persistenceBacklog: history });
		const transport = transportCase.create({ healthChecker });
		transports.push(transport);
		await transport.connect(createProtocolServer().server);
		const ready = async (): Promise<{ status: number; body: HealthCheckResult }> => {
			const response = await fetch(`http://127.0.0.1:${getListeningPort(transport)}/ready`, {
				signal: AbortSignal.timeout(5_000),
			});
			return { status: response.status, body: JSON.parse(await response.text()) };
		};
		return { history, ready };
	}

	it('stays ready and counts a quarantined session, a blocked session, a retained failure and pending work', async () => {
		// Given
		const persistence = new ControlledPersistence();
		const { history, ready } = await startReady(persistence);
		history.addThought(createTestThought({ id: 'quarantined-1', session_id: 'ready-quarantined' }));
		await history.drainSession(asSessionId('ready-quarantined'));
		persistence.failClearSession = true;
		await expect(history.resetSession('ready-quarantined')).rejects.toThrow('session reset failed');
		persistence.failClearSession = false;
		persistence.failThoughtWrites = true;
		history.addThought(createTestThought({ id: 'failed-1', session_id: 'ready-failing' }));
		await expect(history.drainSession(asSessionId('ready-failing'))).rejects.toThrow();
		persistence.failThoughtWrites = false;
		history.addThought(createTestThought({ id: 'waiting-1', session_id: 'ready-waiting' }));

		// When
		const { status, body } = await ready();

		// Then
		expect(status).toBe(200);
		expect(body.status).toBe('ok');
		expect(body.components['persistenceBacklog']).toEqual({
			name: 'persistenceBacklog',
			healthy: true,
			details: 'quarantined sessions: 1, blocked sessions: 1, retained failures: 1, pending thoughts: 2',
		});
	});

	it('answers 503 while persistence is globally quarantined and 200 once a reset succeeds', async () => {
		// Given
		const persistence = new ControlledPersistence();
		const { history, ready } = await startReady(persistence);
		persistence.failClearAll = true;
		await expect(history.resetAll()).rejects.toThrow('global reset failed');

		// When
		const quarantined = await ready();
		persistence.failClearAll = false;
		await history.resetAll();
		const recovered = await ready();

		// Then
		expect(quarantined.status).toBe(503);
		expect(quarantined.body.components['persistenceBacklog']?.healthy).toBe(false);
		expect(quarantined.body.components['persistence']?.healthy).toBe(true);
		expect(recovered.status).toBe(200);
	});

	it('answers 503 when the probe fails', async () => {
		// Given
		const persistence = new ControlledPersistence();
		persistence.probe = async () => false;
		const { ready } = await startReady(persistence);

		// When
		const { status, body } = await ready();

		// Then
		expect(status).toBe(503);
		expect(body.components['persistence']?.healthy).toBe(false);
	});

	it('answers 503 at the deadline when the probe never settles and joins it until it does', async () => {
		// Given
		const persistence = new ControlledPersistence();
		const probeStarted = createDeferred<undefined>();
		const probeResult = createDeferred<boolean>();
		let probeCalls = 0;
		persistence.probe = () => {
			probeCalls += 1;
			probeStarted.resolve(undefined);
			return probeResult.promise;
		};
		const { ready } = await startReady(persistence);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const first = ready();
		await probeStarted.promise;

		// When
		await vi.advanceTimersByTimeAsync(1_000);
		const timedOut = await first;
		const joined = await ready();
		probeResult.resolve(true);
		const recovered = await ready();

		// Then
		expect(timedOut.status).toBe(503);
		expect(timedOut.body.components['persistence']?.details).toBe(
			'Health check timed out after 1000ms'
		);
		expect(joined.status).toBe(503);
		expect(probeCalls).toBe(2);
		expect(recovered.status).toBe(200);
	});
});
