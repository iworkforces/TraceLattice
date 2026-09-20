import { isDeepStrictEqual } from 'node:util';
import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import { asBranchId, asSessionId, type BranchId, type SessionId } from '../contracts/ids.js';
import { PersistenceCompatibilityError } from '../errors.js';
import {
	PersistenceScopeMismatchError,
	type PersistenceScope,
	type PersistenceWriteOperation,
} from './PersistenceErrors.js';

const BRANCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

type PersistedThoughtData = ThoughtData & { readonly id: string };

export interface PersistedThoughtCollection {
	readonly sessionId: SessionId;
	readonly thoughts: readonly ThoughtData[];
}

export function parsePersistenceBranchId(value: string, sourcePath: string): BranchId {
	if (!BRANCH_ID_PATTERN.test(value)) {
		throw new PersistenceCompatibilityError(sourcePath, `invalid branch id '${value}'`);
	}
	return asBranchId(value);
}

export function assertPersistableThoughts(
	thoughts: readonly ThoughtData[],
	sourcePath: string
): asserts thoughts is readonly PersistedThoughtData[] {
	const identifiers = new Set<string>();
	for (const thought of thoughts) {
		if (thought.id === undefined || thought.id.length === 0) {
			throw new PersistenceCompatibilityError(sourcePath, 'persisted thoughts require an id');
		}
		if (identifiers.has(thought.id)) {
			throw new PersistenceCompatibilityError(sourcePath, `duplicate thought id '${thought.id}'`);
		}
		identifiers.add(thought.id);
	}
}

/**
 * Enforces thought identity across session-tagged persisted arrays.
 *
 * Each array must contain unique IDs. Reuse between arrays is valid only for deeply equal
 * payloads in the same session; equal identifiers in different sessions are independent.
 *
 * @param collections - History and branch arrays tagged with their owning session.
 * @param sourcePath - Persistence location included in compatibility errors.
 * @returns Nothing when all collection identities are compatible.
 */
export function assertPersistableThoughtCollections(
	collections: readonly PersistedThoughtCollection[],
	sourcePath: string
): void {
	const payloadsBySession = new Map<SessionId, Map<string, ThoughtData>>();
	for (const collection of collections) {
		assertPersistableThoughts(collection.thoughts, sourcePath);
		let sessionPayloads = payloadsBySession.get(collection.sessionId);
		if (sessionPayloads === undefined) {
			sessionPayloads = new Map<string, ThoughtData>();
			payloadsBySession.set(collection.sessionId, sessionPayloads);
		}
		for (const thought of collection.thoughts) {
			const identifier = thought.id;
			const existing = sessionPayloads.get(identifier);
			if (existing !== undefined && !isDeepStrictEqual(existing, thought)) {
				throw new PersistenceCompatibilityError(
					sourcePath,
					`conflicting thought id '${identifier}'`
				);
			}
			sessionPayloads.set(identifier, thought);
		}
	}
}

function thoughtScope(thought: ThoughtData): PersistenceScope {
	return {
		sessionId: asSessionId(thought.session_id),
		...(thought.branch_id === undefined ? {} : { branchId: thought.branch_id }),
	};
}

export function assertThoughtScope(
	operation: Extract<PersistenceWriteOperation, 'saveThought' | 'saveThoughtForSession'>,
	sessionId: SessionId,
	thought: ThoughtData
): void {
	const actualScope = thoughtScope(thought);
	if (actualScope.sessionId !== sessionId) {
		throw new PersistenceScopeMismatchError(operation, { sessionId }, [actualScope]);
	}
}

export function assertBranchScope(
	operation: Extract<PersistenceWriteOperation, 'saveBranch' | 'saveBranchForSession'>,
	sessionId: SessionId,
	branchId: BranchId,
	thoughts: readonly ThoughtData[]
): void {
	const expectedScope = { sessionId, branchId } satisfies PersistenceScope;
	const mismatches = thoughts
		.map(thoughtScope)
		.filter(
			(scope) =>
				scope.sessionId !== expectedScope.sessionId ||
				(scope.branchId !== undefined && scope.branchId !== expectedScope.branchId)
		);
	if (mismatches.length > 0) {
		throw new PersistenceScopeMismatchError(operation, expectedScope, mismatches);
	}
}

export function assertEdgeScopes(sessionId: SessionId, edges: readonly Edge[]): void {
	const actualScopes = edges
		.filter((edge) => edge.sessionId !== sessionId)
		.map((edge) => ({ sessionId: edge.sessionId }));
	if (actualScopes.length > 0) {
		throw new PersistenceScopeMismatchError('saveEdges', { sessionId }, actualScopes);
	}
}

export function assertSummaryScopes(sessionId: SessionId, summaries: readonly Summary[]): void {
	const actualScopes = summaries
		.filter((summary) => summary.sessionId !== sessionId)
		.map((summary) => ({
			sessionId: summary.sessionId,
			...(summary.branchId === undefined ? {} : { branchId: summary.branchId }),
		}));
	if (actualScopes.length > 0) {
		throw new PersistenceScopeMismatchError('saveSummaries', { sessionId }, actualScopes);
	}
}

export function assertUniqueRecordIds(
	records: readonly { readonly id: string }[],
	sourcePath: string,
	recordKind: 'edge' | 'summary'
): void {
	const identifiers = new Set<string>();
	for (const record of records) {
		if (identifiers.has(record.id)) {
			throw new PersistenceCompatibilityError(
				sourcePath,
				`duplicate ${recordKind} id '${record.id}'`
			);
		}
		identifiers.add(record.id);
	}
}

export function compareCodePoint(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function compareCreatedThenId(
	left: { readonly createdAt: number; readonly id: string },
	right: { readonly createdAt: number; readonly id: string }
): number {
	return left.createdAt - right.createdAt || compareCodePoint(left.id, right.id);
}
