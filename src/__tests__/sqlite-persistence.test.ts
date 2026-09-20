import { describe, expect, it } from 'vitest';
import type { PersistenceConfig } from '../contracts/PersistenceBackend.js';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asThoughtId,
	type BranchId,
	type SessionId,
} from '../contracts/ids.js';
import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import { PersistenceCompatibilityError, PersistenceCorruptionError } from '../errors.js';
import type {
	SqliteDatabase,
	SqliteRunResult,
	SqliteStatement,
} from '../persistence/SqliteDriver.js';
import { runSqliteTransaction } from '../persistence/SqliteDriver.js';
import { decodeEdgeRow, decodeSummaryRow, decodeThoughtRow } from '../persistence/SqlitePayload.js';
import { SqlitePersistence } from '../persistence/SqlitePersistence.js';
import {
	initializeOrValidateSqliteV2,
	SQLITE_V2_SCHEMA_DDL,
	SQLITE_V2_VERSION_INSERT,
	validateSqliteV2Schema,
} from '../persistence/SqliteSchemaV2.js';
import { createTestThought } from './helpers/factories.js';
import {
	STATEFUL_SQLITE_SUPPORTED_SQL,
	StatefulSqliteDatabase,
	UnsupportedStructuralSqlError,
} from './helpers/StatefulSqliteDatabase.js';

type SchemaRow = {
	readonly type: string;
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string;
};

const EMPTY_RESULT: SqliteRunResult = { changes: 0, lastInsertRowid: 0 };
const TEST_SESSION_ID = asSessionId('test-session');

function schemaRowsFromDdl(): SchemaRow[] {
	return SQLITE_V2_SCHEMA_DDL.split(';')
		.map((sql) => sql.trim())
		.filter(Boolean)
		.flatMap((sql) => {
			const match = /^CREATE\s+(TABLE|INDEX)\s+([^\s(]+)/i.exec(sql);
			if (match?.[1] === undefined || match[2] === undefined) return [];
			const type = match[1].toLowerCase();
			const tableMatch = type === 'index' ? /\sON\s+([^\s(]+)/i.exec(sql) : undefined;
			return [{ type, name: match[2], tbl_name: tableMatch?.[1] ?? match[2], sql }];
		});
}

class StructuralDatabase implements SqliteDatabase {
	public readonly commands: string[] = [];
	public schemaRows: SchemaRow[];
	public versionRows: unknown[];
	public failCommand: string | undefined;

	constructor(schemaRows: SchemaRow[] = [], versionRows: unknown[] = []) {
		this.schemaRows = schemaRows;
		this.versionRows = versionRows;
	}

	public exec(sql: string): void {
		this.commands.push(sql);
		if (this.failCommand !== undefined && sql.includes(this.failCommand)) {
			throw new Error(`injected ${this.failCommand} failure`);
		}
		if (sql === SQLITE_V2_SCHEMA_DDL) this.schemaRows = schemaRowsFromDdl();
		if (sql === SQLITE_V2_VERSION_INSERT) this.versionRows = [{ singleton: 1, version: 2 }];
	}

	public prepare(sql: string): SqliteStatement {
		const all = (): unknown[] => {
			if (sql.includes('sqlite_master')) return this.schemaRows;
			if (sql.includes('schema_version')) return this.versionRows;
			return [];
		};
		return {
			run: () => EMPTY_RESULT,
			get: () => (sql === 'SELECT 1' ? { result: 1 } : undefined),
			all,
		};
	}

	public close(): void {}
	public pragma(): unknown {
		return undefined;
	}
}

type StructuralPersistenceFixture = {
	readonly database: StatefulSqliteDatabase;
	readonly persistence: SqlitePersistence;
};

type TimedFixture = {
	readonly id: string;
	readonly sessionId: SessionId;
	readonly createdAt: number;
	readonly branchId?: BranchId;
};

const COUNT_SESSION_THOUGHTS_SQL = 'SELECT COUNT(*) AS count FROM thoughts WHERE session_id = ?';
const INSERT_EDGE_SQL =
	'INSERT INTO edges (id, session_id, from_id, to_id, kind, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)';
const DELETE_EDGES_FOR_SESSION_SQL = 'DELETE FROM edges WHERE session_id = ?';

function createStructuralPersistence(
	options: PersistenceConfig['options'] = {}
): StructuralPersistenceFixture {
	const database = new StatefulSqliteDatabase();
	return {
		database,
		persistence: SqlitePersistence.createWithDatabase(
			database,
			options,
			'<stateful-structural-sqlite>'
		),
	};
}

function edgeFixture({ id, sessionId, createdAt }: TimedFixture): Edge {
	return {
		id: asEdgeId(id),
		from: asThoughtId(`${id}-from`),
		to: asThoughtId(`${id}-to`),
		kind: 'sequence',
		sessionId,
		createdAt,
		metadata: { source: id },
	};
}

function summaryFixture({ id, sessionId, createdAt, branchId }: TimedFixture): Summary {
	const rootThoughtId = asThoughtId(`${id}-root`);
	return {
		id,
		sessionId,
		...(branchId === undefined ? {} : { branchId }),
		rootThoughtId,
		coveredIds: [rootThoughtId],
		coveredRange: [1, 1],
		topics: ['sqlite'],
		aggregateConfidence: 0.75,
		createdAt,
		meta: { source: id },
	};
}

function canonicalThought(id: string, thought: string) {
	return decodeThoughtRow(
		{ data: JSON.stringify(createTestThought({ id, thought })) },
		'<canonical-structural-fixture>'
	);
}

describe('SQLite v2 frozen schema', () => {
	it('creates the complete v2 schema only when the database is entirely empty', () => {
		const database = new StructuralDatabase();

		initializeOrValidateSqliteV2(database, 'empty.db');

		expect(database.commands).toEqual([
			'BEGIN IMMEDIATE',
			SQLITE_V2_SCHEMA_DDL,
			SQLITE_V2_VERSION_INSERT,
			'COMMIT',
		]);
		expect(SQLITE_V2_SCHEMA_DDL).not.toContain('user_version');
		expect(database.schemaRows.map(({ name }) => name).sort()).toEqual([
			'branches',
			'edges',
			'idx_edges_from',
			'idx_edges_session_created',
			'idx_edges_to',
			'idx_summaries_session_branch',
			'idx_summaries_session_created',
			'idx_thoughts_session_id',
			'schema_version',
			'summaries',
			'thoughts',
		]);
	});

	it('accepts exact v2 and rejects drift without mutation', () => {
		const exact = new StructuralDatabase(schemaRowsFromDdl(), [{ singleton: 1, version: 2 }]);
		validateSqliteV2Schema(exact, 'exact.db');
		const driftedRows = schemaRowsFromDdl().map((row) =>
			row.name === 'thoughts'
				? { ...row, sql: row.sql.replace('session_id TEXT NOT NULL', 'session_id TEXT') }
				: row
		);
		const drifted = new StructuralDatabase(driftedRows, [{ singleton: 1, version: 2 }]);

		expect(() => validateSqliteV2Schema(drifted, 'drifted.db')).toThrowError(
			PersistenceCompatibilityError
		);
		expect(drifted.commands).toEqual([]);
	});

	it('rejects any non-v2 object set generically without mutation', () => {
		const unknown = new StructuralDatabase([
			{
				type: 'table',
				name: 'thoughts',
				tbl_name: 'thoughts',
				sql: 'CREATE TABLE thoughts (id INTEGER)',
			},
			{ type: 'table', name: 'edges', tbl_name: 'edges', sql: 'CREATE TABLE edges (id TEXT)' },
			{
				type: 'table',
				name: 'summaries',
				tbl_name: 'summaries',
				sql: 'CREATE TABLE summaries (id TEXT)',
			},
		]);

		expect(() => initializeOrValidateSqliteV2(unknown, 'unknown.db')).toThrowError(
			expect.objectContaining({
				code: 'PERSISTENCE_COMPATIBILITY',
				detail: 'database does not match SQLite v2 schema',
			})
		);
		expect(unknown.commands).toEqual([]);
	});

	it('rolls back operation and commit failures', () => {
		for (const failure of ['statement', 'COMMIT']) {
			const database = new StructuralDatabase();
			database.failCommand = failure;
			expect(() =>
				runSqliteTransaction(database, () => {
					database.exec('statement');
				})
			).toThrow();
			expect(database.commands.at(-1)).toBe('ROLLBACK');
		}
	});
});

describe('SQLite row decoders', () => {
	it('reconstructs canonical thought, edge, and summary payloads', () => {
		const thought = createTestThought({ id: 'thought-1', session_id: 'session-1' });
		expect(decodeThoughtRow({ data: JSON.stringify(thought) }, 'thought-row')).toEqual(thought);
		expect(
			decodeEdgeRow(
				{
					id: 'edge-1',
					session_id: 'session-1',
					from_id: 'thought-1',
					to_id: 'thought-2',
					kind: 'sequence',
					created_at: 2,
					metadata: null,
				},
				'edge-row'
			).id
		).toBe('edge-1');
		expect(
			decodeSummaryRow(
				{
					id: 'summary-1',
					session_id: 'session-1',
					branch_id: null,
					root_thought_id: 'thought-1',
					covered_ids: '["thought-1"]',
					covered_range_start: 1,
					covered_range_end: 1,
					topics: '["sqlite"]',
					aggregate_confidence: 1,
					created_at: 3,
					meta: null,
				},
				'summary-row'
			).id
		).toBe('summary-1');
	});

	it('fails closed on malformed and schema-invalid payload JSON', () => {
		expect(() => decodeThoughtRow({ data: '{' }, 'malformed')).toThrowError(
			PersistenceCorruptionError
		);
		expect(() => decodeThoughtRow({ data: '{}' }, 'invalid')).toThrowError(
			PersistenceCorruptionError
		);
	});
});

describe('SqlitePersistence stateful structural behavior', () => {
	it('isolates two named sessions with matching branch IDs', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const namedSession = asSessionId('named-session');
		const sharedBranch = asBranchId('shared-branch');
		const testSessionThought = createTestThought({ id: 'test-history', thought: 'test session' });
		const namedThought = createTestThought({
			id: 'named-history',
			session_id: namedSession,
			thought: 'named',
		});
		const testSessionBranchThought = createTestThought({
			id: 'test-branch',
			thought: 'test session branch',
		});
		const namedBranchThought = createTestThought({
			id: 'named-branch',
			session_id: namedSession,
			thought: 'named branch',
		});

		// When
		await persistence.saveThoughtForSession(TEST_SESSION_ID, testSessionThought);
		await persistence.saveThoughtForSession(namedSession, namedThought);
		await persistence.saveBranchForSession(TEST_SESSION_ID, sharedBranch, [
			testSessionBranchThought,
		]);
		await persistence.saveBranchForSession(namedSession, sharedBranch, [namedBranchThought]);

		// Then
		expect(await persistence.loadHistoryForSession(TEST_SESSION_ID)).toEqual([testSessionThought]);
		expect(await persistence.loadHistoryForSession(namedSession)).toEqual([namedThought]);
		expect(await persistence.loadBranchForSession(TEST_SESSION_ID, sharedBranch)).toEqual([
			testSessionBranchThought,
		]);
		expect(await persistence.loadBranchForSession(namedSession, sharedBranch)).toEqual([
			namedBranchThought,
		]);
		expect(await persistence.listBranchesForSession(TEST_SESSION_ID)).toEqual([sharedBranch]);
		expect(await persistence.listBranchesForSession(namedSession)).toEqual([sharedBranch]);
		expect(await persistence.listSessions()).toEqual([namedSession, TEST_SESSION_ID]);
	});

	it('rejects a thought missing its nested session before creating SQLite state', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const thought = createTestThought({ id: 'missing-session' });
		Reflect.deleteProperty(thought, 'session_id');

		// When / Then
		await expect(persistence.saveThoughtForSession(TEST_SESSION_ID, thought)).rejects.toMatchObject(
			{
				code: 'VALIDATION_ERROR',
			}
		);
		expect(await persistence.listSessions()).toEqual([]);
	});

	it('rejects a retired nested thought session before creating SQLite state', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const thought = createTestThought({ id: 'retired-session' });
		Reflect.set(thought, 'session_id', '__global__');

		// When / Then
		await expect(persistence.saveThoughtForSession(TEST_SESSION_ID, thought)).rejects.toMatchObject(
			{
				code: 'VALIDATION_ERROR',
			}
		);
		expect(await persistence.listSessions()).toEqual([]);
	});

	it('preserves admission order and applies positive retention independently per session', async () => {
		// Given
		const { persistence } = createStructuralPersistence({ maxHistorySize: 2 });
		const sessionA = asSessionId('session-A');
		const sessionB = asSessionId('session-B');
		const numbers = [30, 10, 20];

		// When
		for (const thoughtNumber of numbers) {
			await persistence.saveThoughtForSession(
				sessionA,
				createTestThought({
					id: `A-${thoughtNumber}`,
					session_id: sessionA,
					thought_number: thoughtNumber,
					total_thoughts: 30,
				})
			);
			await persistence.saveThoughtForSession(
				sessionB,
				createTestThought({
					id: `B-${thoughtNumber}`,
					session_id: sessionB,
					thought_number: thoughtNumber,
					total_thoughts: 30,
				})
			);
		}

		// Then
		expect((await persistence.loadHistoryForSession(sessionA)).map(({ id }) => id)).toEqual([
			'A-10',
			'A-20',
		]);
		expect((await persistence.loadHistoryForSession(sessionB)).map(({ id }) => id)).toEqual([
			'B-10',
			'B-20',
		]);
	});

	it.each([0, -2])('keeps maxHistorySize %s as unlimited retention', async (maxHistorySize) => {
		// Given
		const { persistence } = createStructuralPersistence({ maxHistorySize });
		const thoughts = [1, 2, 3].map((thoughtNumber) =>
			createTestThought({ id: `unlimited-${thoughtNumber}`, thought_number: thoughtNumber })
		);

		// When
		for (const thought of thoughts)
			await persistence.saveThoughtForSession(TEST_SESSION_ID, thought);

		// Then
		expect(await persistence.loadHistoryForSession(TEST_SESSION_ID)).toEqual(thoughts);
	});

	it('replaces one branch and preserves an explicitly empty branch record', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const branchId = asBranchId('replaceable');
		const initial = createTestThought({ id: 'branch-initial' });
		const replacement = createTestThought({ id: 'branch-replacement' });

		// When
		await persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [initial]);
		await persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [replacement]);
		await persistence.saveBranchForSession(TEST_SESSION_ID, branchId, []);

		// Then
		expect(await persistence.loadBranchForSession(TEST_SESSION_ID, branchId)).toEqual([]);
		expect(await persistence.listBranchesForSession(TEST_SESSION_ID)).toEqual([branchId]);
	});

	it('deletes one branch idempotently without deleting its session sibling', async () => {
		const { persistence } = createStructuralPersistence();
		const sessionId = asSessionId('delete-branch');
		const removed = asBranchId('removed');
		const sibling = asBranchId('sibling');
		await persistence.saveBranchForSession(sessionId, removed, []);
		await persistence.saveBranchForSession(sessionId, sibling, []);

		await persistence.deleteBranchForSession(sessionId, removed);
		await persistence.deleteBranchForSession(sessionId, removed);

		expect(await persistence.loadBranchForSession(sessionId, removed)).toBeUndefined();
		expect(await persistence.loadBranchForSession(sessionId, sibling)).toEqual([]);
		expect(await persistence.listBranchesForSession(sessionId)).toEqual([sibling]);
	});

	it('orders session, branch, and edge-session identifiers by Unicode code point', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const sessions = [asSessionId('a'), asSessionId('Z'), asSessionId('_')] as const;
		const branchSession = sessions[0];
		const branchIds = [asBranchId('z'), asBranchId('A'), asBranchId('_')];

		// When
		for (const branchId of branchIds) {
			await persistence.saveBranchForSession(branchSession, branchId, []);
		}
		for (const [index, sessionId] of sessions.entries()) {
			await persistence.saveEdges(sessionId, [
				edgeFixture({ id: `edge-${index}`, sessionId, createdAt: index }),
			]);
		}

		// Then
		expect(await persistence.listSessions()).toEqual([sessions[1], sessions[2], sessions[0]]);
		expect(await persistence.listBranchesForSession(branchSession)).toEqual([
			branchIds[1],
			branchIds[2],
			branchIds[0],
		]);
		expect(await persistence.listSessions()).toEqual([sessions[1], sessions[2], sessions[0]]);
	});

	it('clears one session across every namespace while preserving another', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const sessionA = asSessionId('session-A');
		const sessionB = asSessionId('session-B');
		const branchId = asBranchId('shared');
		for (const sessionId of [sessionA, sessionB]) {
			await persistence.saveThoughtForSession(
				sessionId,
				createTestThought({ id: `${sessionId}-thought`, session_id: sessionId })
			);
			await persistence.saveBranchForSession(sessionId, branchId, [
				createTestThought({ id: `${sessionId}-branch`, session_id: sessionId }),
			]);
			await persistence.saveEdges(sessionId, [
				edgeFixture({ id: `${sessionId}-edge`, sessionId, createdAt: 1 }),
			]);
			await persistence.saveSummaries(sessionId, [
				summaryFixture({ id: `${sessionId}-summary`, sessionId, createdAt: 1 }),
			]);
		}

		// When
		await persistence.clearSession(sessionA);

		// Then
		expect(await persistence.loadHistoryForSession(sessionA)).toEqual([]);
		expect(await persistence.loadBranchForSession(sessionA, branchId)).toBeUndefined();
		expect(await persistence.loadEdges(sessionA)).toEqual([]);
		expect(await persistence.loadSummaries(sessionA)).toEqual([]);
		expect(await persistence.loadHistoryForSession(sessionB)).toHaveLength(1);
		expect(await persistence.loadBranchForSession(sessionB, branchId)).toHaveLength(1);
		expect(await persistence.loadEdges(sessionB)).toHaveLength(1);
		expect(await persistence.loadSummaries(sessionB)).toHaveLength(1);
	});

	it('globally clears payload rows while retaining schema and version state', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('clear-all');
		await persistence.saveThoughtForSession(
			TEST_SESSION_ID,
			createTestThought({ id: 'global-before-clear' })
		);
		await persistence.saveBranchForSession(TEST_SESSION_ID, asBranchId('before-clear'), []);
		await persistence.saveEdges(sessionId, [
			edgeFixture({ id: 'edge-before-clear', sessionId, createdAt: 1 }),
		]);
		await persistence.saveSummaries(sessionId, [
			summaryFixture({ id: 'summary-before-clear', sessionId, createdAt: 1 }),
		]);
		const before = database.snapshot();

		// When
		await persistence.clearAll();

		// Then
		const after = database.snapshot();
		expect(after.schemaRows).toEqual(before.schemaRows);
		expect(after.versionRows).toEqual(before.versionRows);
		expect(after.thoughts).toEqual([]);
		expect(after.branches).toEqual([]);
		expect(after.edges).toEqual([]);
		expect(after.summaries).toEqual([]);
		expect(await persistence.listSessions()).toEqual([]);
	});

	it('replaces edges and loads them by createdAt then id', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const sessionId = asSessionId('edge-order');
		const unordered = [
			edgeFixture({ id: 'edge-c', sessionId, createdAt: 2 }),
			edgeFixture({ id: 'edge-b', sessionId, createdAt: 1 }),
			edgeFixture({ id: 'edge-a', sessionId, createdAt: 1 }),
		];
		const replacement = edgeFixture({ id: 'edge-new', sessionId, createdAt: 3 });

		// When
		await persistence.saveEdges(sessionId, unordered);
		const ordered = await persistence.loadEdges(sessionId);
		await persistence.saveEdges(sessionId, [replacement]);

		// Then
		expect(ordered.map(({ id }) => id)).toEqual(['edge-a', 'edge-b', 'edge-c']);
		expect(ordered[0]?.metadata).toEqual({ source: 'edge-a' });
		expect(await persistence.loadEdges(sessionId)).toEqual([replacement]);
	});

	it('replaces summaries and loads them by createdAt then id', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const sessionId = asSessionId('summary-order');
		const branchId = asBranchId('summary-branch');
		const unordered = [
			summaryFixture({ id: 'summary-c', sessionId, createdAt: 2 }),
			summaryFixture({ id: 'summary-b', sessionId, createdAt: 1 }),
			summaryFixture({ id: 'summary-a', sessionId, createdAt: 1, branchId }),
		];
		const replacement = summaryFixture({ id: 'summary-new', sessionId, createdAt: 3 });

		// When
		await persistence.saveSummaries(sessionId, unordered);
		const ordered = await persistence.loadSummaries(sessionId);
		await persistence.saveSummaries(sessionId, [replacement]);

		// Then
		expect(ordered.map(({ id }) => id)).toEqual(['summary-a', 'summary-b', 'summary-c']);
		expect(ordered[0]?.branchId).toBe(branchId);
		expect(ordered[0]?.meta).toEqual({ source: 'summary-a' });
		expect(await persistence.loadSummaries(sessionId)).toEqual([replacement]);
	});

	it('fails closed when public loaders encounter malformed stored rows', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('malformed');
		const branchId = asBranchId('malformed-branch');
		await persistence.saveThoughtForSession(
			sessionId,
			createTestThought({ id: 'malformed-thought', session_id: sessionId })
		);
		await persistence.saveBranchForSession(sessionId, branchId, [
			createTestThought({ id: 'malformed-branch-thought', session_id: sessionId }),
		]);
		await persistence.saveEdges(sessionId, [
			edgeFixture({ id: 'malformed-edge', sessionId, createdAt: 1 }),
		]);
		await persistence.saveSummaries(sessionId, [
			summaryFixture({ id: 'malformed-summary', sessionId, createdAt: 1 }),
		]);
		database.overwriteThoughtData(sessionId, '{');
		database.overwriteBranchData(sessionId, branchId, '{}');
		database.overwriteEdgeMetadata(sessionId, 'malformed-edge', '{');
		database.overwriteSummaryTopics(sessionId, 'malformed-summary', '{');

		// When / Then
		await expect(persistence.loadHistoryForSession(sessionId)).rejects.toBeInstanceOf(
			PersistenceCorruptionError
		);
		await expect(persistence.loadBranchForSession(sessionId, branchId)).rejects.toBeInstanceOf(
			PersistenceCorruptionError
		);
		await expect(persistence.loadEdges(sessionId)).rejects.toBeInstanceOf(
			PersistenceCorruptionError
		);
		await expect(persistence.loadSummaries(sessionId)).rejects.toBeInstanceOf(
			PersistenceCorruptionError
		);
	});

	it('reports stats, health transitions, and closure through public methods', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		await persistence.saveThoughtForSession(
			TEST_SESSION_ID,
			createTestThought({ id: 'stats-thought' })
		);
		await persistence.saveBranchForSession(TEST_SESSION_ID, asBranchId('stats-branch'), []);

		// When / Then
		expect(persistence.getStats()).toEqual({ thoughtCount: 1, branchCount: 1, dbSize: 0 });
		expect(await persistence.healthy()).toBe(true);
		database.setHealthy(false);
		expect(await persistence.healthy()).toBe(false);
		database.setHealthy(true);
		await persistence.close();
		expect(database.snapshot().closed).toBe(true);
		expect(await persistence.healthy()).toBe(false);
	});

	it('reports zero branch stats when branch persistence is disabled', () => {
		// Given
		const { persistence } = createStructuralPersistence({ persistBranches: false });

		// When
		const stats = persistence.getStats();

		// Then
		expect(stats).toEqual({ thoughtCount: 0, branchCount: 0, dbSize: 0 });
	});

	it('publishes an exact SQL inventory and rejects every unsupported SQL surface', () => {
		// Given
		const database = new StatefulSqliteDatabase();

		// When / Then
		expect(STATEFUL_SQLITE_SUPPORTED_SQL.exec).toHaveLength(10);
		expect(STATEFUL_SQLITE_SUPPORTED_SQL.exec).toEqual([
			'BEGIN',
			'BEGIN IMMEDIATE',
			'COMMIT',
			'ROLLBACK',
			SQLITE_V2_SCHEMA_DDL,
			SQLITE_V2_VERSION_INSERT,
			'DELETE FROM thoughts',
			'DELETE FROM branches',
			'DELETE FROM edges',
			'DELETE FROM summaries',
		]);
		expect(STATEFUL_SQLITE_SUPPORTED_SQL.prepared).toHaveLength(24);
		expect(() => database.prepare('SELECT * FROM imaginary')).toThrowError(
			UnsupportedStructuralSqlError
		);
		expect(() => database.exec('VACUUM')).toThrowError(UnsupportedStructuralSqlError);
		expect(() => database.pragma('journal_mode = WAL')).toThrowError(UnsupportedStructuralSqlError);
		expect(() => database.prepare('SELECT 1').all()).toThrowError(UnsupportedStructuralSqlError);
	});

	it('rejects an identical duplicate already present in history', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const thought = canonicalThought('duplicate-history', 'duplicate history');
		await persistence.saveThoughtForSession(TEST_SESSION_ID, thought);

		// When / Then
		await expect(persistence.saveThoughtForSession(TEST_SESSION_ID, thought)).rejects.toMatchObject(
			{
				code: 'PERSISTENCE_COMPATIBILITY',
			}
		);
	});

	it('rejects duplicate candidate IDs inside one branch array', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const branchId = asBranchId('duplicate-candidate');
		const thought = createTestThought({ id: 'duplicate-candidate-id' });

		// When / Then
		await expect(
			persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [thought, thought])
		).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
	});

	it('allows deeply equal thought reuse between history and branch material', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const branchId = asBranchId('equal-reuse');
		const thought = createTestThought({ id: 'equal-reuse-id' });
		await persistence.saveThoughtForSession(TEST_SESSION_ID, thought);

		// When
		await persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [thought]);

		// Then
		expect(await persistence.loadBranchForSession(TEST_SESSION_ID, branchId)).toEqual([thought]);
	});

	it('rejects a branch conflict after history was admitted', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const branchId = asBranchId('history-first');
		await persistence.saveThoughtForSession(
			TEST_SESSION_ID,
			createTestThought({ id: 'history-first-id', thought: 'history payload' })
		);

		// When / Then
		await expect(
			persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [
				createTestThought({ id: 'history-first-id', thought: 'branch payload' }),
			])
		).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
	});

	it('rejects a history conflict after branch material was admitted', async () => {
		// Given
		const { persistence } = createStructuralPersistence();
		const branchId = asBranchId('branch-first');
		await persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [
			createTestThought({ id: 'branch-first-id', thought: 'branch payload' }),
		]);

		// When / Then
		await expect(
			persistence.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ id: 'branch-first-id', thought: 'history payload' })
			)
		).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
	});

	it('fails loadHistoryForSession closed on a cross-collection payload conflict', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('loader-history-conflict');
		const branchId = asBranchId('loader-history-branch');
		const historyThought = createTestThought({
			id: 'loader-history-shared',
			session_id: sessionId,
			thought: 'history payload',
		});
		const branchThought = createTestThought({
			id: 'loader-history-shared',
			session_id: sessionId,
			thought: 'branch payload',
		});
		await persistence.saveThoughtForSession(sessionId, historyThought);
		database.seedBranchData(sessionId, branchId, JSON.stringify([branchThought]));
		const before = database.snapshot();

		// When
		const load = persistence.loadHistoryForSession(sessionId);

		// Then
		await expect(load).rejects.toBeInstanceOf(PersistenceCompatibilityError);
		await expect(load).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		expect(database.snapshot()).toEqual(before);
		expect(database.execLog.slice(-2)).toEqual(['BEGIN', 'ROLLBACK']);
	});

	it('fails loadBranchForSession closed on a cross-collection payload conflict before a missing-branch return', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('loader-branch-conflict');
		const existingBranchId = asBranchId('loader-existing-branch');
		const missingBranchId = asBranchId('loader-missing-branch');
		const historyThought = createTestThought({
			id: 'loader-branch-shared',
			session_id: sessionId,
			thought: 'history payload',
		});
		const branchThought = createTestThought({
			id: 'loader-branch-shared',
			session_id: sessionId,
			thought: 'branch payload',
		});
		await persistence.saveThoughtForSession(sessionId, historyThought);
		database.seedBranchData(sessionId, existingBranchId, JSON.stringify([branchThought]));
		const before = database.snapshot();

		// When
		const load = persistence.loadBranchForSession(sessionId, missingBranchId);

		// Then
		await expect(load).rejects.toBeInstanceOf(PersistenceCompatibilityError);
		await expect(load).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		expect(database.snapshot()).toEqual(before);
		expect(database.execLog.slice(-2)).toEqual(['BEGIN', 'ROLLBACK']);
	});

	it('rejects saveThoughtForSession on a competing commit at BEGIN IMMEDIATE', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('writer-thought-conflict');
		const branchId = asBranchId('writer-thought-branch');
		const candidate = createTestThought({
			id: 'writer-thought-shared',
			session_id: sessionId,
			thought: 'candidate history payload',
		});
		const competing = createTestThought({
			id: 'writer-thought-shared',
			session_id: sessionId,
			thought: 'competing branch payload',
		});
		let competingSnapshot: ReturnType<StatefulSqliteDatabase['snapshot']> | undefined;
		database.beforeNextBeginImmediate(() => {
			database.seedBranchData(sessionId, branchId, JSON.stringify([competing]));
			competingSnapshot = database.snapshot();
		});

		// When
		const save = persistence.saveThoughtForSession(sessionId, candidate);

		// Then
		await expect(save).rejects.toBeInstanceOf(PersistenceCompatibilityError);
		await expect(save).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		const after = database.snapshot();
		expect(after).toEqual(competingSnapshot);
		expect(after.branches).toEqual([
			{
				session_id: sessionId,
				branch_id: branchId,
				data: JSON.stringify([competing]),
			},
		]);
		expect(after.thoughts).toEqual([]);
		expect(after.nextThoughtId).toBe(1);
		expect(database.execLog.slice(-2)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
	});

	it('rejects saveBranchForSession on a competing commit at BEGIN IMMEDIATE', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('writer-branch-conflict');
		const branchId = asBranchId('writer-target-branch');
		const candidate = createTestThought({
			id: 'writer-branch-shared',
			session_id: sessionId,
			thought: 'candidate branch payload',
		});
		const competing = createTestThought({
			id: 'writer-branch-shared',
			session_id: sessionId,
			thought: 'competing history payload',
		});
		let competingSnapshot: ReturnType<StatefulSqliteDatabase['snapshot']> | undefined;
		database.beforeNextBeginImmediate(() => {
			database.seedThoughtData(sessionId, JSON.stringify(competing));
			competingSnapshot = database.snapshot();
		});

		// When
		const save = persistence.saveBranchForSession(sessionId, branchId, [candidate]);

		// Then
		await expect(save).rejects.toBeInstanceOf(PersistenceCompatibilityError);
		await expect(save).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		const after = database.snapshot();
		expect(after).toEqual(competingSnapshot);
		expect(after.thoughts).toEqual([
			{
				id: 1,
				session_id: sessionId,
				data: JSON.stringify(competing),
			},
		]);
		expect(after.branches).toEqual([]);
		expect(after.nextThoughtId).toBe(2);
		expect(database.execLog.slice(-2)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
	});

	it.each([
		['alpha then omega', asBranchId('alpha'), asBranchId('omega')],
		['omega then alpha', asBranchId('omega'), asBranchId('alpha')],
	])('rejects conflicts across multiple branches read as %s', async (_label, first, second) => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const candidate = canonicalThought('multi-branch-id', 'candidate payload');
		const conflict = canonicalThought('multi-branch-id', 'conflicting payload');
		database.seedBranchData(TEST_SESSION_ID, first, JSON.stringify([conflict]));
		database.seedBranchData(TEST_SESSION_ID, second, JSON.stringify([candidate]));

		// When / Then
		await expect(
			persistence.saveThoughtForSession(TEST_SESSION_ID, candidate)
		).rejects.toMatchObject({
			code: 'PERSISTENCE_COMPATIBILITY',
		});
	});

	it('validates duplicate candidates before a persistBranches=false no-op', async () => {
		// Given
		const { persistence } = createStructuralPersistence({ persistBranches: false });
		const sessionId = asSessionId('disabled-branches');
		const branchId = asBranchId('disabled-branch');
		const thought = createTestThought({
			id: 'disabled-duplicate',
			session_id: sessionId,
		});

		// When / Then
		await expect(
			persistence.saveBranchForSession(sessionId, branchId, [thought, thought])
		).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
	});

	it('rejects a current-history conflict before a persistBranches=false no-op without writing', async () => {
		// Given
		const database = new StatefulSqliteDatabase();
		const persistence = SqlitePersistence.createWithDatabase(
			database,
			{ persistBranches: false },
			'<disabled-conflict>'
		);
		const sessionId = asSessionId('disabled-conflict');
		const branchId = asBranchId('disabled-branch');
		const historyThought = createTestThought({
			id: 'disabled-shared-id',
			session_id: sessionId,
			thought: 'history payload',
		});
		await persistence.saveThoughtForSession(sessionId, historyThought);
		const before = database.snapshot();
		const execLogLength = database.execLog.length;

		// When
		const save = persistence.saveBranchForSession(sessionId, branchId, [
			createTestThought({
				id: 'disabled-shared-id',
				session_id: sessionId,
				branch_id: branchId,
				thought: 'conflicting branch payload',
			}),
		]);

		// Then
		await expect(save).rejects.toBeInstanceOf(PersistenceCompatibilityError);
		await expect(save).rejects.toMatchObject({ code: 'PERSISTENCE_COMPATIBILITY' });
		const transactionSlice = database.execLog.slice(execLogLength);
		expect(transactionSlice).toEqual(['BEGIN', 'ROLLBACK']);
		expect(transactionSlice).not.toContain('BEGIN IMMEDIATE');
		expect(database.snapshot()).toEqual(before);
		expect(database.snapshot().branches).toEqual([]);
		expect(await persistence.loadHistoryForSession(sessionId)).toEqual([historyThought]);
		expect(await persistence.loadBranchForSession(sessionId, branchId)).toBeUndefined();
	});

	it('validates a current-history-compatible candidate before a persistBranches=false no-op', async () => {
		// Given
		const database = new StatefulSqliteDatabase();
		const persistence = SqlitePersistence.createWithDatabase(
			database,
			{ persistBranches: false },
			'<disabled-compatible>'
		);
		const sessionId = asSessionId('disabled-compatible');
		const branchId = asBranchId('disabled-branch');
		const historyThought = createTestThought({
			id: 'disabled-history-id',
			session_id: sessionId,
			thought: 'retained history',
		});
		await persistence.saveThoughtForSession(sessionId, historyThought);
		const before = database.snapshot();
		const execLogLength = database.execLog.length;

		// When
		await persistence.saveBranchForSession(sessionId, branchId, [
			createTestThought({
				id: 'disabled-branch-id',
				session_id: sessionId,
				branch_id: branchId,
				thought: 'compatible branch payload',
			}),
		]);

		// Then
		const transactionSlice = database.execLog.slice(execLogLength);
		expect(transactionSlice).toEqual(['BEGIN', 'COMMIT']);
		expect(transactionSlice).not.toContain('BEGIN IMMEDIATE');
		expect(database.snapshot()).toEqual(before);
		expect(await persistence.loadBranchForSession(sessionId, branchId)).toBeUndefined();
		expect(await persistence.listBranchesForSession(sessionId)).toEqual([]);
		expect(await persistence.listSessions()).toEqual([sessionId]);
		expect(persistence.getStats()).toEqual({ thoughtCount: 1, branchCount: 0, dbSize: 0 });
	});

	it('enforces edge primary-key conflicts and rolls replacement data back', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('duplicate-edges');
		const original = edgeFixture({ id: 'original-edge', sessionId, createdAt: 1 });
		const duplicate = edgeFixture({ id: 'duplicate-edge', sessionId, createdAt: 2 });
		await persistence.saveEdges(sessionId, [original]);
		const before = database.snapshot();

		// When / Then
		await expect(persistence.saveEdges(sessionId, [duplicate, duplicate])).rejects.toThrow(
			'edges primary key'
		);
		expect(database.snapshot()).toEqual(before);
		expect(await persistence.loadEdges(sessionId)).toEqual([original]);
	});

	it('enforces summary primary-key conflicts and rolls replacement data back', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('duplicate-summaries');
		const original = summaryFixture({ id: 'original-summary', sessionId, createdAt: 1 });
		const duplicate = summaryFixture({ id: 'duplicate-summary', sessionId, createdAt: 2 });
		await persistence.saveSummaries(sessionId, [original]);
		const before = database.snapshot();

		// When / Then
		await expect(persistence.saveSummaries(sessionId, [duplicate, duplicate])).rejects.toThrow(
			'summaries primary key'
		);
		expect(database.snapshot()).toEqual(before);
		expect(await persistence.loadSummaries(sessionId)).toEqual([original]);
	});

	it('rolls an inserted thought and auto-increment state back after a later statement fails', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const before = database.snapshot();
		database.failNextStatement(COUNT_SESSION_THOUGHTS_SQL);

		// When / Then
		await expect(
			persistence.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ id: 'rolled-back-insert' })
			)
		).rejects.toThrow(COUNT_SESSION_THOUGHTS_SQL);
		expect(database.snapshot()).toEqual(before);
	});

	it('rolls edge replacement data back when insertion fails after deletion', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('edge-replacement-rollback');
		const original = edgeFixture({ id: 'edge-original', sessionId, createdAt: 1 });
		await persistence.saveEdges(sessionId, [original]);
		const before = database.snapshot();
		database.failNextStatement(INSERT_EDGE_SQL);

		// When / Then
		await expect(
			persistence.saveEdges(sessionId, [
				edgeFixture({ id: 'edge-replacement', sessionId, createdAt: 2 }),
			])
		).rejects.toThrow(INSERT_EDGE_SQL);
		expect(database.snapshot()).toEqual(before);
		expect(await persistence.loadEdges(sessionId)).toEqual([original]);
	});

	it('rolls retention deletion and auto-increment back when commit fails', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence({ maxHistorySize: 1 });
		const original = createTestThought({ id: 'retained-original' });
		await persistence.saveThoughtForSession(TEST_SESSION_ID, original);
		const before = database.snapshot();
		database.failNextCommit();

		// When / Then
		await expect(
			persistence.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ id: 'retained-replacement' })
			)
		).rejects.toThrow('COMMIT');
		expect(database.snapshot()).toEqual(before);
		expect(await persistence.loadHistoryForSession(TEST_SESSION_ID)).toEqual([original]);
	});

	it('rolls branch replacement data back when commit fails', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const branchId = asBranchId('branch-commit-rollback');
		const original = createTestThought({ id: 'branch-original' });
		await persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [original]);
		const before = database.snapshot();
		database.failNextCommit();

		// When / Then
		await expect(
			persistence.saveBranchForSession(TEST_SESSION_ID, branchId, [
				createTestThought({ id: 'branch-replacement' }),
			])
		).rejects.toThrow('COMMIT');
		expect(database.snapshot()).toEqual(before);
		expect(await persistence.loadBranchForSession(TEST_SESSION_ID, branchId)).toEqual([original]);
	});

	it('rolls scoped clear data back after a later namespace delete fails', async () => {
		// Given
		const { database, persistence } = createStructuralPersistence();
		const sessionId = asSessionId('clear-rollback');
		const branchId = asBranchId('clear-rollback-branch');
		await persistence.saveThoughtForSession(
			sessionId,
			createTestThought({ id: 'clear-thought', session_id: sessionId })
		);
		await persistence.saveBranchForSession(sessionId, branchId, []);
		await persistence.saveEdges(sessionId, [
			edgeFixture({ id: 'clear-edge', sessionId, createdAt: 1 }),
		]);
		await persistence.saveSummaries(sessionId, [
			summaryFixture({ id: 'clear-summary', sessionId, createdAt: 1 }),
		]);
		const before = database.snapshot();
		database.failNextStatement(DELETE_EDGES_FOR_SESSION_SQL);

		// When / Then
		await expect(persistence.clearSession(sessionId)).rejects.toThrow(DELETE_EDGES_FOR_SESSION_SQL);
		expect(database.snapshot()).toEqual(before);
	});
});
