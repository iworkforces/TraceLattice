import type { PersistenceBackend } from '../contracts/PersistenceBackend.js';
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

async function stageSession(
	persistence: PersistenceBackend,
	sessionId: SessionId
): Promise<RestoredSession> {
	const history = await persistence.loadHistoryForSession(sessionId);
	const listedBranches = await persistence.listBranchesForSession(sessionId);
	const branches: RestoredBranch[] = [];
	const seenBranches = new Set<BranchId>();
	for (const listedBranchId of listedBranches) {
		const branchId = parsePersistenceBranchId(listedBranchId, `restore:${sessionId}:branches`);
		if (seenBranches.has(branchId)) {
			throw new PersistenceCompatibilityError(
				`restore:${sessionId}:branches`,
				`duplicate branch id '${branchId}'`
			);
		}
		seenBranches.add(branchId);
		const thoughts = await persistence.loadBranchForSession(sessionId, branchId);
		if (thoughts === undefined) {
			throw new PersistenceCompatibilityError(
				`restore:${sessionId}:branches:${branchId}`,
				'listed branch is missing'
			);
		}
		branches.push(Object.freeze({ branchId, thoughts: Object.freeze([...thoughts]) }));
	}
	const repaired = repairRetainedBacktracks(sessionId, history, branches);
	const repairedBranches = repaired.branches.map((branch) =>
		Object.freeze({ branchId: branch.branchId, thoughts: Object.freeze([...branch.thoughts]) })
	);
	validateThoughts(sessionId, repaired.history, repairedBranches);

	const edges = await persistence.loadEdges(sessionId);
	assertEdgeScopes(sessionId, edges);
	assertUniqueRecordIds(edges, `restore:${sessionId}:edges`, 'edge');
	const validationStore = new EdgeStore();
	for (const restoredEdge of edges) validationStore.addEdge(restoredEdge);

	const summaries = await persistence.loadSummaries(sessionId);
	assertSummaryScopes(sessionId, summaries);
	assertUniqueRecordIds(summaries, `restore:${sessionId}:summaries`, 'summary');

	return Object.freeze({
		sessionId,
		history: Object.freeze([...repaired.history]),
		branches: Object.freeze(repairedBranches),
		edges: Object.freeze([...edges]),
		summaries: Object.freeze([...summaries]),
	});
}

export async function stagePersistenceRestore(
	backend: PersistenceBackend
): Promise<PersistenceRestoreSnapshot> {
	if (!(await backend.healthy())) throw new PersistenceUnavailableError();

	const listedSessions = await backend.listSessions();
	const sessionIds: SessionId[] = [];
	const seen = new Set<SessionId>();
	for (const listedSessionId of listedSessions) {
		const sessionId = asSessionId(listedSessionId);
		if (seen.has(sessionId)) continue;
		seen.add(sessionId);
		sessionIds.push(sessionId);
	}

	const sessions: RestoredSession[] = [];
	for (const sessionId of sessionIds) sessions.push(await stageSession(backend, sessionId));
	return Object.freeze({ sessions: Object.freeze(sessions) });
}
