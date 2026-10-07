declare module 'bun:sqlite' {
	interface Statement {
		run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
		get(...params: readonly unknown[]): unknown;
		all(...params: readonly unknown[]): unknown[];
	}

	export class Database {
		constructor(path: string, flags: number);
		exec(sql: string): void;
		prepare(sql: string): Statement;
		close(): void;
	}

	export const constants: {
		readonly SQLITE_OPEN_READONLY: number;
		readonly SQLITE_OPEN_READWRITE: number;
		readonly SQLITE_OPEN_CREATE: number;
	};
}
