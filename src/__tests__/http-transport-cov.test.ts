import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { HttpTransport } from '../transport/HttpTransport.js';
import { getListeningPort } from './integration/ProtocolHarness.js';

class HttpFixtureError extends Error {
	override readonly name = 'HttpFixtureError';
}

function httpRequest(options: {
	port: number;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
	timeout?: number;
}): Promise<{
	statusCode: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		let responseEnded = false;
		const req = request(
			{
				hostname: '127.0.0.1',
				port: options.port,
				path: options.path ?? '/messages',
				method: options.method ?? 'POST',
				headers: options.headers,
				timeout: options.timeout ?? 5000,
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk.toString();
				});
				res.once('error', reject);
				res.once('aborted', () => {
					reject(new HttpFixtureError('Response aborted'));
				});
				res.once('close', () => {
					if (!responseEnded || !res.complete) {
						reject(new HttpFixtureError('Response closed before completing'));
					}
				});
				res.on('end', () => {
					responseEnded = true;
					resolve({
						statusCode: res.statusCode ?? 0,
						body,
						headers: res.headers as Record<string, string | string[] | undefined>,
					});
				});
			}
		);
		req.once('error', reject);
		req.on('timeout', () => {
			req.destroy(new HttpFixtureError('Request timeout'));
		});
		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

async function connectTransport(transport: HttpTransport, mcpServer: McpServer): Promise<number> {
	await transport.connect(mcpServer);
	return getListeningPort(transport);
}

describe('HttpTransport additional coverage', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		await transport.stop();
	});

	describe('POST body handling', () => {
		it('should accept valid JSON-RPC and return 200', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mockMcpServer = new McpServer(
				{ name: 'test-http-cov', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			port = await connectTransport(transport, mockMcpServer);

			const response = await httpRequest({
				port,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: {},
				}),
			});
			expect(response.statusCode).toBe(200);
		});

		it('should return parse error for invalid JSON', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mockMcpServer = new McpServer(
				{ name: 'test-parse', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			port = await connectTransport(transport, mockMcpServer);
			const response = await httpRequest({
				port,
				body: '{invalid json',
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('Parse error');
		});

		it('should return validation error for invalid JSON-RPC schema', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mockMcpServer = new McpServer(
				{ name: 'test-validation', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			port = await connectTransport(transport, mockMcpServer);
			const response = await httpRequest({
				port,
				body: JSON.stringify({ method: 'tools/list' }),
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('Invalid Request');
		});

		it('should return error when MCP server receive fails', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			const response = await httpRequest({
				port,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: {},
				}),
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('Internal error');
		});

		it('should return 204 for notification (null response)', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mockMcpServer = new McpServer(
				{ name: 'test-notification', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			port = await connectTransport(transport, mockMcpServer);
			const response = await httpRequest({
				port,
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/initialized',
				}),
			});
			expect(response.statusCode).toBe(204);
			expect(response.body).toBe('');
		});
	});

	describe('request body size limit', () => {
		it('should return 413 for oversized body', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				maxBodySize: 100,
			});
			const mockMcpServer = new McpServer(
				{ name: 'test-body-size', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			port = await connectTransport(transport, mockMcpServer);
			const response = await httpRequest({
				port,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: { data: 'x'.repeat(200) },
				}),
			});
			expect(response.statusCode).toBe(413);
			expect(response.body).toContain('too large');
		});

		it('should accept body when size limit disabled', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				enableBodySizeLimit: false,
			});
			const mockMcpServer = new McpServer(
				{ name: 'test-no-limit', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			port = await connectTransport(transport, mockMcpServer);
			const response = await httpRequest({
				port,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: {},
				}),
			});
			expect(response.statusCode).toBe(200);
		});
	});

	describe('health and readiness endpoints', () => {
		it('should return health status', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			const response = await httpRequest({
				port,
				method: 'GET',
				path: '/health',
			});
			expect(response.statusCode).toBe(200);
			const data = JSON.parse(response.body);
			expect(data.status).toBe('healthy');
		});

		it('should return readiness status', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			const response = await httpRequest({
				port,
				method: 'GET',
				path: '/ready',
			});
			expect(response.statusCode).toBe(200);
		});

		it('should return 404 for unknown paths', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			const response = await httpRequest({
				port,
				method: 'GET',
				path: '/unknown',
			});
			expect(response.statusCode).toBe(404);
		});
	});

	describe('metrics endpoint', () => {
		it('should return 404 when no provider configured', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			const response = await httpRequest({
				port,
				method: 'GET',
				path: '/metrics',
			});
			expect(response.statusCode).toBe(404);
		});

		it('should return metrics when provider configured', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				metricsProvider: () => '# HELP test_metric\n# TYPE test_metric counter\ntest_metric 1\n',
			});
			port = await connectTransport(transport, {} as McpServer);
			const response = await httpRequest({
				port,
				method: 'GET',
				path: '/metrics',
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('test_metric');
		});
	});

	describe('shutting down', () => {
		it('should return 503 when shutting down', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			Reflect.set(transport, '_isShuttingDown', true);
			const response = await httpRequest({
				port,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: {},
				}),
			});
			expect(response.statusCode).toBe(503);
		});
	});

	describe('requestCount', () => {
		it('should track request count', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			port = await connectTransport(transport, {} as McpServer);
			expect(transport.requestCount).toBe(0);
			await httpRequest({
				port,
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
			});
			expect(transport.requestCount).toBe(1);
		});
	});

	describe('clientCount', () => {
		it('should track active requests count', async () => {
			transport = new HttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			expect(transport.clientCount).toBe(0);
		});
	});
});

describe('HttpTransport coverage: mcpServer not ready (null)', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) await transport.stop();
	});

	it('should return JSON-RPC error when mcpServer is null', async () => {
		transport = new HttpTransport({
			port,
			host: '127.0.0.1',
			enableRateLimit: false,
		});
		port = await connectTransport(transport, {} as McpServer);

		// Force _mcpServer to null to test the 'server not ready' branch
		(transport as unknown as { _mcpServer: null })._mcpServer = null;

		const response = await httpRequest({
			port,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			}),
		});
		expect(response.statusCode).toBe(200);
		expect(response.body).toContain('Server not ready');
	});
});

describe('HttpTransport coverage: createHttpTransport factory', () => {
	it('should create transport with default options', () => {
		const t = new HttpTransport({ port: 19999, host: '127.0.0.1' });
		expect(t).toBeInstanceOf(HttpTransport);
		expect(t.clientCount).toBe(0);
		expect(t.requestCount).toBe(0);
	});

	it('should create transport via factory function', async () => {
		const { createHttpTransport } = await import('../transport/HttpTransport.js');
		const t = createHttpTransport({ port: 19998, host: '127.0.0.1' });
		expect(t).toBeInstanceOf(HttpTransport);
	});
});

describe('HttpTransport coverage: OPTIONS preflight', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) await transport.stop();
	});

	it('should return 204 for OPTIONS request', async () => {
		transport = new HttpTransport({
			port,
			host: '127.0.0.1',
			enableRateLimit: false,
		});
		port = await connectTransport(transport, {} as McpServer);

		const response = await httpRequest({
			port,
			method: 'OPTIONS',
			path: '/messages',
		});
		expect(response.statusCode).toBe(204);
	});
});

describe('HttpTransport coverage: rate limiting', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) await transport.stop();
	});

	it('should return 429 when rate limited', async () => {
		transport = new HttpTransport({
			port,
			host: '127.0.0.1',
			enableRateLimit: true,
			maxRequestsPerMinute: 1,
		});
		port = await connectTransport(transport, {} as McpServer);

		// First request should pass
		await httpRequest({
			port,
			method: 'GET',
			path: '/health',
		});

		// Second request should be rate limited
		const response = await httpRequest({
			port,
			method: 'GET',
			path: '/health',
		});
		expect(response.statusCode).toBe(429);
		expect(response.body).toContain('Too many requests');
	});
});

describe('HttpTransport coverage: CORS origin validation', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) await transport.stop();
	});

	it('should return 403 for invalid CORS origin', async () => {
		transport = new HttpTransport({
			port,
			host: '127.0.0.1',
			enableRateLimit: false,
			corsOrigin: 'https://allowed.com',
		});
		port = await connectTransport(transport, {} as McpServer);

		const response = await httpRequest({
			port,
			method: 'GET',
			path: '/health',
			headers: { Origin: 'https://evil.com' },
		});
		expect(response.statusCode).toBe(403);
		expect(response.body).toContain('Forbidden');
	});
});

describe('HttpTransport coverage: host header validation', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(() => {
		port = 0;
	});

	afterEach(async () => {
		if (transport) await transport.stop();
	});

	it('should return 403 for invalid host header', async () => {
		transport = new HttpTransport({
			port,
			host: '127.0.0.1',
			enableRateLimit: false,
			allowedHosts: ['allowed.com'],
		});
		port = await connectTransport(transport, {} as McpServer);

		const response = await httpRequest({
			port,
			method: 'GET',
			path: '/health',
			headers: { Host: 'evil.com' },
		});
		expect(response.statusCode).toBe(403);
		expect(response.body).toContain('Forbidden');
	});
});
