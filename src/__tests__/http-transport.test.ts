import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { Metrics } from '../metrics/metrics.impl.js';
import { HttpTransport } from '../transport/HttpTransport.js';
import { getListeningPort } from './integration/ProtocolHarness.js';

const EXPECTED_METRICS =
	'# HELP test_metric_total Test metric\n' +
	'# TYPE test_metric_total counter\n' +
	'test_metric_total{workflow="plan\\\\review\\"\\nnext"} 42';

class HttpFixtureError extends Error {
	override readonly name = 'HttpFixtureError';
}

function createMockMcpServer(): McpServer {
	return new McpServer(
		{ name: 'test-http-transport', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);
}

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
		let responseEnded = false;
		const req = request(
			{
				hostname: '127.0.0.1',
				port: options.port,
				path: options.path ?? '/messages',
				method: options.method ?? 'POST',
				headers: options.headers,
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

describe('HttpTransport', () => {
	let transport: HttpTransport;
	let port: number;

	beforeEach(async () => {
		port = 0;
		const metrics = new Metrics();
		metrics.counter('test_metric_total', 42, { workflow: 'plan\\review"\nnext' }, 'Test metric');
		transport = new HttpTransport({
			port,
			host: '127.0.0.1',
			corsOrigin: 'https://allowed.example.com',
			maxRequestsPerMinute: 1,
			metricsProvider: () => metrics.export(),
		});

		await transport.connect(createMockMcpServer());
		port = getListeningPort(transport);
	});

	afterEach(async () => {
		await transport.stop();
	});

	it('returns 403 for invalid CORS origin', async () => {
		const response = await httpRequest({
			port,
			headers: {
				origin: 'https://blocked.example.com',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});

		expect(response.statusCode).toBe(403);
		expect(response.body).toContain('Forbidden - invalid origin');
	});

	it('returns 429 when rate limit exceeded', async () => {
		const firstResponse = await httpRequest({
			port,
			headers: {
				origin: 'https://allowed.example.com',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});

		expect(firstResponse.statusCode).toBe(200);

		const secondResponse = await httpRequest({
			port,
			headers: {
				origin: 'https://allowed.example.com',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
		});

		expect(secondResponse.statusCode).toBe(429);
		expect(secondResponse.body).toContain('Too many requests');
	});

	it('handles OPTIONS preflight with CORS headers', async () => {
		const response = await httpRequest({
			port,
			method: 'OPTIONS',
			path: '/messages',
			headers: {
				origin: 'https://allowed.example.com',
			},
		});

		expect(response.statusCode).toBe(204);
		expect(response.headers['access-control-allow-origin']).toBe('https://allowed.example.com');
		expect(response.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
	});

	it('returns metrics from /metrics endpoint', async () => {
		const response = await httpRequest({
			port,
			method: 'GET',
			path: '/metrics',
			headers: { origin: 'https://allowed.example.com' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toBe(EXPECTED_METRICS);
		expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
	});

	it('returns the existing 404 response when no metrics provider is configured', async () => {
		await transport.stop();
		transport = new HttpTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
		});
		await transport.connect(createMockMcpServer());
		port = getListeningPort(transport);

		const response = await httpRequest({ port, method: 'GET', path: '/metrics' });

		expect(response.statusCode).toBe(404);
		expect(response.body).toBe('Not Found');
		expect(response.headers['content-type']).toBe('text/plain');
	});

	it('returns 403 for invalid host header', async () => {
		const response = await httpRequest({
			port,
			headers: {
				host: 'evil.example.com',
				origin: 'https://allowed.example.com',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});

		expect(response.statusCode).toBe(403);
		expect(response.body).toContain('invalid host header');
	});
});
