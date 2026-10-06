import type { SqliteDatabase, SqliteDatabaseConstructor, SqliteStatement } from './SqliteDriver.js';

export interface BunSqliteModule {
	readonly Database: new (path: string, flags: number) => Omit<SqliteDatabase, 'pragma'>;
	readonly constants: {
		readonly SQLITE_OPEN_READONLY: number;
		readonly SQLITE_OPEN_READWRITE: number;
		readonly SQLITE_OPEN_CREATE: number;
	};
}

export function createBunSqliteDatabaseConstructor(
	module: BunSqliteModule
): SqliteDatabaseConstructor {
	return class BunSqliteDatabase implements SqliteDatabase {
		private readonly _database: Omit<SqliteDatabase, 'pragma'>;

		constructor(
			path: string,
			options?: { readonly readonly?: boolean; readonly fileMustExist?: boolean }
		) {
			const { SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE } = module.constants;
			const flags = options?.readonly
				? SQLITE_OPEN_READONLY
				: SQLITE_OPEN_READWRITE | (options?.fileMustExist ? 0 : SQLITE_OPEN_CREATE);
			this._database = new module.Database(path, flags);
		}

		exec(sql: string): void {
			this._database.exec(sql);
		}

		prepare(sql: string): SqliteStatement {
			const statement = this._database.prepare(sql);
			return {
				run: (...params) => {
					const { changes, lastInsertRowid } = statement.run(...params);
					return { changes, lastInsertRowid };
				},
				get: (...params) => statement.get(...params) ?? undefined,
				all: (...params) => statement.all(...params),
			};
		}

		pragma(source: string): unknown {
			return this._database.prepare(`PRAGMA ${source}`).all();
		}

		close(): void {
			this._database.close();
		}
	};
}
