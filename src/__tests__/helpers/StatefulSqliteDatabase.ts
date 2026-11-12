import type {
	SqliteDatabase,
	SqliteRunResult,
	SqliteStatement,
} from '../../persistence/SqliteDriver.js';
import {
	SQLITE_V2_SCHEMA_DDL,
	SQLITE_V2_VERSION_INSERT,
} from '../../persistence/SqliteSchemaV2.js';

const SQL = {
	schemaObjects:
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
	versionRows: 'SELECT singleton, version FROM schema_version',
	insertThought: 'INSERT INTO thoughts (session_id, data) VALUES (?, ?)',
	countSessionThoughts: 'SELECT COUNT(*) AS count FROM thoughts WHERE session_id = ?',
	trimThoughts:
		'DELETE FROM thoughts WHERE id IN (SELECT id FROM thoughts WHERE session_id = ? ORDER BY id ASC LIMIT ?)',
	selectHistory: 'SELECT data FROM thoughts WHERE session_id = ? ORDER BY id ASC',
	replaceBranch: 'INSERT OR REPLACE INTO branches (session_id, branch_id, data) VALUES (?, ?, ?)',
	deleteBranch: 'DELETE FROM branches WHERE session_id = ? AND branch_id = ?',
	selectBranch: 'SELECT data FROM branches WHERE session_id = ? AND branch_id = ?',
	listBranches: 'SELECT branch_id FROM branches WHERE session_id = ? ORDER BY branch_id ASC',
	listSessions:
		'SELECT session_id FROM thoughts UNION SELECT session_id FROM branches UNION SELECT session_id FROM edges UNION SELECT session_id FROM summaries',
	deleteThoughtsSession: 'DELETE FROM thoughts WHERE session_id = ?',
	deleteBranchesSession: 'DELETE FROM branches WHERE session_id = ?',
	deleteEdgesSession: 'DELETE FROM edges WHERE session_id = ?',
	deleteSummariesSession: 'DELETE FROM summaries WHERE session_id = ?',
	insertEdge:
		'INSERT INTO edges (id, session_id, from_id, to_id, kind, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
	selectEdges:
		'SELECT id, session_id, from_id, to_id, kind, created_at, metadata FROM edges WHERE session_id = ? ORDER BY created_at ASC, id ASC',
	listEdgeSessions: 'SELECT DISTINCT session_id FROM edges ORDER BY session_id ASC',
	insertSummary:
		'INSERT INTO summaries (id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	selectSummaries:
		'SELECT id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta FROM summaries WHERE session_id = ? ORDER BY created_at ASC, id ASC',
	health: 'SELECT 1',
	countThoughts: 'SELECT COUNT(*) AS count FROM thoughts',
	countBranches: 'SELECT COUNT(*) AS count FROM branches',
	selectBranchPayloads: 'SELECT branch_id, data FROM branches WHERE session_id = ?',
} as const;

export const STATEFUL_SQLITE_SQL = SQL;

const EXEC_SQL = [
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
] as const;

const PREPARED_SQL = new Set<string>(Object.values(SQL));
const EXEC_SQL_SET = new Set<string>(EXEC_SQL);

export const STATEFUL_SQLITE_SUPPORTED_SQL = {
	exec: EXEC_SQL,
	prepared: Object.values(SQL),
} as const;

type SchemaRow = {
	readonly type: string;
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string;
};

type ThoughtRow = {
	readonly id: number;
	readonly session_id: string;
	data: string;
};

type BranchRow = {
	readonly session_id: string;
	readonly branch_id: string;
	data: string;
};

type EdgeRow = {
	readonly id: string;
	readonly session_id: string;
	readonly from_id: string;
	readonly to_id: string;
	readonly kind: string;
	readonly created_at: number;
	metadata: string | null;
};

type SummaryRow = {
	readonly id: string;
	readonly session_id: string;
	readonly branch_id: string | null;
	readonly root_thought_id: string;
	readonly covered_ids: string;
	readonly covered_range_start: number;
	readonly covered_range_end: number;
	topics: string;
	readonly aggregate_confidence: number;
	readonly created_at: number;
	readonly meta: string | null;
};

type DatabaseState = {
	schemaRows: SchemaRow[];
	versionRows: unknown[];
	thoughts: ThoughtRow[];
	branches: Map<string, Map<string, BranchRow>>;
	edges: Map<string, Map<string, EdgeRow>>;
	summaries: Map<string, Map<string, SummaryRow>>;
	nextThoughtId: number;
};

type StatementMethod = 'run' | 'get' | 'all';

type StatementObservation = {
	readonly sql: string;
	readonly inTransaction: boolean;
};

type AfterStatementHook = {
	readonly sql: string;
	readonly callback: () => void;
};

export class UnsupportedStructuralSqlError extends Error {
	public constructor(surface: string, sql: string) {
		super(`unsupported structural SQLite ${surface}: ${sql}`);
		this.name = 'UnsupportedStructuralSqlError';
	}
}

class StructuralSqliteFailure extends Error {
	public constructor(target: string) {
		super(`injected structural SQLite failure: ${target}`);
		this.name = 'StructuralSqliteFailure';
	}
}

function compareCodePoint(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function schemaRowsFromDdl(): SchemaRow[] {
	return SQLITE_V2_SCHEMA_DDL.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean)
		.flatMap((statement) => {
			const match = /^CREATE\s+(TABLE|INDEX)\s+([^\s(]+)/i.exec(statement);
			if (match?.[1] === undefined || match[2] === undefined) return [];
			const type = match[1].toLowerCase();
			const tableMatch = type === 'index' ? /\sON\s+([^\s(]+)/i.exec(statement) : undefined;
			return [
				{
					type,
					name: match[2],
					tbl_name: tableMatch?.[1] ?? match[2],
					sql: statement,
				},
			];
		});
}

function cloneNestedRows<Row>(
	source: Map<string, Map<string, Row>>
): Map<string, Map<string, Row>> {
	return new Map(
		[...source].map(([sessionId, rows]) => [
			sessionId,
			new Map([...rows].map(([id, row]) => [id, structuredClone(row)])),
		])
	);
}

function cloneState(state: DatabaseState): DatabaseState {
	return {
		schemaRows: state.schemaRows.map((row) => ({ ...row })),
		versionRows: structuredClone(state.versionRows),
		thoughts: state.thoughts.map((row) => ({ ...row })),
		branches: cloneNestedRows(state.branches),
		edges: cloneNestedRows(state.edges),
		summaries: cloneNestedRows(state.summaries),
		nextThoughtId: state.nextThoughtId,
	};
}

function parameter(params: readonly unknown[], index: number, sql: string): unknown {
	if (index >= params.length) throw new UnsupportedStructuralSqlError('parameters', sql);
	return params[index];
}

function stringParameter(params: readonly unknown[], index: number, sql: string): string {
	const value = parameter(params, index, sql);
	if (typeof value !== 'string') throw new UnsupportedStructuralSqlError('parameters', sql);
	return value;
}

function numberParameter(params: readonly unknown[], index: number, sql: string): number {
	const value = parameter(params, index, sql);
	if (typeof value !== 'number') throw new UnsupportedStructuralSqlError('parameters', sql);
	return value;
}

function nullableStringParameter(
	params: readonly unknown[],
	index: number,
	sql: string
): string | null {
	const value = parameter(params, index, sql);
	if (value !== null && typeof value !== 'string')
		throw new UnsupportedStructuralSqlError('parameters', sql);
	return value;
}

function result(changes: number, lastInsertRowid = 0): SqliteRunResult {
	return { changes, lastInsertRowid };
}

function emptyState(): DatabaseState {
	return {
		schemaRows: [],
		versionRows: [],
		thoughts: [],
		branches: new Map(),
		edges: new Map(),
		summaries: new Map(),
		nextThoughtId: 1,
	};
}

export class StatefulSqliteDatabase implements SqliteDatabase {
	public readonly execLog: string[] = [];
	public readonly statementLog: StatementObservation[] = [];
	private _state = emptyState();
	private _transactionSnapshot: DatabaseState | undefined;
	// A plain BEGIN reads from this frozen view; seeders and overwrites below keep acting on the
	// committed state, which models another connection committing while the reader is open.
	private _readView: DatabaseState | undefined;
	private _beforeNextBeginImmediate: (() => void) | undefined;
	private _afterNextStatement: AfterStatementHook | undefined;
	private _failingStatement: string | undefined;
	private _commitWillFail = false;
	private _healthy = true;
	private _closed = false;

	public exec(sql: string): void {
		this._assertOpen();
		if (!EXEC_SQL_SET.has(sql)) {
			throw new UnsupportedStructuralSqlError('exec', sql);
		}
		this.execLog.push(sql);
		switch (sql) {
			case 'BEGIN':
				if (this._transactionSnapshot !== undefined)
					throw new StructuralSqliteFailure('nested transaction');
				this._transactionSnapshot = cloneState(this._state);
				this._readView = this._transactionSnapshot;
				return;
			case 'BEGIN IMMEDIATE': {
				if (this._transactionSnapshot !== undefined)
					throw new StructuralSqliteFailure('nested transaction');
				const beforeBegin = this._beforeNextBeginImmediate;
				this._beforeNextBeginImmediate = undefined;
				beforeBegin?.();
				this._transactionSnapshot = cloneState(this._state);
				return;
			}
			case 'COMMIT':
				if (this._transactionSnapshot === undefined)
					throw new StructuralSqliteFailure('commit without transaction');
				if (this._commitWillFail) {
					this._commitWillFail = false;
					throw new StructuralSqliteFailure('COMMIT');
				}
				this._transactionSnapshot = undefined;
				this._readView = undefined;
				return;
			case 'ROLLBACK':
				if (this._transactionSnapshot === undefined)
					throw new StructuralSqliteFailure('rollback without transaction');
				if (this._readView === undefined) this._state = this._transactionSnapshot;
				this._transactionSnapshot = undefined;
				this._readView = undefined;
				return;
			case SQLITE_V2_SCHEMA_DDL:
				this._state.schemaRows = schemaRowsFromDdl();
				return;
			case SQLITE_V2_VERSION_INSERT:
				this._state.versionRows = [{ singleton: 1, version: 2 }];
				return;
			case 'DELETE FROM thoughts':
				this._state.thoughts = [];
				return;
			case 'DELETE FROM branches':
				this._state.branches.clear();
				return;
			case 'DELETE FROM edges':
				this._state.edges.clear();
				return;
			case 'DELETE FROM summaries':
				this._state.summaries.clear();
				return;
			default:
				throw new UnsupportedStructuralSqlError('exec', sql);
		}
	}

	public prepare(sql: string): SqliteStatement {
		this._assertOpen();
		if (!PREPARED_SQL.has(sql)) throw new UnsupportedStructuralSqlError('prepare', sql);
		return {
			run: (...params) => this._observe(sql, () => this._run(sql, params)),
			get: (...params) => this._observe(sql, () => this._get(sql, params)),
			all: (...params) => this._observe(sql, () => this._all(sql, params)),
		};
	}

	public close(): void {
		this._closed = true;
	}

	public pragma(pragma: string): unknown {
		throw new UnsupportedStructuralSqlError('pragma', pragma);
	}

	public failNextStatement(sql: string): void {
		if (!PREPARED_SQL.has(sql)) throw new UnsupportedStructuralSqlError('failure target', sql);
		this._failingStatement = sql;
	}

	public failNextCommit(): void {
		this._commitWillFail = true;
	}

	public beforeNextBeginImmediate(callback: () => void): void {
		this._beforeNextBeginImmediate = callback;
	}

	public afterNextStatement(sql: string, callback: () => void): void {
		if (!PREPARED_SQL.has(sql)) throw new UnsupportedStructuralSqlError('hook target', sql);
		this._afterNextStatement = { sql, callback };
	}

	public removeBranchData(sessionId: string, branchId: string): void {
		const branches = this._state.branches.get(sessionId);
		branches?.delete(branchId);
		if (branches?.size === 0) this._state.branches.delete(sessionId);
	}

	public setHealthy(healthy: boolean): void {
		this._healthy = healthy;
	}

	public seedBranchData(sessionId: string, branchId: string, data: string): void {
		this._rowsFor(this._state.branches, sessionId).set(branchId, {
			session_id: sessionId,
			branch_id: branchId,
			data,
		});
	}

	public seedThoughtData(sessionId: string, data: string): void {
		const id = this._state.nextThoughtId;
		this._state.nextThoughtId++;
		this._state.thoughts.push({ id, session_id: sessionId, data });
	}

	public overwriteThoughtData(sessionId: string, data: string): void {
		const row = this._state.thoughts.find((thought) => thought.session_id === sessionId);
		if (row === undefined) throw new StructuralSqliteFailure('missing thought row');
		row.data = data;
	}

	public overwriteBranchData(sessionId: string, branchId: string, data: string): void {
		const row = this._state.branches.get(sessionId)?.get(branchId);
		if (row === undefined) throw new StructuralSqliteFailure('missing branch row');
		row.data = data;
	}

	public overwriteEdgeMetadata(sessionId: string, edgeId: string, metadata: string): void {
		const row = this._state.edges.get(sessionId)?.get(edgeId);
		if (row === undefined) throw new StructuralSqliteFailure('missing edge row');
		row.metadata = metadata;
	}

	public overwriteSummaryTopics(sessionId: string, summaryId: string, topics: string): void {
		const row = this._state.summaries.get(sessionId)?.get(summaryId);
		if (row === undefined) throw new StructuralSqliteFailure('missing summary row');
		row.topics = topics;
	}

	public snapshot() {
		const nestedRows = <Row>(source: Map<string, Map<string, Row>>) =>
			[...source]
				.sort(([left], [right]) => compareCodePoint(left, right))
				.flatMap(([, rows]) =>
					[...rows]
						.sort(([left], [right]) => compareCodePoint(left, right))
						.map(([, row]) => structuredClone(row))
				);
		return {
			schemaRows: this._state.schemaRows.map((row) => ({ ...row })),
			versionRows: structuredClone(this._state.versionRows),
			thoughts: this._state.thoughts.map((row) => ({ ...row })),
			branches: nestedRows(this._state.branches),
			edges: nestedRows(this._state.edges),
			summaries: nestedRows(this._state.summaries),
			nextThoughtId: this._state.nextThoughtId,
			healthy: this._healthy,
			closed: this._closed,
		};
	}

	private _run(sql: string, params: readonly unknown[]): SqliteRunResult {
		this._maybeFail(sql);
		switch (sql) {
			case SQL.insertThought:
				return this._insertThought(params);
			case SQL.trimThoughts:
				return this._trimThoughts(params);
			case SQL.replaceBranch:
				return this._replaceBranch(params);
			case SQL.deleteBranch:
				return this._deleteBranch(params);
			case SQL.deleteThoughtsSession:
				return this._deleteThoughts(stringParameter(params, 0, sql));
			case SQL.deleteBranchesSession:
				return this._deleteNested(this._state.branches, stringParameter(params, 0, sql));
			case SQL.deleteEdgesSession:
				return this._deleteNested(this._state.edges, stringParameter(params, 0, sql));
			case SQL.deleteSummariesSession:
				return this._deleteNested(this._state.summaries, stringParameter(params, 0, sql));
			case SQL.insertEdge:
				return this._insertEdge(params);
			case SQL.insertSummary:
				return this._insertSummary(params);
			default:
				throw this._wrongMethod('run', sql);
		}
	}

	private _observe<T>(sql: string, execute: () => T): T {
		this.statementLog.push({ sql, inTransaction: this._transactionSnapshot !== undefined });
		const value = execute();
		const hook = this._afterNextStatement;
		if (hook?.sql === sql) {
			this._afterNextStatement = undefined;
			hook.callback();
		}
		return value;
	}

	private _visibleState(): DatabaseState {
		return this._readView ?? this._state;
	}

	private _get(sql: string, params: readonly unknown[]): unknown {
		this._maybeFail(sql);
		const state = this._visibleState();
		switch (sql) {
			case SQL.countSessionThoughts:
				return {
					count: state.thoughts.filter((row) => row.session_id === stringParameter(params, 0, sql))
						.length,
				};
			case SQL.selectBranch: {
				const row = state.branches
					.get(stringParameter(params, 0, sql))
					?.get(stringParameter(params, 1, sql));
				return row === undefined ? undefined : { data: row.data };
			}
			case SQL.health:
				if (!this._healthy) throw new StructuralSqliteFailure('health check');
				return { result: 1 };
			case SQL.countThoughts:
				return { count: state.thoughts.length };
			case SQL.countBranches:
				return {
					count: [...state.branches.values()].reduce((total, branches) => total + branches.size, 0),
				};
			default:
				throw this._wrongMethod('get', sql);
		}
	}

	private _all(sql: string, params: readonly unknown[]): unknown[] {
		this._maybeFail(sql);
		const state = this._visibleState();
		switch (sql) {
			case SQL.schemaObjects:
				return state.schemaRows.map((row) => ({ ...row }));
			case SQL.versionRows:
				return structuredClone(state.versionRows);
			case SQL.selectHistory:
				return state.thoughts
					.filter((row) => row.session_id === stringParameter(params, 0, sql))
					.sort((left, right) => left.id - right.id)
					.map((row) => ({ data: row.data }));
			case SQL.listBranches:
				return [...(state.branches.get(stringParameter(params, 0, sql))?.values() ?? [])]
					.sort((left, right) => compareCodePoint(left.branch_id, right.branch_id))
					.map(({ branch_id }) => ({ branch_id }));
			case SQL.listSessions:
				return [...this._sessionIds(state)].map((session_id) => ({ session_id }));
			case SQL.selectEdges:
				return [...(state.edges.get(stringParameter(params, 0, sql))?.values() ?? [])]
					.sort(
						(left, right) =>
							left.created_at - right.created_at || compareCodePoint(left.id, right.id)
					)
					.map((row) => ({ ...row }));
			case SQL.listEdgeSessions:
				return [...state.edges]
					.filter(([, rows]) => rows.size > 0)
					.map(([session_id]) => ({ session_id }))
					.sort((left, right) => compareCodePoint(left.session_id, right.session_id));
			case SQL.selectSummaries:
				return [...(state.summaries.get(stringParameter(params, 0, sql))?.values() ?? [])]
					.sort(
						(left, right) =>
							left.created_at - right.created_at || compareCodePoint(left.id, right.id)
					)
					.map((row) => ({ ...row }));
			case SQL.selectBranchPayloads:
				return [...(state.branches.get(stringParameter(params, 0, sql))?.values() ?? [])].map(
					({ branch_id, data }) => ({ branch_id, data })
				);
			default:
				throw this._wrongMethod('all', sql);
		}
	}

	private _insertThought(params: readonly unknown[]): SqliteRunResult {
		const id = this._state.nextThoughtId;
		this._state.nextThoughtId++;
		this._state.thoughts.push({
			id,
			session_id: stringParameter(params, 0, SQL.insertThought),
			data: stringParameter(params, 1, SQL.insertThought),
		});
		return result(1, id);
	}

	private _trimThoughts(params: readonly unknown[]): SqliteRunResult {
		const sessionId = stringParameter(params, 0, SQL.trimThoughts);
		const limit = numberParameter(params, 1, SQL.trimThoughts);
		const ids = this._state.thoughts
			.filter((row) => row.session_id === sessionId)
			.sort((left, right) => left.id - right.id)
			.slice(0, Math.max(0, Math.trunc(limit)))
			.map(({ id }) => id);
		const deletedIds = new Set(ids);
		this._state.thoughts = this._state.thoughts.filter((row) => !deletedIds.has(row.id));
		return result(deletedIds.size);
	}

	private _replaceBranch(params: readonly unknown[]): SqliteRunResult {
		const sessionId = stringParameter(params, 0, SQL.replaceBranch);
		const branchId = stringParameter(params, 1, SQL.replaceBranch);
		this._rowsFor(this._state.branches, sessionId).set(branchId, {
			session_id: sessionId,
			branch_id: branchId,
			data: stringParameter(params, 2, SQL.replaceBranch),
		});
		return result(1);
	}

	private _deleteBranch(params: readonly unknown[]): SqliteRunResult {
		const sessionId = stringParameter(params, 0, SQL.deleteBranch);
		const branchId = stringParameter(params, 1, SQL.deleteBranch);
		const branches = this._state.branches.get(sessionId);
		const changes = branches?.delete(branchId) === true ? 1 : 0;
		if (branches?.size === 0) this._state.branches.delete(sessionId);
		return result(changes);
	}

	private _insertEdge(params: readonly unknown[]): SqliteRunResult {
		const id = stringParameter(params, 0, SQL.insertEdge);
		const sessionId = stringParameter(params, 1, SQL.insertEdge);
		const rows = this._rowsFor(this._state.edges, sessionId);
		if (rows.has(id)) throw new StructuralSqliteFailure(`edges primary key ${sessionId}/${id}`);
		rows.set(id, {
			id,
			session_id: sessionId,
			from_id: stringParameter(params, 2, SQL.insertEdge),
			to_id: stringParameter(params, 3, SQL.insertEdge),
			kind: stringParameter(params, 4, SQL.insertEdge),
			created_at: numberParameter(params, 5, SQL.insertEdge),
			metadata: nullableStringParameter(params, 6, SQL.insertEdge),
		});
		return result(1);
	}

	private _insertSummary(params: readonly unknown[]): SqliteRunResult {
		const id = stringParameter(params, 0, SQL.insertSummary);
		const sessionId = stringParameter(params, 1, SQL.insertSummary);
		const rows = this._rowsFor(this._state.summaries, sessionId);
		if (rows.has(id)) throw new StructuralSqliteFailure(`summaries primary key ${sessionId}/${id}`);
		rows.set(id, {
			id,
			session_id: sessionId,
			branch_id: nullableStringParameter(params, 2, SQL.insertSummary),
			root_thought_id: stringParameter(params, 3, SQL.insertSummary),
			covered_ids: stringParameter(params, 4, SQL.insertSummary),
			covered_range_start: numberParameter(params, 5, SQL.insertSummary),
			covered_range_end: numberParameter(params, 6, SQL.insertSummary),
			topics: stringParameter(params, 7, SQL.insertSummary),
			aggregate_confidence: numberParameter(params, 8, SQL.insertSummary),
			created_at: numberParameter(params, 9, SQL.insertSummary),
			meta: nullableStringParameter(params, 10, SQL.insertSummary),
		});
		return result(1);
	}

	private _deleteThoughts(sessionId: string): SqliteRunResult {
		const size = this._state.thoughts.length;
		this._state.thoughts = this._state.thoughts.filter((row) => row.session_id !== sessionId);
		return result(size - this._state.thoughts.length);
	}

	private _deleteNested<Row>(
		source: Map<string, Map<string, Row>>,
		sessionId: string
	): SqliteRunResult {
		const changes = source.get(sessionId)?.size ?? 0;
		source.delete(sessionId);
		return result(changes);
	}

	private _rowsFor<Row>(
		source: Map<string, Map<string, Row>>,
		sessionId: string
	): Map<string, Row> {
		let rows = source.get(sessionId);
		if (rows === undefined) {
			rows = new Map();
			source.set(sessionId, rows);
		}
		return rows;
	}

	private _sessionIds(state: DatabaseState): Set<string> {
		const sessionIds = new Set(state.thoughts.map(({ session_id }) => session_id));
		for (const [sessionId, rows] of state.branches) if (rows.size > 0) sessionIds.add(sessionId);
		for (const [sessionId, rows] of state.edges) if (rows.size > 0) sessionIds.add(sessionId);
		for (const [sessionId, rows] of state.summaries) if (rows.size > 0) sessionIds.add(sessionId);
		return sessionIds;
	}

	private _maybeFail(sql: string): void {
		if (this._failingStatement !== sql) return;
		this._failingStatement = undefined;
		throw new StructuralSqliteFailure(sql);
	}

	private _wrongMethod(method: StatementMethod, sql: string): UnsupportedStructuralSqlError {
		return new UnsupportedStructuralSqlError(`statement ${method}`, sql);
	}

	private _assertOpen(): void {
		if (this._closed) throw new StructuralSqliteFailure('database is closed');
	}
}
