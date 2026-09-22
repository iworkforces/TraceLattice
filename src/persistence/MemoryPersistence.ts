import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
import { asSessionId, type BranchId, type SessionId, type ThoughtId } from '../contracts/ids.js';
import { stageBacktrackPersistence } from './BacktrackPersistence.js';
import {
	assertBranchScope,
	assertEdgeScopes,
	assertPersistableThoughtCollections,
	assertSummaryScopes,
	assertThoughtScope,
	assertUniqueRecordIds,
	compareCodePoint,
	compareCreatedThenId,
	parsePersistenceBranchId,
	type PersistedThoughtCollection,
} from './PersistenceScope.js';

export interface MemoryPersistenceOptions {
	maxSize?: number;
	maxHistorySize?: number;
	persistBranches?: boolean;
}

export class MemoryPersistence implements PersistenceBackend {
	private readonly _histories = new Map<SessionId, ThoughtData[]>();
	private readonly _branches = new Map<SessionId, Map<BranchId, ThoughtData[]>>();
	private readonly _edges = new Map<SessionId, Edge[]>();
	private readonly _summaries = new Map<SessionId, Summary[]>();
	private readonly _maxSize: number | undefined;
	private readonly _persistBranches: boolean;

	constructor(options: MemoryPersistenceOptions = {}) {
		const configuredSize = options.maxHistorySize ?? options.maxSize;
		this._maxSize =
			configuredSize === undefined ? 10_000 : configuredSize > 0 ? configuredSize : undefined;
		this._persistBranches = options.persistBranches ?? true;
	}

	public async saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertThoughtScope('saveThoughtForSession', validatedSessionId, thought);
		const history = [...(this._histories.get(validatedSessionId) ?? []), thought];
		const collections: PersistedThoughtCollection[] = [
			{ sessionId: validatedSessionId, thoughts: history },
		];
		for (const branch of this._branches.get(validatedSessionId)?.values() ?? []) {
			collections.push({ sessionId: validatedSessionId, thoughts: branch });
		}
		assertPersistableThoughtCollections(collections, `${validatedSessionId}/thoughts`);
		this._histories.set(
			validatedSessionId,
			this._maxSize === undefined ? history : history.slice(-this._maxSize)
		);
	}

	public async saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		const branches = this._branches.get(validatedSessionId) ?? new Map();
		const staged = stageBacktrackPersistence(
			validatedSessionId,
			this._histories.get(validatedSessionId) ?? [],
			[...branches].map(([branchId, thoughts]) => ({ branchId, thoughts })),
			thought,
			targetThoughtId,
			this._maxSize ?? 0
		);
		this._histories.set(validatedSessionId, [...staged.history]);
		if (this._persistBranches) {
			this._branches.set(
				validatedSessionId,
				new Map(staged.branches.map((branch) => [branch.branchId, [...branch.thoughts]]))
			);
		}
	}

	public async loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]> {
		return [...(this._histories.get(asSessionId(sessionId)) ?? [])];
	}

	public async saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${validatedSessionId}/branches`);
		assertBranchScope('saveBranchForSession', validatedSessionId, validatedBranchId, thoughts);
		const branches = new Map(this._branches.get(validatedSessionId) ?? []);
		branches.set(validatedBranchId, [...thoughts]);
		const collections: PersistedThoughtCollection[] = [
			{
				sessionId: validatedSessionId,
				thoughts: this._histories.get(validatedSessionId) ?? [],
			},
		];
		for (const branch of branches.values()) {
			collections.push({ sessionId: validatedSessionId, thoughts: branch });
		}
		assertPersistableThoughtCollections(
			collections,
			`${validatedSessionId}/branches/${validatedBranchId}`
		);
		if (!this._persistBranches) return;
		this._branches.set(validatedSessionId, branches);
	}

	public async deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void> {
		if (!this._persistBranches) return;
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${validatedSessionId}/branches`);
		const branches = this._branches.get(validatedSessionId);
		if (branches === undefined) return;
		branches.delete(validatedBranchId);
		if (branches.size === 0) this._branches.delete(validatedSessionId);
	}

	public async loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined> {
		if (!this._persistBranches) return undefined;
		const validatedSessionId = asSessionId(sessionId);
		const validatedBranchId = parsePersistenceBranchId(branchId, `${validatedSessionId}/branches`);
		const branch = this._branches.get(validatedSessionId)?.get(validatedBranchId);
		return branch === undefined ? undefined : [...branch];
	}

	public async listBranchesForSession(sessionId: SessionId): Promise<BranchId[]> {
		if (!this._persistBranches) return [];
		return [...(this._branches.get(asSessionId(sessionId))?.keys() ?? [])].sort(compareCodePoint);
	}

	public async listSessions(): Promise<SessionId[]> {
		const sessions = new Set<SessionId>();
		for (const namespace of [this._histories, this._branches, this._edges, this._summaries]) {
			for (const sessionId of namespace.keys()) sessions.add(sessionId);
		}
		return [...sessions].sort(compareCodePoint);
	}

	public async healthy(): Promise<boolean> {
		return true;
	}

	public async clearAll(): Promise<void> {
		this._histories.clear();
		this._branches.clear();
		this._edges.clear();
		this._summaries.clear();
	}

	public async clearSession(sessionId: SessionId): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		this._histories.delete(validatedSessionId);
		this._branches.delete(validatedSessionId);
		this._edges.delete(validatedSessionId);
		this._summaries.delete(validatedSessionId);
	}

	public async close(): Promise<void> {}

	public async saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertEdgeScopes(validatedSessionId, edges);
		assertUniqueRecordIds(edges, `${validatedSessionId}/edges`, 'edge');
		if (edges.length === 0) this._edges.delete(validatedSessionId);
		else this._edges.set(validatedSessionId, [...edges].sort(compareCreatedThenId));
	}

	public async loadEdges(sessionId: SessionId): Promise<Edge[]> {
		return [...(this._edges.get(asSessionId(sessionId)) ?? [])].sort(compareCreatedThenId);
	}

	public async saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void> {
		const validatedSessionId = asSessionId(sessionId);
		assertSummaryScopes(validatedSessionId, summaries);
		assertUniqueRecordIds(summaries, `${validatedSessionId}/summaries`, 'summary');
		if (summaries.length === 0) this._summaries.delete(validatedSessionId);
		else this._summaries.set(validatedSessionId, [...summaries].sort(compareCreatedThenId));
	}

	public async loadSummaries(sessionId: SessionId): Promise<Summary[]> {
		return [...(this._summaries.get(asSessionId(sessionId)) ?? [])].sort(compareCreatedThenId);
	}
}
