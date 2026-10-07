import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { asBranchId, asEdgeId, asSummaryId, asThoughtId } from '../../contracts/ids.js';
import type { SqliteDatabase } from '../../persistence/SqliteDriver.js';
import { SqlitePersistence } from '../../persistence/SqlitePersistence.js';
import { createTestSessionId, createTestThought } from '../helpers/factories.js';

// Optional native dependency: import('better-sqlite3') probe controls local skipIf.
const nativeModule = await import('better-sqlite3').catch((error: unknown) => {
	if (error instanceof Error) return undefined;
	throw error;
});
const SQLITE_AVAILABLE = nativeModule !== undefined;
const constants = { SQLITE_OPEN_READONLY: 1, SQLITE_OPEN_READWRITE: 2, SQLITE_OPEN_CREATE: 4 };
let raw: SqliteDatabase;
let sqlLog: string[];

class BunShapedDatabase {
	private readonly _database: SqliteDatabase;
	constructor(path: string, flags: number) {
		if (!nativeModule) throw new Error('native SQLite unavailable');
		this._database = new nativeModule.default(path, {
			readonly: (flags & constants.SQLITE_OPEN_READONLY) !== 0,
			fileMustExist: (flags & constants.SQLITE_OPEN_CREATE) === 0,
		});
		raw = this._database;
	}
	exec(sql: string): void {
		sqlLog.push(sql);
		this._database.exec(sql);
	}
	prepare(sql: string) {
		sqlLog.push(sql);
		const statement = this._database.prepare(sql);
		return {
			run: (...params: readonly unknown[]) => statement.run(...params),
			get: (...params: readonly unknown[]) => statement.get(...params) ?? null,
			all: (...params: readonly unknown[]) => {
				if ('reader' in statement && statement.reader === false) {
					statement.run(...params);
					return [];
				}
				return statement.all(...params);
			},
		};
	}
	close(): void {
		this._database.close();
	}
}

const runtime = {
	isBun: () => true,
	importBunSqlite: async () => ({ Database: BunShapedDatabase, constants }),
	importBetterSqlite3: async () => {
		throw new Error('Node driver must not be selected');
	},
};
const sessionA = createTestSessionId('bun-session-A');
const sessionB = createTestSessionId('bun-session-B');
const branchId = asBranchId('bun-branch');
let root: string;
let backend: SqlitePersistence | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'tracelattice-bun-shaped-'));
	sqlLog = [];
});
afterEach(async () => {
	await backend?.close();
	backend = undefined;
	await rm(root, { recursive: true, force: true });
});

// All cases depend on the local optional native import probe above.
it.skipIf(!SQLITE_AVAILABLE).each([true, false])(
	'applies startup pragmas with WAL %s',
	async (enableWAL) => {
		backend = await SqlitePersistence.create(
			{ dbPath: join(root, 'history.db'), enableWAL },
			runtime
		);
		expect(raw.prepare('SELECT singleton, version FROM schema_version').get()).toEqual({
			singleton: 1,
			version: 2,
		});
		expect(sqlLog.filter((sql) => sql.startsWith('PRAGMA '))).toEqual([
			...(enableWAL ? ['PRAGMA journal_mode = WAL'] : []),
			'PRAGMA synchronous = NORMAL',
			'PRAGMA foreign_keys = ON',
			'PRAGMA busy_timeout = 5000',
			'PRAGMA cache_size = -64000',
			'PRAGMA temp_store = MEMORY',
		]);
		for (const [name, value] of Object.entries({
			journal_mode: enableWAL ? 'wal' : 'delete',
			synchronous: 1,
			foreign_keys: 1,
			busy_timeout: 5000,
			cache_size: -64000,
			temp_store: 2,
		})) {
			expect(raw.prepare(`PRAGMA ${name}`).get()).toEqual({
				[name === 'busy_timeout' ? 'timeout' : name]: value,
			});
		}
	}
);

it.skipIf(!SQLITE_AVAILABLE)('restores confidence from an existing v2 file', async () => {
	const dbPath = join(root, 'history.db');
	const thought = createTestThought({ id: 'bun-durable', session_id: sessionA, confidence: 0.73 });
	backend = await SqlitePersistence.create({ dbPath }, runtime);
	await backend.saveThoughtForSession(sessionA, thought);
	await backend.close();
	backend = undefined;
	backend = await SqlitePersistence.create({ dbPath }, runtime);
	expect(await backend.loadHistoryForSession(sessionA)).toEqual([thought]);
});

it.skipIf(!SQLITE_AVAILABLE)(
	'replaces branches, edges and summaries only in the selected session',
	async () => {
		backend = await SqlitePersistence.create({ dbPath: join(root, 'history.db') }, runtime);
		for (const sessionId of [sessionA, sessionB]) {
			const thought = createTestThought({
				id: `target-${sessionId}`,
				session_id: sessionId,
				branch_id: branchId,
			});
			await backend.saveBranchForSession(sessionId, branchId, [thought]);
			await backend.saveEdges(sessionId, [
				{
					id: asEdgeId('edge'),
					from: asThoughtId('root'),
					to: asThoughtId('leaf'),
					kind: 'branch',
					sessionId,
					createdAt: 1,
				},
			]);
			await backend.saveSummaries(sessionId, [
				{
					id: asSummaryId('summary'),
					sessionId,
					rootThoughtId: asThoughtId('root'),
					coveredIds: [asThoughtId('root')],
					coveredRange: [1, 1],
					topics: ['topic'],
					aggregateConfidence: 0.7,
					createdAt: 1,
				},
			]);
		}
		await backend.saveBranchForSession(sessionA, branchId, []);
		await backend.saveEdges(sessionA, []);
		await backend.saveSummaries(sessionA, []);
		expect(await backend.loadBranchForSession(sessionA, branchId)).toEqual([]);
		expect(await backend.loadEdges(sessionA)).toEqual([]);
		expect(await backend.loadSummaries(sessionA)).toEqual([]);
		expect(await backend.loadBranchForSession(sessionB, branchId)).toHaveLength(1);
		expect(await backend.loadEdges(sessionB)).toHaveLength(1);
		expect(await backend.loadSummaries(sessionB)).toHaveLength(1);
	}
);

it.skipIf(!SQLITE_AVAILABLE)('rolls back an atomic backtrack when insertion fails', async () => {
	backend = await SqlitePersistence.create({ dbPath: join(root, 'history.db') }, runtime);
	const target = createTestThought({ id: 'bun-target', session_id: sessionA, branch_id: branchId });
	const backtrack = createTestThought({
		id: 'bun-backtrack',
		session_id: sessionA,
		thought_number: 2,
		thought_type: 'backtrack',
		backtrack_target: 1,
	});
	await backend.saveThoughtForSession(sessionA, target);
	await backend.saveBranchForSession(sessionA, branchId, [target]);
	raw.exec(
		"CREATE TEMP TRIGGER reject_backtrack BEFORE INSERT ON thoughts WHEN NEW.data LIKE '%bun-backtrack%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
	);
	sqlLog = [];
	await expect(
		backend.saveBacktrackForSession(sessionA, backtrack, asThoughtId('bun-target'))
	).rejects.toThrow('injected failure');
	expect(sqlLog[0]).toBe('BEGIN IMMEDIATE');
	expect(sqlLog).toContain('ROLLBACK');
	expect(await backend.loadHistoryForSession(sessionA)).toEqual([target]);
	expect(await backend.loadBranchForSession(sessionA, branchId)).toEqual([target]);
});

it.skipIf(!SQLITE_AVAILABLE)('rejects a non-v2 schema on reopen', async () => {
	const dbPath = join(root, 'history.db');
	backend = await SqlitePersistence.create({ dbPath }, runtime);
	raw.exec('CREATE TABLE unexpected (value TEXT)');
	await backend.close();
	backend = undefined;
	await expect(SqlitePersistence.create({ dbPath }, runtime)).rejects.toMatchObject({
		code: 'PERSISTENCE_COMPATIBILITY',
	});
});

it.skipIf(!SQLITE_AVAILABLE)('fails closed on malformed persisted thoughts', async () => {
	backend = await SqlitePersistence.create({ dbPath: join(root, 'history.db') }, runtime);
	raw.prepare('INSERT INTO thoughts (session_id, data) VALUES (?, ?)').run(sessionA, '{');
	await expect(backend.loadHistoryForSession(sessionA)).rejects.toMatchObject({
		code: 'PERSISTENCE_CORRUPTION',
	});
});
