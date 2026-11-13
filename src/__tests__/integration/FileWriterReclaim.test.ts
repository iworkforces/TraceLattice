import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId } from '../../contracts/ids.js';
import {
	PersistenceCompatibilityError,
	PersistenceOwnershipError,
	PersistencePublicationError,
} from '../../errors.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import {
	FILE_WRITER_LOCK_NAME,
	FILE_WRITER_MARKER_FORMAT,
	FILE_WRITER_MARKER_NAME,
	FileWriter,
	nodeFileWriterOperations,
	type FileWriterOperations,
} from '../../persistence/FileWriter.js';
import { assertNever } from '../../utils.js';
import { createTestThought } from '../helpers/factories.js';

const SESSION = asSessionId('reclaim-session');
const temporaryRoots: string[] = [];
const openBackends: FilePersistence[] = [];

type LockLayout = {
	readonly dataDir: string;
	readonly lockPath: string;
	readonly markerPath: string;
};

async function createLayout(prefix: string): Promise<LockLayout> {
	const dataDir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	temporaryRoots.push(dataDir);
	const lockPath = join(dataDir, FILE_WRITER_LOCK_NAME);
	return { dataDir, lockPath, markerPath: join(lockPath, FILE_WRITER_MARKER_NAME) };
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
	const [code] = await once(child, 'exit');
	expect(code).toBe(0);
	if (child.pid === undefined) throw new Error('Child process has no pid');
	return child.pid;
}

function markerContent(fields: Record<string, unknown>): string {
	return `${JSON.stringify({ format: FILE_WRITER_MARKER_FORMAT, ...fields })}\n`;
}

function staleMarker(pid: number, host = hostname()): string {
	return markerContent({ hostname: host, pid, token: randomUUID() });
}

async function plantLock(layout: LockLayout, marker: string | undefined): Promise<void> {
	await mkdir(layout.lockPath);
	if (marker !== undefined) await writeFile(layout.markerPath, marker, 'utf-8');
}

async function lockState(lockPath: string): Promise<readonly string[]> {
	const entries = (await readdir(lockPath)).sort();
	return Promise.all(
		entries.map(async (entry) => `${entry}=${await readFile(join(lockPath, entry), 'utf-8')}`)
	);
}

async function seedSnapshot(dataDir: string, thought: string): Promise<void> {
	const seed = await FilePersistence.create({ dataDir });
	await seed.saveThoughtForSession(
		SESSION,
		createTestThought({ id: `seed-${thought}`, thought, session_id: SESSION })
	);
	await seed.close();
}

async function create(
	dataDir: string,
	writerOperations?: FileWriterOperations
): Promise<FilePersistence> {
	const backend = await FilePersistence.create(
		writerOperations === undefined ? { dataDir } : { dataDir, writerOperations }
	);
	openBackends.push(backend);
	return backend;
}

function probing(probeProcess: (pid: number) => void): FileWriterOperations {
	return { ...nodeFileWriterOperations, probeProcess };
}

afterEach(async () => {
	await Promise.all(openBackends.splice(0).map(async (backend) => await backend.close()));
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('FileWriter stale lock reclaim', () => {
	it('reclaims a dead same-host owner and restores its snapshot', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-dead-');
		await seedSnapshot(layout.dataDir, 'before-crash');
		await plantLock(layout, staleMarker(await deadPid()));

		// When
		const backend = await create(layout.dataDir);

		// Then
		expect(
			(await backend.loadHistoryForSession(SESSION)).map((thought) => thought.thought)
		).toEqual(['before-crash']);
		expect(await readdir(layout.lockPath)).toEqual([FILE_WRITER_MARKER_NAME]);
		expect(JSON.parse(await readFile(layout.markerPath, 'utf-8'))).toMatchObject({
			format: FILE_WRITER_MARKER_FORMAT,
			hostname: hostname(),
			pid: process.pid,
		});
		await backend.close();
		expect(await readdir(layout.dataDir)).toEqual(['snapshot.json']);
	});

	it.each([
		['a live owner', async () => staleMarker(process.ppid)],
		['this process as owner', async () => staleMarker(process.pid)],
		['another host', async () => staleMarker(await deadPid(), 'another-host.invalid')],
		[
			'a missing hostname',
			async () => markerContent({ pid: await deadPid(), token: randomUUID() }),
		],
		[
			'an empty hostname',
			async () => markerContent({ hostname: '', pid: await deadPid(), token: randomUUID() }),
		],
		[
			'a non-string hostname',
			async () => markerContent({ hostname: 7, pid: await deadPid(), token: randomUUID() }),
		],
		['a legacy pid-only marker', async () => `${await deadPid()}\n`],
		['a zero pid', async () => staleMarker(0)],
		['a negative pid', async () => staleMarker(-1)],
		[
			'an invalid token',
			async () => markerContent({ hostname: hostname(), pid: await deadPid(), token: '../x' }),
		],
		['an unknown marker format', async () => `${JSON.stringify({ pid: await deadPid() })}\n`],
		['malformed JSON', async () => '{"format":'],
		['an empty lock directory', async () => undefined],
	])('fails closed on %s and leaves the lock untouched', async (_label, marker) => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-closed-');
		await plantLock(layout, await marker());
		const before = await lockState(layout.lockPath);

		// When / Then
		await expect(FilePersistence.create({ dataDir: layout.dataDir })).rejects.toMatchObject({
			code: 'PERSISTENCE_OWNERSHIP',
		});
		expect(await lockState(layout.lockPath)).toEqual(before);
	});

	it('fails closed on a legacy lock directory without a current marker', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-legacy-');
		const pid = await deadPid();
		await plantLock(layout, undefined);
		await writeFile(join(layout.lockPath, `${pid}-${randomUUID()}.owner`), `${pid}\n`, 'utf-8');
		const before = await lockState(layout.lockPath);

		// When / Then
		await expect(FilePersistence.create({ dataDir: layout.dataDir })).rejects.toMatchObject({
			code: 'PERSISTENCE_OWNERSHIP',
			ownerPid: undefined,
		});
		expect(await lockState(layout.lockPath)).toEqual(before);
	});

	it('names the lock path and the recorded owner pid in the ownership error', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-message-');
		await plantLock(layout, staleMarker(process.ppid));

		// When
		const failure = await FilePersistence.create({ dataDir: layout.dataDir }).catch(
			(error: unknown) => error
		);

		// Then
		expect(failure).toBeInstanceOf(PersistenceOwnershipError);
		expect(failure).toMatchObject({
			code: 'PERSISTENCE_OWNERSHIP',
			lockPath: layout.lockPath,
			ownerPid: process.ppid,
			message: expect.stringContaining(`(lock '${layout.lockPath}', owner pid ${process.ppid})`),
		});
	});

	it('reports a lock without a readable owner pid', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-no-pid-');
		await plantLock(layout, undefined);

		// When / Then
		await expect(FilePersistence.create({ dataDir: layout.dataDir })).rejects.toThrow(
			`(lock '${layout.lockPath}', no readable owner pid)`
		);
	});

	it.each([
		['EPERM', Object.assign(new Error('kill ESRCH'), { code: 'EPERM', errno: -3 }), false],
		['an unknown code', Object.assign(new Error('No such process'), { code: 'EINVAL' }), false],
		['no code', new Error('ESRCH'), false],
		[
			'ESRCH with a negative errno',
			Object.assign(new Error('x'), { code: 'ESRCH', errno: -3 }),
			true,
		],
		[
			'ESRCH with a positive errno',
			Object.assign(new Error('y'), { code: 'ESRCH', errno: 3 }),
			true,
		],
		['a plain ESRCH object', { code: 'ESRCH' }, true],
	])('decides liveness from the probe error code only: %s', async (_label, thrown, reclaims) => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-probe-');
		await plantLock(layout, staleMarker(424242));
		const before = await lockState(layout.lockPath);
		const operations = probing(() => {
			throw thrown;
		});

		// When
		const outcome = await create(layout.dataDir, operations).then(
			() => 'owner',
			(error: unknown) => error
		);

		// Then
		if (reclaims) {
			expect(outcome).toBe('owner');
			expect(JSON.parse(await readFile(layout.markerPath, 'utf-8'))).toMatchObject({
				pid: process.pid,
			});
			return;
		}
		expect(outcome).toMatchObject({ code: 'PERSISTENCE_OWNERSHIP', ownerPid: 424242 });
		expect(await lockState(layout.lockPath)).toEqual(before);
	});
});

describe('FileWriter stale lock races', () => {
	it('lets exactly one of two simultaneous reclaimers own the lock', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-race-');
		await plantLock(layout, staleMarker(await deadPid()));

		// When
		const outcomes = await Promise.allSettled([create(layout.dataDir), create(layout.dataDir)]);

		// Then
		const owners: FilePersistence[] = [];
		const rejections: unknown[] = [];
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
		expect(owners).toHaveLength(1);
		expect(rejections).toEqual([expect.objectContaining({ code: 'PERSISTENCE_OWNERSHIP' })]);
		expect(await readdir(layout.lockPath)).toEqual([FILE_WRITER_MARKER_NAME]);
	});

	it('rejects a late reclaimer that read the stale marker before the winner replaced it', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-late-');
		await plantLock(layout, staleMarker(await deadPid()));
		const staleRead = Promise.withResolvers<void>();
		const resumeLate = Promise.withResolvers<void>();
		let firstMarkerRead = true;
		const lateOperations: FileWriterOperations = {
			...nodeFileWriterOperations,
			readUtf8: async (path) => {
				const content = await nodeFileWriterOperations.readUtf8(path);
				if (firstMarkerRead && path === layout.markerPath) {
					firstMarkerRead = false;
					staleRead.resolve();
					await resumeLate.promise;
				}
				return content;
			},
		};

		// When
		const late = create(layout.dataDir, lateOperations).catch((error: unknown) => error);
		await staleRead.promise;
		const winner = await create(layout.dataDir);
		const winnerMarker = await readFile(layout.markerPath, 'utf-8');
		resumeLate.resolve();

		// Then
		expect(await late).toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
		expect(await readdir(layout.lockPath)).toEqual([FILE_WRITER_MARKER_NAME]);
		expect(await readFile(layout.markerPath, 'utf-8')).toBe(winnerMarker);
		await winner.close();
		expect(await readdir(layout.dataDir)).not.toContain(FILE_WRITER_LOCK_NAME);
	});

	it('rejects a reclaimer whose claim is held by a reclaimer still in progress', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-claim-');
		await plantLock(layout, staleMarker(await deadPid()));
		const claimed = Promise.withResolvers<void>();
		const resumeFirst = Promise.withResolvers<void>();
		const firstOperations: FileWriterOperations = {
			...nodeFileWriterOperations,
			writeExclusiveUtf8: async (path, content) => {
				await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
				if (path.endsWith('.claim')) {
					claimed.resolve();
					await resumeFirst.promise;
				}
			},
		};

		// When
		const first = create(layout.dataDir, firstOperations);
		await claimed.promise;
		const second = await create(layout.dataDir).catch((error: unknown) => error);
		resumeFirst.resolve();
		const owner = await first;

		// Then
		expect(second).toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
		expect(await readdir(layout.lockPath)).toEqual([FILE_WRITER_MARKER_NAME]);
		await owner.close();
		expect(await readdir(layout.dataDir)).not.toContain(FILE_WRITER_LOCK_NAME);
	});

	it('leaves a claim it failed to create in place for the reclaimer that holds it', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-claim-fault-');
		const staleToken = randomUUID();
		const stale = markerContent({ hostname: hostname(), pid: await deadPid(), token: staleToken });
		await plantLock(layout, stale);
		const foreignClaim = staleMarker(process.ppid);
		const faultingOperations: FileWriterOperations = {
			...nodeFileWriterOperations,
			writeExclusiveUtf8: async (path, content) => {
				if (!path.endsWith('.claim')) {
					await nodeFileWriterOperations.writeExclusiveUtf8(path, content);
					return;
				}
				await writeFile(path, foreignClaim, 'utf-8');
				throw Object.assign(new Error('injected'), { code: 'EIO' });
			},
		};

		// When
		const failure = await create(layout.dataDir, faultingOperations).catch(
			(error: unknown) => error
		);

		// Then
		expect(failure).toMatchObject({ code: 'PERSISTENCE_OWNERSHIP' });
		expect(await lockState(layout.lockPath)).toEqual(
			[`${staleToken}.claim=${foreignClaim}`, `${FILE_WRITER_MARKER_NAME}=${stale}`].sort()
		);
	});

	it('leaves a successor marker in place when the reclaimed owner closes', async () => {
		// Given
		const layout = await createLayout('tracelattice-reclaim-successor-');
		await plantLock(layout, staleMarker(await deadPid()));
		const backend = await create(layout.dataDir);
		const successor = staleMarker(process.ppid);
		await writeFile(layout.markerPath, successor, 'utf-8');

		// When
		await backend.close();

		// Then
		expect(await readFile(layout.markerPath, 'utf-8')).toBe(successor);
	});
});

describe('FileWriter orphaned temporary sweep', () => {
	function orphanName(pid: number): string {
		return `.snapshot.json.${pid}.${randomUUID()}.tmp`;
	}

	it.each([
		['after reclaiming a stale lock', true],
		['on a fresh acquisition', false],
	])('removes its own orphaned temporaries %s', async (_label, stale) => {
		// Given
		const layout = await createLayout('tracelattice-sweep-');
		await seedSnapshot(layout.dataDir, 'kept');
		const pid = await deadPid();
		await writeFile(join(layout.dataDir, orphanName(pid)), '{"partial":', 'utf-8');
		if (stale) await plantLock(layout, staleMarker(pid));

		// When
		const backend = await create(layout.dataDir);

		// Then
		expect(
			(await backend.loadHistoryForSession(SESSION)).map((thought) => thought.thought)
		).toEqual(['kept']);
		expect((await readdir(layout.dataDir)).sort()).toEqual([
			FILE_WRITER_LOCK_NAME,
			'snapshot.json',
		]);
	});

	it.each([
		'.snapshot.json.tmp',
		'.snapshot.json.0.4f0c2d4e-7f43-4b9a-9d55-2f2f0f0f0f0f.tmp',
		'.snapshot.json.12.not-a-uuid.tmp',
		'.other.json.12.4f0c2d4e-7f43-4b9a-9d55-2f2f0f0f0f0f.tmp',
		'notes.txt',
	])('still rejects the foreign entry %s through the v2 layout check', async (entry) => {
		// Given
		const layout = await createLayout('tracelattice-sweep-foreign-');
		await seedSnapshot(layout.dataDir, 'kept');
		await writeFile(join(layout.dataDir, entry), 'foreign', 'utf-8');
		await plantLock(layout, staleMarker(await deadPid()));

		// When / Then
		await expect(FilePersistence.create({ dataDir: layout.dataDir })).rejects.toBeInstanceOf(
			PersistenceCompatibilityError
		);
		expect(await readFile(join(layout.dataDir, entry), 'utf-8')).toBe('foreign');
	});

	it('releases ownership before a failed sweep surfaces', async () => {
		// Given
		const layout = await createLayout('tracelattice-sweep-failure-');
		const orphan = join(layout.dataDir, orphanName(await deadPid()));
		await writeFile(orphan, 'partial', 'utf-8');
		const writer = new FileWriter(
			layout.dataDir,
			{
				...nodeFileWriterOperations,
				unlink: async (path) => {
					if (path === orphan) throw Object.assign(new Error('injected'), { code: 'EACCES' });
					await nodeFileWriterOperations.unlink(path);
				},
			},
			'snapshot.json'
		);

		// When
		const failure = await writer.ready().catch((error: unknown) => error);

		// Then
		expect(failure).toBeInstanceOf(PersistencePublicationError);
		expect(failure).toMatchObject({ stage: 'cleanup', path: orphan });
		expect(await readdir(layout.dataDir)).toEqual([orphan.slice(layout.dataDir.length + 1)]);
		await writer.close();
	});
});
