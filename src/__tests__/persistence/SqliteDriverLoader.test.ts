import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistenceCompatibilityError } from '../../errors.js';
import { loadSqliteDatabaseConstructor } from '../../persistence/SqliteDriverLoader.js';

class FakeDatabase {
	exec() {}
	prepare() {
		return { run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => null, all: () => [] };
	}
	close() {}
	pragma() {}
}
const bunModule = {
	Database: FakeDatabase,
	constants: { SQLITE_OPEN_READONLY: 1, SQLITE_OPEN_READWRITE: 2, SQLITE_OPEN_CREATE: 4 },
};
const originalBun = Object.getOwnPropertyDescriptor(process.versions, 'bun');

afterEach(() => {
	if (originalBun) Object.defineProperty(process.versions, 'bun', originalBun);
	else Reflect.deleteProperty(process.versions, 'bun');
});

describe('SQLite driver loader', () => {
	it.each([true, false])('selects only the runtime driver when Bun is %s', async (isBun) => {
		const runtime = {
			isBun: () => isBun,
			importBunSqlite: vi.fn(async () => bunModule),
			importBetterSqlite3: vi.fn(async () => ({ default: FakeDatabase })),
		};
		const Database = await loadSqliteDatabaseConstructor('history.db', runtime);
		expect(new Database('history.db')).toBeDefined();
		expect(runtime.importBunSqlite).toHaveBeenCalledTimes(isBun ? 1 : 0);
		expect(runtime.importBetterSqlite3).toHaveBeenCalledTimes(isBun ? 0 : 1);
		if (!isBun) expect(Database).toBe(FakeDatabase);
	});

	it.each([true, false])('fails closed with the import cause when Bun is %s', async (isBun) => {
		const cause = new Error('driver unavailable');
		const runtime = {
			isBun: () => isBun,
			importBunSqlite: vi.fn(async () => {
				throw cause;
			}),
			importBetterSqlite3: vi.fn(async () => {
				throw cause;
			}),
		};
		const result = loadSqliteDatabaseConstructor('history.db', runtime);
		await expect(result).rejects.toBeInstanceOf(PersistenceCompatibilityError);
		await expect(result).rejects.toMatchObject({ cause });
		await expect(result).rejects.toThrow(
			isBun ? 'bun:sqlite' : "SQLite persistence requires the optional 'better-sqlite3' package"
		);
		expect(runtime.importBunSqlite).toHaveBeenCalledTimes(isBun ? 1 : 0);
		expect(runtime.importBetterSqlite3).toHaveBeenCalledTimes(isBun ? 0 : 1);
	});

	it('uses the default literal Bun importer under a simulated Bun runtime', async () => {
		Object.defineProperty(process.versions, 'bun', { value: '1.4.2', configurable: true });
		await expect(loadSqliteDatabaseConstructor('history.db')).rejects.toThrow('bun:sqlite');
		await expect(loadSqliteDatabaseConstructor('history.db')).rejects.toBeInstanceOf(
			PersistenceCompatibilityError
		);
	});
});
