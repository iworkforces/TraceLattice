import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliTransportConfig } from '../../config/CliTransportConfig.js';
import { runWithContext } from '../../context/RequestContext.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';
import { SequentialThinkingSchema } from '../../schema.js';
import { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';
import {
	getListeningPort,
	INITIALIZE_PARAMS,
	postJson,
	ToolCallResultSchema,
} from './ProtocolHarness.js';
import { nextEventLoopTurn } from './TransportLifecycleHarness.js';
import { withDeadline } from './ShutdownContractHarness.js';

type Fixture = {
	thinking: Awaited<ReturnType<typeof createServer>>;
	transport: StreamableHttpTransport;
	started: ReturnType<typeof Promise.withResolvers<void>>;
	release: ReturnType<typeof Promise.withResolvers<void>>;
	url: string;
};
const fixtures: Fixture[] = [];

async function startFixture(): Promise<Fixture> {
	const config = parseCliTransportConfig({
		TRACELATTICE_TRANSPORT_TYPE: 'streamable-http',
		TRACELATTICE_STREAMABLE_HTTP_PORT: '0',
		TRACELATTICE_STREAMABLE_HTTP_HOST: '127.0.0.1',
		TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS: '1',
		TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS: '150',
		TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS: '10',
	});
	if (config.kind !== 'streamable-http') throw new Error('Expected HTTP config');
	const thinking = await createServer({
		config: new ServerConfig({ persistence: { enabled: false } }),
		autoDiscover: false,
		loadFromPersistence: false,
	});
	const server = new McpServer(
		{ name: 'cli-retention-test', version: '1' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
	server.tool(
		{ name: 'sequentialthinking_tools', description: 'Think', schema: SequentialThinkingSchema },
		async (input) => thinking.processThought(input)
	);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	server.tool(
		{ name: 'barrier', description: 'Controlled accepted work', schema: v.object({}) },
		async () => {
			started.resolve();
			await release.promise;
			return { content: [{ type: 'text', text: 'released' }] };
		}
	);
	const transport = new StreamableHttpTransport({
		port: config.port,
		host: config.host,
		corsOrigin: config.corsOrigin,
		enableCors: config.enableCors,
		allowedHosts: config.allowedHosts,
		stateful: config.stateful,
		...config.retention,
	});
	const fixture = { thinking, transport, started, release, url: '' };
	fixtures.push(fixture);
	await transport.connect(server);
	fixture.url = `http://127.0.0.1:${getListeningPort(transport)}/mcp`;
	return fixture;
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		fixture.release.resolve();
		await fixture.transport.stop();
		await fixture.thinking.stop();
	}
	vi.restoreAllMocks();
});

async function initialize(url: string) {
	const response = await postJson(url, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: INITIALIZE_PARAMS,
	});
	expect(response.status).toBe(200);
	const session = response.headers.get('mcp-session-id');
	if (session === null) throw new Error('Missing transport session');
	return session;
}

function thoughtRequest(number: number) {
	return {
		jsonrpc: '2.0',
		id: number,
		method: 'tools/call',
		params: {
			name: 'sequentialthinking_tools',
			arguments: {
				session_id: 'retained-thoughts',
				thought: `thought ${number}`,
				thought_number: number,
				total_thoughts: 3,
				next_thought_needed: true,
			},
		},
	};
}

describe('CLI HTTP session retention wiring', () => {
	it('rejects capacity, sweeps idle sessions and admits a fresh initialize', async () => {
		const { transport, url } = await startFixture();
		const session = await initialize(url);
		const full = await postJson(url, {
			jsonrpc: '2.0',
			id: 2,
			method: 'initialize',
			params: INITIALIZE_PARAMS,
		});
		expect(full.status).toBe(503);
		expect(full.body?.error?.code).toBe(-32000);
		await vi.waitFor(() => expect(transport.clientCount).toBe(0), { timeout: 2000, interval: 10 });
		const expired = await postJson(
			url,
			{ jsonrpc: '2.0', id: 3, method: 'tools/list' },
			{ 'mcp-session-id': session }
		);
		expect(expired.status).toBe(404);
		expect(expired.body?.error?.code).toBe(-32001);
		expect(await initialize(url)).not.toBe(session);
	});

	it('keeps accepted POST work alive during sweeping and joins it on stop', async () => {
		const { transport, url, started, release } = await startFixture();
		const session = await initialize(url);
		const response = postJson(
			url,
			{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'barrier', arguments: {} } },
			{ 'mcp-session-id': session }
		);
		await withDeadline(started.promise, 2000, 'accepted barrier');
		const acceptedAt = Date.now();
		await vi.waitFor(() => expect(Date.now() - acceptedAt).toBeGreaterThan(300), {
			timeout: 2000,
			interval: 10,
		});
		expect(transport.clientCount).toBe(1);
		let stopped = false;
		const stopping = transport.stop().then(() => {
			stopped = true;
		});
		await nextEventLoopTurn();
		expect(stopped).toBe(false);
		release.resolve();
		expect((await response).status).toBe(200);
		await withDeadline(stopping, 5000, 'joining transport stop');
		expect(stopped).toBe(true);
	});
});

describe('transport and thought session separation', () => {
	it('preserves history, ownership and TTL after sweeping and denies the new owner', async () => {
		const { thinking, transport, url } = await startFixture();
		const owner = await initialize(url);
		const first = await postJson(url, thoughtRequest(1), { 'mcp-session-id': owner });
		expect(v.parse(ToolCallResultSchema, first.body?.result).isError).not.toBe(true);
		const sessions: unknown = Reflect.get(thinking.history, '_sessions');
		if (!(sessions instanceof Map)) throw new Error('Missing thought session map');
		const state: unknown = sessions.get('retained-thoughts');
		if (typeof state !== 'object' || state === null) throw new Error('Missing thought session');
		const lastAccessedAt: unknown = Reflect.get(state, 'lastAccessedAt');
		const manager: unknown = Reflect.get(thinking.history, '_sessionManager');
		if (typeof manager !== 'object' || manager === null) throw new Error('Missing TTL policy');
		expect(Reflect.get(manager, '_sessionTtlMs')).toBe(30 * 60 * 1000);
		await vi.waitFor(() => expect(transport.clientCount).toBe(0), { timeout: 2000, interval: 10 });
		expect(sessions.get('retained-thoughts')).toBe(state);
		expect(Reflect.get(state, 'lastAccessedAt')).toBe(lastAccessedAt);
		expect(Reflect.get(state, 'owner')).toBe(owner);
		expect(Reflect.get(manager, '_sessionTtlMs')).toBe(30 * 60 * 1000);
		const fresh = await initialize(url);
		const denied = await postJson(url, thoughtRequest(2), { 'mcp-session-id': fresh });
		expect(v.parse(ToolCallResultSchema, denied.body?.result).isError).toBe(true);
		const history = runWithContext({ owner, requestId: 'retention-history-check' }, () =>
			thinking.history.getHistory('retained-thoughts')
		);
		expect(history.map((thought) => thought.thought)).toEqual(['thought 1']);
	});
});
