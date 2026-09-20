import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asSummaryId,
	asThoughtId,
	type SessionId,
} from '../../contracts/ids.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { Edge } from '../../core/graph/Edge.js';
import type { ThoughtData } from '../../core/thought.js';
import { createPersistenceBackend } from '../../persistence/PersistenceFactory.js';
import { createTestThought } from '../helpers/factories.js';

type NamespaceState = {
	readonly history: ThoughtData;
	readonly branch: ThoughtData;
	readonly edge: Edge;
	readonly summary: Summary;
};

const sessionA = asSessionId('native-session-A');
const sessionB = asSessionId('native-session-B');
const branchId = asBranchId('native-branch');
let root: string;
let backend: PersistenceBackend | undefined;

async function openBackend(dbPath: string, maxHistorySize = 10000): Promise<PersistenceBackend> {
	const candidate = await createPersistenceBackend({
		enabled: true,
		backend: 'sqlite',
		options: { dbPath, maxHistorySize },
	});
	expect(candidate).not.toBeNull();
	if (candidate === null) throw new TypeError('enabled SQLite factory returned null');
	return candidate;
}

async function closeBackend(): Promise<void> {
	await backend?.close();
	backend = undefined;
}

function namespaceState(prefix: string, sessionId: SessionId): NamespaceState {
	const history = createTestThought({
		id: `${prefix}-history`,
		session_id: sessionId,
		thought: `${prefix} history`,
		thought_number: 1,
		total_thoughts: 2,
	});
	const branch = createTestThought({
		id: `${prefix}-branch`,
		session_id: sessionId,
		branch_id: branchId,
		thought: `${prefix} branch`,
		thought_number: 2,
		total_thoughts: 2,
	});
	return {
		history,
		branch,
		edge: {
			id: asEdgeId(`${prefix}-edge`),
			from: asThoughtId(`${prefix}-history`),
			to: asThoughtId(`${prefix}-branch`),
			kind: 'branch',
			sessionId,
			createdAt: 10,
		},
		summary: {
			id: asSummaryId(`${prefix}-summary`),
			sessionId,
			branchId,
			rootThoughtId: asThoughtId(`${prefix}-history`),
			coveredIds: [asThoughtId(`${prefix}-history`)],
			coveredRange: [1, 1],
			topics: [prefix],
			aggregateConfidence: 0.75,
			createdAt: 20,
		},
	};
}

async function saveState(candidate: PersistenceBackend, state: NamespaceState): Promise<void> {
	await candidate.saveThoughtForSession(state.summary.sessionId, state.history);
	await candidate.saveBranchForSession(state.summary.sessionId, branchId, [state.branch]);
	await candidate.saveEdges(state.summary.sessionId, [state.edge]);
	await candidate.saveSummaries(state.summary.sessionId, [state.summary]);
}

async function loadState(candidate: PersistenceBackend, sessionId: SessionId) {
	return {
		history: await candidate.loadHistoryForSession(sessionId),
		branch: await candidate.loadBranchForSession(sessionId, branchId),
		branches: await candidate.listBranchesForSession(sessionId),
		edges: await candidate.loadEdges(sessionId),
		summaries: await candidate.loadSummaries(sessionId),
	};
}

describe('native SQLite conformance', () => {
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'tracelattice-native-sqlite-'));
	});

	afterEach(async () => {
		await closeBackend();
		await rm(root, { recursive: true, force: true });
	});

	it('opens, writes, loads, and closes a healthy real file database', async () => {
		const dbPath = join(root, 'history.db');
		const thought = createTestThought({ id: 'native-lifecycle', session_id: sessionA });
		backend = await openBackend(dbPath);

		expect(await backend.healthy()).toBe(true);
		await backend.saveThoughtForSession(sessionA, thought);
		expect(await backend.loadHistoryForSession(sessionA)).toEqual([thought]);
		await closeBackend();

		expect((await stat(dbPath)).isFile()).toBe(true);
	});

	it('restores independent session namespaces after close and reopen', async () => {
		const dbPath = join(root, 'history.db');
		const stateA = namespaceState('A', sessionA);
		const stateB = namespaceState('B', sessionB);
		backend = await openBackend(dbPath);
		await saveState(backend, stateA);
		await saveState(backend, stateB);

		await closeBackend();
		backend = await openBackend(dbPath);

		expect(await loadState(backend, sessionA)).toEqual({
			history: [stateA.history],
			branch: [stateA.branch],
			branches: [branchId],
			edges: [stateA.edge],
			summaries: [stateA.summary],
		});
		expect(await loadState(backend, sessionB)).toEqual({
			history: [stateB.history],
			branch: [stateB.branch],
			branches: [branchId],
			edges: [stateB.edge],
			summaries: [stateB.summary],
		});
	});

	it('clears only one session namespace across close and reopen', async () => {
		const dbPath = join(root, 'history.db');
		backend = await openBackend(dbPath);
		await saveState(backend, namespaceState('A', sessionA));
		await saveState(backend, namespaceState('B', sessionB));
		const stateBBefore = await loadState(backend, sessionB);

		await backend.clearSession(sessionA);
		await closeBackend();
		backend = await openBackend(dbPath);

		expect(await loadState(backend, sessionA)).toEqual({
			history: [],
			branch: undefined,
			branches: [],
			edges: [],
			summaries: [],
		});
		expect(await loadState(backend, sessionB)).toEqual(stateBBefore);
	});

	it('retains positive history limits independently after reopen', async () => {
		const dbPath = join(root, 'history.db');
		backend = await openBackend(dbPath, 2);
		for (const number of [1, 2, 3]) {
			await backend.saveThoughtForSession(
				sessionA,
				createTestThought({ id: `A-${number}`, session_id: sessionA, thought_number: number })
			);
			await backend.saveThoughtForSession(
				sessionB,
				createTestThought({ id: `B-${number}`, session_id: sessionB, thought_number: number })
			);
		}

		await closeBackend();
		backend = await openBackend(dbPath, 2);

		expect((await backend.loadHistoryForSession(sessionA)).map(({ id }) => id)).toEqual([
			'A-2',
			'A-3',
		]);
		expect((await backend.loadHistoryForSession(sessionB)).map(({ id }) => id)).toEqual([
			'B-2',
			'B-3',
		]);
	});

	it('rejects conflicting stable identity without losing the admitted row after reopen', async () => {
		const dbPath = join(root, 'history.db');
		const admitted = createTestThought({
			id: 'stable-id',
			session_id: sessionA,
			thought_number: 1,
		});
		const conflict = createTestThought({
			id: 'stable-id',
			session_id: sessionA,
			thought_number: 2,
		});
		backend = await openBackend(dbPath, 1);
		await backend.saveThoughtForSession(sessionA, admitted);

		await expect(backend.saveThoughtForSession(sessionA, conflict)).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
		await closeBackend();
		backend = await openBackend(dbPath, 1);

		expect(await backend.loadHistoryForSession(sessionA)).toEqual([admitted]);
	});

	it('preserves integrity and file-backed WAL mode after public close', async () => {
		const dbPath = join(root, 'history.db');
		backend = await openBackend(dbPath);
		await saveState(backend, namespaceState('durable', sessionA));
		await closeBackend();

		const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			expect(inspection.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
			expect(inspection.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
		} finally {
			inspection.close();
		}
	});
});
