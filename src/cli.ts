#!/usr/bin/env bun

// CLI entry point for tracelattice MCP server.
// This file handles CLI argument parsing, transport selection, and signal handlers.
// For library usage, import from './lib.js' or './index.js' instead.

import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { StdioTransport } from '@tmcp/transport-stdio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from 'tmcp';
import { CliLifecycle, createCliShutdownHandler } from './CliLifecycle.js';
import type { ToolAwareSequentialThinkingServer } from './lib.js';
import { initializeServer } from './lib.js';
import { StructuredLogger } from './logger/StructuredLogger.js';
import { getErrorMessage } from './errors.js';
import { SEQUENTIAL_THINKING_TOOL, SequentialThinkingSchema } from './schema.js';

// Get version from package.json
const CLI_NAME = 'tracelattice' as const;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const package_json = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const { version } = package_json;
// Handle CLI arguments
const args = process.argv.slice(2);
const shouldShowVersion = args.includes('--version') || args.includes('-v');

if (shouldShowVersion) {
	console.log(`${CLI_NAME} v${version}`);
	process.exit(0);
}
async function main() {
	const transportType = process.env.TRACELATTICE_TRANSPORT_TYPE || 'stdio';
	const adapter = new ValibotJsonSchemaAdapter();
	const server = new McpServer(
		{
			name: CLI_NAME,
			version,
			description: 'Semantic Sequential Thinking MCP Server',
		},
		{
			adapter,
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);

	const thinkingServer = await initializeServer();
	const lifecycle = new CliLifecycle(thinkingServer);
	try {
		server.tool(
			{
				name: 'sequentialthinking_tools',
				description: SEQUENTIAL_THINKING_TOOL.description,
				schema: SequentialThinkingSchema,
			},
			async (input) => thinkingServer.processThought(input)
		);
		if (transportType === 'streamable-http') {
			await startStreamableHttpTransport(server, thinkingServer, lifecycle);
		} else {
			await startStdioTransport(server, thinkingServer, lifecycle);
		}
		registerShutdownHandlers(lifecycle, thinkingServer, transportType === 'stdio');
	} catch (error) {
		await lifecycle.rollbackStartup(error);
	}
}
/**
 * Start Streamable HTTP transport (MCP spec recommended)
 */
async function startStreamableHttpTransport(
	server: McpServer,
	thinkingServer: ToolAwareSequentialThinkingServer,
	lifecycle: CliLifecycle
): Promise<void> {
	const { StreamableHttpTransport } = await import('./transport/StreamableHttpTransport.js');
	const port = parseInt(process.env.TRACELATTICE_STREAMABLE_HTTP_PORT || '9007', 10);
	const host = process.env.TRACELATTICE_STREAMABLE_HTTP_HOST || 'localhost';
	const transportMetrics = thinkingServer.getContainer().resolve('Metrics');
	const stateful = process.env.TRACELATTICE_STREAMABLE_HTTP_STATEFUL !== 'false';
	const streamableTransport = new StreamableHttpTransport({
		port,
		host,
		corsOrigin: process.env.TRACELATTICE_CORS_ORIGIN || '*',
		enableCors: process.env.TRACELATTICE_ENABLE_CORS !== 'false',
		allowedHosts: process.env.TRACELATTICE_ALLOWED_HOSTS?.split(',').map((hostValue) =>
			hostValue.trim()
		),
		metrics: transportMetrics,
		stateful,
	});
	lifecycle.attachTransport(streamableTransport);
	// Connect the Streamable HTTP transport
	await streamableTransport.connect(server);
	thinkingServer['_logger'].info(
		`Sequential Thinking MCP Server running on Streamable HTTP transport at http://${host}:${port}`
	);
}
/**
 * Start stdio transport (default, single-user)
 */
async function startStdioTransport(
	server: McpServer,
	thinkingServer: ToolAwareSequentialThinkingServer,
	lifecycle: CliLifecycle
): Promise<void> {
	const transport = new StdioTransport(server);
	const processListeners = {
		sigint: new Set(process.listeners('SIGINT')),
		sigterm: new Set(process.listeners('SIGTERM')),
		stdinEnd: new Set(process.stdin.listeners('end')),
	};
	lifecycle.attachTransport({ stop: () => transport.close() });
	transport.listen();
	for (const listener of process.listeners('SIGINT')) {
		if (!processListeners.sigint.has(listener)) process.off('SIGINT', listener);
	}
	for (const listener of process.listeners('SIGTERM')) {
		if (!processListeners.sigterm.has(listener)) process.off('SIGTERM', listener);
	}
	for (const listener of process.stdin.listeners('end')) {
		if (!processListeners.stdinEnd.has(listener)) process.stdin.off('end', listener);
	}
	thinkingServer['_logger'].info('Sequential Thinking MCP Server running on stdio');
}
/**
 * Register shutdown signal handlers for a common pattern
 */
function registerShutdownHandlers(
	lifecycle: CliLifecycle,
	thinkingServer: ToolAwareSequentialThinkingServer,
	shutdownOnStdinEnd: boolean
): void {
	const shutdown = createCliShutdownHandler(lifecycle, {
		reportFailure: (error) => {
			thinkingServer['_logger'].error('CLI shutdown failed', failureMetadata(error));
		},
		exit: (code) => process.exit(code),
	});
	const requestShutdown = (): void => {
		void shutdown();
	};
	process.on('SIGINT', requestShutdown);
	process.on('SIGTERM', requestShutdown);
	if (shutdownOnStdinEnd) process.stdin.on('end', requestShutdown);
}

function failureMetadata(error: unknown): Record<string, unknown> {
	if (!(error instanceof AggregateError)) return { error: getErrorMessage(error) };
	return {
		error: error.message,
		causes: error.errors.map((cause) => getErrorMessage(cause)),
	};
}
main().catch((error) => {
	const logger = new StructuredLogger({
		level: 'error',
		context: 'SequentialThinking',
		pretty: true,
	});
	logger.error('Fatal error running server', failureMetadata(error));
	process.exit(1);
});
