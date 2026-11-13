/**
 * HTTP Transport implementation.
 *
 * This transport provides a stateless, REST-like API interface for MCP tool invocations
 * using standard HTTP request-response patterns.
 *
 * @example
 * ```typescript
 * const transport = new HttpTransport({
 *   port: 3000,
 *   host: 'localhost'
 * });
 * await transport.connect(server);
 * ```
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer } from 'tmcp';
import { safeParse } from 'valibot';
import type { IMetrics } from '../contracts/interfaces.js';
import { getErrorMessage } from '../errors.js';
import { JsonRpcRequestSchema } from '../schema.js';
import { BaseTransport, type TransportOptions } from './BaseTransport.js';
import type { ITransport, TransportKind } from '../contracts/transport.js';
import {
	readRequestBody,
	sendCorsPreflight,
	sendJsonRpcError,
	sendJsonRpcResponse,
} from './HttpHelpers.js';
import { runWithContext } from '../context/RequestContext.js';
import {
	AcceptedWorkTracker,
	LifecycleFailureReporter,
	PreDispatchTracker,
	ResponseFinalizer,
	boundStop,
	type PreDispatchLease,
} from './HttpRequestLifecycle.js';

export interface HttpTransportOptions extends TransportOptions {
	/**
	 * Path for messages endpoint
	 * @default '/messages'
	 */
	path?: string;
	metrics?: IMetrics;
	metricsProvider?: () => string;

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
}

/**
 * HTTP Transport for MCP server.
 *
 * This transport provides a stateless, REST-like API interface for MCP tool invocations
 * using standard HTTP request-response patterns.
 *
 * @remarks
 * **Security Features:**
 * - Session ID validation (alphanumeric, max 64 chars)
 * - Query parameter sanitization (whitelist allowed keys)
 * - Rate limiting per IP (configurable, default 100 req/min)
 * - CORS origin validation
 * - Request body size limits (configurable, default 10MB)
 * - Request timeout (configurable, default 30s)
 *
 * **Rate Limiting:**
 * - Tracks requests per IP address within a time window
 * - Returns 429 Too Many Requests when limit exceeded
 * - Can be disabled via `enableRateLimit: false`
 *
 * **HTTP Status Code Mapping:**
 * - 200: Success (JSON-RPC response)
 * - 204: CORS Preflight (empty body)
 * - 400: Bad Request
 * - 403: Forbidden (invalid CORS)
 * - 404: Not Found
 * - 413: Payload Too Large
 * - 429: Too Many Requests
 * - 500: Internal Server Error
 * - 503: Server Not Ready
 */
export class HttpTransport extends BaseTransport implements ITransport {
	get kind(): TransportKind {
		return 'http';
	}
	private _server: ReturnType<typeof createServer>;
	private _mcpServer: McpServer | null = null;
	private _requestTimeout: number;
	private _bodySizeLimitEnabled: boolean;
	private _maxBodySize: number;
	private _requestCount: number = 0;
	private _activeRequests: number = 0;
	private _path: string;
	private _metrics?: IMetrics;
	private _metricsProvider: (() => string) | null;
	private readonly _lifecycleFailureReporter: LifecycleFailureReporter;
	private readonly _acceptedWork: AcceptedWorkTracker;
	private readonly _preDispatch = new PreDispatchTracker();
	private _stopPromise: Promise<void> | null = null;

	constructor(options: HttpTransportOptions = {}) {
		super(options);

		this._requestTimeout = options.requestTimeout ?? 30000;
		this._bodySizeLimitEnabled = options.enableBodySizeLimit ?? true;
		this._maxBodySize = options.maxBodySize ?? 10 * 1024 * 1024;
		this._path = options.path ?? '/messages';
		this._metrics = options.metrics;
		this._metricsProvider = options.metricsProvider ?? null;
		this._lifecycleFailureReporter = new LifecycleFailureReporter((error) => {
			this.log('error', 'HTTP request lifecycle failed', { error: getErrorMessage(error) });
		});
		this._acceptedWork = new AcceptedWorkTracker(this._lifecycleFailureReporter);
		this._server = createServer((req, res) => {
			const responseFinalizer = new ResponseFinalizer(res, this._lifecycleFailureReporter);
			void this._handleRequest(req, res).catch((error: unknown) => {
				this._lifecycleFailureReporter.report(error);
				responseFinalizer.finalize((response) => {
					sendJsonRpcError(response, 500, -32603, 'Internal error', null, getErrorMessage(error));
				});
			});
		});
	}

	private _requireMcpServer(): McpServer {
		if (!this._mcpServer) {
			throw new Error('MCP server not initialized. Did you call connect()?');
		}
		return this._mcpServer;
	}

	/**
	 * Get number of active HTTP connections.
	 */
	get clientCount(): number {
		return this._activeRequests;
	}

	/**
	 * Connects MCP server to this transport.
	 */
	async connect(mcpServer: McpServer): Promise<void> {
		this._mcpServer = mcpServer;
		const server = this._server;
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
				this.log('info', `HTTP transport listening on http://${this._host}:${this._port}`);
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

	/**
	 * Track an error in metrics.
	 */
	private _trackError(errorType: string): void {
		this._metrics?.counter(
			'http_request_errors_total',
			1,
			{ transport: 'http', error_type: errorType },
			'Total HTTP request errors'
		);
	}

	private _parseJsonRpcRequest(
		body: string,
		responseFinalizer: ResponseFinalizer
	): Parameters<McpServer['receive']>[0] | null {
		let rawBody: unknown;
		try {
			rawBody = JSON.parse(body) as unknown;
		} catch {
			this._trackError('parse_error');
			responseFinalizer.finalize((response) => {
				sendJsonRpcError(response, 200, -32700, 'Parse error');
			});
			return null;
		}

		const parseResult = safeParse(JsonRpcRequestSchema, rawBody);
		const rawId =
			rawBody && typeof rawBody === 'object' && 'id' in rawBody
				? ((rawBody as { id?: unknown }).id ?? null)
				: null;
		if (!parseResult.success) {
			this._trackError('validation');
			responseFinalizer.finalize((response) => {
				sendJsonRpcError(
					response,
					200,
					-32600,
					'Invalid Request',
					rawId as string | number | null,
					parseResult.issues
				);
			});
			return null;
		}
		return parseResult.output as Parameters<McpServer['receive']>[0];
	}

	/**
	 * Route and handle incoming HTTP requests.
	 *
	 * Performs security checks (host, shutdown, rate limit, CORS) then
	 * dispatches to the appropriate endpoint handler.
	 */
	private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const startTime = Date.now();
		const requestPath = req.url || '/';
		const requestMethod = req.method || 'GET';
		this._metrics?.counter('http_requests_total', 1, {}, 'Total HTTP transport requests');
		this._metrics?.counter(
			'http_transport_requests_total',
			1,
			{ transport: 'http', method: requestMethod, path: requestPath },
			'Total HTTP requests by transport'
		);
		res.once('finish', () => {
			const durationSeconds = (Date.now() - startTime) / 1000;
			this._metrics?.histogram('http_request_duration_seconds', durationSeconds, {});
			this._metrics?.histogram('http_transport_request_duration_seconds', durationSeconds, {
				transport: 'http',
				path: requestPath,
			});
		});

		// Security middleware chain
		if (!this.validateHostHeader(req)) {
			this._trackError('forbidden');
			sendJsonRpcError(res, 403, -32000, 'Forbidden - invalid host header');
			return;
		}

		if (this.isShuttingDown) {
			this._trackError('shutting_down');
			sendJsonRpcError(res, 503, -32603, 'Server is shutting down');
			return;
		}

		const clientIp = this.getClientIp(req);
		if (this.checkRateLimit(clientIp)) {
			this._trackError('rate_limit');
			res.setHeader('Retry-After', '60');
			sendJsonRpcError(res, 429, -32000, 'Too many requests');
			return;
		}

		if (!this.validateCorsOrigin(req)) {
			this._trackError('forbidden');
			sendJsonRpcError(res, 403, -32000, 'Forbidden - invalid origin');
			return;
		}

		this.setCorsHeaders(res);

		// Static endpoints
		if (req.method === 'GET' && req.url === '/metrics')
			return this.handleMetricsEndpoint(res, this._metricsProvider);
		if (req.method === 'OPTIONS') return sendCorsPreflight(res);
		if (req.method === 'GET' && req.url === '/health')
			return this.handleHealthEndpoint(res, { requests: this._requestCount });
		if (req.method === 'GET' && req.url === '/ready') return this.handleReadinessEndpoint(res);

		// MCP endpoint
		if (req.method === 'POST' && req.url === this._path) {
			const lease = this._preDispatch.acquire();
			if (!lease) {
				const responseFinalizer = new ResponseFinalizer(res, this._lifecycleFailureReporter);
				responseFinalizer.finalize((response) => {
					sendJsonRpcError(response, 503, -32603, 'Server is shutting down');
				});
				return;
			}
			await this._handlePostRequest(req, res, lease);
			return;
		}

		// 404
		this._trackError('not_found');
		sendJsonRpcError(res, 404, -32601, 'Not Found');
	}

	/**
	 * Handle POST to the MCP messages endpoint.
	 *
	 * Reads the request body, validates JSON-RPC format, and delegates
	 * processing to the MCP server.
	 */
	private async _handlePostRequest(
		req: IncomingMessage,
		res: ServerResponse,
		lease: PreDispatchLease
	): Promise<void> {
		this._requestCount++;
		this._activeRequests++;
		const responseFinalizer = new ResponseFinalizer(res, this._lifecycleFailureReporter);
		const onAborted = (): void => lease.cancel('peer');
		req.once('aborted', onAborted);

		const timeout = setTimeout(() => {
			this._trackError('timeout');
			responseFinalizer.finalize((response) => {
				sendJsonRpcError(response, 500, -32603, 'Request timeout');
			});
			lease.cancel('timeout');
		}, this._requestTimeout);

		try {
			const maxBodySize = this._bodySizeLimitEnabled ? this._maxBodySize : 0;
			const body = await readRequestBody(req, maxBodySize, lease.signal);

			if (body === null) {
				this._trackError('payload_too_large');
				responseFinalizer.finalize((response) => {
					sendJsonRpcError(response, 413, -32000, 'Request body too large');
				});
				return;
			}

			const jsonRpcRequest = this._parseJsonRpcRequest(body, responseFinalizer);
			if (jsonRpcRequest === null) return;

			if (!this._mcpServer) {
				this._trackError('server_not_ready');
				const requestId = 'id' in jsonRpcRequest ? (jsonRpcRequest.id ?? null) : null;
				responseFinalizer.finalize((response) => {
					sendJsonRpcError(response, 200, -32603, 'Server not ready', requestId);
				});
				return;
			}

			req.off('aborted', onAborted);
			const owner = randomUUID();
			const acceptedWork = this._acceptedWork.transfer(lease, () =>
				runWithContext({ requestId: randomUUID(), owner }, () =>
					this._requireMcpServer().receive(jsonRpcRequest, {
						sessionInfo: {},
					})
				)
					.then((response: Awaited<ReturnType<McpServer['receive']>>) => {
						responseFinalizer.finalize((httpResponse) => {
							if (response) {
								sendJsonRpcResponse(httpResponse, response);
							} else {
								httpResponse.writeHead(204);
								httpResponse.end();
							}
						});
					})
					.catch((error: unknown) => {
						this._trackError('internal_error');
						responseFinalizer.finalize((response) => {
							sendJsonRpcError(
								response,
								200,
								-32603,
								'Internal error',
								null,
								getErrorMessage(error)
							);
						});
					})
			);
			await acceptedWork;
		} catch (error) {
			if (lease.signal.aborted) {
				if (lease.cancellationReason === 'shutdown') {
					responseFinalizer.finalize((response) => {
						sendJsonRpcError(response, 503, -32603, 'Server is shutting down');
					});
				}
				return;
			}
			this._trackError('internal_error');
			responseFinalizer.finalize((response) => {
				sendJsonRpcError(response, 200, -32603, 'Internal error', null, getErrorMessage(error));
			});
		} finally {
			req.off('aborted', onAborted);
			lease.release();
			clearTimeout(timeout);
			this._activeRequests--;
		}
	}

	/**
	 * Returns number of requests handled.
	 */
	get requestCount(): number {
		return this._requestCount;
	}

	/**
	 * Stops transport server.
	 *
	 * Accepted work is joined until the timeout. At the timeout the transport's own timer force-closes
	 * connections and settles: it rejects with `TransportStopTimeoutError` while accepted work is
	 * still pending and resolves otherwise. A later `stop()` starts a new bounded join.
	 *
	 * @param timeout - Maximum time to join accepted work and server close (default: 30s)
	 */
	stop(timeout = 30000): Promise<void> {
		if (this._stopPromise) return this._stopPromise;
		this._isShuttingDown = true;
		this._preDispatch.closeAdmission('shutdown');
		this._stopRateLimitCleanup();

		const server = this._server;
		const needsDeadline = server.listening || this._acceptedWork.size > 0;
		const serverClosed = server.listening
			? new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				})
			: Promise.resolve();
		const joined = Promise.all([
			serverClosed,
			this._preDispatch.join().then(() => this._acceptedWork.join()),
		]).then(() => {
			this.log('info', 'HTTP transport stopped');
		});
		const stopPromise = needsDeadline
			? boundStop(joined, {
					timeoutMs: timeout,
					acceptedWork: this._acceptedWork,
					forceClose: () => {
						this.log('warn', 'HTTP transport force-closing after timeout');
						server.closeAllConnections();
					},
				})
			: joined;
		this._stopPromise = stopPromise;
		void stopPromise.catch(() => {
			if (this._stopPromise === stopPromise) this._stopPromise = null;
		});
		return stopPromise;
	}
}

/**
 * Create an HTTP transport with given options.
 *
 * @param options - Transport configuration
 * @returns A configured HTTP transport
 *
 * @example
 * ```typescript
 * const transport = new HttpTransport({ port: 3000 });
 * await transport.connect(server);
 * ```
 */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
	return new HttpTransport(options);
}
