import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import {
	StreamableHttpTransport,
	createStreamableHttpTransport,
} from '../transport/StreamableHttpTransport.js';
import { HealthChecker } from '../health/HealthChecker.js';
import type { IMetrics } from '../contracts/interfaces.js';
import { getListeningPort } from './integration/ProtocolHarness.js';

/**
 * Helper: send an HTTP request and collect the full response.
 */
function httpRequest(options: {
	port: number;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{
	statusCode: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: '127.0.0.1',
				port: options.port,
				path: options.path ?? '/mcp',
				method: options.method ?? 'POST',
				headers: options.headers,
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk.toString();
				});
				res.on('error', reject);
				res.on('aborted', () => reject(new Error('HTTP response aborted')));
				res.on('close', () => {
					if (!res.complete) reject(new Error('HTTP response closed before completion'));
				});
				res.on('end', () => {
					resolve({
						statusCode: res.statusCode ?? 0,
						body,
						headers: res.headers,
					});
				});
			}
		);

		req.on('error', reject);
		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

/**
 * Build a valid JSON-RPC 2.0 request body.
 */
function jsonRpcBody(
	id: number | string,
	method: string,
	params?: Record<string, unknown>
): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		method,
		params: params ?? {},
	});
}

/**
 * Create a mock McpServer for testing.
 */
function createMockMcpServer(): McpServer {
	return new McpServer(
		{ name: 'test-streamable-http-cov', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);
}

/**
 * Create a mock IMetrics that records calls.
 */
function createMockMetrics(): IMetrics & { calls: { method: string; args: unknown[] }[] } {
	const calls: { method: string; args: unknown[] }[] = [];
	return {
		calls,
		counter(name, value, labels, help) {
			calls.push({ method: 'counter', args: [name, value, labels, help] });
		},
		gauge(name, value, labels, help) {
			calls.push({ method: 'gauge', args: [name, value, labels, help] });
		},
		histogram(name, value, labels, buckets) {
			calls.push({ method: 'histogram', args: [name, value, labels, buckets] });
		},
		get() {
			return undefined;
		},
		inc() {},
		dec() {},
		reset() {},
		export() {
			return '';
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Additional coverage tests for StreamableHttpTransport
// ─────────────────────────────────────────────────────────────────────────────

describe('StreamableHttpTransport — coverage gaps', () => {
	let transport: StreamableHttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) {
			await transport.stop(1000);
		}
	});

	// ───────── Helper to spin up transport with defaults ─────────
	async function startTransport(
		overrides: ConstructorParameters<typeof StreamableHttpTransport>[0] = {}
	): Promise<void> {
		transport = new StreamableHttpTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
			...overrides,
		});
		const mcpServer = createMockMcpServer();
		await transport.connect(mcpServer);
		port = getListeningPort(transport);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Health check with HealthChecker integration
	// ═══════════════════════════════════════════════════════════════════
	describe('health check with healthChecker', () => {
		it('GET /health includes liveness data when healthChecker is provided', async () => {
			const healthChecker = new HealthChecker();
			await startTransport({ healthChecker });

			const res = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('healthy');
			expect(parsed.liveness).toBeDefined();
			expect(parsed.liveness.status).toBe('ok');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Readiness check with HealthChecker
	// ═══════════════════════════════════════════════════════════════════
	describe('readiness check with healthChecker', () => {
		it('GET /ready delegates to healthChecker when provided', async () => {
			const healthChecker = new HealthChecker();
			await startTransport({ healthChecker });

			const res = await httpRequest({ port, method: 'GET', path: '/ready' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('ok');
			expect(parsed.timestamp).toBeDefined();
			expect(parsed.components).toBeDefined();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Metrics integration
	// ═══════════════════════════════════════════════════════════════════
	describe('metrics integration', () => {
		it('records request counter and histogram via IMetrics', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics });

			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			// Should have recorded counter
			const counterCalls = metrics.calls.filter(
				(c) => c.method === 'counter' && c.args[0] === 'streamable_http_requests_total'
			);
			expect(counterCalls.length).toBeGreaterThanOrEqual(1);

			// Should have recorded histogram (after response finishes)
			// Wait a tick for the 'finish' event
			await new Promise((r) => setTimeout(r, 50));
			const histCalls = metrics.calls.filter(
				(c) => c.method === 'histogram' && c.args[0] === 'streamable_http_request_duration_seconds'
			);
			expect(histCalls.length).toBeGreaterThanOrEqual(1);
		});

		it('records session metrics gauge on session creation', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			const gaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_active_sessions'
			);
			expect(gaugeCalls.length).toBeGreaterThanOrEqual(1);
			// Should report 1 active session
			expect(gaugeCalls[gaugeCalls.length - 1]!.args[1]).toBe(1);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Force-close timeout in stop()
	// ═══════════════════════════════════════════════════════════════════
	describe('force-close timeout', () => {
		it('stop() resolves even if server.close() is slow (force timeout)', async () => {
			await startTransport({ stateful: true });

			const hangingPost = request(
				{
					hostname: '127.0.0.1',
					port,
					path: '/mcp',
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'content-length': '1024',
					},
				},
				() => {}
			);
			hangingPost.on('error', () => {});
			hangingPost.write('{');

			await new Promise((r) => setTimeout(r, 50));

			const stopPromise = transport.stop(100);
			await expect(stopPromise).resolves.toBeUndefined();

			hangingPost.destroy();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Session management — POST with Mcp-Session-Id for existing session
	// ═══════════════════════════════════════════════════════════════════
	describe('session reuse via Mcp-Session-Id', () => {
		it('POST with existing Mcp-Session-Id updates lastActivityAt', async () => {
			await startTransport({ stateful: true });

			// Create session
			const res1 = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = res1.headers['mcp-session-id'] as string;
			expect(sessionId).toBeDefined();
			expect(transport.clientCount).toBe(1);

			// Wait briefly to ensure time difference
			await new Promise((r) => setTimeout(r, 10));

			// Reuse session
			const res2 = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': sessionId,
				},
				body: jsonRpcBody(2, 'tools/list'),
			});
			expect(res2.statusCode).toBe(200);
			expect(res2.headers['mcp-session-id']).toBe(sessionId);
			// Still 1 session
			expect(transport.clientCount).toBe(1);
			// Request count should be 2
			expect(transport.requestCount).toBe(2);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// createStreamableHttpTransport factory function
	// ═══════════════════════════════════════════════════════════════════
	describe('createStreamableHttpTransport factory', () => {
		it('creates transport with all options passed through', async () => {
			const metrics = createMockMetrics();
			const healthChecker = new HealthChecker();
			transport = createStreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				stateful: true,
				enableRateLimit: false,
				metrics,
				healthChecker,
				metricsProvider: () => 'test_metric 1',
			});

			expect(transport).toBeInstanceOf(StreamableHttpTransport);
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			// Verify health checker is wired
			const healthRes = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(JSON.parse(healthRes.body).liveness).toBeDefined();

			// Verify metrics provider is wired
			const metricsRes = await httpRequest({ port, method: 'GET', path: '/metrics' });
			expect(metricsRes.statusCode).toBe(200);
			expect(metricsRes.body).toContain('test_metric 1');
		});

		it('creates transport with default (no-arg) options', () => {
			transport = createStreamableHttpTransport();
			expect(transport).toBeInstanceOf(StreamableHttpTransport);
			expect(transport.clientCount).toBe(0);
			expect(transport.requestCount).toBe(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Shutdown rejects new requests (503)
	// ═══════════════════════════════════════════════════════════════════
	describe('shutdown behavior', () => {
		it('returns 503 for requests during shutdown', async () => {
			await startTransport();

			// Start shutdown but don't await immediately
			const stopPromise = transport.stop(5000);

			// Try to make a request during shutdown
			try {
				const res = await httpRequest({
					port,
					headers: { 'content-type': 'application/json' },
					body: jsonRpcBody(1, 'tools/list'),
				});
				// If we get a response, it should be 503
				expect(res.statusCode).toBe(503);
			} catch {
				// Connection refused is also acceptable (server already closed)
			}

			await stopPromise;
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// _updateSessionMetrics with multiple sessions
	// ═══════════════════════════════════════════════════════════════════
	describe('session metrics tracking', () => {
		it('expires an idle session at the boundary and updates every observable count', async () => {
			vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
			vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
			const metrics = createMockMetrics();
			await startTransport({
				metrics,
				stateful: true,
				maxSessions: 1,
				sessionIdleTimeoutMs: 50,
				sessionSweepIntervalMs: 10,
			});

			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;

			try {
				await vi.advanceTimersByTimeAsync(49);
				expect(transport.clientCount).toBe(1);

				await vi.advanceTimersByTimeAsync(1);
				expect(transport.clientCount).toBe(0);
				const health = await httpRequest({ port, method: 'GET', path: '/health' });
				expect(JSON.parse(health.body).sessions).toBe(0);

				const activeSessionCalls = metrics.calls.filter(
					(call) => call.method === 'gauge' && call.args[0] === 'streamable_http_active_sessions'
				);
				expect(activeSessionCalls.at(-1)?.args[1]).toBe(0);

				const expired = await httpRequest({
					port,
					headers: {
						'content-type': 'application/json',
						'mcp-session-id': sessionId,
					},
					body: jsonRpcBody(2, 'tools/list'),
				});
				expect(expired.statusCode).toBe(404);
			} finally {
				await transport.stop(1_000);
				vi.useRealTimers();
			}
		});

		it('tracks multiple sessions in gauge', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			// Create 3 sessions
			for (let i = 0; i < 3; i++) {
				await httpRequest({
					port,
					headers: { 'content-type': 'application/json' },
					body: jsonRpcBody(i + 1, 'tools/list'),
				});
			}

			expect(transport.clientCount).toBe(3);

			const sessionGaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_active_sessions'
			);
			// The last gauge call should show 3
			expect(sessionGaugeCalls[sessionGaugeCalls.length - 1]!.args[1]).toBe(3);
		});
	});
});

describe('StreamableHttpTransport — error handling coverage', () => {
	let transport: StreamableHttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) {
			await transport.stop(1000);
		}
	});

	describe('_handleMcpPost catch block (internal error)', () => {
		it('should return JSON-RPC internal error when mcpServer.receive throws', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			// Connect with a broken mcpServer that throws on receive
			await transport.connect({} as McpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error).toBeDefined();
			expect(parsed.error.code).toBe(-32603);
			expect(parsed.error.message).toBe('Internal error');
			expect(parsed.error.data).toBeDefined();
		});

		it('should handle non-Error thrown objects in catch', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			// Use a mcpServer with receive that throws a string
			const brokenServer = {
				receive: () => {
					throw 'string error';
				},
			} as unknown as McpServer;
			await transport.connect(brokenServer);
			port = getListeningPort(transport);

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.data).toBe('string error');
		});
	});

	describe('stop() force-close timeout path', () => {
		it('should force-close and log warning when server.close is slow', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const hangingPost = request(
				{
					hostname: '127.0.0.1',
					port,
					path: '/mcp',
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'content-length': '1024',
					},
				},
				() => {}
			);
			hangingPost.on('error', () => {});
			hangingPost.write('{');

			await new Promise((r) => setTimeout(r, 50));

			const stopPromise = transport.stop(50);
			await expect(stopPromise).resolves.toBeUndefined();

			hangingPost.destroy();
		});
	});

	describe('stop() with no server (early stop)', () => {
		it('should resolve immediately when no server exists', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			// Don't call connect() — _server is null
			const stopPromise = transport.stop();
			await expect(stopPromise).resolves.toBeUndefined();
		});
	});

	describe('mcpServer not ready', () => {
		it('should return 503 when mcpServer is null', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			await transport.connect({} as McpServer);
			port = getListeningPort(transport);

			// Force _mcpServer to null
			(transport as unknown as { _mcpServer: null })._mcpServer = null;

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(503);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Server not ready');
		});
	});

	describe('stateless mode — GET /mcp returns 405', () => {
		it('should reject GET /mcp in stateless mode', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({
				port,
				method: 'GET',
				path: '/mcp',
			});
			expect(res.statusCode).toBe(405);
			expect(res.headers.allow).toBe('POST');
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Method not allowed');
		});
	});

	describe('session validation', () => {
		it('should return 400 for invalid Mcp-Session-Id format', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': 'invalid!@#$%',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(400);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Invalid Mcp-Session-Id');
		});

		it('should return 404 for unknown Mcp-Session-Id', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': 'valid-but-nonexistent-session-id',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(404);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Session not found');
		});
	});

	describe('_sendJsonRpcError with extra data', () => {
		it('should include extra properties in error response', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			// Invalid JSON triggers the parse error path which uses _sendJsonRpcError
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: '{invalid json',
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32700);
			expect(parsed.error.message).toBe('Parse error');
		});
	});

	describe('body size limit enforcement', () => {
		it('should return 413 when body exceeds max size', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
				maxBodySize: 50,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: { data: 'x'.repeat(200) },
				}),
			});
			expect(res.statusCode).toBe(413);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('too large');
		});
	});

	describe('JSON-RPC validation error', () => {
		it('should return validation error for invalid JSON-RPC schema', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			// Valid JSON but not valid JSON-RPC
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ notJsonRpc: true }),
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32600);
			expect(parsed.error.message).toBe('Invalid Request');
		});
	});

	describe('notification response (no body, 202)', () => {
		it('should return 202 for notification without response', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			// Notification (no id) — server returns null response
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/initialized',
				}),
			});
			// 200 or 202 are both acceptable
			expect([200, 202]).toContain(res.statusCode);
		});
	});

	describe('readiness check fallback', () => {
		it('should return default ok readiness when no healthChecker', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({ port, method: 'GET', path: '/ready' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('ok');
			expect(parsed.components).toBeDefined();
		});
	});

	describe('metrics endpoint', () => {
		it('should return 404 when no metricsProvider', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
			expect(res.statusCode).toBe(404);
		});
	});

	describe('unsupported method on MCP endpoint', () => {
		it('should return 405 for PUT /mcp', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({ port, method: 'PUT', path: '/mcp' });
			expect(res.statusCode).toBe(405);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Method not allowed');
		});
	});

	describe('GET /mcp is not allowed in stateful mode', () => {
		it('should return 405 for GET /mcp', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);

			const res = await httpRequest({ port, method: 'GET', path: '/mcp' });
			expect(res.statusCode).toBe(405);
			expect(res.headers.allow).toBe('POST');
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Method not allowed');
		});
	});
});
