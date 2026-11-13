/**
 * Transport kind discriminator.
 */
import type { McpServer } from 'tmcp';

export type TransportKind = 'http' | 'streamable-http';

/**
 * Shared lifecycle interface for MCP transports.
 *
 * All transports (HTTP and Streamable HTTP) implement this interface.
 * Share lifecycle only — request/response shapes genuinely differ across transports.
 */
export interface ITransport {
	/** Discriminator for transport type identification. */
	readonly kind: TransportKind;

	/** Connect the transport to an MCP server. */
	connect(mcpServer: McpServer): Promise<void>;

	/**
	 * Stop the transport with graceful shutdown. Accepted work is joined until `timeout`
	 * milliseconds (default 30000); at the timeout the promise rejects with a
	 * `TRANSPORT_STOP_TIMEOUT` error while accepted work is still pending and resolves otherwise.
	 */
	stop(timeout?: number): Promise<void>;

	/** Number of currently active client connections. */
	readonly clientCount: number;

	/** Whether the transport is in the process of shutting down. */
	readonly isShuttingDown: boolean;

	/** The server URL for client connections. */
	readonly serverUrl: string;
}
