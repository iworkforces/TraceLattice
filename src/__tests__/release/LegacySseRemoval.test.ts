import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type FileContents = {
	readonly contents: string | undefined;
	readonly relativePath: string;
};

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dedicatedLegacyTransportFiles = [
	'src/transport/SseTransport.ts',
	'src/__tests__/sse-transport.test.ts',
	'src/__tests__/sse-transport-cov.test.ts',
	'src/__tests__/integration/SsePoolRouting.test.ts',
] as const;
const activeLegacyFiles = [
	'src/cli.ts',
	'src/lib.ts',
	'src/contracts/transport.ts',
	'src/transport/HttpHelpers.ts',
	'src/transport/StreamableHttpTransport.ts',
	'src/transport/HttpTransport.ts',
	'src/transport/BaseTransport.ts',
	'src/__tests__/metrics-integration.test.ts',
	'src/__tests__/transport-owner-context.test.ts',
	'src/__tests__/streamable-http-transport.test.ts',
	'src/__tests__/streamable-http-cov.test.ts',
	'src/__tests__/integration/ProtocolHarness.ts',
	'src/__tests__/integration/ShutdownContractHarness.ts',
	'src/__tests__/integration/ShutdownContract.test.ts',
	'src/__tests__/integration/TransportContract.test.ts',
	'src/__tests__/integration/shutdown-contract.fixture.mjs',
	'.example.env',
	'README.md',
	'AGENTS.md',
	'src/AGENTS.md',
	'src/__tests__/AGENTS.md',
	'src/health/AGENTS.md',
	'src/logger/AGENTS.md',
	'src/pool/AGENTS.md',
	'src/transport/AGENTS.md',
] as const;
const legacyIdentifiers = [
	'SseTransport',
	'SseTransportOptions',
	'createSseTransport',
	'startSseTransport',
	'assertPooledSsePersistence',
	'pooled-sse',
	'/sse/message',
	'SSE_PORT',
	'SSE_HOST',
	'SSE_ENABLE_POOL',
	'SSE_MAX_SESSIONS',
	'SSE_SESSION_TIMEOUT',
	'text/event-stream',
	'_sendSseEvent',
	'notificationStreams',
	'streamable_http_notification_streams',
	'broadcastToSession',
] as const;
const pathSpecificLegacyIdentifiers = [
	{ relativePath: 'src/cli.ts', identifier: "'sse'" },
	{ relativePath: 'src/lib.ts', identifier: "'sse'" },
	{ relativePath: 'src/contracts/transport.ts', identifier: "'sse'" },
] as const;

async function readIfPresent(relativePath: string): Promise<FileContents> {
	try {
		return { relativePath, contents: await readFile(resolve(projectRoot, relativePath), 'utf8') };
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return { relativePath, contents: undefined };
		}
		throw error;
	}
}

describe('legacy SSE removal', () => {
	it('rejects dedicated legacy SSE transport surfaces', async () => {
		// Given
		const [dedicatedLegacyFiles, activeFiles] = await Promise.all([
			Promise.all(dedicatedLegacyTransportFiles.map(readIfPresent)),
			Promise.all(activeLegacyFiles.map(readIfPresent)),
		]);
		// When
		const remainingLegacySurfaces = [
			...dedicatedLegacyFiles.flatMap(({ contents, relativePath }) =>
				contents === undefined ? [] : [relativePath]
			),
			...activeFiles.flatMap(({ contents, relativePath }) => {
				if (contents === undefined) return [];
				const identifiers = [
					...legacyIdentifiers,
					...pathSpecificLegacyIdentifiers
						.filter((rule) => rule.relativePath === relativePath)
						.map((rule) => rule.identifier),
				];
				return identifiers
					.filter((identifier) => contents.includes(identifier))
					.map((identifier) => `${relativePath}:${identifier}`);
			}),
		];
		// Then
		expect(remainingLegacySurfaces).toEqual([]);
	});

	it('uses port 9007 as the Streamable HTTP default', async () => {
		// Given
		const { contents } = await readIfPresent('src/cli.ts');
		// Then
		expect(contents).toContain("process.env.TRACELATTICE_STREAMABLE_HTTP_PORT || '9007'");
	});
});
