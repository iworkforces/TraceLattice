import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import type { BranchId, SessionId } from './ids.js';

export interface PersistenceBackend {
	saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void>;
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
