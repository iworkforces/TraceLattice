import type {
	PersistedBranchRecord,
	PersistedSessionRecord,
	PersistenceBackend,
} from '../contracts/PersistenceBackend.js';
import { asSessionId, type BranchId, type SessionId } from '../contracts/ids.js';
import type { Summary } from './compression/Summary.js';
import { PersistenceCompatibilityError, PersistenceUnavailableError } from '../errors.js';
import {
	assertBranchScope,
	assertEdgeScopes,
	assertPersistableThoughtCollections,
	assertSummaryScopes,
	assertThoughtScope,
	assertUniqueRecordIds,
	compareCodePoint,
	parsePersistenceBranchId,
	type PersistedThoughtCollection,
} from '../persistence/PersistenceScope.js';
import type { Edge } from './graph/Edge.js';
import { EdgeStore } from './graph/EdgeStore.js';
import type { ThoughtData } from './thought.js';
import { repairRetainedBacktracks } from '../persistence/BacktrackPersistence.js';

export type RestoredBranch = {
	readonly branchId: BranchId;
	readonly thoughts: readonly ThoughtData[];
};

export type RestoredSession = {
	readonly sessionId: SessionId;
	readonly history: readonly ThoughtData[];
	readonly branches: readonly RestoredBranch[];
	readonly edges: readonly Edge[];
	readonly summaries: readonly Summary[];
};

export type PersistenceRestoreSnapshot = {
	readonly sessions: readonly RestoredSession[];
};

function validateThoughts(
	sessionId: SessionId,
	history: readonly ThoughtData[],
	branches: readonly RestoredBranch[]
): void {
	for (const thought of history) assertThoughtScope('saveThoughtForSession', sessionId, thought);
	for (const branch of branches) {
		assertBranchScope('saveBranchForSession', sessionId, branch.branchId, branch.thoughts);
	}
	const collections: PersistedThoughtCollection[] = [
		{ sessionId, thoughts: history },
		...branches.map((branch) => ({ sessionId, thoughts: branch.thoughts })),
	];
	assertPersistableThoughtCollections(collections, `restore:${sessionId}`);
}

function stageBranches(
	sessionId: SessionId,
	records: readonly PersistedBranchRecord[]
): RestoredBranch[] {
	const branches: RestoredBranch[] = [];
	const seenBranches = new Set<BranchId>();
	for (const record of records) {
		const branchId = parsePersistenceBranchId(record.branchId, `restore:${sessionId}:branches`);
		if (seenBranches.has(branchId)) {
			throw new PersistenceCompatibilityError(
				`restore:${sessionId}:branches`,
				`duplicate branch id '${branchId}'`
			);
		}
		seenBranches.add(branchId);
		branches.push(Object.freeze({ branchId, thoughts: Object.freeze([...record.thoughts]) }));
	}
	return branches.sort((left, right) => compareCodePoint(left.branchId, right.branchId));
}

function stageSession(sessionId: SessionId, record: PersistedSessionRecord): RestoredSession {
	const branches = stageBranches(sessionId, record.branches);
	const repaired = repairRetainedBacktracks(sessionId, record.history, branches);
	const repairedBranches = repaired.branches.map((branch) =>
		Object.freeze({ branchId: branch.branchId, thoughts: Object.freeze([...branch.thoughts]) })
	);
	validateThoughts(sessionId, repaired.history, repairedBranches);

	assertEdgeScopes(sessionId, record.edges);
	assertUniqueRecordIds(record.edges, `restore:${sessionId}:edges`, 'edge');
	const validationStore = new EdgeStore();
	for (const restoredEdge of record.edges) validationStore.addEdge(restoredEdge);

	assertSummaryScopes(sessionId, record.summaries);
	assertUniqueRecordIds(record.summaries, `restore:${sessionId}:summaries`, 'summary');

	return Object.freeze({
		sessionId,
		history: Object.freeze([...repaired.history]),
		branches: Object.freeze(repairedBranches),
		edges: Object.freeze([...record.edges]),
		summaries: Object.freeze([...record.summaries]),
	});
}

export async function stagePersistenceRestore(
	backend: PersistenceBackend
): Promise<PersistenceRestoreSnapshot> {
	if (!(await backend.healthy())) throw new PersistenceUnavailableError();

	const read = await backend.loadAllSessionsForRestore();
	const sessions: RestoredSession[] = [];
	const seenSessions = new Set<SessionId>();
	for (const record of read.sessions) {
		const sessionId = asSessionId(record.sessionId);
		if (seenSessions.has(sessionId)) {
			throw new PersistenceCompatibilityError(
				'restore:sessions',
				`duplicate session id '${sessionId}'`
			);
		}
		seenSessions.add(sessionId);
		sessions.push(stageSession(sessionId, record));
	}
	return Object.freeze({ sessions: Object.freeze(sessions) });
}
