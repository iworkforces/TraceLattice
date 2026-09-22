import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IMetrics } from '../contracts/interfaces.js';
import type { PersistenceConfig, PersistenceBackend } from '../contracts/PersistenceBackend.js';
import { asSessionId, type BranchId, type SessionId, type ThoughtId } from '../contracts/ids.js';
import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceCompatibilityError } from '../errors.js';
import {
	EMPTY_FILE_SNAPSHOT_V2,
	parseFileSnapshotV2,
	serializeFileSnapshotV2,
	sessionsInSnapshot,
} from './FileSnapshotV2.js';
import type { FileSnapshotV2 } from './FileSnapshotTypes.js';
import { stageBacktrackPersistence } from './BacktrackPersistence.js';
import { FILE_WRITER_LOCK_NAME, FileWriter, type FileWriterOperations } from './FileWriter.js';
import {
	assertBranchScope,
	assertEdgeScopes,
	assertPersistableThoughtCollections,
	assertPersistableThoughts,
	assertSummaryScopes,
	assertThoughtScope,
	compareCodePoint,
	parsePersistenceBranchId,
} from './PersistenceScope.js';

type FilePersistenceOptions = NonNullable<PersistenceConfig['options']> & {
	readonly metrics?: IMetrics;
	readonly writerOperations?: FileWriterOperations;
};

const SNAPSHOT_NAME = 'snapshot.json';

export class FilePersistence implements PersistenceBackend {
	private readonly _dataDir: string;
	private readonly _maxHistorySize: number;
	private readonly _persistBranches: boolean;
	private readonly _metrics: IMetrics | undefined;
	private readonly _writer: FileWriter;

	constructor(options?: FilePersistenceOptions) {
		const defaultDataDir = existsSync('.claude/data')
			? '.claude/data'
			: join(homedir(), '.claude/data');
		this._dataDir = options?.dataDir ?? defaultDataDir;
		this._maxHistorySize = options?.maxHistorySize ?? 10000;
		this._persistBranches = options?.persistBranches ?? true;
		this._metrics = options?.metrics;
		this._writer = new FileWriter(this._dataDir, options?.writerOperations);
	}

	public static async create(options?: FilePersistenceOptions): Promise<FilePersistence> {
		const persistence = new FilePersistence(options);
		try {
			await persistence._writer.ready();
			await persistence._writer.run(async (dataDir) => await persistence._loadSnapshot(dataDir));
			return persistence;
		} catch (error) {
			await persistence.close();
			throw error;
		}
	}

	public async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertThoughtScope('saveThoughtForSession', validatedSessionId, thought);
		await this._saveThought(validatedSessionId, thought);
	}

	public async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		await this._mutate('save_backtrack', (snapshot) => {
			const staged = stageBacktrackPersistence(
				validatedSessionId,
				snapshot.thoughts.find((record) => record.sessionId === validatedSessionId)?.thoughts ?? [],
				snapshot.branches
					.filter((record) => record.sessionId === validatedSessionId)
					.map((record) => ({ branchId: record.branchId, thoughts: record.thoughts })),
				thought,
				targetThoughtId,
				this._maxHistorySize
			);
			return {
				...snapshot,
				thoughts: [
					...snapshot.thoughts.filter((record) => record.sessionId !== validatedSessionId),
					{ sessionId: validatedSessionId, thoughts: staged.history },
				],
				branches: [
					...snapshot.branches.filter((record) => record.sessionId !== validatedSessionId),
					...staged.branches.map((branch) => ({
						sessionId: validatedSessionId,
						branchId: branch.branchId,
						thoughts: branch.thoughts,
					})),
				],
			};
		});
	}

	private async _saveThought(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		assertPersistableThoughts([thought], `${sessionId}/thoughts`);
		await this._mutate('save_thought', (snapshot) => {
			const current =
				snapshot.thoughts.find((record) => record.sessionId === sessionId)?.thoughts ?? [];
			const prospective = [...current, thought];
			assertPersistableThoughtCollections(
				[
					{ sessionId, thoughts: prospective },
					...snapshot.branches
						.filter((record) => record.sessionId === sessionId)
						.map((record) => ({ sessionId, thoughts: record.thoughts })),
				],
				`${sessionId}/thoughts`
			);
			const retained =
				this._maxHistorySize > 0 ? prospective.slice(-this._maxHistorySize) : prospective;
			return {
				...snapshot,
				thoughts: [
					...snapshot.thoughts.filter((record) => record.sessionId !== sessionId),
					{ sessionId, thoughts: retained },
				],
			};
		});
	}

	public async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		const validatedSessionId = asSessionId(sessionId);
		return await this._read('load_history', (snapshot) => [
			...(snapshot.thoughts.find((record) => record.sessionId === validatedSessionId)?.thoughts ??
				[]),
		]);
	}

	public async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${validatedSessionId}/branches`);
		assertBranchScope('saveBranchForSession', validatedSessionId, validatedBranchId, thoughts);
		await this._saveBranch(validatedSessionId, validatedBranchId, thoughts);
	}

	private async _saveBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		assertPersistableThoughtCollections(
			[{ sessionId, thoughts }],
			`${sessionId}/branches/${branchId}`
		);
		if (!this._persistBranches) {
			await this._writer.run(async (dataDir) => {
				const snapshot = await this._loadSnapshot(dataDir);
				assertPersistableThoughtCollections(
					[
						{
							sessionId,
							thoughts:
								snapshot.thoughts.find((record) => record.sessionId === sessionId)?.thoughts ?? [],
						},
						...snapshot.branches
							.filter((record) => record.sessionId === sessionId)
							.map((record) => ({ sessionId, thoughts: record.thoughts })),
						{ sessionId, thoughts },
					],
					`${sessionId}/branches/${branchId}`
				);
			});
			return;
		}
		await this._mutate('save_branch', (snapshot) => ({
			...snapshot,
			branches: [
				...snapshot.branches.filter(
					(record) => record.sessionId !== sessionId || record.branchId !== branchId
				),
				{ sessionId, branchId, thoughts: [...thoughts] },
			],
		}));
	}

	public async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		if (!this._persistBranches) return;
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${validatedSessionId}/branches`);
		await this._mutate('delete_branch', (snapshot) => ({
			...snapshot,
			branches: snapshot.branches.filter(
				(record) => record.sessionId !== validatedSessionId || record.branchId !== validatedBranchId
			),
		}));
	}

	public async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		if (!this._persistBranches) return undefined;
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${validatedSessionId}/branches`);
		return await this._read('load_branch', (snapshot) => {
			const thoughts = snapshot.branches.find(
				(record) => record.sessionId === validatedSessionId && record.branchId === validatedBranchId
			)?.thoughts;
			return thoughts === undefined ? undefined : [...thoughts];
		});
	}

	public async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		if (!this._persistBranches) return [];
		const validatedSessionId = asSessionId(sessionId);
		return await this._read('list_branches', (snapshot) =>
			snapshot.branches
				.filter((record) => record.sessionId === validatedSessionId)
				.map((record) => record.branchId)
				.sort(compareCodePoint)
		);
	}

	public async listSessions(): Promise<SessionId[]> {
		return await this._read('list_sessions', sessionsInSnapshot);
	}

	public async clearAll(): Promise<void> {
		await this._mutate('clear_all', () => EMPTY_FILE_SNAPSHOT_V2);
	}

	public async clearSession(sessionId: SessionId): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		await this._mutate('clear_session', (snapshot) => ({
			version: 2,
			thoughts: snapshot.thoughts.filter((record) => record.sessionId !== validatedSessionId),
			branches: snapshot.branches.filter((record) => record.sessionId !== validatedSessionId),
			edges: snapshot.edges.filter((record) => record.sessionId !== validatedSessionId),
			summaries: snapshot.summaries.filter((record) => record.sessionId !== validatedSessionId),
		}));
	}

	public async saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertEdgeScopes(validatedSessionId, edges);
		await this._mutate('save_edges', (snapshot) => ({
			...snapshot,
			edges: [
				...snapshot.edges.filter((record) => record.sessionId !== validatedSessionId),
				...(edges.length === 0 ? [] : [{ sessionId: validatedSessionId, edges: [...edges] }]),
			],
		}));
	}

	public async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		const validatedSessionId = asSessionId(sessionId);
		return await this._read('load_edges', (snapshot) => [
			...(snapshot.edges.find((record) => record.sessionId === validatedSessionId)?.edges ?? []),
		]);
	}

	public async saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertSummaryScopes(validatedSessionId, summaries);
		await this._mutate('save_summaries', (snapshot) => ({
			...snapshot,
			summaries: [
				...snapshot.summaries.filter((record) => record.sessionId !== validatedSessionId),
				...(summaries.length === 0
					? []
					: [{ sessionId: validatedSessionId, summaries: [...summaries] }]),
			],
		}));
	}

	public async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		const validatedSessionId = asSessionId(sessionId);
		return await this._read('load_summaries', (snapshot) => [
			...(snapshot.summaries.find((record) => record.sessionId === validatedSessionId)?.summaries ??
				[]),
		]);
	}

	public async healthy(): Promise<boolean> {
		try {
			await this._writer.run(async (dataDir) => await this._loadSnapshot(dataDir));
			return true;
		} catch (error) {
			if (error instanceof Error) return false;
			throw error;
		}
	}

	public getDataDir(): string {
		return this._dataDir;
	}

	public async close(): Promise<void> {
		await this._writer.close();
	}

	private async _read<T>(operation: string, select: (snapshot: FileSnapshotV2) => T): Promise<T> {
		return await this._measure(
			operation,
			async () =>
				await this._writer.run(async (dataDir) => select(await this._loadSnapshot(dataDir)))
		);
	}

	private async _mutate(
		operation: string,
		mutate: (snapshot: FileSnapshotV2) => FileSnapshotV2
	): Promise<void> {
		await this._measure(operation, async () => {
			await this._writer.run(async (dataDir) => {
				const snapshotPath = join(dataDir, SNAPSHOT_NAME);
				const updated = mutate(await this._loadSnapshot(dataDir));
				await this._writer.publish(snapshotPath, serializeFileSnapshotV2(updated, snapshotPath));
			});
		});
	}

	private async _loadSnapshot(dataDir: string): Promise<FileSnapshotV2> {
		const snapshotPath = join(dataDir, SNAPSHOT_NAME);
		const layoutEntries = (await readdir(dataDir)).filter(
			(entry) => entry !== FILE_WRITER_LOCK_NAME
		);
		if (layoutEntries.length === 0) return EMPTY_FILE_SNAPSHOT_V2;
		if (layoutEntries.length !== 1 || layoutEntries[0] !== SNAPSHOT_NAME) {
			throw new PersistenceCompatibilityError(dataDir, 'directory does not match File v2 layout');
		}
		return parseFileSnapshotV2(await readFile(snapshotPath, 'utf-8'), snapshotPath);
	}

	private async _measure<T>(operation: string, action: () => Promise<T>): Promise<T> {
		const startTime = Date.now();
		try {
			return await action();
		} finally {
			this._metrics?.histogram('persistence_op_duration_seconds', (Date.now() - startTime) / 1000, {
				operation,
			});
		}
	}
}
