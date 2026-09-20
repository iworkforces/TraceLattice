import { once } from 'node:events';
import { watch } from 'node:fs';
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { asSessionId } from '../../contracts/ids.js';
import {
	PersistenceClosedError,
	PersistenceCorruptionError,
	PersistencePublicationError,
} from '../../errors.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { parseFileSnapshotV2 } from '../../persistence/FileSnapshotV2.js';
import { nodeFileWriterOperations } from '../../persistence/FileWriter.js';
import { assertNever } from '../../utils.js';
import { createTestThought as createBaseTestThought } from '../helpers/factories.js';

let persistentThoughtSequence = 0;
function createTestThought(overrides: Parameters<typeof createBaseTestThought>[0] = {}) {
	persistentThoughtSequence += 1;
	return createBaseTestThought({ id: `file-writer-${persistentThoughtSequence}`, ...overrides });
}

const TEST_SESSION_ID = asSessionId('test-session');

const CHILD_DIRECTORY = process.env['TRACELATTICE_FILE_WRITER_CHILD_DIR'];
const CHILD_READY = 'TRACELATTICE_FILE_WRITER_READY';

function startChildOwner(dataDir: string) {
	const vitestPath = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
	const child = spawn(
		process.execPath,
		[
			vitestPath,
			'run',
			'--config',
			'vitest.config.ts',
			'src/__tests__/integration/FileWriterOwnership.test.ts',
		],
		{
			cwd: process.cwd(),
			env: { ...process.env, TRACELATTICE_FILE_WRITER_CHILD_DIR: dataDir },
			stdio: 'pipe',
		}
	);
	const childExit = once(child, 'exit');
	let childOutput = '';
	const childReady = new Promise<void>((resolveReady, rejectReady) => {
		child.stdout.on('data', (chunk: Buffer) => {
			childOutput += chunk.toString('utf-8');
			if (childOutput.includes(CHILD_READY)) {
				resolveReady();
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			childOutput += chunk.toString('utf-8');
		});
		child.once('error', rejectReady);
		child.once('exit', (code) => {
			if (!childOutput.includes(CHILD_READY)) {
				rejectReady(new Error(`Child writer exited ${code}: ${childOutput}`));
			}
		});
	});
	return { child, childExit, childReady };
}

if (CHILD_DIRECTORY) {
	describe('FilePersistence child writer fixture', () => {
		it('holds directory ownership until its parent publishes the release marker', async () => {
			// Given
			const backend = new FilePersistence({ dataDir: CHILD_DIRECTORY });
			const watcher = watch(CHILD_DIRECTORY);

			// When
			await backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ thought: 'child-owned' })
			);
			process.stdout.write(`${CHILD_READY}\n`);
			try {
				while (true) {
					const [, filename] = await once(watcher, 'change');
					if (filename === '.release') {
						break;
					}
				}
			} finally {
				watcher.close();
			}

			// Then
			await backend.close();
		});
	});
} else {
	describe('FilePersistence writer ownership', () => {
		it('retains every acknowledged concurrent direct save', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-concurrent-save-'));
			const backend = new FilePersistence({ dataDir, maxHistorySize: 64 });
			const thoughts = Array.from({ length: 32 }, (_, index) =>
				createTestThought({
					id: `concurrent-${index}`,
					thought: `concurrent-${index}`,
					thought_number: index + 1,
					total_thoughts: 32,
				})
			);

			try {
				// When
				await Promise.all(
					thoughts.map((thought) => backend.saveThoughtForSession(TEST_SESSION_ID, thought))
				);

				// Then
				const recovered = await backend.loadHistoryForSession(TEST_SESSION_ID);
				expect(new Set(recovered.map((thought) => thought.id))).toEqual(
					new Set(thoughts.map((thought) => thought.id))
				);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('orders clear after an already accepted save', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-clear-order-'));
			const backend = new FilePersistence({ dataDir });

			try {
				// When
				const acceptedSave = backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'before-clear' })
				);
				await backend.clearAll();
				await acceptedSave;

				// Then
				expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toEqual([]);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('rejects a second live backend for the same directory', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-two-writers-'));
			const owner = new FilePersistence({ dataDir });
			const competitor = new FilePersistence({ dataDir });

			try {
				await owner.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'owner' }));

				// When / Then
				await expect(
					competitor.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'competitor' }))
				).rejects.toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
			} finally {
				await competitor.close();
				await owner.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('allows only one of two simultaneous acquisitions', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-simultaneous-owners-'));
			const outcomes = await Promise.allSettled([
				FilePersistence.create({ dataDir }),
				FilePersistence.create({ dataDir }),
			]);
			const owners: FilePersistence[] = [];
			const rejections: unknown[] = [];

			try {
				// When
				for (const outcome of outcomes) {
					switch (outcome.status) {
						case 'fulfilled':
							owners.push(outcome.value);
							break;
						case 'rejected':
							rejections.push(outcome.reason);
							break;
						default:
							assertNever(outcome);
					}
				}

				// Then
				expect(owners).toHaveLength(1);
				expect(rejections).toHaveLength(1);
				expect(rejections[0]).toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
			} finally {
				await Promise.all(owners.map(async (owner) => await owner.close()));
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('does not let a failed competitor close remove the active owner lock', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-failed-owner-'));
			const owner = new FilePersistence({ dataDir });
			const firstCompetitor = new FilePersistence({ dataDir });
			await owner.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'owner' }));

			try {
				await expect(firstCompetitor.loadHistoryForSession(TEST_SESSION_ID)).rejects.toMatchObject({
					code: 'PERSISTENCE_OWNERSHIP',
				});
				await firstCompetitor.close();
				const secondCompetitor = new FilePersistence({ dataDir });

				// When / Then
				await expect(secondCompetitor.loadHistoryForSession(TEST_SESSION_ID)).rejects.toMatchObject(
					{
						code: 'PERSISTENCE_OWNERSHIP',
					}
				);
				await secondCompetitor.close();
			} finally {
				await firstCompetitor.close();
				await owner.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('treats canonical path aliases as one owned directory', async () => {
			// Given
			const root = await mkdtemp(join(tmpdir(), 'tracelattice-path-alias-'));
			const dataDir = join(root, 'data');
			const alias = join(root, 'alias');
			await mkdir(dataDir);
			await symlink(dataDir, alias, 'dir');
			const owner = new FilePersistence({ dataDir });
			const competitor = new FilePersistence({ dataDir: alias });

			try {
				await owner.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'canonical-owner' })
				);

				// When / Then
				await expect(
					competitor.saveThoughtForSession(
						TEST_SESSION_ID,
						createTestThought({ id: 'alias-competitor' })
					)
				).rejects.toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
			} finally {
				await competitor.close();
				await owner.close();
				await rm(root, { recursive: true, force: true });
			}
		});

		it('rejects a competing writer held by another process', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-process-owner-'));
			const { childExit, childReady } = startChildOwner(dataDir);
			const competitor = new FilePersistence({ dataDir });

			try {
				await childReady;

				// When / Then
				await expect(
					competitor.saveThoughtForSession(
						TEST_SESSION_ID,
						createTestThought({ id: 'parent-competitor' })
					)
				).rejects.toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
			} finally {
				await competitor.close();
				await writeFile(join(dataDir, '.release'), '', 'utf-8');
				await childExit;
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('rejects a stale lock left by a killed owner process', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-killed-owner-'));
			const { child, childExit, childReady } = startChildOwner(dataDir);

			try {
				await childReady;
				child.kill('SIGKILL');
				const [exitCode, signal] = await childExit;
				expect(exitCode).toBeNull();
				expect(signal).toBe('SIGKILL');

				// When / Then
				await expect(FilePersistence.create({ dataDir })).rejects.toMatchObject({
					code: 'PERSISTENCE_OWNERSHIP',
				});
			} finally {
				child.kill('SIGKILL');
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('preserves the previous bytes when a temporary write fails', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-temp-failure-'));
			const seed = new FilePersistence({ dataDir });
			await seed.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'stable' }));
			await seed.close();
			const snapshotPath = join(dataDir, 'snapshot.json');
			const previousBytes = await readFile(snapshotPath, 'utf-8');
			const backend = new FilePersistence({
				dataDir,
				writerOperations: {
					...nodeFileWriterOperations,
					writeExclusiveUtf8: async (path, content) => {
						if (path.endsWith('.tmp')) {
							throw new Error('injected temporary write failure');
						}
						await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
					},
				},
			});

			try {
				// When / Then
				await expect(
					backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'new' }))
				).rejects.toMatchObject({ stage: 'temporary-write' });
				expect(await readFile(snapshotPath, 'utf-8')).toBe(previousBytes);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('preserves the previous bytes when atomic replacement fails', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-rename-failure-'));
			const seed = new FilePersistence({ dataDir });
			await seed.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'stable' }));
			await seed.close();
			const snapshotPath = join(dataDir, 'snapshot.json');
			const previousBytes = await readFile(snapshotPath, 'utf-8');
			const backend = new FilePersistence({
				dataDir,
				writerOperations: {
					...nodeFileWriterOperations,
					rename: async () => {
						throw new Error('injected rename failure');
					},
				},
			});

			try {
				// When / Then
				await expect(
					backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'new' }))
				).rejects.toMatchObject({ stage: 'atomic-replacement' });
				expect(await readFile(snapshotPath, 'utf-8')).toBe(previousBytes);
				expect((await readdir(dataDir)).some((path) => path.endsWith('.tmp'))).toBe(false);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('reports corrupt input without changing its bytes', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-corrupt-input-'));
			const snapshotPath = join(dataDir, 'snapshot.json');
			const corruptBytes = '{not-json';
			await writeFile(snapshotPath, corruptBytes, 'utf-8');
			const backend = new FilePersistence({ dataDir });

			try {
				// When / Then
				await expect(
					backend.saveThoughtForSession(
						TEST_SESSION_ID,
						createTestThought({ id: 'must-not-replace-corruption' })
					)
				).rejects.toBeInstanceOf(PersistenceCorruptionError);
				expect(await readFile(snapshotPath, 'utf-8')).toBe(corruptBytes);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('drains already queued saves before close releases ownership', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-close-queued-'));
			const publicationStarted = Promise.withResolvers<void>();
			const resumePublication = Promise.withResolvers<void>();
			let firstPublication = true;
			const backend = new FilePersistence({
				dataDir,
				writerOperations: {
					...nodeFileWriterOperations,
					writeExclusiveUtf8: async (path, content) => {
						if (firstPublication && path.endsWith('.tmp')) {
							firstPublication = false;
							publicationStarted.resolve();
							await resumePublication.promise;
						}
						await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
					},
				},
			});
			const first = createTestThought({ id: 'queued-1' });
			const second = createTestThought({ id: 'queued-2' });

			try {
				// When
				const firstSave = backend.saveThoughtForSession(TEST_SESSION_ID, first);
				await publicationStarted.promise;
				const secondSave = backend.saveThoughtForSession(TEST_SESSION_ID, second);
				let closeSettled = false;
				const closing = backend.close().then(() => {
					closeSettled = true;
				});
				await Promise.resolve();

				// Then
				expect(closeSettled).toBe(false);
				resumePublication.resolve();
				await Promise.all([firstSave, secondSave, closing]);
				const snapshotPath = join(dataDir, 'snapshot.json');
				const stored = parseFileSnapshotV2(await readFile(snapshotPath, 'utf-8'), snapshotPath);
				expect(stored.thoughts).toEqual([{ sessionId: 'test-session', thoughts: [first, second] }]);
				await expect(
					backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'after-close' }))
				).rejects.toBeInstanceOf(PersistenceClosedError);
			} finally {
				resumePublication.resolve();
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('uses unique sibling temporary files for repeated publication', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-temp-paths-'));
			const temporaryPaths: string[] = [];
			const backend = new FilePersistence({
				dataDir,
				writerOperations: {
					...nodeFileWriterOperations,
					writeExclusiveUtf8: async (path, content) => {
						if (path.endsWith('.tmp')) {
							temporaryPaths.push(path);
						}
						await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
					},
				},
			});

			try {
				// When
				await backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'first-temp' })
				);
				await backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'second-temp' })
				);

				// Then
				expect(new Set(temporaryPaths).size).toBe(2);
				const canonicalDataDir = await realpath(dataDir);
				expect(temporaryPaths.every((path) => dirname(path) === canonicalDataDir)).toBe(true);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('allows a new owner only after the current owner closes', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-owner-cleanup-'));
			const first = new FilePersistence({ dataDir });
			await first.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'first-owner' }));

			try {
				// When
				await first.close();
				const second = new FilePersistence({ dataDir });
				await second.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'second-owner' })
				);

				// Then
				expect(
					(await second.loadHistoryForSession(TEST_SESSION_ID)).map((thought) => thought.id)
				).toEqual(['first-owner', 'second-owner']);
				await second.close();
				expect(await readdir(dataDir)).not.toContain('.tracelattice-writer.lock');
			} finally {
				await first.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('preserves a replacement lock installed after release validates ownership', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-replaced-owner-'));
			const lockPath = join(await realpath(dataDir), '.tracelattice-writer.lock');
			const successorMarker = 'successor.owner';
			const replacementToken = 'successor-owner';
			let replacementInstalled = false;
			const backend = new FilePersistence({
				dataDir,
				writerOperations: {
					...nodeFileWriterOperations,
					unlink: async (path) => {
						if (!replacementInstalled && dirname(path) === lockPath) {
							replacementInstalled = true;
							await nodeFileWriterOperations.unlink(path);
							await nodeFileWriterOperations.rmdir(lockPath);
							await nodeFileWriterOperations.mkdirExclusive(lockPath);
							await writeFile(join(lockPath, successorMarker), replacementToken, 'utf-8');
							return;
						}
						await nodeFileWriterOperations.unlink(path);
					},
				},
			});

			try {
				await backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'replaced-owner' })
				);

				// When
				await backend.close();

				// Then
				expect(await readFile(join(lockPath, successorMarker), 'utf-8')).toBe(replacementToken);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('preserves a successor lock installed before the old owner closes', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-successor-before-close-'));
			const lockPath = join(await realpath(dataDir), '.tracelattice-writer.lock');
			const successorMarker = join(lockPath, 'successor.owner');
			const backend = new FilePersistence({ dataDir });

			try {
				await backend.saveThoughtForSession(
					TEST_SESSION_ID,
					createTestThought({ id: 'old-owner' })
				);
				const ownerMarker = (await readdir(lockPath))[0];
				if (!ownerMarker) {
					throw new Error('Owner marker was not created');
				}
				await nodeFileWriterOperations.unlink(join(lockPath, ownerMarker));
				await nodeFileWriterOperations.rmdir(lockPath);
				await nodeFileWriterOperations.mkdirExclusive(lockPath);
				await writeFile(successorMarker, 'successor-owner', 'utf-8');

				// When
				await backend.close();

				// Then
				expect(await readFile(successorMarker, 'utf-8')).toBe('successor-owner');
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('cleans a failed owner-marker acquisition so a later writer can acquire', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-marker-failure-'));
			const lockPath = join(await realpath(dataDir), '.tracelattice-writer.lock');
			let markerCreationAttempted = false;

			try {
				// When / Then
				await expect(
					FilePersistence.create({
						dataDir,
						writerOperations: {
							...nodeFileWriterOperations,
							writeExclusiveUtf8: async (path, content) => {
								if (dirname(path) === lockPath) {
									markerCreationAttempted = true;
									throw new Error('injected owner marker failure');
								}
								await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
							},
						},
					})
				).rejects.toMatchObject({ code: 'PERSISTENCE_PUBLICATION', stage: 'cleanup' });
				expect(markerCreationAttempted).toBe(true);

				const successor = await FilePersistence.create({ dataDir });
				await successor.close();
				expect(await readdir(dataDir)).not.toContain('.tracelattice-writer.lock');
			} finally {
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('never auto-steals an existing ownership file', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-stale-owner-'));
			const lockPath = join(dataDir, '.tracelattice-writer.lock');
			const existingToken = 'operator-must-remove-this-lock';
			await writeFile(lockPath, existingToken, 'utf-8');

			try {
				// When / Then
				await expect(FilePersistence.create({ dataDir })).rejects.toMatchObject({
					code: 'PERSISTENCE_OWNERSHIP',
				});
				expect(await readFile(lockPath, 'utf-8')).toBe(existingToken);
			} finally {
				await rm(dataDir, { recursive: true, force: true });
			}
		});

		it('exposes typed publication failures', async () => {
			// Given
			const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-typed-publication-'));
			const backend = new FilePersistence({
				dataDir,
				writerOperations: {
					...nodeFileWriterOperations,
					rename: async () => {
						throw new Error('injected rename failure');
					},
				},
			});

			try {
				// When / Then
				await expect(
					backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought())
				).rejects.toBeInstanceOf(PersistencePublicationError);
			} finally {
				await backend.close();
				await rm(dataDir, { recursive: true, force: true });
			}
		});
	});
}
