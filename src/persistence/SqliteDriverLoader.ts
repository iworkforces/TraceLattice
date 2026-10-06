import { PersistenceCompatibilityError } from '../errors.js';
import { createBunSqliteDatabaseConstructor, type BunSqliteModule } from './BunSqliteDriver.js';
import type { SqliteDatabaseConstructor } from './SqliteDriver.js';

export interface SqliteDriverRuntime {
	readonly isBun: () => boolean;
	readonly importBunSqlite: () => Promise<BunSqliteModule>;
	readonly importBetterSqlite3: () => Promise<{ readonly default: SqliteDatabaseConstructor }>;
}

const defaultRuntime: SqliteDriverRuntime = {
	isBun: () => 'bun' in process.versions && Boolean(process.versions.bun),
	importBunSqlite: () => import('bun:sqlite'),
	importBetterSqlite3: () => import('better-sqlite3'),
};

export async function loadSqliteDatabaseConstructor(
	dbPath: string,
	runtime: SqliteDriverRuntime = defaultRuntime
): Promise<SqliteDatabaseConstructor> {
	const isBun = runtime.isBun();
	try {
		if (isBun) return createBunSqliteDatabaseConstructor(await runtime.importBunSqlite());
		return (await runtime.importBetterSqlite3()).default;
	} catch (error) {
		throw new PersistenceCompatibilityError(
			dbPath,
			isBun
				? "SQLite persistence requires the Bun 'bun:sqlite' module"
				: "SQLite persistence requires the optional 'better-sqlite3' package",
			error
		);
	}
}
