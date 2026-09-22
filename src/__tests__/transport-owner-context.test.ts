/**
 * Tests for owner identity propagation in transports (WU-3.2).
 *
 * Verifies that each transport sets the owner identifier in AsyncLocalStorage
 * (`runWithContext`) for the duration of the MCP request processing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { HttpTransport } from '../transport/HttpTransport.js';
import { StreamableHttpTransport } from '../transport/StreamableHttpTransport.js';
import { getOwner, getRequestId } from '../context/RequestContext.js';
import { getListeningPort } from './integration/ProtocolHarness.js';

interface CapturedContext {
	owner: string | undefined;
	requestId: string | undefined;
}

function makeMcpServer(): McpServer {
	return new McpServer(
		{ name: 'test-owner-ctx', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
}

function postJson(
	port: number,
	path: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<{
	statusCode: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = request(
			{
				hostname: '127.0.0.1',
				port,
				path,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload).toString(),
					...headers,
				},
			},
			(res) => {
				let buf = '';
				res.on('data', (chunk) => {
					buf += chunk.toString();
				});
				res.once('error', reject);
				res.once('aborted', () => {
					reject(new Error('Response aborted before completion'));
				});
				res.once('close', () => {
					if (!res.complete) {
						reject(new Error('Response closed before completion'));
					}
				});
				res.on('end', () => {
					resolve({
						statusCode: res.statusCode ?? 0,
						body: buf,
						headers: res.headers,
					});
				});
			}
		);
		req.on('error', reject);
		req.write(payload);
		req.end();
	});
}

/**
 * Patch the _mcpServer's receive method to capture context state at call time.
 */
function spyContext(transport: { _mcpServer?: unknown }): CapturedContext[] {
	const captured: CapturedContext[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mcp = (transport as any)._mcpServer;
	const originalReceive = mcp.receive.bind(mcp);
	mcp.receive = async (req: unknown, opts: unknown) => {
		captured.push({ owner: getOwner(), requestId: getRequestId() });
		return originalReceive(req, opts);
	};
	return captured;
}

describe('Transport owner identity propagation (WU-3.2)', () => {
	describe('HttpTransport', () => {
		let transport: HttpTransport | undefined;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			transport = undefined;
			const nextTransport = new HttpTransport({
				port: 0,
				host: '127.0.0.1',
				maxRequestsPerMinute: 1000,
			});
			transport = nextTransport;
			await nextTransport.connect(makeMcpServer());
			port = getListeningPort(nextTransport);
			captured = spyContext(nextTransport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			if (transport !== undefined) await transport.stop();
		});

		it('sets a unique owner per request (stateless UUID)', async () => {
			await postJson(port, '/messages', {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			});
			await postJson(port, '/messages', {
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: {},
			});

			expect(captured).toHaveLength(2);
			expect(captured[0]!.owner).toBeDefined();
			expect(captured[1]!.owner).toBeDefined();
			expect(captured[0]!.owner).not.toBe(captured[1]!.owner);
			expect(captured[0]!.requestId).toBeDefined();
		});
	});

	describe('StreamableHttpTransport (stateful)', () => {
		let transport: StreamableHttpTransport | undefined;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			transport = undefined;
			const nextTransport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				stateful: true,
				maxRequestsPerMinute: 1000,
			});
			transport = nextTransport;
			await nextTransport.connect(makeMcpServer());
			port = getListeningPort(nextTransport);
			captured = spyContext(nextTransport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			if (transport !== undefined) await transport.stop();
		});

		it('sets owner = sessionId for stateful sessions', async () => {
			// First request: server creates a session and returns Mcp-Session-Id
			const res1 = await postJson(port, '/mcp', {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			});
			const sessionId = res1.headers['mcp-session-id'] as string | undefined;
			expect(sessionId).toBeDefined();

			// Second request reuses the session
			await postJson(
				port,
				'/mcp',
				{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
				{
					'mcp-session-id': sessionId!,
				}
			);

			expect(captured).toHaveLength(2);
			// Owner should match session ID for both calls
			expect(captured[0]!.owner).toBe(sessionId);
			expect(captured[1]!.owner).toBe(sessionId);
		});
	});

	describe('StreamableHttpTransport (stateless)', () => {
		let transport: StreamableHttpTransport | undefined;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			transport = undefined;
			const nextTransport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				stateful: false,
				maxRequestsPerMinute: 1000,
			});
			transport = nextTransport;
			await nextTransport.connect(makeMcpServer());
			port = getListeningPort(nextTransport);
			captured = spyContext(nextTransport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			if (transport !== undefined) await transport.stop();
		});

		it('sets a unique owner per request (UUID)', async () => {
			await postJson(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
			await postJson(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

			expect(captured).toHaveLength(2);
			expect(captured[0]!.owner).toBeDefined();
			expect(captured[1]!.owner).toBeDefined();
			expect(captured[0]!.owner).not.toBe(captured[1]!.owner);
		});
	});
});
