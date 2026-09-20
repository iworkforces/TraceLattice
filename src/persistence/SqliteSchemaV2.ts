import { PersistenceCompatibilityError } from '../errors.js';
import type { SqliteDatabase } from './SqliteDriver.js';
import { runSqliteTransaction } from './SqliteDriver.js';

export const SQLITE_V2_SCHEMA_DDL = `
CREATE TABLE schema_version (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 2)
);
CREATE TABLE thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*')
);
CREATE INDEX idx_thoughts_session_id ON thoughts(session_id, id);
CREATE TABLE branches (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, branch_id),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(branch_id) BETWEEN 1 AND 50),
  CHECK (branch_id NOT GLOB '*[^A-Za-z0-9_-]*')
);
CREATE TABLE edges (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  PRIMARY KEY (session_id, id),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*')
);
CREATE INDEX idx_edges_session_created ON edges(session_id, created_at, id);
CREATE INDEX idx_edges_from ON edges(session_id, from_id);
CREATE INDEX idx_edges_to ON edges(session_id, to_id);
CREATE TABLE summaries (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch_id TEXT,
  root_thought_id TEXT NOT NULL,
  covered_ids TEXT NOT NULL,
  covered_range_start INTEGER NOT NULL,
  covered_range_end INTEGER NOT NULL,
  topics TEXT NOT NULL,
  aggregate_confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  meta TEXT,
  PRIMARY KEY (session_id, id),
  CHECK (length(session_id) BETWEEN 1 AND 100),
  CHECK (session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (branch_id IS NULL OR (
    length(branch_id) BETWEEN 1 AND 50
    AND branch_id NOT GLOB '*[^A-Za-z0-9_-]*'
  )),
  CHECK (aggregate_confidence >= 0.0 AND aggregate_confidence <= 1.0)
);
CREATE INDEX idx_summaries_session_created
  ON summaries(session_id, created_at, id);
CREATE INDEX idx_summaries_session_branch
  ON summaries(session_id, branch_id);
`;

export const SQLITE_V2_VERSION_INSERT =
	'INSERT INTO schema_version (singleton, version) VALUES (1, 2);';

type SchemaObject = {
	readonly type: string;
	readonly name: string;
	readonly tableName: string;
	readonly sql: string;
};

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').replace(/;$/, '').trim().toLowerCase();
}

function expectedV2Objects(): Map<string, string> {
	const objects = new Map<string, string>();
	for (const statement of SQLITE_V2_SCHEMA_DDL.split(';')
		.map((sql) => sql.trim())
		.filter(Boolean)) {
		const match = /^CREATE\s+(TABLE|INDEX)\s+([^\s(]+)/i.exec(statement);
		if (match?.[1] === undefined || match[2] === undefined) continue;
		objects.set(`${match[1].toLowerCase()}:${match[2]}`, normalizeSql(statement));
	}
	return objects;
}

const V2_OBJECTS = expectedV2Objects();

function readSchemaObject(row: unknown, sourcePath: string): SchemaObject {
	if (typeof row !== 'object' || row === null) {
		throw new PersistenceCompatibilityError(sourcePath, 'invalid sqlite_master row');
	}
	const type = 'type' in row ? row.type : undefined;
	const name = 'name' in row ? row.name : undefined;
	const tableName = 'tbl_name' in row ? row.tbl_name : undefined;
	const sql = 'sql' in row ? row.sql : undefined;
	if (
		typeof type !== 'string' ||
		typeof name !== 'string' ||
		typeof tableName !== 'string' ||
		typeof sql !== 'string'
	) {
		throw new PersistenceCompatibilityError(sourcePath, 'invalid sqlite_master fields');
	}
	return { type, name, tableName, sql };
}

export function sqliteSchemaObjects(database: SqliteDatabase, sourcePath: string): SchemaObject[] {
	return database
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
		)
		.all()
		.map((row) => readSchemaObject(row, sourcePath));
}

export function validateSqliteV2Schema(database: SqliteDatabase, sourcePath: string): void {
	const objects = sqliteSchemaObjects(database, sourcePath);
	if (objects.length !== V2_OBJECTS.size) {
		throw new PersistenceCompatibilityError(sourcePath, 'database does not match SQLite v2 schema');
	}
	for (const object of objects) {
		const expected = V2_OBJECTS.get(`${object.type}:${object.name}`);
		if (expected === undefined || normalizeSql(object.sql) !== expected) {
			throw new PersistenceCompatibilityError(sourcePath, 'database does not match SQLite v2 schema');
		}
	}
	const versionRows = database.prepare('SELECT singleton, version FROM schema_version').all();
	const versionRow = versionRows[0];
	if (
		versionRows.length !== 1 ||
		typeof versionRow !== 'object' ||
		versionRow === null ||
		!('singleton' in versionRow) ||
		versionRow.singleton !== 1 ||
		!('version' in versionRow) ||
		versionRow.version !== 2
	) {
		throw new PersistenceCompatibilityError(
			sourcePath,
			'schema_version must contain exactly (1, 2)'
		);
	}
}

export function initializeOrValidateSqliteV2(database: SqliteDatabase, sourcePath: string): void {
	const objects = sqliteSchemaObjects(database, sourcePath);
	if (objects.length === 0) {
		runSqliteTransaction(database, () => {
			database.exec(SQLITE_V2_SCHEMA_DDL);
			database.exec(SQLITE_V2_VERSION_INSERT);
		});
	}
	validateSqliteV2Schema(database, sourcePath);
}
