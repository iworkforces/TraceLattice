import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBunSqliteDatabaseConstructor } from '../../persistence/BunSqliteDriver.js';

const constants = {
	SQLITE_OPEN_READONLY: 1,
	SQLITE_OPEN_READWRITE: 2,
	SQLITE_OPEN_CREATE: 4,
};
const statement = {
	run: vi.fn(() => ({ changes: 2, lastInsertRowid: 9n })),
	get: vi.fn<(...params: readonly unknown[]) => unknown>(() => null),
	all: vi.fn(() => [{ value: 1 }]),
};
const calls = {
	open: vi.fn(),
	prepare: vi.fn((_sql: string) => statement),
	exec: vi.fn(),
	close: vi.fn(),
};
class FakeDatabase {
	constructor(path: string, flags: number) {
		calls.open(path, flags);
	}
	prepare = calls.prepare;
	exec = calls.exec;
	close = calls.close;
}

function open(options?: { readonly?: boolean; fileMustExist?: boolean }) {
	const Database = createBunSqliteDatabaseConstructor({ Database: FakeDatabase, constants });
	return new Database('history.db', options);
}

describe('Bun SQLite adapter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		statement.get.mockReturnValue(null);
	});

	it.each([
		[undefined, 6],
		[{ readonly: true }, 1],
		[{ fileMustExist: true }, 2],
		[{ readonly: true, fileMustExist: true }, 1],
		[{ readonly: false, fileMustExist: false }, 6],
	])('passes explicit flags for %j', (options, flags) => {
		open(options);
		expect(calls.open).toHaveBeenCalledWith('history.db', flags);
	});

	it('derives flags from the supplied module constants', () => {
		const Database = createBunSqliteDatabaseConstructor({
			Database: FakeDatabase,
			constants: { SQLITE_OPEN_READONLY: 8, SQLITE_OPEN_READWRITE: 16, SQLITE_OPEN_CREATE: 32 },
		});
		new Database('custom.db');
		expect(calls.open).toHaveBeenCalledWith('custom.db', 48);
	});

	it('executes pragma SQL and returns its rows', () => {
		expect(open().pragma('journal_mode = WAL')).toEqual([{ value: 1 }]);
		expect(calls.prepare).toHaveBeenCalledWith('PRAGMA journal_mode = WAL');
		expect(statement.all).toHaveBeenCalledWith();
	});

	it('normalizes a missing row to undefined and forwards bindings', () => {
		expect(open().prepare('SELECT ?').get(7)).toBeUndefined();
		expect(statement.get).toHaveBeenCalledWith(7);
	});

	it('preserves SQL NULL columns', () => {
		statement.get.mockReturnValue({ value: null });
		expect(open().prepare('SELECT NULL').get()).toEqual({ value: null });
	});

	it('returns the run result and forwards bindings', () => {
		expect(open().prepare('INSERT').run('value', null)).toEqual({
			changes: 2,
			lastInsertRowid: 9n,
		});
		expect(statement.run).toHaveBeenCalledWith('value', null);
	});

	it('passes all rows and bindings through unchanged', () => {
		expect(open().prepare('SELECT ?').all(3)).toEqual([{ value: 1 }]);
		expect(statement.all).toHaveBeenCalledWith(3);
	});

	it('passes multi-statement exec through', () => {
		open().exec('BEGIN IMMEDIATE; COMMIT;');
		expect(calls.exec).toHaveBeenCalledWith('BEGIN IMMEDIATE; COMMIT;');
	});

	it('closes the underlying database', () => {
		open().close();
		expect(calls.close).toHaveBeenCalledOnce();
	});
});
