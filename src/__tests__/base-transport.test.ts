import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { BaseTransport, type TransportOptions } from '../transport/BaseTransport.js';
import { useFakeTimers, useRealTimers, advanceTime } from './helpers/timers.js';

/**
 * Concrete subclass exposing protected methods for testing.
 */
class TestableTransport extends BaseTransport {
	private _clientCount = 0;

	constructor(options?: TransportOptions) {
		super(options);
	}

	// Expose protected methods
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

describe('BaseTransport', () => {
	let transport: TestableTransport;

	afterEach(() => {
		useRealTimers();
	});

	describe('validateSessionId', () => {
		beforeEach(() => {
			transport = new TestableTransport();
		});

		it('should accept valid alphanumeric session IDs', () => {
			expect(transport.validateSessionId('abc123')).toBe(true);
			expect(transport.validateSessionId('session-1')).toBe(true);
			expect(transport.validateSessionId('my_session')).toBe(true);
		});

		it('should reject session IDs exceeding max length (100)', () => {
			const longId = 'a'.repeat(101);
			expect(transport.validateSessionId(longId)).toBe(false);
		});

		it('should accept session IDs at exactly max length (100)', () => {
			const maxId = 'a'.repeat(100);
			expect(transport.validateSessionId(maxId)).toBe(true);
		});

		it('should reject session IDs with special characters', () => {
			expect(transport.validateSessionId('session.id')).toBe(false);
			expect(transport.validateSessionId('session id')).toBe(false);
			expect(transport.validateSessionId('session/id')).toBe(false);
			expect(transport.validateSessionId('session@id')).toBe(false);
		});

		it('should reject empty session IDs', () => {
			expect(transport.validateSessionId('')).toBe(false);
		});
	});

	describe('validateCorsOrigin', () => {
		it('should accept any origin when corsOrigin is wildcard', () => {
			transport = new TestableTransport({ corsOrigin: '*' });
			const req = createMockRequest({ headers: { origin: 'https://evil.com' } });
			expect(transport.validateCorsOrigin(req)).toBe(true);
		});

		it('should return true when no origin header is present', () => {
			transport = new TestableTransport({ corsOrigin: 'https://example.com' });
			const req = createMockRequest({ headers: {} });
			expect(transport.validateCorsOrigin(req)).toBe(true);
		});

		it('should accept exact origin match', () => {
			transport = new TestableTransport({ corsOrigin: 'https://example.com' });
			const req = createMockRequest({ headers: { origin: 'https://example.com' } });
			expect(transport.validateCorsOrigin(req)).toBe(true);
		});

		it('should reject non-matching origin', () => {
			transport = new TestableTransport({ corsOrigin: 'https://example.com' });
			const req = createMockRequest({ headers: { origin: 'https://evil.com' } });
			expect(transport.validateCorsOrigin(req)).toBe(false);
		});

		it('should match wildcard subdomain pattern correctly', () => {
			transport = new TestableTransport({ corsOrigin: 'https://*.example.com' });

			const goodReq = createMockRequest({ headers: { origin: 'https://sub.example.com' } });
			expect(transport.validateCorsOrigin(goodReq)).toBe(true);

			const badReq = createMockRequest({
				headers: { origin: 'https://evil.example.com.attacker.com' },
			});
			expect(transport.validateCorsOrigin(badReq)).toBe(false);
		});

		it('should be case-sensitive for origin matching', () => {
			transport = new TestableTransport({ corsOrigin: 'https://Example.com' });
			const req = createMockRequest({ headers: { origin: 'https://example.com' } });
			expect(transport.validateCorsOrigin(req)).toBe(false);
		});

		it('should handle wildcard at start of origin', () => {
			transport = new TestableTransport({ corsOrigin: '*.example.com' });

			const goodReq = createMockRequest({ headers: { origin: 'sub.example.com' } });
			expect(transport.validateCorsOrigin(goodReq)).toBe(true);

			const badReq = createMockRequest({ headers: { origin: 'evil.com' } });
			expect(transport.validateCorsOrigin(badReq)).toBe(false);
		});
	});

	describe('checkRateLimit', () => {
		it('should allow requests under the limit', () => {
			transport = new TestableTransport({ maxRequestsPerMinute: 5, enableRateLimit: true });

			for (let i = 0; i < 5; i++) {
				expect(transport.checkRateLimit('1.2.3.4')).toBe(false);
			}
			expect(transport.checkRateLimit('1.2.3.4')).toBe(true);
		});

		it('should isolate rate limits between different IPs', () => {
			transport = new TestableTransport({ maxRequestsPerMinute: 1, enableRateLimit: true });

			expect(transport.checkRateLimit('1.1.1.1')).toBe(false);
			expect(transport.checkRateLimit('1.1.1.1')).toBe(true);

			expect(transport.checkRateLimit('2.2.2.2')).toBe(false);
		});

		it('should reset rate limit after window expires', () => {
			useFakeTimers();

			transport = new TestableTransport({ maxRequestsPerMinute: 1, enableRateLimit: true });

			expect(transport.checkRateLimit('1.1.1.1')).toBe(false);
			expect(transport.checkRateLimit('1.1.1.1')).toBe(true);

			advanceTime(61_000);

			expect(transport.checkRateLimit('1.1.1.1')).toBe(false);
		});

		it('should not rate limit when disabled', () => {
			transport = new TestableTransport({ enableRateLimit: false });

			for (let i = 0; i < 200; i++) {
				expect(transport.checkRateLimit('1.1.1.1')).toBe(false);
			}
		});
	});

	describe('validateHostHeader', () => {
		it('should return true when no host header is present', () => {
			transport = new TestableTransport();
			const req = createMockRequest({ headers: {} });
			expect(transport.validateHostHeader(req)).toBe(true);
		});

		it('should allow localhost by default', () => {
			transport = new TestableTransport({ host: '127.0.0.1' });
			const req = createMockRequest({ headers: { host: 'localhost' } });
			expect(transport.validateHostHeader(req)).toBe(true);
		});

		it('should reject non-allowed hosts', () => {
			transport = new TestableTransport({ allowedHosts: ['myapp.com'] });
			const req = createMockRequest({ headers: { host: 'evil.com' } });
			expect(transport.validateHostHeader(req)).toBe(false);
		});

		it('should allow explicitly configured hosts', () => {
			transport = new TestableTransport({ allowedHosts: ['myapp.com'] });
			const req = createMockRequest({ headers: { host: 'myapp.com' } });
			expect(transport.validateHostHeader(req)).toBe(true);
		});

		it('should strip port from host header before validation', () => {
			transport = new TestableTransport({ allowedHosts: ['myapp.com'] });
			const req = createMockRequest({ headers: { host: 'myapp.com:8080' } });
			expect(transport.validateHostHeader(req)).toBe(true);
		});
	});

	describe('getClientIp', () => {
		beforeEach(() => {
			transport = new TestableTransport();
		});

		it('should extract IP from X-Forwarded-For header', () => {
			const req = createMockRequest({
				headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
			});
			expect(transport.getClientIp(req)).toBe('1.2.3.4');
		});

		it('should fall back to remoteAddress', () => {
			const socket = { remoteAddress: '10.0.0.1' };
			const req = createMockRequest({ headers: {}, socket: socket as unknown as IncomingMessage['socket'] });
			expect(transport.getClientIp(req)).toBe('10.0.0.1');
		});

		it('should return "unknown" when no IP is available', () => {
			const socket = { remoteAddress: undefined };
			const req = createMockRequest({ headers: {}, socket: socket as unknown as IncomingMessage['socket'] });
			expect(transport.getClientIp(req)).toBe('unknown');
		});
	});
});
