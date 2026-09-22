import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';

import { asSessionId } from '../../contracts/ids.js';
import { createServer } from '../../lib.js';

const RESPONSE_SCHEMA = v.object({
	confidence_signals: v.object({
		quality_components_raw: v.object({ verification_coverage: v.number() }),
	}),
	reasoning_stats: v.object({
		verified_hypothesis_count: v.number(),
		unresolved_hypothesis_count: v.number(),
	}),
});

type Server = Awaited<ReturnType<typeof createServer>>;
type PublicInput = Parameters<Server['processThought']>[0];
type PublicResponse = v.InferOutput<typeof RESPONSE_SCHEMA>;

const servers = new Set<Server>();
const directories = new Set<string>();

function parseResponse(result: Awaited<ReturnType<Server['processThought']>>): PublicResponse {
	const text = result.content[0]?.text;
	if (text === undefined) throw new TypeError('processThought returned no content');
	return v.parse(RESPONSE_SCHEMA, JSON.parse(text));
}

function thought(overrides: Partial<PublicInput>): PublicInput {
	return {
		id: 'thought',
		session_id: 'verification-file-restart',
		thought: 'thought',
		thought_number: 1,
		total_thoughts: 10,
		next_thought_needed: true,
		...overrides,
	};
}

async function fileServer(dataDir: string, loadFromPersistence: boolean): Promise<Server> {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence,
		fileConfig: {
			persistence: { enabled: true, backend: 'file', options: { dataDir } },
			persistenceBufferSize: 1,
			persistenceFlushInterval: 60_000,
			features: { dagEdges: false, toolInterleave: false },
		},
	});
	servers.add(server);
	return server;
}

afterEach(async () => {
	for (const server of servers) await server.dispose();
	servers.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe('explicit verification target persistence', () => {
	it('preserves explicit target analytics across a FilePersistence restart', async () => {
		// Given
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-verification-restart-'));
		directories.add(dataDir);
		const sessionId = asSessionId('verification-file-restart');
		const first = await fileServer(dataDir, false);
		await first.processThought(
			thought({
				id: 'hypothesis',
				session_id: sessionId,
				thought: 'hypothesis',
				thought_number: 1,
				thought_type: 'hypothesis',
				hypothesis_id: 'stable-target',
			})
		);
		const live = parseResponse(
			await first.processThought(
				thought({
					id: 'verifier',
					session_id: sessionId,
					thought: 'verifier',
					thought_number: 2,
					thought_type: 'verification',
					verification_target: 1,
				})
			)
		);
		await first.dispose();
		servers.delete(first);
		const snapshotPath = join(dataDir, 'snapshot.json');
		const beforeRestore = await readFile(snapshotPath);

		// When
		const reopened = await fileServer(dataDir, true);
		expect(await readFile(snapshotPath)).toEqual(beforeRestore);
		const afterRestore = parseResponse(
			await reopened.processThought(
				thought({
					id: 'later',
					session_id: sessionId,
					thought: 'later',
					thought_number: 3,
				})
			)
		);

		// Then
		expect(live.confidence_signals.quality_components_raw.verification_coverage).toBe(1);
		expect(live.reasoning_stats.verified_hypothesis_count).toBe(1);
		expect(afterRestore.confidence_signals.quality_components_raw.verification_coverage).toBe(1);
		expect(afterRestore.reasoning_stats.verified_hypothesis_count).toBe(1);
		expect(afterRestore.reasoning_stats.unresolved_hypothesis_count).toBe(0);
	});
});
