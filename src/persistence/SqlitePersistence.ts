import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
	PersistenceConfig,
	PersistenceBackend,
} from '../contracts/PersistenceBackend.js';
import { asSessionId, type BranchId, type SessionId } from '../contracts/ids.js';
import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceCompatibilityError, PersistenceCorruptionError } from '../errors.js';
import type { SqliteDatabase, SqliteDatabaseConstructor } from './SqliteDriver.js';
import { runSqliteReadTransaction, runSqliteTransaction } from './SqliteDriver.js';
import {
	decodeEdgeRow,
	decodeSummaryRow,
	decodeThoughtRow,
	numberField,
	stringField,
} from './SqlitePayload.js';
import {
	assertBranchScope,
	assertEdgeScopes,
	assertPersistableThoughtCollections,
	assertPersistableThoughts,
	assertSummaryScopes,
	assertThoughtScope,
	compareCodePoint,
	parsePersistenceBranchId,
	type PersistedThoughtCollection,
} from './PersistenceScope.js';
import { initializeOrValidateSqliteV2 } from './SqliteSchemaV2.js';

type SqliteOptions = PersistenceConfig['options'];

type ValidatedThoughtState = {
	readonly history: ThoughtData[];
	readonly branches: ReadonlyMap<BranchId, ThoughtData[]>;
};

export class SqlitePersistence implements PersistenceBackend {
	private constructor(
		private readonly _db: SqliteDatabase,
		private readonly _sourcePath: string,
		private readonly _maxHistorySize: number,
		private readonly _persistBranches: boolean
	) {}

	public static createWithDatabase(
		database: SqliteDatabase,
		options: SqliteOptions = {},
		sourcePath = '<structural-sqlite>'
	): SqlitePersistence {
		initializeOrValidateSqliteV2(database, sourcePath);
		return new SqlitePersistence(
			database,
			sourcePath,
			options?.maxHistorySize ?? 10000,
			options?.persistBranches ?? true
		);
	}

	public static async create(options?: SqliteOptions): Promise<SqlitePersistence> {
		const defaultDataDir = existsSync('.claude/data')
			? '.claude/data'
			: join(homedir(), '.claude/data');
		const dbPath = options?.dbPath ?? join(defaultDataDir, 'history.db');
		let Database: SqliteDatabaseConstructor;
		try {
			const module = await import('better-sqlite3');
			Database = module.default;
		} catch (error) {
			throw new PersistenceCompatibilityError(
				dbPath,
				"SQLite persistence requires the optional 'better-sqlite3' package",
				error
			);
		}
		const database = new Database(dbPath);
		try {
			const persistence = SqlitePersistence.createWithDatabase(database, options, dbPath);
			if (options?.enableWAL !== false) database.pragma('journal_mode = WAL');
			database.pragma('synchronous = NORMAL');
			database.pragma('foreign_keys = ON');
			database.pragma('busy_timeout = 5000');
			database.pragma('cache_size = -64000');
			database.pragma('temp_store = MEMORY');
			return persistence;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	public async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertThoughtScope('saveThoughtForSession', validatedSessionId, thought);
		this._saveThought(validatedSessionId, thought);
	}

	private _saveThought(sessionId: SessionId, thought: ThoughtData): void {
		runSqliteTransaction(this._db, () => {
			this._loadValidatedThoughtState(sessionId, [thought]);
			this._db
				.prepare('INSERT INTO thoughts (session_id, data) VALUES (?, ?)')
				.run(sessionId, JSON.stringify(thought));
			if (this._maxHistorySize > 0) {
				const countRow = this._db
					.prepare('SELECT COUNT(*) AS count FROM thoughts WHERE session_id = ?')
					.get(sessionId);
				const excess =
					numberField(countRow, 'count', `${this._sourcePath}:thought-count`) -
					this._maxHistorySize;
				if (excess > 0) {
					this._db
						.prepare(
							'DELETE FROM thoughts WHERE id IN (SELECT id FROM thoughts WHERE session_id = ? ORDER BY id ASC LIMIT ?)'
						)
						.run(sessionId, excess);
				}
			}
		});
	}

	public async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		const validatedSessionId = asSessionId(sessionId);
		return runSqliteReadTransaction(
			this._db,
			() => this._loadValidatedThoughtState(validatedSessionId).history
		);
	}

	public async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${this._sourcePath}:branches`);
		assertBranchScope('saveBranchForSession', validatedSessionId, validatedBranchId, thoughts);
		this._saveBranch(validatedSessionId, validatedBranchId, thoughts);
	}

	private _saveBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): void {
		assertPersistableThoughts(thoughts, `${this._sourcePath}:branch:${branchId}`);
		if (!this._persistBranches) {
			runSqliteReadTransaction(this._db, () =>
				this._loadValidatedThoughtState(sessionId, thoughts, branchId)
			);
			return;
		}
		runSqliteTransaction(this._db, () => {
			this._loadValidatedThoughtState(sessionId, thoughts, branchId);
			this._db
				.prepare('INSERT OR REPLACE INTO branches (session_id, branch_id, data) VALUES (?, ?, ?)')
				.run(sessionId, branchId, JSON.stringify(thoughts));
		});
	}

	public async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		if (!this._persistBranches) return;
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${this._sourcePath}:branches`);
		runSqliteTransaction(this._db, () => {
			this._db
				.prepare('DELETE FROM branches WHERE session_id = ? AND branch_id = ?')
				.run(validatedSessionId, validatedBranchId);
		});
	}

	public async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		if (!this._persistBranches) return undefined;
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${this._sourcePath}:branches`);
		return runSqliteReadTransaction(this._db, () =>
			this._loadValidatedThoughtState(validatedSessionId).branches.get(validatedBranchId)
		);
	}

	public async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		if (!this._persistBranches) return [];
		return this._db
			.prepare('SELECT branch_id FROM branches WHERE session_id = ? ORDER BY branch_id ASC')
			.all(asSessionId(sessionId))
			.map((row) =>
				parsePersistenceBranchId(stringField(row, 'branch_id', this._sourcePath), this._sourcePath)
			);
	}

	public async listSessions(): Promise<SessionId[]> {
		return this._db
			.prepare(
				'SELECT session_id FROM thoughts UNION SELECT session_id FROM branches UNION SELECT session_id FROM edges UNION SELECT session_id FROM summaries'
			)
			.all()
			.map((row) => asSessionId(stringField(row, 'session_id', this._sourcePath)))
			.sort(compareCodePoint);
	}

	public async clearAll(): Promise<void> {
		runSqliteTransaction(this._db, () => {
			for (const table of ['thoughts', 'branches', 'edges', 'summaries'])
				this._db.exec(`DELETE FROM ${table}`);
		});
	}

	public async clearSession(sessionId: SessionId): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		runSqliteTransaction(this._db, () => {
			for (const table of ['thoughts', 'branches', 'edges', 'summaries']) {
				this._db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(validatedSessionId);
			}
		});
	}

	public async saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertEdgeScopes(validatedSessionId, edges);
		runSqliteTransaction(this._db, () => {
			this._db.prepare('DELETE FROM edges WHERE session_id = ?').run(validatedSessionId);
			const insert = this._db.prepare(
				'INSERT INTO edges (id, session_id, from_id, to_id, kind, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
			);
			for (const edge of edges)
				insert.run(
					edge.id,
					edge.sessionId,
					edge.from,
					edge.to,
					edge.kind,
					edge.createdAt,
					edge.metadata === undefined ? null : JSON.stringify(edge.metadata)
				);
		});
	}

	public async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		const validatedSessionId = asSessionId(sessionId);
		return this._db
			.prepare(
				'SELECT id, session_id, from_id, to_id, kind, created_at, metadata FROM edges WHERE session_id = ? ORDER BY created_at ASC, id ASC'
			)
			.all(validatedSessionId)
			.map((row, index) => decodeEdgeRow(row, `${this._sourcePath}:edges:${index}`));
	}

	public async saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertSummaryScopes(validatedSessionId, summaries);
		runSqliteTransaction(this._db, () => {
			this._db.prepare('DELETE FROM summaries WHERE session_id = ?').run(validatedSessionId);
			const insert = this._db.prepare(
				'INSERT INTO summaries (id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			);
			for (const summary of summaries)
				insert.run(
					summary.id,
					summary.sessionId,
					summary.branchId ?? null,
					summary.rootThoughtId,
					JSON.stringify(summary.coveredIds),
					summary.coveredRange[0],
					summary.coveredRange[1],
					JSON.stringify(summary.topics),
					summary.aggregateConfidence,
					summary.createdAt,
					summary.meta === undefined ? null : JSON.stringify(summary.meta)
				);
		});
	}

	public async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		const validatedSessionId = asSessionId(sessionId);
		return this._db
			.prepare(
				'SELECT id, session_id, branch_id, root_thought_id, covered_ids, covered_range_start, covered_range_end, topics, aggregate_confidence, created_at, meta FROM summaries WHERE session_id = ? ORDER BY created_at ASC, id ASC'
			)
			.all(validatedSessionId)
			.map((row, index) => decodeSummaryRow(row, `${this._sourcePath}:summaries:${index}`));
	}

	public async healthy(): Promise<boolean> {
		try {
			this._db.prepare('SELECT 1').get();
			return true;
		} catch (error) {
			if (error instanceof Error) return false;
			throw error;
		}
	}

	public async close(): Promise<void> {
		this._db.close();
	}

	public getStats(): {
		readonly thoughtCount: number;
		readonly branchCount: number;
		readonly dbSize: number;
	} {
		const thoughtCount = numberField(
			this._db.prepare('SELECT COUNT(*) AS count FROM thoughts').get(),
			'count',
			this._sourcePath
		);
		const branchCount = numberField(
			this._db.prepare('SELECT COUNT(*) AS count FROM branches').get(),
			'count',
			this._sourcePath
		);
		return { thoughtCount, branchCount: this._persistBranches ? branchCount : 0, dbSize: 0 };
	}

	private _loadValidatedThoughtState(
		sessionId: SessionId,
		candidates: readonly ThoughtData[] = [],
		replacingBranch?: BranchId
	): ValidatedThoughtState {
		const history = this.loadHistoryRows(sessionId);
		for (const thought of history) {
			assertThoughtScope('saveThoughtForSession', sessionId, thought);
		}
		const collections: PersistedThoughtCollection[] = [
			{
				sessionId,
				thoughts: replacingBranch === undefined ? [...history, ...candidates] : history,
			},
		];
		const branches = new Map<BranchId, ThoughtData[]>();
		for (const row of this._db
			.prepare('SELECT branch_id, data FROM branches WHERE session_id = ?')
			.all(sessionId)) {
			const branchId = parsePersistenceBranchId(
				stringField(row, 'branch_id', this._sourcePath),
				this._sourcePath
			);
			const data = stringField(row, 'data', this._sourcePath);
			let values: unknown;
			try {
				values = JSON.parse(data);
			} catch (error) {
				throw new PersistenceCorruptionError(this._sourcePath, error);
			}
			if (!Array.isArray(values))
				throw new PersistenceCorruptionError(
					this._sourcePath,
					new TypeError('branch data is not an array')
				);
			const thoughts = values.map((value, index) =>
				decodeThoughtRow(
					{ data: JSON.stringify(value) },
					`${this._sourcePath}:branch:${sessionId}:${branchId}:${index}`
				)
			);
			assertBranchScope('saveBranchForSession', sessionId, branchId, thoughts);
			branches.set(branchId, thoughts);
			if (branchId !== replacingBranch) collections.push({ sessionId, thoughts });
		}
		if (replacingBranch !== undefined) {
			collections.push({ sessionId, thoughts: candidates });
		}
		assertPersistableThoughtCollections(collections, this._sourcePath);
		return { history, branches };
	}

	private loadHistoryRows(sessionId: SessionId): ThoughtData[] {
		return this._db
			.prepare('SELECT data FROM thoughts WHERE session_id = ? ORDER BY id ASC')
			.all(sessionId)
			.map((row) => decodeThoughtRow(row, this._sourcePath));
	}
}
