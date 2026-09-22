import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { resolveVerificationLinks } from '../../core/evaluator/VerificationLinks.js';
import { createPersistenceBackend } from '../../persistence/PersistenceFactory.js';
import { createTestThought } from '../helpers/factories.js';

const managers = new Set<HistoryManager>();
const backends = new Set<PersistenceBackend>();
const directories = new Set<string>();

async function openBackend(dbPath: string): Promise<PersistenceBackend> {
	const backend = await createPersistenceBackend({
		enabled: true,
		backend: 'sqlite',
		options: { dbPath },
	});
	if (backend === null) throw new TypeError('enabled SQLite backend was not created');
	backends.add(backend);
	return backend;
}

function manager(persistence: PersistenceBackend): HistoryManager {
	const value = new HistoryManager({
		persistence,
		persistenceBufferSize: 1,
		persistenceFlushInterval: 60_000,
	});
	managers.add(value);
	return value;
}

afterEach(async () => {
	for (const value of managers) await value.shutdown();
	managers.clear();
	for (const backend of backends) await backend.close();
	backends.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe('native SQLite verification target restoration', () => {
	it('preserves the admission target after close, reopen, and a later duplicate number', async () => {
		// Given
		const directory = await mkdtemp(join(tmpdir(), 'tracelattice-verification-sqlite-'));
		directories.add(directory);
		const sessionId = asSessionId('verification-sqlite-restart');
		const first = manager(await openBackend(join(directory, 'history.db')));
		first.addThought(
			createTestThought({
				id: 'sqlite-target',
				session_id: sessionId,
				thought_number: 1,
				thought_type: 'hypothesis',
			})
		);
		first.addThought(
			createTestThought({
				id: 'sqlite-verifier',
				session_id: sessionId,
				thought_number: 2,
				thought_type: 'verification',
				verification_target: 1,
			})
		);
		await first.drainSession(sessionId);
		await first.shutdown();
		managers.delete(first);
		for (const backend of backends) await backend.close();
		backends.clear();

		// When
		const restored = manager(await openBackend(join(directory, 'history.db')));
		await restored.loadFromPersistence();
		restored.addThought(
			createTestThought({
				id: 'sqlite-later-duplicate',
				session_id: sessionId,
				thought_number: 1,
				thought_type: 'hypothesis',
			})
		);
		const links = resolveVerificationLinks(
			restored.getHistory(sessionId),
			restored.getBranches(sessionId),
			restored.inspectSession(sessionId).verificationTargets
		);

		// Then
		expect(links.targetFor(asThoughtId('sqlite-verifier'))).toBe(asThoughtId('sqlite-target'));
		expect(links.verifiedHypothesisIds).toEqual(new Set([asThoughtId('sqlite-target')]));
	});
});
