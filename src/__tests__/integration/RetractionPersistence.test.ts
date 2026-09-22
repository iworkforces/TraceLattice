import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import { asBranchId, asSessionId, asThoughtId } from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import type { ThoughtData } from '../../core/thought.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { nodeFileWriterOperations } from '../../persistence/FileWriter.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { SqlitePersistence } from '../../persistence/SqlitePersistence.js';
import { createTestThought } from '../helpers/factories.js';
import { StatefulSqliteDatabase } from '../helpers/StatefulSqliteDatabase.js';

type ReopenFixture = {
	readonly name: string;
	readonly create: (maxHistorySize?: number) => Promise<{
		readonly backend: PersistenceBackend;
		readonly reopen: () => Promise<PersistenceBackend>;
		readonly cleanup: () => Promise<void>;
	}>;
};

const sessionId = asSessionId('atomic-retraction');
const branchId = asBranchId('atomic-branch');

function target(overrides: Partial<ThoughtData> = {}): ThoughtData {
	return createTestThought({
		id: 'target-id',
		session_id: sessionId,
		thought: 'target',
		thought_number: 1,
		branch_id: branchId,
		...overrides,
	});
}

function backtrack(id: string, number = 2): ThoughtData {
	return createTestThought({
		id,
		session_id: sessionId,
		thought: `backtrack ${id}`,
		thought_number: number,
		thought_type: 'backtrack',
		backtrack_target: 1,
	});
}

const fixtures: readonly ReopenFixture[] = [
	{
		name: 'Memory',
		create: async (maxHistorySize) => {
			const backend = new MemoryPersistence({ maxHistorySize });
			return {
				backend,
				reopen: async () => backend,
				cleanup: async () => await backend.close(),
			};
		},
	},
	{
		name: 'File',
		create: async (maxHistorySize) => {
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-retraction-file-'));
			let current = await FilePersistence.create({ dataDir, maxHistorySize });
			return {
				backend: current,
				reopen: async () => {
					await current.close();
					current = await FilePersistence.create({ dataDir, maxHistorySize });
					return current;
				},
				cleanup: async () => {
					await current.close();
					await rm(dataDir, { recursive: true, force: true });
				},
			};
		},
	},
];

describe.each(fixtures)('$name atomic retraction persistence', ({ create }) => {
	it('publishes the backtrack and every retained target copy as one operation', async () => {
		const fixture = await create();
		try {
			const retainedTarget = target();
			const correction = backtrack('backtrack-id');
			await fixture.backend.saveThoughtForSession(sessionId, retainedTarget);
			await fixture.backend.saveBranchForSession(sessionId, branchId, [retainedTarget]);

			await fixture.backend.saveBacktrackForSession(
				sessionId,
				correction,
				asThoughtId('target-id')
			);
			const reopened = await fixture.reopen();

			expect(await reopened.loadHistoryForSession(sessionId)).toEqual([
				{ ...retainedTarget, retracted: true },
				correction,
			]);
			expect(await reopened.loadBranchForSession(sessionId, branchId)).toEqual([
				{ ...retainedTarget, retracted: true },
			]);
		} finally {
			await fixture.cleanup();
		}
	});

	it('appends when durable retention has removed every target copy', async () => {
		const fixture = await create(1);
		try {
			await fixture.backend.saveThoughtForSession(sessionId, target({ branch_id: undefined }));
			const retained = createTestThought({
				id: 'retained-id',
				session_id: sessionId,
				thought_number: 2,
			});
			await fixture.backend.saveThoughtForSession(sessionId, retained);
			const correction = backtrack('evicted-backtrack', 3);

			await fixture.backend.saveBacktrackForSession(
				sessionId,
				correction,
				asThoughtId('target-id')
			);

			expect(await fixture.backend.loadHistoryForSession(sessionId)).toEqual([correction]);
		} finally {
			await fixture.cleanup();
		}
	});

	it('corrects a branch-only target across repeated and evicted backtracks', async () => {
		const fixture = await create(1);
		try {
			const retainedTarget = target();
			await fixture.backend.saveThoughtForSession(sessionId, retainedTarget);
			await fixture.backend.saveBranchForSession(sessionId, branchId, [retainedTarget]);
			await fixture.backend.saveThoughtForSession(
				sessionId,
				createTestThought({ id: 'newer-id', session_id: sessionId, thought_number: 2 })
			);
			const first = backtrack('first-backtrack', 3);
			const second = backtrack('second-backtrack', 4);

			await fixture.backend.saveBacktrackForSession(sessionId, first, asThoughtId('target-id'));
			await fixture.backend.saveBacktrackForSession(sessionId, second, asThoughtId('target-id'));
			const afterBacktracks = createTestThought({
				id: 'after-backtracks',
				session_id: sessionId,
				thought_number: 5,
			});
			await fixture.backend.saveThoughtForSession(sessionId, afterBacktracks);

			expect(await fixture.backend.loadHistoryForSession(sessionId)).toEqual([afterBacktracks]);
			expect(await fixture.backend.loadBranchForSession(sessionId, branchId)).toEqual([
				{ ...retainedTarget, retracted: true },
			]);
		} finally {
			await fixture.cleanup();
		}
	});
});

describe('HistoryManager atomic backtrack pipeline', () => {
	it('corrects an already-flushed branch-only target without DAG storage', async () => {
		const persistence = new MemoryPersistence({ maxHistorySize: 1 });
		const manager = new HistoryManager({
			persistence,
			maxHistorySize: 1,
			persistenceHistorySize: 1,
			persistenceBufferSize: 100,
			persistenceFlushInterval: 60_000,
		});
		try {
			manager.addThought(
				createTestThought({ id: 'pipeline-root', session_id: sessionId, thought_number: 1 })
			);
			const retainedTarget = createTestThought({
				id: 'pipeline-target',
				session_id: sessionId,
				thought_number: 2,
				branch_id: branchId,
				branch_from_thought: 1,
			});
			manager.addThought(retainedTarget);
			manager.addThought(
				createTestThought({ id: 'pipeline-newer', session_id: sessionId, thought_number: 3 })
			);
			await manager._flushBuffer();

			const correction = createTestThought({
				id: 'pipeline-backtrack',
				session_id: sessionId,
				thought_number: 4,
				thought_type: 'backtrack',
				backtrack_target: 2,
			});
			manager.addThought(correction);
			await manager._flushBuffer();

			expect(await persistence.loadHistoryForSession(sessionId)).toEqual([correction]);
			expect(await persistence.loadBranchForSession(sessionId, branchId)).toEqual([
				{ ...retainedTarget, retracted: true },
			]);
		} finally {
			await manager.shutdown();
		}
	});
});

describe('atomic publication failures', () => {
	it('leaves prior file bytes intact when publication fails before replacement', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-retraction-failure-'));
		let failReplacement = false;
		const backend = await FilePersistence.create({
			dataDir,
			writerOperations: {
				...nodeFileWriterOperations,
				rename: async (source, destination) => {
					if (failReplacement) throw new Error('injected replacement failure');
					await nodeFileWriterOperations.rename(source, destination);
				},
			},
		});
		try {
			await backend.saveThoughtForSession(sessionId, target({ branch_id: undefined }));
			const snapshotPath = join(dataDir, 'snapshot.json');
			const before = await readFile(snapshotPath, 'utf8');
			failReplacement = true;

			await expect(
				backend.saveBacktrackForSession(
					sessionId,
					backtrack('failed-backtrack'),
					asThoughtId('target-id')
				)
			).rejects.toMatchObject({ code: 'PERSISTENCE_PUBLICATION' });

			expect(await readFile(snapshotPath, 'utf8')).toBe(before);
		} finally {
			await backend.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('rolls back every SQLite correction when commit fails', async () => {
		const database = new StatefulSqliteDatabase();
		const backend = SqlitePersistence.createWithDatabase(database);
		await backend.saveThoughtForSession(sessionId, target());
		await backend.saveBranchForSession(sessionId, branchId, [target()]);
		const before = database.snapshot();
		database.failNextCommit();

		await expect(
			backend.saveBacktrackForSession(
				sessionId,
				backtrack('failed-sqlite-backtrack'),
				asThoughtId('target-id')
			)
		).rejects.toThrow('COMMIT');

		expect(database.snapshot()).toEqual(before);
	});
});

describe('read-only legacy retraction restore', () => {
	const managers = new Set<HistoryManager>();
	let dataDir: string | undefined;

	afterEach(async () => {
		for (const manager of managers) await manager.shutdown();
		managers.clear();
		if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	});

	it('repairs an unambiguous retained target before live trimming without rewriting file bytes', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-legacy-retraction-'));
		const seed = await FilePersistence.create({ dataDir });
		const retainedTarget = target();
		await seed.saveThoughtForSession(sessionId, retainedTarget);
		await seed.saveBranchForSession(sessionId, branchId, [retainedTarget]);
		await seed.saveThoughtForSession(sessionId, backtrack('legacy-backtrack'));
		await seed.close();
		const snapshotPath = join(dataDir, 'snapshot.json');
		const before = await readFile(snapshotPath, 'utf8');
		const persistence = await FilePersistence.create({ dataDir });
		const manager = new HistoryManager({
			persistence,
			maxHistorySize: 1,
			persistenceFlushInterval: 60_000,
		});
		managers.add(manager);

		await manager.loadFromPersistence();

		expect(manager.getBranches(sessionId)[branchId]).toEqual([
			{ ...retainedTarget, retracted: true },
		]);
		expect(await readFile(snapshotPath, 'utf8')).toBe(before);
	});

	it('ignores an absent target and preserves an explicit retained retraction', async () => {
		const persistence = new MemoryPersistence();
		const explicit = target({ retracted: true });
		await persistence.saveBranchForSession(sessionId, branchId, [explicit]);
		await persistence.saveThoughtForSession(sessionId, backtrack('absent-backtrack'));
		const manager = new HistoryManager({ persistence, persistenceFlushInterval: 60_000 });
		managers.add(manager);

		await manager.loadFromPersistence();

		expect(manager.getBranches(sessionId)[branchId]).toEqual([explicit]);
	});

	it('fails closed on an ambiguous retained target without replacing live state', async () => {
		const persistence = new MemoryPersistence();
		await persistence.saveThoughtForSession(
			sessionId,
			createTestThought({ id: 'ambiguous-a', session_id: sessionId, thought_number: 1 })
		);
		await persistence.saveThoughtForSession(
			sessionId,
			createTestThought({ id: 'ambiguous-b', session_id: sessionId, thought_number: 1 })
		);
		await persistence.saveThoughtForSession(sessionId, backtrack('ambiguous-backtrack'));
		const manager = new HistoryManager({ persistence, persistenceFlushInterval: 60_000 });
		managers.add(manager);
		const liveSession = asSessionId('live-before-failed-restore');
		manager.addThought(createTestThought({ id: 'live-id', session_id: liveSession }));

		await expect(manager.loadFromPersistence()).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});

		expect(manager.getHistory(liveSession).map((thought) => thought.id)).toEqual(['live-id']);
	});
});
