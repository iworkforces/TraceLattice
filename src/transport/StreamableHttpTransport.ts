/**
 * Streamable HTTP Transport implementation (MCP spec recommended transport).
 *
 * Key features:
 * - POST /mcp for JSON-RPC requests (main MCP endpoint)
 * - Session management via Mcp-Session-Id header
 * - Supports both stateful (session-based) and stateless (per-request) modes
 * - Health endpoints (/health, /ready)
 *
 * @example
 * ```typescript
 * const transport = new StreamableHttpTransport({
 *   port: 3000,
 *   host: 'localhost',
 *   stateful: true,
 * });
 * await transport.connect(server);
 * ```
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from 'tmcp';
import { safeParse } from 'valibot';
import type { IMetrics } from '../contracts/interfaces.js';
import { getErrorMessage } from '../errors.js';
import { JsonRpcRequestSchema } from '../schema.js';
import { BaseTransport, type TransportOptions } from './BaseTransport.js';
import type { ITransport, TransportKind } from '../contracts/transport.js';
import { asSessionId, type SessionId } from '../contracts/ids.js';
import { readRequestBody } from './HttpHelpers.js';
import { runWithContext } from '../context/RequestContext.js';
import {
	AcceptedWorkTracker,
	LifecycleFailureReporter,
	PreDispatchTracker,
	ResponseFinalizer,
	type PreDispatchLease,
} from './HttpRequestLifecycle.js';

/**
 * MCP Streamable HTTP transport options extending base TransportOptions.
 */
export interface StreamableHttpTransportOptions extends TransportOptions {
	/**
	 * Path for the MCP endpoint
	 * @default '/mcp'
	 */
	path?: string;

	/**
	 * Metrics collector for transport telemetry
	 */
	metrics?: IMetrics;

	/**
	 * Prometheus metrics provider function
	 */
	metricsProvider?: () => string;

	/**
	 * Enable stateful session-based mode.
	 * When true, sessions are tracked via Mcp-Session-Id header.
	 * When false, each request is processed independently (stateless).
	 * @default true
	 */
	stateful?: boolean;

	/**
	 * Custom session ID generator function.
	 * @default () => randomUUID()
	 */
	sessionIdGenerator?: () => string;

	/**
	 * Enable request body size limit
	 * @default true
	 */
	enableBodySizeLimit?: boolean;

	/**
	 * Maximum request body size in bytes
	 * @default 10485760 (10MB)
	 */
	maxBodySize?: number;

	/**
	 * Request timeout in milliseconds
	 * @default 30000 (30 seconds)
	 */
	requestTimeout?: number;

	/** Maximum retained sessions when idle expiry is enabled. */
	maxSessions?: number;

	/** Idle duration before an unpinned session expires. */
	sessionIdleTimeoutMs?: number;

	/** Interval between idle-session sweeps. */
	sessionSweepIntervalMs?: number;
}

type SessionRetentionOptions = {
	readonly maxSessions: number;
	readonly sessionIdleTimeoutMs: number;
	readonly sessionSweepIntervalMs: number;
};

function parseSessionRetentionOptions(
	options: StreamableHttpTransportOptions
): SessionRetentionOptions | null {
	const { maxSessions, sessionIdleTimeoutMs, sessionSweepIntervalMs } = options;
	if (
		maxSessions === undefined &&
		sessionIdleTimeoutMs === undefined &&
		sessionSweepIntervalMs === undefined
	) {
		return null;
	}
	if (
		maxSessions === undefined ||
		!Number.isFinite(maxSessions) ||
		!Number.isInteger(maxSessions) ||
		maxSessions <= 0 ||
		sessionIdleTimeoutMs === undefined ||
		!Number.isFinite(sessionIdleTimeoutMs) ||
		!Number.isInteger(sessionIdleTimeoutMs) ||
		sessionIdleTimeoutMs <= 0 ||
		sessionSweepIntervalMs === undefined ||
		!Number.isFinite(sessionSweepIntervalMs) ||
		!Number.isInteger(sessionSweepIntervalMs) ||
		sessionSweepIntervalMs <= 0
	) {
		throw new TypeError(
			'maxSessions, sessionIdleTimeoutMs, and sessionSweepIntervalMs must be provided together as positive integers'
		);
	}
	return {
		maxSessions,
		sessionIdleTimeoutMs,
		sessionSweepIntervalMs,
	};
}

/**
 * Internal session state for stateful mode.
 */
interface SessionState {
	/** Unique session identifier */
	id: SessionId;
	/** Timestamp when the session was created */
	createdAt: number;
	/** Timestamp of the last activity */
	lastActivityAt: number;
	acceptedPostCount: number;
}

type SessionError = {
	readonly statusCode: number;
	readonly code: number;
	readonly message: string;
};

type AcceptedPostSession = {
	readonly id: string | undefined;
	readonly state: SessionState | null;
};

/**
 * Streamable HTTP Transport for MCP server.
 *
 * This transport implements the MCP Streamable HTTP specification,
 * providing JSON-RPC over HTTP with optional session management.
 *
 * @remarks
 * **Security Features (inherited from BaseTransport):**
 * - Session ID validation (alphanumeric, max 64 chars)
 * - Query parameter sanitization (whitelist allowed keys)
 * - Rate limiting per IP (configurable, default 100 req/min)
 * - CORS origin validation
 * - Host header validation
 *
 * **MCP Streamable HTTP Spec Compliance:**
 * - POST /mcp — JSON-RPC method calls
 * - Mcp-Session-Id header for session management
 * - Content-Type: application/json for JSON-RPC responses
 *
 * **HTTP Status Code Mapping:**
 * - 200: Success (JSON-RPC response)
 * - 202: Accepted (JSON-RPC notification, no response body)
 * - 204: CORS Preflight (empty body)
 * - 400: Bad Request (invalid JSON, invalid session ID)
 * - 403: Forbidden (invalid CORS, invalid host)
 * - 404: Not Found
 * - 405: Method Not Allowed
 * - 413: Payload Too Large
 * - 429: Too Many Requests
 * - 500: Internal Server Error
 * - 503: Server Not Ready / Shutting Down
 */
export class StreamableHttpTransport extends BaseTransport implements ITransport {
	get kind(): TransportKind {
		return 'streamable-http';
	}
	private _server: Server | null = null;
	private _mcpServer: McpServer | null = null;
	private _path: string;
	private _stateful: boolean;
	private _sessionIdGenerator: () => string;
	private _sessions: Map<SessionId, SessionState> = new Map();
	private _requestCount: number = 0;
	private _activeRequests: number = 0;
	private _bodySizeLimitEnabled: boolean;
	private _maxBodySize: number;
	private _requestTimeout: number;
	private _metrics?: IMetrics;
	private _metricsProvider: (() => string) | null;
	private readonly _lifecycleFailureReporter: LifecycleFailureReporter;
	private readonly _acceptedWork: AcceptedWorkTracker;
	private readonly _preDispatch = new PreDispatchTracker();
	private readonly _sessionRetention: SessionRetentionOptions | null;
	private _sessionSweepIntervalId: NodeJS.Timeout | null = null;
	private _stopPromise: Promise<void> | null = null;

	constructor(options: StreamableHttpTransportOptions = {}) {
		const sessionRetention = parseSessionRetentionOptions(options);
		super(options);

		this._path = options.path ?? '/mcp';
		this._stateful = options.stateful ?? true;
		this._sessionIdGenerator = options.sessionIdGenerator ?? (() => randomUUID());
		this._bodySizeLimitEnabled = options.enableBodySizeLimit ?? true;
		this._maxBodySize = options.maxBodySize ?? 10 * 1024 * 1024;
		this._requestTimeout = options.requestTimeout ?? 30000;
		this._metrics = options.metrics;
		this._metricsProvider = options.metricsProvider ?? null;
		this._sessionRetention = sessionRetention;
		this._lifecycleFailureReporter = new LifecycleFailureReporter((error) => {
			this.log('error', 'Streamable HTTP request lifecycle failed', {
				error: getErrorMessage(error),
			});
		});
		this._acceptedWork = new AcceptedWorkTracker(this._lifecycleFailureReporter);
		if (this._stateful && sessionRetention) {
			this._sessionSweepIntervalId = setInterval(
				() => this._sweepExpiredSessions(),
				sessionRetention.sessionSweepIntervalMs
			);
			this._sessionSweepIntervalId.unref();
		}
	}

	private _requireMcpServer(): McpServer {
		if (!this._mcpServer) {
			throw new Error('MCP server not initialized. Did you call connect()?');
		}
		return this._mcpServer;
	}

	/**
	 * Get number of active sessions (stateful) or active requests (stateless).
	 */
	get clientCount(): number {
		return this._stateful ? this._sessions.size : this._activeRequests;
	}

	/**
	 * Get the total number of requests handled.
	 */
	get requestCount(): number {
		return this._requestCount;
	}

	/**
	 * Connects MCP server to this transport and starts listening.
	 */
	async connect(mcpServer: McpServer): Promise<void> {
		this._mcpServer = mcpServer;
		const server = createServer((req, res) => {
			const responseFinalizer = new ResponseFinalizer(res, this._lifecycleFailureReporter);
			void this._handleRequest(req, res).catch((error: unknown) => {
				this._lifecycleFailureReporter.report(error);
				responseFinalizer.finalize((response) => {
					this._sendJsonRpcError(response, 500, -32603, 'Internal error', null, {
						data: getErrorMessage(error),
					});
				});
			});
		});
		this._server = server;

		return new Promise((resolve, reject) => {
			const cleanup = (): void => {
				server.off('error', onError);
				server.off('listening', onListening);
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			const onListening = (): void => {
				cleanup();
				this.log(
					'info',
					`Streamable HTTP transport listening on http://${this._host}:${this._port}`
				);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			try {
				server.listen(this._port, this._host);
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	}

	private _recordRequestMetrics(res: ServerResponse): void {
		const startTime = Date.now();
		this._metrics?.counter(
			'streamable_http_requests_total',
			1,
			{},
			'Total Streamable HTTP transport requests'
		);
		res.once('finish', () => {
			const durationSeconds = (Date.now() - startTime) / 1000;
			this._metrics?.histogram('streamable_http_request_duration_seconds', durationSeconds, {});
		});
	}

	/**
	 * Validate the request origin and attach CORS headers.
	 *
	 * @returns false when the origin is rejected and the 403 has been sent
	 */
	private _admitCors(req: IncomingMessage, res: ServerResponse): boolean {
		if (!this.validateCorsOrigin(req)) {
			this._sendJsonRpcError(res, 403, -32000, 'Forbidden - invalid origin');
			return false;
		}
		this.setCorsHeaders(res);
		return true;
	}

	/**
	 * Serve GET /health and GET /ready. These run after Host validation and the shutdown check
	 * but ahead of the rate limiter; they keep CORS origin validation and headers.
	 *
	 * @returns true when the request was a probe and has been answered
	 */
	private async _handleProbeRoute(
		req: IncomingMessage,
		res: ServerResponse,
		urlPath: string
	): Promise<boolean> {
		if (req.method !== 'GET' || (urlPath !== '/health' && urlPath !== '/ready')) {
			return false;
		}
		if (!this._admitCors(req, res)) {
			return true;
		}
		if (urlPath === '/health') {
			this._handleHealthCheck(res);
		} else {
			await this._handleReadinessCheck(res);
		}
		return true;
	}

	/**
	 * Route and handle incoming HTTP requests.
	 */
	private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		this._recordRequestMetrics(res);

		// Host validation
		if (!this.validateHostHeader(req)) {
			this._sendJsonRpcError(res, 403, -32000, 'Forbidden - invalid host header');
			return;
		}

		// Shutdown check
		if (this.isShuttingDown) {
			this._sendJsonRpcError(res, 503, -32603, 'Server is shutting down');
			return;
		}

		// Parse URL path
		const urlPath = req.url?.split('?')[0] ?? '/';

		// Probes (/health, /ready) precede rate limiting so polling never spends the client budget
		if (await this._handleProbeRoute(req, res, urlPath)) {
			return;
		}

		// Rate limiting
		const clientIp = this.getClientIp(req);
		if (this.checkRateLimit(clientIp)) {
			res.setHeader('Retry-After', '60');
			this._sendJsonRpcError(res, 429, -32000, 'Too many requests');
			return;
		}

		// CORS validation
		if (!this._admitCors(req, res)) {
			return;
		}

		// CORS preflight
		if (req.method === 'OPTIONS') {
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
			res.writeHead(204);
			res.end();
			return;
		}

		// Metrics endpoint
		if (req.method === 'GET' && urlPath === '/metrics') {
			this._handleMetrics(res);
			return;
		}

		// MCP endpoint routing
		if (urlPath === this._path) {
			if (req.method === 'POST') {
				const lease = this._preDispatch.acquire();
				if (!lease) {
					const responseFinalizer = new ResponseFinalizer(res, this._lifecycleFailureReporter);
					responseFinalizer.finalize((response) => {
						this._sendJsonRpcError(response, 503, -32603, 'Server is shutting down');
					});
					return;
				}
				await this._handleMcpPost(req, res, lease);
				return;
			}
			res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: null,
					error: { code: -32601, message: 'Method not allowed' },
				})
			);
			return;
		}

		// 404 for unknown paths
		this._sendJsonRpcError(res, 404, -32601, 'Not Found');
	}

	/**
	 * Send a JSON-RPC error response.
	 */
	private _sendJsonRpcError(
		res: ServerResponse,
		statusCode: number,
		code: number,
		message: string,
		id: unknown = null,
		extra?: Record<string, unknown>
	): void {
		const error: Record<string, unknown> = { code, message };
		if (extra) {
			Object.assign(error, extra);
		}
		res.writeHead(statusCode, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ jsonrpc: '2.0', id, error }));
	}

	private _parseJsonRpcRequest(
		body: string,
		responseFinalizer: ResponseFinalizer
	): Parameters<McpServer['receive']>[0] | null {
		let rawBody: unknown;
		try {
			rawBody = JSON.parse(body) as unknown;
		} catch {
			responseFinalizer.finalize((response) => {
				this._sendJsonRpcError(response, 200, -32700, 'Parse error');
			});
			return null;
		}

		const parseResult = safeParse(JsonRpcRequestSchema, rawBody);
		const rawId =
			rawBody && typeof rawBody === 'object' && 'id' in rawBody
				? ((rawBody as { id?: unknown }).id ?? null)
				: null;
		if (!parseResult.success) {
			responseFinalizer.finalize((response) => {
				this._sendJsonRpcError(
					response,
					200,
					-32600,
					'Invalid Request',
					rawId as string | number | null,
					{ data: parseResult.issues }
				);
			});
			return null;
		}
		return parseResult.output as Parameters<McpServer['receive']>[0];
	}

	/**
	 * Handle POST /mcp — JSON-RPC method calls.
	 *
	 * Per the MCP Streamable HTTP spec:
	 * - Accepts JSON-RPC request bodies
	 * - Returns Mcp-Session-Id header for new sessions (stateful mode)
	 * - Validates Mcp-Session-Id for existing sessions (stateful mode)
	 * - Content-Type: application/json for responses
	 */
	private async _handleMcpPost(
		req: IncomingMessage,
		res: ServerResponse,
		lease: PreDispatchLease
	): Promise<void> {
		this._requestCount++;
		this._activeRequests++;
		const responseFinalizer = new ResponseFinalizer(res, this._lifecycleFailureReporter);
		let acceptedSession: SessionState | null = null;
		const onAborted = (): void => lease.cancel('peer');
		req.once('aborted', onAborted);

		const timeout = setTimeout(() => {
			responseFinalizer.finalize((response) => {
				this._sendJsonRpcError(response, 500, -32603, 'Request timeout');
			});
			lease.cancel('timeout');
		}, this._requestTimeout);
		try {
			// Read request body with size limit
			const body = await readRequestBody(
				req,
				this._bodySizeLimitEnabled ? this._maxBodySize : 0,
				lease.signal
			);
			if (body === null) {
				responseFinalizer.finalize((response) => {
					this._sendJsonRpcError(response, 413, -32000, 'Request body too large');
				});
				return;
			}

			const jsonRpcRequest = this._parseJsonRpcRequest(body, responseFinalizer);
			if (jsonRpcRequest === null) return;

			const session = this._acceptPostSession(req, responseFinalizer);
			if (!session) return;
			acceptedSession = session.state;

			// Check if MCP server is ready
			if (!this._mcpServer) {
				const requestId = 'id' in jsonRpcRequest ? (jsonRpcRequest.id ?? null) : null;
				responseFinalizer.finalize((response) => {
					this._sendJsonRpcError(response, 503, -32603, 'Server not ready', requestId);
				});
				return;
			}

			req.off('aborted', onAborted);
			const acceptedWork = this._acceptedWork.transfer(lease, () =>
				this._receiveAndFinalize(jsonRpcRequest, session.id, responseFinalizer).catch(
					(error: unknown) => {
						responseFinalizer.finalize((response) => {
							this._sendJsonRpcError(response, 200, -32603, 'Internal error', null, {
								data: getErrorMessage(error),
							});
						});
					}
				)
			);
			await acceptedWork;
		} catch (error) {
			if (lease.signal.aborted) {
				if (lease.cancellationReason === 'shutdown') {
					responseFinalizer.finalize((response) => {
						this._sendJsonRpcError(response, 503, -32603, 'Server is shutting down');
					});
				}
				return;
			}
			responseFinalizer.finalize((response) => {
				this._sendJsonRpcError(response, 200, -32603, 'Internal error', null, {
					data: getErrorMessage(error),
				});
			});
		} finally {
			req.off('aborted', onAborted);
			lease.release();
			if (acceptedSession) acceptedSession.acceptedPostCount--;
			clearTimeout(timeout);
			this._activeRequests--;
		}
	}

	private _acceptPostSession(
		req: IncomingMessage,
		responseFinalizer: ResponseFinalizer
	): AcceptedPostSession | null {
		if (!this._stateful) return { id: undefined, state: null };
		if (this.isShuttingDown) {
			responseFinalizer.finalize((response) => {
				this._sendJsonRpcError(response, 503, -32603, 'Server is shutting down');
			});
			return null;
		}
		const session = this._resolveSession(req);
		if (!('state' in session)) {
			responseFinalizer.finalize((response) => {
				this._sendJsonRpcError(response, session.statusCode, session.code, session.message);
			});
			return null;
		}
		session.state.acceptedPostCount++;
		return { id: session.id, state: session.state };
	}

	private async _receiveAndFinalize(
		jsonRpcRequest: Parameters<McpServer['receive']>[0],
		sessionId: string | undefined,
		responseFinalizer: ResponseFinalizer
	): Promise<void> {
		const owner = this._stateful ? (sessionId ?? randomUUID()) : randomUUID();
		const response = await runWithContext({ requestId: randomUUID(), owner }, () =>
			this._requireMcpServer().receive(jsonRpcRequest, { sessionInfo: {} })
		);
		const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
		if (sessionId) responseHeaders['Mcp-Session-Id'] = sessionId;

		responseFinalizer.finalize((httpResponse) => {
			if (response) {
				httpResponse.writeHead(200, responseHeaders);
				httpResponse.end(JSON.stringify(response));
				return;
			}
			if (sessionId) httpResponse.setHeader('Mcp-Session-Id', sessionId);
			httpResponse.writeHead(202);
			httpResponse.end();
		});
	}

	/**
	 * Resolve or create a session for a stateful request.
	 *
	 * @returns Session ID string on success, or the response error to finalize.
	 */
	private _resolveSession(
		req: IncomingMessage
	): { readonly id: SessionId; readonly state: SessionState } | SessionError {
		const headerSessionId = this._getSessionIdFromHeader(req);

		if (headerSessionId) {
			// Validate format
			if (!this.validateSessionId(headerSessionId)) {
				return {
					statusCode: 400,
					code: -32600,
					message: 'Invalid Mcp-Session-Id format',
				};
			}

			// Check if session exists
			const session = this._sessions.get(asSessionId(headerSessionId));
			if (session) {
				session.lastActivityAt = Date.now();
				return { id: session.id, state: session };
			}

			// Unknown session ID — per spec, return 404
			return { statusCode: 404, code: -32001, message: 'Session not found' };
		}

		// No session header — create new session
		if (this._sessionRetention && this._sessions.size >= this._sessionRetention.maxSessions) {
			return { statusCode: 503, code: -32000, message: 'Session capacity reached' };
		}
		const newSessionId = asSessionId(this._sessionIdGenerator());
		const now = Date.now();
		const sessionState: SessionState = {
			id: newSessionId,
			createdAt: now,
			lastActivityAt: now,
			acceptedPostCount: 0,
		};
		this._sessions.set(newSessionId, sessionState);
		this.log('info', `New session created: ${newSessionId}`);
		this._updateSessionMetrics();

		return { id: newSessionId, state: sessionState };
	}

	private _sweepExpiredSessions(): void {
		if (!this._sessionRetention) return;
		const now = Date.now();
		for (const [sessionId, session] of this._sessions) {
			if (
				session.acceptedPostCount === 0 &&
				now - session.lastActivityAt >= this._sessionRetention.sessionIdleTimeoutMs
			) {
				this._disposeSession(sessionId);
			}
		}
	}

	private _disposeSession(sessionId: SessionId): void {
		if (!this._sessions.delete(sessionId)) return;
		this._updateSessionMetrics();
	}

	private _stopSessionSweep(): void {
		const interval = this._sessionSweepIntervalId;
		if (!interval) return;
		interval.unref();
		clearInterval(interval);
		this._sessionSweepIntervalId = null;
	}

	/**
	 * Extract Mcp-Session-Id from request headers.
	 */
	private _getSessionIdFromHeader(req: IncomingMessage): string | undefined {
		const value = req.headers['mcp-session-id'];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
		return undefined;
	}

	/**
	 * Handle GET /metrics endpoint.
	 */
	private _handleMetrics(res: ServerResponse): void {
		if (!this._metricsProvider) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not Found');
			return;
		}

		res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
		res.end(this._metricsProvider());
	}

	/**
	 * Handle GET /health — Liveness check.
	 */
	private _handleHealthCheck(res: ServerResponse): void {
		const healthData: Record<string, unknown> = {
			status: 'healthy',
			requests: this._requestCount,
			sessions: this._sessions.size,
			transport: 'streamable-http',
		};
		if (this._healthChecker) {
			const liveness = this._healthChecker.checkLiveness();
			healthData.liveness = liveness;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(healthData));
	}

	/**
	 * Handle GET /ready — Readiness check.
	 */
	private async _handleReadinessCheck(res: ServerResponse): Promise<void> {
		if (this._healthChecker) {
			const readiness = await this._healthChecker.checkReadiness();
			const statusCode = readiness.status === 'ok' ? 200 : 503;
			res.writeHead(statusCode, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(readiness));
		} else {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					status: 'ok',
					timestamp: new Date().toISOString(),
					components: {},
				})
			);
		}
	}

	/**
	 * Update session-related metrics.
	 */
	private _updateSessionMetrics(): void {
		this._metrics?.gauge(
			'streamable_http_active_sessions',
			this._sessions.size,
			{},
			'Active Streamable HTTP sessions'
		);
	}

	/**
	 * Stop transport server with graceful shutdown.
	 *
	 * @param timeout - Maximum time before force-closing HTTP connections (default: 30s)
	 */
	stop(timeout?: number): Promise<void> {
		if (this._stopPromise) return this._stopPromise;
		this._isShuttingDown = true;
		this._preDispatch.closeAdmission('shutdown');
		this._stopRateLimitCleanup();
		this._stopSessionSweep();

		const shutdownTimeout = timeout ?? 30000;

		for (const sessionId of this._sessions.keys()) {
			this._disposeSession(sessionId);
		}

		const server = this._server;
		const serverClosed = new Promise<void>((resolve, reject) => {
			if (!server?.listening) {
				resolve();
				return;
			}

			let settled = false;
			let forceClose: NodeJS.Timeout | null = null;
			server.close((error) => {
				if (settled) return;
				settled = true;
				if (forceClose) clearTimeout(forceClose);
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
			if (settled) return;
			forceClose = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.log('warn', 'Streamable HTTP transport force-closing after timeout');
				server.closeAllConnections();
				resolve();
			}, shutdownTimeout);
		});
		const stopPromise = Promise.all([
			serverClosed,
			this._preDispatch.join().then(() => this._acceptedWork.join()),
		]).then(() => {
			this.log('info', 'Streamable HTTP transport stopped');
		});
		this._stopPromise = stopPromise;
		void stopPromise.catch(() => {
			if (this._stopPromise === stopPromise) this._stopPromise = null;
		});
		return stopPromise;
	}
}

/**
 * Create a Streamable HTTP transport with given options.
 *
 * @param options - Transport configuration
 * @returns A configured Streamable HTTP transport
 *
 * @example
 * ```typescript
 * const transport = createStreamableHttpTransport({ port: 3000, stateful: true });
 * await transport.connect(server);
 * ```
 */
export function createStreamableHttpTransport(
	options: StreamableHttpTransportOptions = {}
): StreamableHttpTransport {
	return new StreamableHttpTransport(options);
}
