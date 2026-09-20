import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asThoughtId,
	type SessionId,
} from '../../contracts/ids.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { Edge } from '../../core/graph/Edge.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { nodeFileWriterOperations } from '../../persistence/FileWriter.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought } from '../helpers/factories.js';

type BackendFixture = {
	readonly name: string;
	readonly create: (maxHistorySize?: number) => Promise<PersistenceBackend>;
	readonly cleanup: (backend: PersistenceBackend) => Promise<void>;
};

type ManagedBackendFixture = {
	readonly name: string;
	readonly create: () => Promise<{
		readonly backend: PersistenceBackend;
		readonly publicationCount: () => number;
		readonly cleanup: () => Promise<void>;
	}>;
};

const sessionA = asSessionId('session-A');
const sessionB = asSessionId('session-B');
const sharedBranch = asBranchId('shared');

function thought(id: string, sessionId: SessionId, number: number, branch = false) {
	return createTestThought({
		id,
		session_id: sessionId,
		thought: id,
		thought_number: number,
		total_thoughts: 3,
		...(branch ? { branch_id: sharedBranch } : {}),
	});
}

function edge(id: string, sessionId: SessionId): Edge {
	return {
		id: asEdgeId(id),
		from: asThoughtId(`${id}-from`),
		to: asThoughtId(`${id}-to`),
		kind: 'sequence',
		sessionId,
		createdAt: 1,
	};
}

function summary(id: string, sessionId: SessionId): Summary {
	return {
		id,
		sessionId,
		rootThoughtId: asThoughtId(`${id}-root`),
		coveredIds: [asThoughtId(`${id}-root`)],
		coveredRange: [1, 1],
		topics: ['persistence'],
		aggregateConfidence: 1,
		createdAt: 1,
	};
}

const fixtures: readonly BackendFixture[] = [
	{
		name: 'Memory',
		create: async (maxHistorySize = 2) => new MemoryPersistence({ maxSize: maxHistorySize }),
		cleanup: async (backend) => await backend.close(),
	},
	{
		name: 'File',
		create: async (maxHistorySize = 2) => {
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-file-'));
			return await FilePersistence.create({ dataDir, maxHistorySize });
		},
		cleanup: async (backend) => {
			const dataDir = (backend as FilePersistence).getDataDir();
			await backend.close();
			await rm(dataDir, { recursive: true, force: true });
		},
	},
];

const disabledBranchFixtures: readonly ManagedBackendFixture[] = [
	{
		name: 'Memory',
		create: async () => {
			const backend = new MemoryPersistence({ persistBranches: false });
			return {
				backend,
				publicationCount: () => 0,
				cleanup: async () => await backend.close(),
			};
		},
	},
	{
		name: 'File',
		create: async () => {
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-disabled-branches-'));
			let publications = 0;
			const backend = await FilePersistence.create({
				dataDir,
				persistBranches: false,
				writerOperations: {
					...nodeFileWriterOperations,
					writeExclusiveUtf8: async (path, content) => {
						if (path.endsWith('.tmp')) publications += 1;
						await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
					},
				},
			});
			return {
				backend,
				publicationCount: () => publications,
				cleanup: async () => {
					await backend.close();
					await rm(dataDir, { recursive: true, force: true });
				},
			};
		},
	},
];

const duplicateDisabledBranchThought = thought('disabled-duplicate', sessionA, 1, true);
const missingIdDisabledBranchThought = createTestThought({
	id: 'disabled-missing-id',
	session_id: sessionA,
	branch_id: sharedBranch,
});
Reflect.deleteProperty(missingIdDisabledBranchThought, 'id');
const disabledBranchValidationCases = [
	{
		name: 'session mismatch',
		thoughts: [thought('disabled-wrong-session', sessionB, 1, true)],
		code: 'PERSISTENCE_SCOPE_MISMATCH',
	},
	{
		name: 'branch mismatch',
		thoughts: [
			createTestThought({
				id: 'disabled-wrong-branch',
				session_id: sessionA,
				branch_id: asBranchId('another-branch'),
			}),
		],
		code: 'PERSISTENCE_SCOPE_MISMATCH',
	},
	{
		name: 'missing thought ID',
		thoughts: [missingIdDisabledBranchThought],
		code: 'PERSISTENCE_COMPATIBILITY',
	},
	{
		name: 'duplicate candidate IDs',
		thoughts: [duplicateDisabledBranchThought, duplicateDisabledBranchThought],
		code: 'PERSISTENCE_COMPATIBILITY',
	},
] as const;

describe.each(fixtures)('$name session-scoped persistence conformance', ({ create, cleanup }) => {
	it('rejects a conflicting retained-boundary identity before evicting prior history', async () => {
		const backend = await create(1);
		try {
			// Given
			const admitted = thought('retention-boundary-id', sessionA, 1);
			const conflict = thought('retention-boundary-id', sessionA, 2);
			await backend.saveThoughtForSession(sessionA, admitted);

			// When / Then
			await expect(backend.saveThoughtForSession(sessionA, conflict)).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
			expect(await backend.loadHistoryForSession(sessionA)).toEqual([admitted]);
		} finally {
			await cleanup(backend);
		}
	});

	it('trims only the oldest admitted thought when positive retention is exceeded', async () => {
		const backend = await create();
		try {
			// Given
			const admitted = [
				thought('oldest-admitted', sessionA, 30),
				thought('middle-admitted', sessionA, 10),
				thought('newest-admitted', sessionA, 20),
			];

			// When
			for (const candidate of admitted) await backend.saveThoughtForSession(sessionA, candidate);

			// Then
			expect((await backend.loadHistoryForSession(sessionA)).map(({ id }) => id)).toEqual([
				'middle-admitted',
				'newest-admitted',
			]);
		} finally {
			await cleanup(backend);
		}
	});

	it('applies positive retention independently to each session', async () => {
		const backend = await create();
		try {
			// Given
			const sessionAThoughts = [1, 2, 3].map((number) =>
				thought(`retained-A-${number}`, sessionA, number)
			);
			const sessionBThoughts = [1, 2].map((number) =>
				thought(`retained-B-${number}`, sessionB, number)
			);

			// When
			for (const candidate of sessionAThoughts)
				await backend.saveThoughtForSession(sessionA, candidate);
			for (const candidate of sessionBThoughts)
				await backend.saveThoughtForSession(sessionB, candidate);

			// Then
			expect({
				sessionA: (await backend.loadHistoryForSession(sessionA)).map(({ id }) => id),
				sessionB: (await backend.loadHistoryForSession(sessionB)).map(({ id }) => id),
			}).toEqual({
				sessionA: ['retained-A-2', 'retained-A-3'],
				sessionB: ['retained-B-1', 'retained-B-2'],
			});
		} finally {
			await cleanup(backend);
		}
	});

	it('isolates matching branch IDs and applies retention independently', async () => {
		const backend = await create();
		try {
			for (let number = 1; number <= 3; number++) {
				await backend.saveThoughtForSession(sessionA, thought(`A-${number}`, sessionA, number));
				await backend.saveThoughtForSession(sessionB, thought(`B-${number}`, sessionB, number));
			}
			await backend.saveBranchForSession(sessionA, sharedBranch, [
				thought('A-branch', sessionA, 1, true),
			]);
			await backend.saveBranchForSession(sessionB, sharedBranch, [
				thought('B-branch', sessionB, 1, true),
			]);

			expect((await backend.loadHistoryForSession(sessionA)).map(({ id }) => id)).toEqual([
				'A-2',
				'A-3',
			]);
			expect((await backend.loadHistoryForSession(sessionB)).map(({ id }) => id)).toEqual([
				'B-2',
				'B-3',
			]);
			expect((await backend.loadBranchForSession(sessionA, sharedBranch))?.[0]?.id).toBe(
				'A-branch'
			);
			expect((await backend.loadBranchForSession(sessionB, sharedBranch))?.[0]?.id).toBe(
				'B-branch'
			);
		} finally {
			await cleanup(backend);
		}
	});

	it('deletes one branch idempotently without changing sibling or matching-session branches', async () => {
		const backend = await create();
		const siblingBranch = asBranchId('sibling');
		try {
			await backend.saveBranchForSession(sessionA, sharedBranch, [
				thought('A-shared', sessionA, 1, true),
			]);
			await backend.saveBranchForSession(sessionA, siblingBranch, []);
			await backend.saveBranchForSession(sessionB, sharedBranch, [
				thought('B-shared', sessionB, 1, true),
			]);

			await backend.deleteBranchForSession(sessionA, sharedBranch);
			await backend.deleteBranchForSession(sessionA, sharedBranch);

			expect(await backend.loadBranchForSession(sessionA, sharedBranch)).toBeUndefined();
			expect(await backend.loadBranchForSession(sessionA, siblingBranch)).toEqual([]);
			expect(await backend.loadBranchForSession(sessionB, sharedBranch)).toHaveLength(1);
			expect(await backend.listBranchesForSession(sessionA)).toEqual([siblingBranch]);
		} finally {
			await cleanup(backend);
		}
	});

	it('distinguishes scoped branch deletion from saving an empty branch', async () => {
		const backend = await create();
		try {
			await backend.saveBranchForSession(sessionA, sharedBranch, []);
			expect(await backend.loadBranchForSession(sessionA, sharedBranch)).toEqual([]);

			await backend.deleteBranchForSession(sessionA, sharedBranch);
			await backend.deleteBranchForSession(sessionA, sharedBranch);

			expect(await backend.loadBranchForSession(sessionA, sharedBranch)).toBeUndefined();
			expect(await backend.listBranchesForSession(sessionA)).toEqual([]);
		} finally {
			await cleanup(backend);
		}
	});

	it('enumerates summary-only and explicitly empty-branch sessions in code-point order', async () => {
		const backend = await create();
		const summaryOnly = asSessionId('C-summary');
		const emptyBranch = asSessionId('D-empty');
		try {
			await backend.saveSummaries(summaryOnly, [summary('summary-C', summaryOnly)]);
			await backend.saveBranchForSession(emptyBranch, sharedBranch, []);

			expect(await backend.listSessions()).toEqual([summaryOnly, emptyBranch]);
		} finally {
			await cleanup(backend);
		}
	});

	it('clears one session across every namespace while preserving another', async () => {
		const backend = await create();
		try {
			for (const sessionId of [sessionA, sessionB]) {
				await backend.saveThoughtForSession(
					sessionId,
					thought(`${sessionId}-history`, sessionId, 1)
				);
				await backend.saveBranchForSession(sessionId, sharedBranch, [
					thought(`${sessionId}-branch`, sessionId, 1, true),
				]);
				await backend.saveEdges(sessionId, [edge(`${sessionId}-edge`, sessionId)]);
				await backend.saveSummaries(sessionId, [summary(`${sessionId}-summary`, sessionId)]);
			}

			await backend.clearSession(sessionA);

			expect(await backend.loadHistoryForSession(sessionA)).toEqual([]);
			expect(await backend.loadBranchForSession(sessionA, sharedBranch)).toBeUndefined();
			expect(await backend.loadEdges(sessionA)).toEqual([]);
			expect(await backend.loadSummaries(sessionA)).toEqual([]);
			expect(await backend.loadHistoryForSession(sessionB)).toHaveLength(1);
			expect(await backend.loadBranchForSession(sessionB, sharedBranch)).toHaveLength(1);
			expect(await backend.loadEdges(sessionB)).toHaveLength(1);
			expect(await backend.loadSummaries(sessionB)).toHaveLength(1);
		} finally {
			await cleanup(backend);
		}
	});

	it('clears the whole store explicitly', async () => {
		const backend = await create();
		try {
			await backend.saveThoughtForSession(sessionA, thought('A-history', sessionA, 1));
			await backend.saveBranchForSession(sessionB, sharedBranch, []);
			await backend.saveEdges(sessionB, [edge('B-edge', sessionB)]);
			await backend.saveSummaries(sessionA, [summary('A-summary', sessionA)]);

			await backend.clearAll();

			expect(await backend.listSessions()).toEqual([]);
		} finally {
			await cleanup(backend);
		}
	});

	it('rejects payload ownership mismatches without changing either session', async () => {
		const backend = await create();
		try {
			await expect(
				backend.saveThoughtForSession(sessionA, thought('wrong', sessionB, 1))
			).rejects.toMatchObject({
				code: 'PERSISTENCE_SCOPE_MISMATCH',
			});
			await expect(
				backend.saveBranchForSession(sessionA, sharedBranch, [
					createTestThought({
						id: 'wrong-branch',
						session_id: sessionA,
						branch_id: asBranchId('another-branch'),
					}),
				])
			).rejects.toMatchObject({ code: 'PERSISTENCE_SCOPE_MISMATCH' });
			expect(await backend.listSessions()).toEqual([]);
		} finally {
			await cleanup(backend);
		}
	});

	it('rejects a thought missing its nested session before creating state', async () => {
		const backend = await create();
		try {
			// Given
			const candidate = thought('missing-session', sessionA, 1);
			Reflect.deleteProperty(candidate, 'session_id');

			// When / Then
			await expect(backend.saveThoughtForSession(sessionA, candidate)).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
			});
			expect(await backend.listSessions()).toEqual([]);
		} finally {
			await cleanup(backend);
		}
	});

	it('rejects a retired nested thought session before creating state', async () => {
		const backend = await create();
		try {
			// Given
			const candidate = thought('retired-session', sessionA, 1);
			Reflect.set(candidate, 'session_id', '__global__');

			// When / Then
			await expect(backend.saveThoughtForSession(sessionA, candidate)).rejects.toMatchObject({
				code: 'VALIDATION_ERROR',
			});
			expect(await backend.listSessions()).toEqual([]);
		} finally {
			await cleanup(backend);
		}
	});
});

describe.each(disabledBranchFixtures)(
	'$name disabled branch persistence conformance',
	({ create }) => {
		it('rejects a disabled branch identity conflict without publishing or creating branch state', async () => {
			const { backend, publicationCount, cleanup } = await create();
			try {
				// Given
				const admitted = thought('disabled-history-conflict', sessionA, 1);
				const conflict = thought('disabled-history-conflict', sessionA, 1, true);
				await backend.saveThoughtForSession(sessionA, admitted);
				const publicationsBefore = publicationCount();
				let rejectionCode: unknown;

				// When
				try {
					await backend.saveBranchForSession(sessionA, sharedBranch, [conflict]);
				} catch (error) {
					if (error instanceof Error && 'code' in error) rejectionCode = error.code;
				}

				// Then
				expect({
					rejectionCode,
					history: await backend.loadHistoryForSession(sessionA),
					branch: await backend.loadBranchForSession(sessionA, sharedBranch),
					branches: await backend.listBranchesForSession(sessionA),
					sessions: await backend.listSessions(),
					publicationsBefore,
					publicationsAfter: publicationCount(),
				}).toEqual({
					rejectionCode: 'PERSISTENCE_COMPATIBILITY',
					history: [admitted],
					branch: undefined,
					branches: [],
					sessions: [sessionA],
					publicationsBefore,
					publicationsAfter: publicationsBefore,
				});
			} finally {
				await cleanup();
			}
		});

		it.each(disabledBranchValidationCases)(
			'rejects $name before no-op',
			async ({ thoughts, code }) => {
				const { backend, cleanup } = await create();
				try {
					// Given
					const branchId = sharedBranch;

					// When / Then
					await expect(
						backend.saveBranchForSession(sessionA, branchId, thoughts)
					).rejects.toMatchObject({ code });
				} finally {
					await cleanup();
				}
			}
		);

		it('keeps valid input as a no-op without creating branch or session material', async () => {
			const { backend, cleanup } = await create();
			try {
				// Given
				const candidate = thought('disabled-valid', sessionA, 1, true);

				// When
				await backend.saveBranchForSession(sessionA, sharedBranch, [candidate]);

				// Then
				expect({
					branch: await backend.loadBranchForSession(sessionA, sharedBranch),
					branches: await backend.listBranchesForSession(sessionA),
					sessions: await backend.listSessions(),
				}).toEqual({ branch: undefined, branches: [], sessions: [] });
			} finally {
				await cleanup();
			}
		});
	}
);
