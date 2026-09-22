import { isDeepStrictEqual } from 'node:util';
import type { BranchId, SessionId, ThoughtId } from '../contracts/ids.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceCompatibilityError } from '../errors.js';
import {
	assertBranchScope,
	assertPersistableThoughtCollections,
	assertThoughtScope,
	type PersistedThoughtCollection,
} from './PersistenceScope.js';

export type PersistedBranchSnapshot = {
	readonly branchId: BranchId;
	readonly thoughts: readonly ThoughtData[];
};

export type StagedThoughtState = {
	readonly history: readonly ThoughtData[];
	readonly branches: readonly PersistedBranchSnapshot[];
};

function cloneThoughts(thoughts: readonly ThoughtData[]): ThoughtData[] {
	return [...structuredClone(thoughts)];
}

function collections(
	sessionId: SessionId,
	history: readonly ThoughtData[],
	branches: readonly PersistedBranchSnapshot[]
): PersistedThoughtCollection[] {
	return [
		{ sessionId, thoughts: history },
		...branches.map((branch) => ({ sessionId, thoughts: branch.thoughts })),
	];
}

function retractCopies(
	thoughts: readonly ThoughtData[],
	targetThoughtId: ThoughtId
): ThoughtData[] {
	return thoughts.map((thought) =>
		thought.id === targetThoughtId ? { ...thought, retracted: true } : thought
	);
}

export function stageBacktrackPersistence(
	sessionId: SessionId,
	history: readonly ThoughtData[],
	branches: readonly PersistedBranchSnapshot[],
	thought: ThoughtData,
	targetThoughtId: ThoughtId,
	maxHistorySize: number
): StagedThoughtState {
	assertThoughtScope('saveBacktrackForSession', sessionId, thought);
	if (thought.thought_type !== 'backtrack') {
		throw new PersistenceCompatibilityError(
			`${sessionId}/thoughts`,
			'saveBacktrackForSession requires a backtrack thought'
		);
	}
	if (targetThoughtId.length === 0) {
		throw new PersistenceCompatibilityError(
			`${sessionId}/thoughts`,
			'backtrack target thought id must not be empty'
		);
	}

	const stagedHistory = cloneThoughts(history);
	const stagedBranches = branches.map((branch) => ({
		branchId: branch.branchId,
		thoughts: cloneThoughts(branch.thoughts),
	}));
	assertPersistableThoughtCollections(
		collections(sessionId, stagedHistory, stagedBranches),
		`${sessionId}/backtrack`
	);

	const correctedHistory = [
		...retractCopies(stagedHistory, targetThoughtId),
		structuredClone(thought),
	];
	const retainedHistory =
		maxHistorySize > 0 ? correctedHistory.slice(-maxHistorySize) : correctedHistory;
	const correctedBranches = stagedBranches.map((branch) => ({
		branchId: branch.branchId,
		thoughts: retractCopies(branch.thoughts, targetThoughtId),
	}));
	for (const branch of correctedBranches) {
		assertBranchScope('saveBranchForSession', sessionId, branch.branchId, branch.thoughts);
	}
	assertPersistableThoughtCollections(
		collections(sessionId, retainedHistory, correctedBranches),
		`${sessionId}/backtrack`
	);
	return { history: retainedHistory, branches: correctedBranches };
}

export function repairRetainedBacktracks(
	sessionId: SessionId,
	history: readonly ThoughtData[],
	branches: readonly PersistedBranchSnapshot[]
): StagedThoughtState {
	let repairedHistory = cloneThoughts(history);
	let repairedBranches = branches.map((branch) => ({
		branchId: branch.branchId,
		thoughts: cloneThoughts(branch.thoughts),
	}));
	const allThoughts = (): readonly ThoughtData[] => [
		...repairedHistory,
		...repairedBranches.flatMap((branch) => branch.thoughts),
	];
	const backtracks = new Map<string, ThoughtData>();
	for (const thought of allThoughts()) {
		if (thought.id !== undefined && thought.thought_type === 'backtrack') {
			const existing = backtracks.get(thought.id);
			if (existing === undefined || isDeepStrictEqual(existing, thought)) {
				backtracks.set(thought.id, thought);
			}
		}
	}

	for (const backtrack of backtracks.values()) {
		if (backtrack.backtrack_target === undefined) continue;
		const targetIds = new Set<ThoughtId>();
		for (const candidate of allThoughts()) {
			if (
				candidate.id !== undefined &&
				candidate.id !== backtrack.id &&
				candidate.thought_number === backtrack.backtrack_target
			) {
				targetIds.add(candidate.id);
			}
		}
		if (targetIds.size === 0) continue;
		if (targetIds.size > 1) {
			throw new PersistenceCompatibilityError(
				`restore:${sessionId}`,
				`ambiguous retained backtrack target ${backtrack.backtrack_target}`
			);
		}
		const targetThoughtId = targetIds.values().next().value;
		if (targetThoughtId === undefined) continue;
		repairedHistory = retractCopies(repairedHistory, targetThoughtId);
		repairedBranches = repairedBranches.map((branch) => ({
			branchId: branch.branchId,
			thoughts: retractCopies(branch.thoughts, targetThoughtId),
		}));
	}

	return { history: repairedHistory, branches: repairedBranches };
}
