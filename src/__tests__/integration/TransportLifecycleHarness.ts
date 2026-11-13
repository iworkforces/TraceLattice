import {
	request,
	Server,
	type ClientRequest,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { createConnection } from 'node:net';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import { vi } from 'vitest';
import type { HttpTransport } from '../../transport/HttpTransport.js';
import type { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';
import { INITIALIZE_PARAMS, getListeningPort, postJson } from './ProtocolHarness.js';

export type LifecycleTransport = HttpTransport | StreamableHttpTransport;

export type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
};

export type ControlledProtocolServer = {
	readonly server: McpServer;
	readonly started: Promise<void>;
	readonly settled: Promise<void>;
	readonly release: () => void;
	readonly rejectReceiveAfterRelease: () => void;
};

export type ResponseProbe = {
	readonly closed: Promise<void>;
	readonly writerFailure: Promise<void>;
	readonly closeCount: number;
	readonly finishCount: number;
	readonly writeHeadCount: number;
	readonly endCount: number;
	readonly writerFailureCount: number;
};

export type ResponseWriterMethod = 'writeHead' | 'end';

export type WireOutcome =
	| {
			readonly kind: 'response';
			readonly status: number;
			readonly body: string;
	  }
	| { readonly kind: 'closed' };

export type PendingWireRequest = {
	readonly outcome: Promise<WireOutcome>;
	readonly disconnect: () => void;
};

export type PendingUpload = PendingWireRequest & {
	readonly complete: (tail?: string | Buffer) => void;
};

export type RequestResponseProbe = {
	readonly request: IncomingMessage;
	readonly response: ResponseProbe;
	readonly firstData: Promise<Buffer>;
	readonly requestSettled: Promise<'aborted' | 'ended'>;
};

export class LifecycleFixtureError extends Error {
	override readonly name = 'LifecycleFixtureError';
}

export function createDeferred<T>(): Deferred<T> {
	const state: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((resolve) => {
		state.resolve = resolve;
	});
	return {
		promise,
		resolve(value): void {
			if (!state.resolve) throw new LifecycleFixtureError('Deferred resolver is unavailable');
			state.resolve(value);
		},
	};
}

export function createControlledProtocolServer(onHandlerStarted?: () => void): ControlledProtocolServer {
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const settled = createDeferred<void>();
	const server = new McpServer(
		{ name: 'transport-lifecycle', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
	server.tool({ name: 'controlled', description: 'Controlled lifecycle fixture' }, async () => {
		started.resolve(undefined);
		onHandlerStarted?.();
		try {
			await release.promise;
			return { content: [{ type: 'text', text: 'released' }] };
		} finally {
			settled.resolve(undefined);
		}
	});
	return {
		server,
		started: started.promise,
		settled: settled.promise,
		release: () => release.resolve(undefined),
		rejectReceiveAfterRelease: () => {
			vi.spyOn(server, 'receive').mockImplementation(async () => {
				started.resolve(undefined);
				await release.promise;
				throw new LifecycleFixtureError('controlled receive failure');
			});
		},
	};
}

export function getTransportServer(transport: LifecycleTransport): Server {
	const server = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) {
		throw new LifecycleFixtureError('Transport server is not initialized');
	}
	return server;
}

export function controlledCallBody(): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id: 'controlled-call',
		method: 'tools/call',
		params: { name: 'controlled', arguments: {} },
	});
}

export type GatedTransport = {
	readonly endpoint: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly started: Promise<void>;
	readonly release: () => void;
};

export async function connectGatedTransport(
	transport: LifecycleTransport,
	path: string
): Promise<GatedTransport> {
	const controlled = createControlledProtocolServer();
	await transport.connect(controlled.server);
	const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${path}`;
	const initialized = await postJson(endpoint, {
		jsonrpc: '2.0',
		id: 'gated-initialize',
		method: 'initialize',
		params: INITIALIZE_PARAMS,
	});
	const sessionId = initialized.headers.get('mcp-session-id');
	return {
		endpoint,
		headers: sessionId ? { 'mcp-session-id': sessionId } : {},
		started: controlled.started,
		release: controlled.release,
	};
}

export function observeNextResponse(
	transport: LifecycleTransport,
	writerFailureMethod?: ResponseWriterMethod
): Promise<ResponseProbe> {
	const server = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) {
		throw new LifecycleFixtureError('Transport server is not initialized');
	}
	return new Promise((resolve) => {
		server.prependOnceListener('request', (_request, response) => {
			resolve(createResponseProbe(response, writerFailureMethod));
		});
	});
}

export function observeNextRequestResponse(
	transport: LifecycleTransport
): Promise<RequestResponseProbe> {
	const server = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) {
		throw new LifecycleFixtureError('Transport server is not initialized');
	}
	return new Promise((resolve) => {
		server.prependOnceListener('request', (incomingRequest, response) => {
			const firstData = createDeferred<Buffer>();
			const requestSettled = createDeferred<'aborted' | 'ended'>();
			incomingRequest.once('data', (chunk: Buffer | string) => {
				firstData.resolve(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			});
			incomingRequest.once('aborted', () => requestSettled.resolve('aborted'));
			incomingRequest.once('end', () => requestSettled.resolve('ended'));
			resolve({
				request: incomingRequest,
				response: createResponseProbe(response),
				firstData: firstData.promise,
				requestSettled: requestSettled.promise,
			});
		});
	});
}

export function startWireRequest(
	url: string,
	body: string,
	headers: Readonly<Record<string, string>> = {}
): PendingWireRequest {
	const target = new URL(url);
	let requestCompleted = false;
	const outcome = createDeferred<WireOutcome>();
	const clientRequest: ClientRequest = request(
		{
			hostname: target.hostname,
			port: Number(target.port),
			path: target.pathname,
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
		},
		(response) => {
			let responseBody = '';
			response.on('data', (chunk: Buffer) => {
				responseBody += chunk.toString();
			});
			response.once('end', () => {
				requestCompleted = true;
				outcome.resolve({
					kind: 'response',
					status: response.statusCode ?? 0,
					body: responseBody,
				});
			});
		}
	);
	clientRequest.once('close', () => {
		if (!requestCompleted) outcome.resolve({ kind: 'closed' });
	});
	clientRequest.once('error', () => {
		if (!requestCompleted) outcome.resolve({ kind: 'closed' });
	});
	clientRequest.end(body);
	return {
		outcome: outcome.promise,
		disconnect: () => clientRequest.destroy(),
	};
}

export function startIncompleteWireRequest(
	url: string,
	initialChunk: string | Buffer,
	headers: Readonly<Record<string, string>> = {}
): PendingUpload {
	const target = new URL(url);
	let requestCompleted = false;
	let uploadCompleted = false;
	const outcome = createDeferred<WireOutcome>();
	let responseBytes = Buffer.alloc(0);
	const socket = createConnection({ host: target.hostname, port: Number(target.port) }, () => {
		const requestHeaders = {
			host: target.host,
			'content-type': 'application/json',
			'transfer-encoding': 'chunked',
			...headers,
		};
		const headerLines = Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`);
		socket.write(
			`POST ${target.pathname}${target.search} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`
		);
		writeChunk(socket, initialChunk);
	});
	socket.on('data', (chunk: Buffer) => {
		responseBytes = Buffer.concat([responseBytes, chunk]);
		const response = parseHttpResponse(responseBytes);
		if (!response || requestCompleted) return;
		requestCompleted = true;
		outcome.resolve(response);
	});
	socket.once('close', () => {
		if (!requestCompleted) outcome.resolve({ kind: 'closed' });
	});
	socket.once('error', () => {
		if (!requestCompleted) outcome.resolve({ kind: 'closed' });
	});
	return {
		outcome: outcome.promise,
		disconnect: () => socket.destroy(),
		complete: (tail = '') => {
			if (uploadCompleted || socket.destroyed) return;
			uploadCompleted = true;
			if (Buffer.byteLength(tail) > 0) writeChunk(socket, tail);
			socket.write('0\r\n\r\n');
		},
	};
}

function writeChunk(socket: ReturnType<typeof createConnection>, chunk: string | Buffer): void {
	const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
	socket.write(`${bytes.length.toString(16)}\r\n`);
	socket.write(bytes);
	socket.write('\r\n');
}

function parseHttpResponse(bytes: Buffer): WireOutcome | null {
	const headerEnd = bytes.indexOf('\r\n\r\n');
	if (headerEnd < 0) return null;
	const headerLines = bytes.subarray(0, headerEnd).toString('latin1').split('\r\n');
	const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(headerLines[0] ?? '');
	if (!statusMatch) throw new LifecycleFixtureError('Raw HTTP response omitted its status line');
	const responseHeaders = new Map<string, string>();
	for (const line of headerLines.slice(1)) {
		const separator = line.indexOf(':');
		if (separator > 0) {
			responseHeaders.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
		}
	}
	const bodyBytes = bytes.subarray(headerEnd + 4);
	const contentLength = responseHeaders.get('content-length');
	if (contentLength !== undefined) {
		const length = Number(contentLength);
		if (bodyBytes.length < length) return null;
		return {
			kind: 'response',
			status: Number(statusMatch[1]),
			body: bodyBytes.subarray(0, length).toString('utf8'),
		};
	}
	if (responseHeaders.get('transfer-encoding') === 'chunked') {
		const body = parseChunkedBody(bodyBytes);
		if (body === null) return null;
		return { kind: 'response', status: Number(statusMatch[1]), body };
	}
	return null;
}

function parseChunkedBody(bytes: Buffer): string | null {
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const sizeEnd = bytes.indexOf('\r\n', offset);
		if (sizeEnd < 0) return null;
		const size = Number.parseInt(bytes.subarray(offset, sizeEnd).toString('ascii'), 16);
		if (!Number.isFinite(size)) throw new LifecycleFixtureError('Invalid response chunk size');
		offset = sizeEnd + 2;
		if (size === 0) return Buffer.concat(chunks).toString('utf8');
		if (bytes.length < offset + size + 2) return null;
		chunks.push(bytes.subarray(offset, offset + size));
		offset += size + 2;
	}
	return null;
}

export function activeRequestCount(transport: LifecycleTransport): number {
	const count = Reflect.get(transport, '_activeRequests');
	if (typeof count !== 'number') {
		throw new LifecycleFixtureError('Transport active request count is unavailable');
	}
	return count;
}

export function outstandingWorkCount(transport: LifecycleTransport): number {
	const tracker = Reflect.get(transport, '_acceptedWork');
	if (typeof tracker !== 'object' || tracker === null) {
		throw new LifecycleFixtureError('Transport accepted work tracker is unavailable');
	}
	const count = Reflect.get(tracker, 'size');
	if (typeof count !== 'number') {
		throw new LifecycleFixtureError('Transport outstanding work count is unavailable');
	}
	return count;
}

export function lifecycleReportingFailureCount(transport: LifecycleTransport): number {
	const reporter = Reflect.get(transport, '_lifecycleFailureReporter');
	if (typeof reporter !== 'object' || reporter === null) {
		throw new LifecycleFixtureError('Transport lifecycle failure reporter is unavailable');
	}
	const failures = Reflect.get(reporter, 'reportingFailures');
	if (!Array.isArray(failures)) {
		throw new LifecycleFixtureError('Lifecycle reporting failures are unavailable');
	}
	return failures.length;
}

export function makeServerNotReady(transport: LifecycleTransport): void {
	if (!Reflect.set(transport, '_mcpServer', null)) {
		throw new LifecycleFixtureError('Could not clear MCP server fixture');
	}
}

export async function nextEventLoopTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function createResponseProbe(
	response: ServerResponse,
	writerFailureMethod?: ResponseWriterMethod
): ResponseProbe {
	let closeCount = 0;
	let finishCount = 0;
	let writerFailureCount = 0;
	const writerFailure = createDeferred<void>();
	const closed = new Promise<void>((resolve) => {
		response.once('close', () => {
			closeCount++;
			resolve();
		});
	});
	response.once('finish', () => {
		finishCount++;
	});
	const writeHead = vi.spyOn(response, 'writeHead');
	const end = vi.spyOn(response, 'end');
	if (writerFailureMethod === 'writeHead') {
		writeHead.mockImplementationOnce(() => {
			writerFailureCount++;
			writerFailure.resolve(undefined);
			throw new LifecycleFixtureError('injected writeHead failure');
		});
	}
	if (writerFailureMethod === 'end') {
		end.mockImplementationOnce(() => {
			writerFailureCount++;
			writerFailure.resolve(undefined);
			throw new LifecycleFixtureError('injected end failure');
		});
	}
	return {
		closed,
		writerFailure: writerFailure.promise,
		get closeCount(): number {
			return closeCount;
		},
		get finishCount(): number {
			return finishCount;
		},
		get writeHeadCount(): number {
			return writeHead.mock.calls.length;
		},
		get endCount(): number {
			return end.mock.calls.length;
		},
		get writerFailureCount(): number {
			return writerFailureCount;
		},
	};
}
