/**
 * Base transport implementation.
 *
 * This class provides shared functionality for all transport implementations,
 * including session validation, rate limiting, CORS handling, and IP extraction.
 *
 * @remarks
 * **Security Features:**
 * - Session ID validation (alphanumeric, max 64 chars)
 * - Rate limiting per IP (configurable, default 100 req/min)
 * - CORS origin validation
 *
 * **Rate Limiting:**
 * - Tracks requests per IP address within a time window
 * - Returns 429 Too Many Requests when limit exceeded
 * - Can be disabled via `enableRateLimit: false`
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HealthChecker } from '../health/HealthChecker.js';
import type { Logger, LogLevel } from '../logger/StructuredLogger.js';
import { SESSION_ID_PATTERN, MAX_SESSION_ID_LENGTH } from '../core/ids.js';
import type { McpServer } from 'tmcp';

/**
 * No-op logger that does nothing. Used when no logger is provided.
 */
class NoopLogger implements Logger {
	private _level: LogLevel = 'info';

	info(_message: string, _meta?: Record<string, unknown>): void {}
	warn(_message: string, _meta?: Record<string, unknown>): void {}
	error(_message: string, _meta?: Record<string, unknown>): void {}
	debug(_message: string, _meta?: Record<string, unknown>): void {}
	setLevel(level: LogLevel): void {
		this._level = level;
	}
	getLevel(): LogLevel {
		return this._level;
	}
}

/**
 * Rate limit settings (requests per minute per IP).
 */
const RATE_LIMIT_REQUESTS = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

export interface TransportOptions {
	readonly port?: number;
	readonly host?: string;
	readonly allowedHosts?: string[];
	readonly corsOrigin?: string;
	readonly enableCors?: boolean;
	readonly enableRateLimit?: boolean;
	readonly maxRequestsPerMinute?: number;
	readonly logger?: Logger;
	readonly healthChecker?: HealthChecker;
}

export abstract class BaseTransport {
	protected _port: number;
	protected _host: string;
	protected _corsOrigin: string;
	protected _enableCors: boolean;
	protected _rateLimitEnabled: boolean;
	protected _maxRequestsPerMinute: number;
	protected _allowedHosts: Set<string>;
	protected _rateLimitMap: Map<string, { count: number; resetTime: number }> = new Map();
	protected _rateLimitCleanupIntervalId: NodeJS.Timeout | null = null;
	protected _wasHostExplicitlySet: boolean;
	/** Shutdown state for graceful shutdown. */
	protected _isShuttingDown: boolean = false;
	private _logger: Logger | NoopLogger;
	protected _healthChecker: HealthChecker | null;

	constructor(options: TransportOptions = {}) {
		this._port = options.port ?? 9108;
		this._host = options.host ?? '127.0.0.1';
		this._wasHostExplicitlySet = options.host !== undefined;
		this._corsOrigin = options.corsOrigin ?? '*';
		this._enableCors = options.enableCors ?? true;
		this._rateLimitEnabled = options.enableRateLimit ?? true;
		this._maxRequestsPerMinute = options.maxRequestsPerMinute ?? RATE_LIMIT_REQUESTS;
		this._allowedHosts = this._buildAllowedHosts(options.allowedHosts);
		this._isShuttingDown = false;
		this._logger = options.logger ?? new NoopLogger();
		this._healthChecker = options.healthChecker ?? null;

		if (this._rateLimitEnabled) {
			this._startRateLimitCleanup();
		}
	}

	/**
	 * Get the server URL with localhost substitution for default host.
	 */
	get serverUrl(): string {
		const host =
			!this._wasHostExplicitlySet && this._host === '127.0.0.1' ? 'localhost' : this._host;
		return `http://${host}:${this._port}`;
	}

	/**
	 * Validate session ID format.
	 *
	 * @param sessionId - The session ID to validate
	 * @returns true if valid, false otherwise
	 */
	protected validateSessionId(sessionId: string): boolean {
		if (sessionId.length > MAX_SESSION_ID_LENGTH) {
			return false;
		}
		return SESSION_ID_PATTERN.test(sessionId);
	}

	/**
	 * Check rate limit for a given IP address.
	 *
	 * @param ip - The IP address to check
	 * @returns true if rate limit exceeded, false otherwise
	 */
	protected checkRateLimit(ip: string): boolean {
		if (!this._rateLimitEnabled) {
			return false;
		}

		const now = Date.now();
		this._cleanupExpiredRateLimitEntries(now);
		const record = this._rateLimitMap.get(ip);

		if (!record || now > record.resetTime) {
			this._rateLimitMap.set(ip, {
				count: 1,
				resetTime: now + RATE_LIMIT_WINDOW_MS,
			});
			return false;
		}

		if (record.count >= this._maxRequestsPerMinute) {
			return true; // Rate limit exceeded
		}

		record.count++;
		return false;
	}

	protected _cleanupExpiredRateLimitEntries(now = Date.now()): void {
		for (const [ip, record] of this._rateLimitMap.entries()) {
			if (record.resetTime <= now) {
				this._rateLimitMap.delete(ip);
			}
		}
	}

	protected _startRateLimitCleanup(): void {
		if (this._rateLimitCleanupIntervalId !== null) {
			clearInterval(this._rateLimitCleanupIntervalId);
		}

		this._rateLimitCleanupIntervalId = setInterval(() => {
			this._cleanupExpiredRateLimitEntries();
		}, RATE_LIMIT_WINDOW_MS);
	}

	protected _stopRateLimitCleanup(): void {
		if (this._rateLimitCleanupIntervalId !== null) {
			clearInterval(this._rateLimitCleanupIntervalId);
			this._rateLimitCleanupIntervalId = null;
		}
	}

	/**
	 * Get client IP address from request.
	 *
	 * @param req - The incoming request
	 * @returns The client IP address
	 */
	protected getClientIp(req: IncomingMessage): string {
		const forwardedFor = req.headers['x-forwarded-for'];
		if (forwardedFor && typeof forwardedFor === 'string') {
			return forwardedFor.split(',')[0]!.trim();
		}
		const remoteAddress = req.socket.remoteAddress;
		return remoteAddress || 'unknown';
	}

	/**
	 * Validate CORS origin from request headers.
	 *
	 * @param req - The incoming request
	 * @returns true if origin is valid, false otherwise
	 */
	protected validateCorsOrigin(req: IncomingMessage): boolean {
		if (this._corsOrigin === '*') {
			return true;
		}

		const origin = req.headers.origin;
		if (!origin) {
			return true; // No origin header is acceptable
		}

		// Exact match
		if (this._corsOrigin === origin) {
			return true;
		}

		// Check if configured origin is a wildcard pattern
		if (this._corsOrigin.includes('*')) {
			// Escape all regex metacharacters EXCEPT *,
			// then replace * with a hostname-safe pattern (alphanumeric, hyphens, dots)
			const escaped = this._corsOrigin
				.replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape metacharacters (not *)
				.replace(/\*/g, '[a-zA-Z0-9.-]*');    // * matches valid hostname chars only
			const regex = new RegExp(`^${escaped}$`);
			return regex.test(origin);
		}

		return false;
	}

	/**
	 * Set CORS headers on response.
	 *
	 * @param res - The server response
	 */
	protected setCorsHeaders(res: ServerResponse): void {
		if (this._enableCors) {
			res.setHeader('Access-Control-Allow-Origin', this._corsOrigin);
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		}
	}

	protected validateHostHeader(req: IncomingMessage): boolean {
		const rawHost = req.headers.host;
		if (!rawHost) {
			return true;
		}

		const hostWithoutPort = rawHost.split(':')[0]!.trim().toLowerCase();
		if (!hostWithoutPort) {
			return false;
		}

		if (this._allowedHosts.size === 0) {
			return true;
		}

		return this._allowedHosts.has(hostWithoutPort);
	}

	private _buildAllowedHosts(configuredHosts?: string[]): Set<string> {
		if (configuredHosts && configuredHosts.length > 0) {
			return new Set(configuredHosts.map((host) => host.toLowerCase().trim()).filter(Boolean));
		}

		const boundHost = this._host.toLowerCase();
		const localHosts = ['localhost', '127.0.0.1', '::1'];

		if (localHosts.includes(boundHost)) {
			return new Set(localHosts);
		}

		if (boundHost === '0.0.0.0' || boundHost === '::') {
			return new Set(localHosts);
		}

		return new Set([boundHost]);
	}

	/**
	 * Log a message using the configured logger.
	 *
	 * @param level - Log level
	 * @param message - Message to log
	 * @param meta - Optional metadata
	 */
	protected log(
		level: 'info' | 'warn' | 'error',
		message: string,
		meta?: Record<string, unknown>
	): void {
		if (level === 'info') {
			this._logger.info(message, meta);
		} else if (level === 'warn') {
			this._logger.warn(message, meta);
		} else {
			this._logger.error(message, meta);
		}
	}

	/**
	 * Check if transport is shutting down.
	 * @returns true if in shutdown phase
	 */
	public get isShuttingDown(): boolean {
		return this._isShuttingDown;
	}

	/**
	 * Handle GET /health endpoint — liveness check.
	 *
	 * Builds a standard health response with optional liveness data from the health checker.
	 * Transports can pass extra data (e.g. client counts, session info).
	 *
	 * @param res - The server response
	 * @param extraData - Optional additional health metadata
	 */
	protected handleHealthEndpoint(res: ServerResponse, extraData?: Record<string, unknown>): void {
		const healthData: Record<string, unknown> = { status: 'healthy', ...extraData };
		if (this._healthChecker) {
			const liveness = this._healthChecker.checkLiveness();
			healthData.liveness = liveness;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(healthData));
	}

	/**
	 * Handle GET /ready endpoint — readiness check.
	 *
	 * Delegates to the health checker if available, otherwise returns a default OK response.
	 *
	 * @param res - The server response
	 */
	protected async handleReadinessEndpoint(res: ServerResponse): Promise<void> {
		if (this._healthChecker) {
			const readiness = await this._healthChecker.checkReadiness();
			const statusCode = readiness.status === 'ok' ? 200 : 503;
			res.writeHead(statusCode, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(readiness));
		} else {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), components: {} })
			);
		}
	}

	/**
	 * Handle GET /metrics endpoint — Prometheus metrics.
	 *
	 * Returns 404 if no metrics provider is configured.
	 *
	 * @param res - The server response
	 * @param metricsProvider - Function that returns Prometheus-format metrics text
	 */
	protected handleMetricsEndpoint(res: ServerResponse, metricsProvider: (() => string) | null): void {
		if (!metricsProvider) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not Found');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
		res.end(metricsProvider());
	}

	/**
	 * Connect to MCP server.
	 */
	abstract connect(mcpServer: McpServer): Promise<void>;

	/**
	 * Stop transport server with graceful shutdown.
	 *
	 * This method should:
	 * 1. Set shutdown flag to prevent new connections
	 * 2. Wait for in-flight requests to complete (configurable timeout)
	 * 3. Close server connections
	 * 4. Release resources
	 *
	 * @param timeout - Maximum time to wait for requests to drain (default: 30 seconds)
	 * @returns Promise that resolves when shutdown is complete
	 */
	abstract stop(timeout?: number): Promise<void>;

	/**
	 * Get number of clients connected.
	 */
	abstract get clientCount(): number;

}
