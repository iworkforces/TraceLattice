import {
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	PersistenceClosedError,
	PersistenceOwnershipError,
	PersistencePublicationError,
} from '../errors.js';

export const FILE_WRITER_LOCK_NAME = '.tracelattice-writer.lock';
export const FILE_WRITER_MARKER_NAME = 'owner.json';
export const FILE_WRITER_MARKER_FORMAT = 'tracelattice-writer-lock/1';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const LEGACY_PID_PATTERN = /^([1-9]\d*)\n?$/;

export interface FileWriterOperations {
	readonly mkdir: (path: string) => Promise<void>;
	readonly mkdirExclusive: (path: string) => Promise<void>;
	readonly realpath: (path: string) => Promise<string>;
	readonly rename: (source: string, destination: string) => Promise<void>;
	readonly rmdir: (path: string) => Promise<void>;
	readonly unlink: (path: string) => Promise<void>;
	readonly writeExclusiveUtf8: (path: string, content: string) => Promise<void>;
	readonly readUtf8: (path: string) => Promise<string>;
	readonly readdir: (path: string) => Promise<string[]>;
	readonly hostname: () => string;
	/** Throws when signal 0 cannot reach `pid`; only the thrown error's `code` is consulted. */
	readonly probeProcess: (pid: number) => void;
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
	readUtf8: async (path) => await readFile(path, 'utf-8'),
	readdir: async (path) => await readdir(path),
	hostname: () => hostname(),
	probeProcess: (pid) => {
		process.kill(pid, 0);
	},
};

function errorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isFileAlreadyPresent(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isDirectoryNotEmpty(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOwnerPid(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function orphanedTemporaryPattern(publishedName: string): RegExp {
	return new RegExp(`^\\.${escapeRegExp(publishedName)}\\.[1-9]\\d*\\.${UUID_SOURCE}\\.tmp$`);
}

type WriterLockMarker = {
	readonly hostname: string;
	readonly pid: number;
	readonly token: string;
};

function serializeMarker(marker: WriterLockMarker): string {
	return `${JSON.stringify({
		format: FILE_WRITER_MARKER_FORMAT,
		hostname: marker.hostname,
		pid: marker.pid,
		token: marker.token,
	})}\n`;
}

function parseMarkerJson(content: string): unknown {
	try {
		return JSON.parse(content);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function parseMarker(value: unknown): WriterLockMarker | undefined {
	if (!isRecord(value) || value['format'] !== FILE_WRITER_MARKER_FORMAT) return undefined;
	const { hostname: markerHost, pid, token } = value;
	const ownerPid = asOwnerPid(pid);
	if (typeof markerHost !== 'string' || markerHost === '' || ownerPid === undefined) {
		return undefined;
	}
	if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return undefined;
	return { hostname: markerHost, pid: ownerPid, token };
}

type RecordedOwner = {
	readonly content: string | undefined;
	readonly pid: number | undefined;
	readonly marker: WriterLockMarker | undefined;
	readonly readError: unknown;
};

function recordOwner(content: string): RecordedOwner {
	const legacyPid = LEGACY_PID_PATTERN.exec(content)?.[1];
	if (legacyPid !== undefined) {
		return { content, pid: asOwnerPid(Number(legacyPid)), marker: undefined, readError: undefined };
	}
	const value = parseMarkerJson(content);
	const marker = parseMarker(value);
	const pid = marker?.pid ?? (isRecord(value) ? asOwnerPid(value['pid']) : undefined);
	return { content, pid, marker, readError: undefined };
}

type TakeoverVerdict =
	| { readonly stale: true; readonly marker: WriterLockMarker }
	| { readonly stale: false; readonly reason: string };

function judgeRecordedOwner(
	recorded: RecordedOwner,
	operations: FileWriterOperations
): TakeoverVerdict {
	if (recorded.content === undefined) {
		return { stale: false, reason: 'the lock has no readable owner marker' };
	}
	const marker = recorded.marker;
	if (marker === undefined) {
		return { stale: false, reason: 'the owner marker is not a current host-and-pid marker' };
	}
	if (marker.hostname !== operations.hostname()) {
		return { stale: false, reason: `the owner ran on host '${marker.hostname}'` };
	}
	if (marker.pid === process.pid) {
		return { stale: false, reason: 'this process owns the lock' };
	}
	try {
		operations.probeProcess(marker.pid);
	} catch (error) {
		const code = errorCode(error);
		if (code === 'ESRCH') return { stale: true, marker };
		return { stale: false, reason: `owner liveness is unknown (${String(code)})` };
	}
	return { stale: false, reason: 'the owner process is still running' };
}

type DirectoryOwnership = {
	readonly canonicalDataDir: string;
	readonly lockPath: string;
	readonly markerPath: string;
	readonly markerContent: string;
};

type LockTarget = Omit<DirectoryOwnership, 'markerContent'>;

type WriterState = 'open' | 'closing' | 'closed';

export class FileWriter {
	private readonly _configuredDataDir: string;
	private readonly _operations: FileWriterOperations;
	private readonly _orphanedTemporary: RegExp | undefined;
	private _ownershipPromise: Promise<DirectoryOwnership> | undefined;
	private _ownership: DirectoryOwnership | undefined;
	private _tail: Promise<void> = Promise.resolve();
	private _closePromise: Promise<void> | undefined;
	private _state: WriterState = 'open';

	/**
	 * @param publishedName Basename this writer publishes. After acquiring ownership the writer
	 * deletes orphaned `.<publishedName>.<pid>.<uuid>.tmp` files left by an interrupted publish.
	 */
	constructor(
		dataDir: string,
		operations: FileWriterOperations = nodeFileWriterOperations,
		publishedName?: string
	) {
		this._configuredDataDir = dataDir;
		this._operations = operations;
		this._orphanedTemporary =
			publishedName === undefined ? undefined : orphanedTemporaryPattern(publishedName);
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
		const markerPath = join(lockPath, FILE_WRITER_MARKER_NAME);
		const ownership = await this._lockDirectory({ canonicalDataDir, lockPath, markerPath });
		await this._sweepOrSurrender(ownership);
		this._ownership = ownership;
		return ownership;
	}

	private _markerContent(): string {
		return serializeMarker({
			hostname: this._operations.hostname(),
			pid: process.pid,
			token: randomUUID(),
		});
	}

	private async _lockDirectory(target: LockTarget): Promise<DirectoryOwnership> {
		try {
			await this._operations.mkdirExclusive(target.lockPath);
		} catch (error) {
			if (isFileAlreadyPresent(error)) {
				return await this._reclaimStaleLock(target, error);
			}
			throw error;
		}

		const markerContent = this._markerContent();
		try {
			await this._operations.writeExclusiveUtf8(target.markerPath, markerContent);
		} catch (error) {
			await this._cleanupFailedAcquisition(target.lockPath, target.markerPath, error);
		}
		return { ...target, markerContent };
	}

	private async _readRecordedOwner(markerPath: string): Promise<RecordedOwner> {
		let content: string;
		try {
			content = await this._operations.readUtf8(markerPath);
		} catch (error) {
			return { content: undefined, pid: undefined, marker: undefined, readError: error };
		}
		return recordOwner(content);
	}

	/**
	 * Single takeover attempt for a lock whose marker names a dead owner on this host. The lock
	 * directory is never removed or renamed. The exclusive claim file `<staleToken>.claim` admits
	 * one reclaimer of that owner at a time; the winner re-reads the marker inside the claim and
	 * renames the claim, which already holds its own marker, over the stale marker. A late racer
	 * that wins the claim after that rename finds a different marker and rejects.
	 */
	private async _reclaimStaleLock(target: LockTarget, cause: unknown): Promise<DirectoryOwnership> {
		const { canonicalDataDir, lockPath, markerPath } = target;
		const recorded = await this._readRecordedOwner(markerPath);
		const verdict = judgeRecordedOwner(recorded, this._operations);
		if (!verdict.stale) {
			throw new PersistenceOwnershipError(
				canonicalDataDir,
				lockPath,
				recorded.readError ?? cause,
				recorded.pid,
				verdict.reason
			);
		}

		const markerContent = this._markerContent();
		const claimPath = join(lockPath, `${verdict.marker.token}.claim`);
		try {
			await this._operations.writeExclusiveUtf8(claimPath, markerContent);
		} catch (error) {
			// A failed exclusive create never proves the claim file is ours, so it is left in place:
			// unlinking by path could delete another reclaimer's claim and admit two owners.
			throw new PersistenceOwnershipError(
				canonicalDataDir,
				lockPath,
				error,
				recorded.pid,
				isFileAlreadyPresent(error)
					? 'another writer is reclaiming the stale lock'
					: 'the takeover claim could not be created'
			);
		}

		const current = await this._readRecordedOwner(markerPath);
		if (current.content !== recorded.content) {
			throw new PersistenceOwnershipError(
				canonicalDataDir,
				lockPath,
				await this._discardClaim(claimPath, current.readError ?? cause),
				current.pid,
				'another writer reclaimed the stale lock first'
			);
		}

		try {
			await this._operations.rename(claimPath, markerPath);
		} catch (error) {
			throw new PersistencePublicationError(
				markerPath,
				'atomic-replacement',
				await this._discardClaim(claimPath, error)
			);
		}
		return { ...target, markerContent };
	}

	private async _discardClaim(claimPath: string, primary: unknown): Promise<unknown> {
		try {
			await this._operations.unlink(claimPath);
			return primary;
		} catch (error) {
			return isFileNotFound(error) ? primary : new AggregateError([primary, error]);
		}
	}

	private async _sweepOrSurrender(ownership: DirectoryOwnership): Promise<void> {
		try {
			await this._sweepOrphanedTemporaries(ownership.canonicalDataDir);
		} catch (sweepError) {
			try {
				await this._releaseLock(ownership);
			} catch (releaseError) {
				throw new PersistencePublicationError(
					ownership.lockPath,
					'cleanup',
					new AggregateError([sweepError, releaseError])
				);
			}
			throw sweepError;
		}
	}

	private async _sweepOrphanedTemporaries(canonicalDataDir: string): Promise<void> {
		const pattern = this._orphanedTemporary;
		if (pattern === undefined) return;
		let entries: string[];
		try {
			entries = await this._operations.readdir(canonicalDataDir);
		} catch (error) {
			throw new PersistencePublicationError(canonicalDataDir, 'cleanup', error);
		}
		for (const entry of entries.filter((name) => pattern.test(name))) {
			const orphanPath = join(canonicalDataDir, entry);
			try {
				await this._operations.unlink(orphanPath);
			} catch (error) {
				if (!isFileNotFound(error)) {
					throw new PersistencePublicationError(orphanPath, 'cleanup', error);
				}
			}
		}
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
		await this._releaseLock(ownership);
	}

	/** Removes the lock only while its marker still holds this writer's own token. */
	private async _releaseLock(ownership: DirectoryOwnership): Promise<void> {
		let current: string;
		try {
			current = await this._operations.readUtf8(ownership.markerPath);
		} catch (error) {
			if (isFileNotFound(error) || errorCode(error) === 'ENOTDIR') {
				return;
			}
			throw new PersistencePublicationError(ownership.markerPath, 'cleanup', error);
		}
		if (current !== ownership.markerContent) {
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
