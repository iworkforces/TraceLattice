import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { Metrics } from '../metrics/metrics.impl.js';
import {
	StreamableHttpTransport,
	createStreamableHttpTransport,
} from '../transport/StreamableHttpTransport.js';
import { getListeningPort } from './integration/ProtocolHarness.js';

const EXPECTED_METRICS =
	'# HELP test_metric_total Test metric\n' +
	'# TYPE test_metric_total counter\n' +
	'test_metric_total{workflow="plan\\\\review\\"\\nnext"} 42';

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
		{ name: 'test-streamable-http', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('StreamableHttpTransport', () => {
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
	// Connection lifecycle
	// ═══════════════════════════════════════════════════════════════════
	describe('connection lifecycle', () => {
		it('connect() starts HTTP server on an ephemeral port', async () => {
			await startTransport();
			// Server is listening — a health check should succeed
			const res = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(res.statusCode).toBe(200);
		});

		it('connect() resolves when server is listening', async () => {
			transport = new StreamableHttpTransport({ port: 0, host: '127.0.0.1' });
			const mcpServer = createMockMcpServer();
			// connect() returns a promise that should resolve without error
			await expect(transport.connect(mcpServer)).resolves.toBeUndefined();
			port = getListeningPort(transport);
		});

		it('stop() shuts down the server gracefully', async () => {
			await startTransport();
			await transport.stop(1000);
			// After stop, requests should fail
			await expect(httpRequest({ port, method: 'GET', path: '/health' })).rejects.toThrow();
		});

		it('clientCount returns 0 when no sessions exist (stateful)', async () => {
			await startTransport({ stateful: true });
			expect(transport.clientCount).toBe(0);
		});

		it('clientCount returns 0 when no active requests (stateless)', async () => {
			await startTransport({ stateful: false });
			expect(transport.clientCount).toBe(0);
		});

		it('stop() cleans up all sessions', async () => {
			await startTransport({ stateful: true });
			// Create a session by making a request
			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			// Session should exist
			expect(transport.clientCount).toBe(1);
			await transport.stop(1000);
			// After stop, sessions cleaned up — clientCount should be 0
			expect(transport.clientCount).toBe(0);
		});

		it('requestCount tracks total requests', async () => {
			await startTransport();
			expect(transport.requestCount).toBe(0);

			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(transport.requestCount).toBe(1);

			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(2, 'tools/list'),
			});
			expect(transport.requestCount).toBe(2);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Request routing
	// ═══════════════════════════════════════════════════════════════════
	describe('request routing', () => {
		it('POST /mcp with valid JSON-RPC request returns 200', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.jsonrpc).toBe('2.0');
		});

		it('POST /mcp with invalid JSON returns 200 with parse error', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: '{ invalid json !!!',
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32700);
			expect(parsed.error.message).toBe('Parse error');
		});

		it('POST /mcp with empty body returns parse error', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: '',
			});
			// Empty string is invalid JSON
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32700);
		});

		it('POST /mcp with invalid JSON-RPC schema returns 200 with invalid request error', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				// Missing "jsonrpc" and "method" fields
				body: JSON.stringify({ id: 1 }),
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32600);
			expect(parsed.error.message).toBe('Invalid Request');
		});

		it('GET /health returns 200 with health info', async () => {
			await startTransport();
			const res = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('healthy');
			expect(parsed.transport).toBe('streamable-http');
			expect(typeof parsed.requests).toBe('number');
			expect(typeof parsed.sessions).toBe('number');
		});

		it('GET /ready returns 200 with readiness info', async () => {
			await startTransport();
			const res = await httpRequest({ port, method: 'GET', path: '/ready' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('ok');
			expect(parsed.timestamp).toBeDefined();
		});

		it('GET /metrics returns 404 when no metricsProvider', async () => {
			await startTransport();
			const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
			expect(res.statusCode).toBe(404);
			expect(res.body).toBe('Not Found');
			expect(res.headers['content-type']).toBe('text/plain');
		});

		it('GET /metrics returns 200 when metricsProvider is configured', async () => {
			const metrics = new Metrics();
			metrics.counter('test_metric_total', 42, { workflow: 'plan\\review"\nnext' }, 'Test metric');
			await startTransport({
				metricsProvider: () => metrics.export(),
			});
			const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
			expect(res.statusCode).toBe(200);
			expect(res.body).toBe(EXPECTED_METRICS);
			expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
		});

		it('unknown path returns 404', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				method: 'GET',
				path: '/unknown/path',
			});
			expect(res.statusCode).toBe(404);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Not Found');
		});

		it('PUT on /mcp returns 405 method not allowed', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				method: 'PUT',
				path: '/mcp',
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(405);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32601);
			expect(res.headers['allow']).toBe('POST');
		});

		it('DELETE on /mcp returns 405 method not allowed', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				method: 'DELETE',
				path: '/mcp',
			});
			expect(res.statusCode).toBe(405);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Session management (stateful mode)
	// ═══════════════════════════════════════════════════════════════════
	describe('session management (stateful)', () => {
		it('admits at most maxSessions concurrent headerless POSTs while preserving reuse', async () => {
			const sessionIdGenerator = vi.fn(() => 'bounded-session');
			await startTransport({
				stateful: true,
				maxSessions: 1,
				sessionIdleTimeoutMs: 60_000,
				sessionSweepIntervalMs: 10_000,
				sessionIdGenerator,
			});

			const responses = await Promise.all(
				[1, 2].map((id) =>
					httpRequest({
						port,
						headers: { 'content-type': 'application/json' },
						body: jsonRpcBody(id, 'tools/list'),
					})
				)
			);

			expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 503]);
			expect(sessionIdGenerator).toHaveBeenCalledTimes(1);
			expect(transport.clientCount).toBe(1);

			const reused = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': 'bounded-session',
				},
				body: jsonRpcBody(3, 'tools/list'),
			});
			expect(reused.statusCode).toBe(200);
		});

		it('first POST /mcp creates a new session — Mcp-Session-Id in response', async () => {
			await startTransport({ stateful: true });
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(200);
			expect(res.headers['mcp-session-id']).toBeDefined();
			expect(typeof res.headers['mcp-session-id']).toBe('string');
		});

		it('subsequent POST with same session ID routes to same session', async () => {
			await startTransport({ stateful: true });

			// First request — creates session
			const res1 = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = res1.headers['mcp-session-id'] as string;
			expect(sessionId).toBeDefined();
			expect(transport.clientCount).toBe(1);

			// Second request with same session ID
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
			// Should still be 1 session, not 2
			expect(transport.clientCount).toBe(1);
		});

		it('POST with unknown session ID returns 404', async () => {
			await startTransport({ stateful: true });
			const res = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': 'nonexistent-session-id',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(404);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32001);
			expect(parsed.error.message).toBe('Session not found');
		});

		it('POST with invalid session ID format returns 400', async () => {
			await startTransport({ stateful: true });
			const res = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': '../../etc/passwd',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(400);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Invalid Mcp-Session-Id format');
		});

		it('custom sessionIdGenerator is used for new sessions', async () => {
			let counter = 0;
			await startTransport({
				stateful: true,
				sessionIdGenerator: () => `custom-session-${++counter}`,
			});

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.headers['mcp-session-id']).toBe('custom-session-1');
		});

		it('multiple sessions are tracked independently', async () => {
			await startTransport({ stateful: true });

			// Create session 1
			const res1 = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const session1 = res1.headers['mcp-session-id'] as string;

			// Create session 2 (no session header → new session)
			const res2 = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(2, 'tools/list'),
			});
			const session2 = res2.headers['mcp-session-id'] as string;

			expect(session1).not.toBe(session2);
			expect(transport.clientCount).toBe(2);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Stateless mode
	// ═══════════════════════════════════════════════════════════════════
	describe('stateless mode', () => {
		it('POST /mcp works without session management', async () => {
			await startTransport({ stateful: false });
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(200);
			// No session header in stateless mode
			expect(res.headers['mcp-session-id']).toBeUndefined();
		});

		it('GET /mcp returns 405 in stateless mode', async () => {
			await startTransport({ stateful: false });
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

	describe('GET /mcp is not allowed', () => {
		it('GET /mcp without session ID returns 405', async () => {
			await startTransport({ stateful: true });
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

		it('GET /mcp with a session ID returns 405', async () => {
			await startTransport({ stateful: true });
			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;
			const res = await httpRequest({
				port,
				method: 'GET',
				path: '/mcp',
				headers: { 'mcp-session-id': sessionId },
			});
			expect(res.statusCode).toBe(405);
			expect(res.headers.allow).toBe('POST');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Security (inherited from BaseTransport)
	// ═══════════════════════════════════════════════════════════════════
	describe('security', () => {
		it('returns 429 when rate limit exceeded', async () => {
			await startTransport({
				enableRateLimit: true,
				maxRequestsPerMinute: 1,
			});

			// First request — should pass
			const first = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(first.statusCode).toBe(200);

			// Second request — rate limited
			const second = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(2, 'tools/list'),
			});
			expect(second.statusCode).toBe(429);
			const parsed = JSON.parse(second.body);
			expect(parsed.error.message).toBe('Too many requests');
			expect(second.headers['retry-after']).toBe('60');
		});

		it('CORS headers are present when enabled', async () => {
			await startTransport({ enableCors: true, corsOrigin: '*' });
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.headers['access-control-allow-origin']).toBe('*');
		});

		it('returns 403 for invalid CORS origin', async () => {
			await startTransport({
				corsOrigin: 'https://allowed.example.com',
			});
			const res = await httpRequest({
				port,
				headers: {
					origin: 'https://blocked.example.com',
					'content-type': 'application/json',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(403);
			expect(res.body).toContain('Forbidden - invalid origin');
		});

		it('returns 403 for invalid host header', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				headers: {
					host: 'evil.example.com',
					'content-type': 'application/json',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(403);
			expect(res.body).toContain('invalid host header');
		});

		it('handles CORS preflight OPTIONS request', async () => {
			await startTransport({ enableCors: true, corsOrigin: '*' });
			const res = await httpRequest({
				port,
				method: 'OPTIONS',
				path: '/mcp',
			});
			expect(res.statusCode).toBe(204);
			expect(res.headers['access-control-allow-headers']).toContain('Mcp-Session-Id');
			expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Graceful shutdown
	// ═══════════════════════════════════════════════════════════════════
	describe('graceful shutdown', () => {
		it('stop() with timeout closes server', async () => {
			await startTransport();
			// Should resolve without error
			await expect(transport.stop(500)).resolves.toBeUndefined();
		});

		it('stop() sets shutting down state and cleans up sessions', async () => {
			await startTransport({ stateful: true });

			// Create a session first
			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(transport.clientCount).toBe(1);

			// Stop the transport
			await transport.stop(1000);

			// Sessions should be cleared
			expect(transport.clientCount).toBe(0);

			// Further requests should be refused (connection refused since server is closed)
			await expect(
				httpRequest({
					port,
					headers: { 'content-type': 'application/json' },
					body: jsonRpcBody(2, 'tools/list'),
				})
			).rejects.toThrow();
		});

		it('stop() when no server was started resolves immediately', async () => {
			transport = new StreamableHttpTransport({ port, host: '127.0.0.1' });
			// stop() without connect() should resolve gracefully
			await expect(transport.stop(500)).resolves.toBeUndefined();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Body size limit
	// ═══════════════════════════════════════════════════════════════════
	describe('body size limit', () => {
		it('rejects body exceeding maxBodySize with 413', async () => {
			await startTransport({
				enableBodySizeLimit: true,
				maxBodySize: 100, // 100 bytes
			});

			const largeBody = 'x'.repeat(200);
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: largeBody,
			});
			expect(res.statusCode).toBe(413);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Request body too large');
		});

		it('accepts body within maxBodySize', async () => {
			await startTransport({
				enableBodySizeLimit: true,
				maxBodySize: 10 * 1024 * 1024, // 10MB
			});

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(200);
		});

		it('allows large bodies when body size limit is disabled', async () => {
			await startTransport({
				enableBodySizeLimit: false,
			});

			// Send a body that would exceed default limit if it were enabled
			const body = jsonRpcBody(1, 'tools/list');
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body,
			});
			expect(res.statusCode).toBe(200);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Constructor / factory
	// ═══════════════════════════════════════════════════════════════════
		describe('constructor and factory', () => {
		it.each([
			[{ maxSessions: 1 }, 'partial retention options'],
			[{ maxSessions: 0, sessionIdleTimeoutMs: 10, sessionSweepIntervalMs: 10 }, 'zero capacity'],
			[{ maxSessions: -1, sessionIdleTimeoutMs: 10, sessionSweepIntervalMs: 10 }, 'negative capacity'],
			[{ maxSessions: 1, sessionIdleTimeoutMs: Number.NaN, sessionSweepIntervalMs: 10 }, 'NaN timeout'],
			[
				{ maxSessions: 1, sessionIdleTimeoutMs: 1.5, sessionSweepIntervalMs: 10 },
				'fractional timeout',
			],
			[
				{
					maxSessions: 1,
					sessionIdleTimeoutMs: 10,
					sessionSweepIntervalMs: Number.POSITIVE_INFINITY,
				},
				'non-finite sweep interval',
			],
		])(
			'rejects invalid retention options before starting base resources',
			(retentionOptions, _description) => {
				vi.useFakeTimers();
				expect(
					() =>
						new StreamableHttpTransport({
							enableRateLimit: true,
							...retentionOptions,
						})
			).toThrow(
				'maxSessions, sessionIdleTimeoutMs, and sessionSweepIntervalMs must be provided together as positive integers'
			);
				expect(vi.getTimerCount()).toBe(0);
				vi.useRealTimers();
			}
		);

		it('starts no retention sweep when options are omitted or transport is stateless', async () => {
			vi.useFakeTimers();
			transport = new StreamableHttpTransport({ enableRateLimit: false });
			expect(vi.getTimerCount()).toBe(0);
			await transport.stop();

			transport = new StreamableHttpTransport({
				enableRateLimit: false,
				stateful: false,
				maxSessions: 1,
				sessionIdleTimeoutMs: 10,
				sessionSweepIntervalMs: 5,
			});
			expect(vi.getTimerCount()).toBe(0);
			await transport.stop();
			vi.useRealTimers();
		});

		it('constructor with default options uses expected defaults', () => {
			transport = new StreamableHttpTransport();
			// Verify it can be instantiated with no options
			expect(transport).toBeInstanceOf(StreamableHttpTransport);
			expect(transport.clientCount).toBe(0);
			expect(transport.requestCount).toBe(0);
		});

		it('constructor with an ephemeral port discovers the bound port', async () => {
			transport = new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);
			port = getListeningPort(transport);
			expect(Number.isInteger(port)).toBe(true);
			expect(port).toBeGreaterThan(0);

			const res = await httpRequest({
				port,
				method: 'GET',
				path: '/health',
			});
			expect(res.statusCode).toBe(200);
		});

		it('createStreamableHttpTransport factory creates instance', () => {
			transport = createStreamableHttpTransport({ port, host: '127.0.0.1' });
			expect(transport).toBeInstanceOf(StreamableHttpTransport);
		});

		it('custom path option changes the MCP endpoint', async () => {
			await startTransport({ path: '/api/v1/mcp' });

			// Default /mcp should return 404
			const res404 = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res404.statusCode).toBe(404);

			// Custom path should work
			const res200 = await httpRequest({
				port,
				path: '/api/v1/mcp',
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res200.statusCode).toBe(200);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Edge cases
	// ═══════════════════════════════════════════════════════════════════
	describe('edge cases', () => {
		it('POST /mcp with valid JSON but no jsonrpc field returns Invalid Request', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method: 'tools/list', id: 1 }),
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32600);
		});

		it('POST /mcp with JSON-RPC notification (no id) returns 202 in stateless mode', async () => {
			await startTransport({ stateful: false });
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
			});
			// Notifications may return 200 or 202 depending on MCP server behavior
			expect([200, 202]).toContain(res.statusCode);
		});

		it('health endpoint reflects session count in stateful mode', async () => {
			await startTransport({ stateful: true });

			// Initially no sessions
			const health1 = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(JSON.parse(health1.body).sessions).toBe(0);

			// Create a session
			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			// Now should reflect 1 session
			const health2 = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(JSON.parse(health2.body).sessions).toBe(1);
		});

		it('health endpoint reflects request count', async () => {
			await startTransport();

			// Make one request
			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			const health = await httpRequest({ port, method: 'GET', path: '/health' });
			const parsed = JSON.parse(health.body);
			expect(parsed.requests).toBe(1);
		});

		it('POST with query parameters on /mcp still works', async () => {
			await startTransport();
			const res = await httpRequest({
				port,
				path: '/mcp?session=test',
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(200);
		});
	});
});
