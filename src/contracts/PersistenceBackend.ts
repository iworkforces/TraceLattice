import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import type { BranchId, SessionId, ThoughtId } from './ids.js';

export interface PersistenceBackend {
	saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void>;
	/**
	 * Atomically persist a backtrack correction for one session.
	 *
	 * Implementations must retract every retained stable-ID copy of `targetThoughtId`, append
	 * `thought`, and apply retention as one all-or-none operation. This is a required contract,
	 * including for custom backends: callers do not probe for it or fall back to ordinary writes.
	 * The ordinary persistence methods keep their existing contracts.
	 */
	saveBacktrackForSession(
		sessionId: SessionId,
		thought: ThoughtData,
		targetThoughtId: ThoughtId
	): Promise<void>;
	loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]>;
	saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void>;
	deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void>;
	loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined>;
	listBranchesForSession(sessionId: SessionId): Promise<BranchId[]>;
	listSessions(): Promise<SessionId[]>;
	healthy(): Promise<boolean>;
	clearSession(sessionId: SessionId): Promise<void>;
	clearAll(): Promise<void>;
	saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void>;
	loadEdges(sessionId: SessionId): Promise<Edge[]>;
	saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void>;
	loadSummaries(sessionId: SessionId): Promise<Summary[]>;
	close(): Promise<void>;
}

export interface PersistedBranchRecord {
	readonly branchId: BranchId;
	readonly thoughts: readonly ThoughtData[];
}

export interface PersistedSessionRecord {
	readonly sessionId: SessionId;
	readonly history: readonly ThoughtData[];
	/** Ascending by branch id (code-point order). Empty when branch persistence is disabled. */
	readonly branches: readonly PersistedBranchRecord[];
	readonly edges: readonly Edge[];
	readonly summaries: readonly Summary[];
}

export interface PersistenceRestoreRead {
	/** Unique sessions in ascending id order: the union of history, branch, edge and summary sessions. */
	readonly sessions: readonly PersistedSessionRecord[];
}

export interface PersistenceConfig {
	enabled?: boolean;
	backend?: 'file' | 'sqlite' | 'memory';
	options?: {
		dataDir?: string;
		dbPath?: string;
		enableWAL?: boolean;
		maxHistorySize?: number;
		persistBranches?: boolean;
	};
}
