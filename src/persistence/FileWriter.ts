import { mkdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
	PersistenceClosedError,
	PersistenceOwnershipError,
	PersistencePublicationError,
} from '../errors.js';

export const FILE_WRITER_LOCK_NAME = '.tracelattice-writer.lock';

export interface FileWriterOperations {
	readonly mkdir: (path: string) => Promise<void>;
	readonly mkdirExclusive: (path: string) => Promise<void>;
	readonly realpath: (path: string) => Promise<string>;
	readonly rename: (source: string, destination: string) => Promise<void>;
	readonly rmdir: (path: string) => Promise<void>;
	readonly unlink: (path: string) => Promise<void>;
	readonly writeExclusiveUtf8: (path: string, content: string) => Promise<void>;
}

export const nodeFileWriterOperations: FileWriterOperations = {
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	mkdirExclusive: async (path) => await mkdir(path),
	realpath: async (path) => await realpath(path),
	rename: async (source, destination) => await rename(source, destination),
	rmdir: async (path) => await rmdir(path),
	unlink: async (path) => await unlink(path),
	writeExclusiveUtf8: async (path, content) => {
		await writeFile(path, content, { encoding: 'utf-8', flag: 'wx' });
	},
};

export function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isFileAlreadyPresent(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isDirectoryNotEmpty(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY';
}

type DirectoryOwnership = {
	readonly canonicalDataDir: string;
	readonly lockPath: string;
	readonly markerPath: string;
};

type WriterState = 'open' | 'closing' | 'closed';

export class FileWriter {
	private readonly _configuredDataDir: string;
	private readonly _operations: FileWriterOperations;
	private _ownershipPromise: Promise<DirectoryOwnership> | undefined;
	private _ownership: DirectoryOwnership | undefined;
	private _tail: Promise<void> = Promise.resolve();
	private _closePromise: Promise<void> | undefined;
	private _state: WriterState = 'open';

	constructor(dataDir: string, operations: FileWriterOperations = nodeFileWriterOperations) {
		this._configuredDataDir = dataDir;
		this._operations = operations;
	}

	public async ready(): Promise<void> {
		if (this._state !== 'open') {
			throw new PersistenceClosedError(this._configuredDataDir);
		}
		await this._getOwnership();
	}

	public run<T>(operation: (canonicalDataDir: string) => Promise<T>): Promise<T> {
		if (this._state !== 'open') {
			return Promise.reject(new PersistenceClosedError(this._configuredDataDir));
		}

		const queued = this._tail.then(async () => {
			const ownership = await this._getOwnership();
			return await operation(ownership.canonicalDataDir);
		});
		this._tail = queued.then(
			() => undefined,
			() => undefined
		);
		return queued;
	}

	public async publish(targetPath: string, content: string): Promise<void> {
		const temporaryPath = join(
			dirname(targetPath),
			`.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
		);
		let stage: 'temporary-write' | 'atomic-replacement' = 'temporary-write';

		try {
			await this._operations.writeExclusiveUtf8(temporaryPath, content);
			stage = 'atomic-replacement';
			await this._operations.rename(temporaryPath, targetPath);
		} catch (error) {
			const publicationError = new PersistencePublicationError(targetPath, stage, error);
			try {
				await this._operations.unlink(temporaryPath);
			} catch (cleanupError) {
				if (!isFileNotFound(cleanupError)) {
					throw new PersistencePublicationError(
						targetPath,
						'cleanup',
						new AggregateError([publicationError, cleanupError])
					);
				}
			}
			throw publicationError;
		}
	}

	public close(): Promise<void> {
		if (this._closePromise) {
			return this._closePromise;
		}

		this._state = 'closing';
		this._closePromise = (async () => {
			try {
				await this._tail;
				await this._releaseOwnership();
			} finally {
				this._state = 'closed';
			}
		})();
		return this._closePromise;
	}

	private _getOwnership(): Promise<DirectoryOwnership> {
		this._ownershipPromise ??= this._acquireOwnership();
		return this._ownershipPromise;
	}

	private async _acquireOwnership(): Promise<DirectoryOwnership> {
		await this._operations.mkdir(this._configuredDataDir);
		const canonicalDataDir = await this._operations.realpath(this._configuredDataDir);
		const lockPath = join(canonicalDataDir, FILE_WRITER_LOCK_NAME);
		const markerName = `${process.pid}-${randomUUID()}.owner`;
		const markerPath = join(lockPath, markerName);

		try {
			await this._operations.mkdirExclusive(lockPath);
		} catch (error) {
			if (isFileAlreadyPresent(error)) {
				throw new PersistenceOwnershipError(canonicalDataDir, lockPath, error);
			}
			throw error;
		}

		try {
			await this._operations.writeExclusiveUtf8(markerPath, `${process.pid}\n`);
		} catch (error) {
			await this._cleanupFailedAcquisition(lockPath, markerPath, error);
		}

		const ownership = { canonicalDataDir, lockPath, markerPath } satisfies DirectoryOwnership;
		this._ownership = ownership;
		return ownership;
	}

	private async _cleanupFailedAcquisition(
		lockPath: string,
		markerPath: string,
		acquisitionError: unknown
	): Promise<never> {
		const failures: unknown[] = [acquisitionError];
		try {
			await this._operations.unlink(markerPath);
		} catch (unlinkError) {
			if (!isFileNotFound(unlinkError)) {
				failures.push(unlinkError);
			}
		}
		try {
			await this._operations.rmdir(lockPath);
		} catch (removeDirectoryError) {
			if (!isFileNotFound(removeDirectoryError) && !isDirectoryNotEmpty(removeDirectoryError)) {
				failures.push(removeDirectoryError);
			}
		}
		throw new PersistencePublicationError(lockPath, 'cleanup', new AggregateError(failures));
	}

	private async _releaseOwnership(): Promise<void> {
		const ownership = this._ownership;
		this._ownership = undefined;
		if (!ownership) {
			return;
		}

		try {
			await this._operations.unlink(ownership.markerPath);
		} catch (error) {
			if (isFileNotFound(error)) {
				return;
			}
			throw new PersistencePublicationError(ownership.markerPath, 'cleanup', error);
		}

		try {
			await this._operations.rmdir(ownership.lockPath);
		} catch (error) {
			if (!isFileNotFound(error) && !isDirectoryNotEmpty(error)) {
				throw new PersistencePublicationError(ownership.lockPath, 'cleanup', error);
			}
		}
	}
}
