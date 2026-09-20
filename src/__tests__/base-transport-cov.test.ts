import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BaseTransport, type TransportOptions } from '../transport/BaseTransport.js';
import { useFakeTimers, useRealTimers, advanceTime } from './helpers/timers.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';

import { HealthChecker } from '../health/HealthChecker.js';

interface MockServerResponse {
	statusCode: number;
	writeHead: Mock<(code: number, headers?: Record<string, string>) => void>;
	end: Mock<(data?: string) => void>;
	write?: Mock<() => void>;
	setHeader?: Mock<(name: string, value: string | number | string[]) => void>;
	once?: Mock<(event: string | symbol, listener: (...args: unknown[]) => void) => unknown>;
}

class TestableTransport extends BaseTransport {
	private _clientCount = 0;

	constructor(options?: TransportOptions) {
		super(options);
	}

	override validateSessionId(sessionId: string): boolean {
		return super.validateSessionId(sessionId);
	}
	override validateCorsOrigin(req: IncomingMessage): boolean {
		return super.validateCorsOrigin(req);
	}
	override checkRateLimit(ip: string): boolean {
		return super.checkRateLimit(ip);
	}
	override validateHostHeader(req: IncomingMessage): boolean {
		return super.validateHostHeader(req);
	}
	override getClientIp(req: IncomingMessage): string {
		return super.getClientIp(req);
	}
	override setCorsHeaders(res: ServerResponse): void {
		super.setCorsHeaders(res);
	}
	override get isShuttingDown(): boolean {
		return super.isShuttingDown;
	}

	get exposedServerUrl(): string {
		return super.serverUrl;
	}

	async connect(): Promise<void> {}
	async stop(): Promise<void> {
		this._stopRateLimitCleanup();
	}
	get clientCount(): number {
		return this._clientCount;
	}
}

function createMockRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return Object.assign(new EventEmitter(), {
		headers: {},
		method: 'GET',
		url: '/',
		...overrides,
	}) as unknown as IncomingMessage;
}

function createMockResponse(): MockServerResponse & ServerResponse {
	const headers: Record<string, string> = {};
	let statusCode = 200;
	const mock: MockServerResponse = {
		get statusCode() { return statusCode; },
		set statusCode(v: number) { statusCode = v; },
		writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
			statusCode = code;
			if (hdrs) Object.assign(headers, hdrs);
		}),
		end: vi.fn(),
		write: vi.fn(),
		setHeader: vi.fn(),
		once: vi.fn(),
	};
	return mock as MockServerResponse & ServerResponse;
}

function createMockPersistence(healthy: boolean): PersistenceBackend {
	return {
		healthy: async () => healthy,
		saveThoughtForSession: vi.fn(),
		loadHistoryForSession: vi.fn().mockResolvedValue([]),
		saveBranchForSession: vi.fn(),
		deleteBranchForSession: vi.fn(),
		loadBranchForSession: vi.fn().mockResolvedValue(undefined),
		listBranchesForSession: vi.fn().mockResolvedValue([]),
		listSessions: vi.fn().mockResolvedValue([]),
		clearSession: vi.fn(),
		clearAll: vi.fn(),
		close: vi.fn(),
		saveEdges: vi.fn().mockResolvedValue(undefined),
		loadEdges: vi.fn().mockResolvedValue([]),
		saveSummaries: vi.fn().mockResolvedValue(undefined),
		loadSummaries: vi.fn().mockResolvedValue([]),
	};
}

describe('BaseTransport additional coverage', () => {
	let transport: TestableTransport;

	afterEach(() => {
		useRealTimers();
	});

	describe('serverUrl property', () => {
		it('should return localhost URL by default', () => {
			transport = new TestableTransport({ port: 3000 });
			expect(transport.exposedServerUrl).toBe('http://localhost:3000');
		});

		it('should return custom host when explicitly set', () => {
			transport = new TestableTransport({ host: '0.0.0.0', port: 3000 });
			expect(transport.exposedServerUrl).toBe('http://0.0.0.0:3000');
		});

		it('should use host as-is for explicit 127.0.0.1', () => {
			transport = new TestableTransport({ host: '127.0.0.1', port: 3000 });
			expect(transport.exposedServerUrl).toBe('http://127.0.0.1:3000');
		});
	});

	describe('log method', () => {
		it('should log info messages', () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			transport = new TestableTransport({ logger });
			transport['log']('info', 'test message', { key: 'value' });
			expect(logger.info).toHaveBeenCalledWith('test message', { key: 'value' });
		});

		it('should log warn messages', () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			transport = new TestableTransport({ logger });
			transport['log']('warn', 'warning message');
			expect(logger.warn).toHaveBeenCalledWith('warning message', undefined);
		});

		it('should log error messages', () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			transport = new TestableTransport({ logger });
			transport['log']('error', 'error message');
			expect(logger.error).toHaveBeenCalledWith('error message', undefined);
		});
	});

	describe('isShuttingDown', () => {
		it('should return false initially', () => {
			transport = new TestableTransport();
			expect(transport.isShuttingDown).toBe(false);
		});
	});

	describe('handleHealthEndpoint', () => {
		it('should return healthy status', () => {
			transport = new TestableTransport();
			const res = createMockResponse();
			transport['handleHealthEndpoint'](res, { requests: 42 });
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.end.mock.calls[0]![0] as string);
			expect(body.status).toBe('healthy');
			expect(body.requests).toBe(42);
		});

		it('should include liveness data from healthChecker', () => {
			const healthChecker = new HealthChecker();
			transport = new TestableTransport({ healthChecker });
			const res = createMockResponse();
			transport['handleHealthEndpoint'](res);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.end.mock.calls[0]![0] as string);
			expect(body.liveness).toBeDefined();
		});
	});

	describe('handleReadinessEndpoint', () => {
		it('should return ok when no healthChecker', async () => {
			transport = new TestableTransport();
			const res = createMockResponse();
			await transport['handleReadinessEndpoint'](res);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.end.mock.calls[0]![0] as string);
			expect(body.status).toBe('ok');
			expect(body.components).toEqual({});
		});

		it('should return readiness from healthChecker', async () => {
			const persistence = createMockPersistence(true);
			const healthChecker = new HealthChecker({ persistence });
			transport = new TestableTransport({ healthChecker });
			const res = createMockResponse();
			await transport['handleReadinessEndpoint'](res);
			expect(res.statusCode).toBe(200);
		});

		it('should return 503 when not ready', async () => {
			const persistence = createMockPersistence(false);
			const healthChecker = new HealthChecker({ persistence });
			transport = new TestableTransport({ healthChecker });
			const res = createMockResponse();
			await transport['handleReadinessEndpoint'](res);
			expect(res.statusCode).toBe(503);
		});
	});

	describe('handleMetricsEndpoint', () => {
		it('should return 404 when no provider', () => {
			transport = new TestableTransport();
			const res = createMockResponse();
			transport['handleMetricsEndpoint'](res, null);
			expect(res.statusCode).toBe(404);
		});

		it('should return metrics when provider configured', () => {
			transport = new TestableTransport();
			const res = createMockResponse();
			transport['handleMetricsEndpoint'](res, () => '# HELP test\n# TYPE test counter\ntest 1\n');
			expect(res.statusCode).toBe(200);
			expect(res.end.mock.calls[0]![0]).toContain('test 1');
		});
	});

	describe('_buildAllowedHosts internal', () => {
		it('should use configured hosts', () => {
			transport = new TestableTransport({ allowedHosts: ['myapp.com', 'other.com'] });
			const req = createMockRequest({ headers: { host: 'myapp.com' } });
			expect(transport.validateHostHeader(req)).toBe(true);
		});

		it('should allow loopback addresses when bound to 0.0.0.0', () => {
			transport = new TestableTransport({ host: '0.0.0.0' });
			const req = createMockRequest({ headers: { host: '127.0.0.1' } });
			expect(transport.validateHostHeader(req)).toBe(true);
		});

		it('should allow localhost when bound to 0.0.0.0', () => {
			transport = new TestableTransport({ host: '0.0.0.0' });
			const req = createMockRequest({ headers: { host: 'localhost' } });
			expect(transport.validateHostHeader(req)).toBe(true);
		});

		it('should allow only bound host for external binding', () => {
			transport = new TestableTransport({ host: '192.168.1.1' });
			const req = createMockRequest({ headers: { host: '192.168.1.1' } });
			expect(transport.validateHostHeader(req)).toBe(true);
			const req2 = createMockRequest({ headers: { host: 'localhost' } });
			expect(transport.validateHostHeader(req2)).toBe(false);
		});

		it('should reject empty host after port strip', () => {
			transport = new TestableTransport({ allowedHosts: ['myapp.com'] });
			const req = createMockRequest({ headers: { host: ':8080' } });
			expect(transport.validateHostHeader(req)).toBe(false);
		});
	});

	describe('rate limit cleanup', () => {
		it('should clean up expired entries', () => {
			useFakeTimers();

			transport = new TestableTransport({ maxRequestsPerMinute: 1, enableRateLimit: true });
			expect(transport.checkRateLimit('1.1.1.1')).toBe(false);
			expect(transport.checkRateLimit('1.1.1.1')).toBe(true);

			advanceTime(61_000);

			expect(transport.checkRateLimit('1.1.1.1')).toBe(false);
		});
	});
});

describe('BaseTransport coverage: NoopLogger setLevel/getLevel', () => {
	it('should use NoopLogger when no logger provided and exercise setLevel/getLevel', () => {
		const transport = new TestableTransport();
		// Access the private _logger to exercise NoopLogger methods
		const noopLogger = (transport as unknown as { _logger: { setLevel: (level: string) => void; getLevel: () => string } })._logger;
		noopLogger.setLevel('debug');
		expect(noopLogger.getLevel()).toBe('debug');
		noopLogger.setLevel('warn');
		expect(noopLogger.getLevel()).toBe('warn');
	});
});

describe('BaseTransport coverage: _startRateLimitCleanup clears existing interval', () => {
	it('should clear existing interval before starting new one', () => {
		const transport = new TestableTransport({ enableRateLimit: true });
		// _rateLimitCleanupIntervalId is already set from constructor
		// Call _startRateLimitCleanup again to exercise the clearInterval branch
		const startCleanup = (transport as unknown as { _startRateLimitCleanup: () => void })._startRateLimitCleanup;
		startCleanup.call(transport);
		// Verify it didn't throw and interval is still set
		const intervalId = (transport as unknown as { _rateLimitCleanupIntervalId: NodeJS.Timeout | null })._rateLimitCleanupIntervalId;
		expect(intervalId).not.toBeNull();
		transport.stop();
	});
});

describe('BaseTransport coverage: validateHostHeader with empty allowedHosts', () => {
	it('should return true when allowedHosts set is empty', () => {
		const transport = new TestableTransport({ allowedHosts: [] });
		// Empty allowedHosts array => _buildAllowedHosts falls through to default logic
		// But with host='127.0.0.1' (default) it adds localhost entries
		// To get allowedHosts.size === 0, we need configuredHosts with only empty strings
		const transport2 = new TestableTransport({ allowedHosts: [''] });
		// filter(Boolean) removes empty strings so the set will be empty
		const req = createMockRequest({ headers: { host: 'any-host.com' } });
		// With size === 0, validateHostHeader returns true at line 303
		expect(transport2.validateHostHeader(req)).toBe(true);
		transport.stop();
		transport2.stop();
	});
});
