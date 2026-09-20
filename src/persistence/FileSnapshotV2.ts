import * as v from 'valibot';
import type { SessionId } from '../contracts/ids.js';
import { asSessionId } from '../contracts/ids.js';
import { SummarySchema } from '../core/compression/Summary.js';
import type { ThoughtData } from '../core/thought.js';
import { PersistenceCompatibilityError, PersistenceCorruptionError } from '../errors.js';
import { EdgeSchema, SequentialThinkingSchema } from '../schema.js';
import { parseEdge, parseSummary, parseThoughtData } from './PersistenceCodec.js';
import type { FileSnapshotV2 } from './FileSnapshotTypes.js';
import {
	compareCodePoint,
	compareCreatedThenId,
	parsePersistenceBranchId,
} from './PersistenceScope.js';
import { validateFileSnapshotV2 } from './FileSnapshotValidation.js';

const SessionIdStringSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,100}$/));
const BranchIdStringSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,50}$/));
const ThoughtSessionV2Schema = v.strictObject({
	sessionId: SessionIdStringSchema,
	thoughts: v.array(SequentialThinkingSchema),
});
const BranchRecordV2Schema = v.strictObject({
	sessionId: SessionIdStringSchema,
	branchId: BranchIdStringSchema,
	thoughts: v.array(SequentialThinkingSchema),
});
const EdgeSessionV2Schema = v.strictObject({
	sessionId: SessionIdStringSchema,
	edges: v.array(EdgeSchema),
});
const SummarySessionV2Schema = v.strictObject({
	sessionId: SessionIdStringSchema,
	summaries: v.array(SummarySchema),
});

export const FileSnapshotV2Schema = v.strictObject({
	version: v.literal(2),
	thoughts: v.array(ThoughtSessionV2Schema),
	branches: v.array(BranchRecordV2Schema),
	edges: v.array(EdgeSessionV2Schema),
	summaries: v.array(SummarySessionV2Schema),
});

export const EMPTY_FILE_SNAPSHOT_V2: FileSnapshotV2 = {
	version: 2,
	thoughts: [],
	branches: [],
	edges: [],
	summaries: [],
};

export function parseFileSnapshotV2(content: string, sourcePath: string): FileSnapshotV2 {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (error) {
		throw new PersistenceCorruptionError(sourcePath, error);
	}
	try {
		const parsed = v.parse(FileSnapshotV2Schema, raw);
		const snapshot: FileSnapshotV2 = {
			version: 2,
			thoughts: parsed.thoughts.map((record) => ({
				sessionId: asSessionId(record.sessionId),
				thoughts: record.thoughts.map((thought) => parseThoughtData(thought, sourcePath)),
			})),
			branches: parsed.branches.map((record) => ({
				sessionId: asSessionId(record.sessionId),
				branchId: parsePersistenceBranchId(record.branchId, sourcePath),
				thoughts: record.thoughts.map((thought) => parseThoughtData(thought, sourcePath)),
			})),
			edges: parsed.edges.map((record) => ({
				sessionId: asSessionId(record.sessionId),
				edges: record.edges.map(parseEdge),
			})),
			summaries: parsed.summaries.map((record) => ({
				sessionId: asSessionId(record.sessionId),
				summaries: record.summaries.map((summary) => parseSummary(summary, sourcePath)),
			})),
		};
		validateFileSnapshotV2(snapshot, sourcePath);
		return snapshot;
	} catch (error) {
		if (error instanceof PersistenceCompatibilityError) throw error;
		throw new PersistenceCompatibilityError(sourcePath, 'document does not match File v2', error);
	}
}

export function serializeFileSnapshotV2(snapshot: FileSnapshotV2, sourcePath: string): string {
	const canonical: FileSnapshotV2 = {
		version: 2,
		thoughts: [...snapshot.thoughts].sort((left, right) =>
			compareCodePoint(left.sessionId, right.sessionId)
		),
		branches: [...snapshot.branches].sort(
			(left, right) =>
				compareCodePoint(left.sessionId, right.sessionId) ||
				compareCodePoint(left.branchId, right.branchId)
		),
		edges: [...snapshot.edges]
			.sort((left, right) => compareCodePoint(left.sessionId, right.sessionId))
			.map((record) => ({ ...record, edges: [...record.edges].sort(compareCreatedThenId) })),
		summaries: [...snapshot.summaries]
			.sort((left, right) => compareCodePoint(left.sessionId, right.sessionId))
			.map((record) => ({
				...record,
				summaries: [...record.summaries].sort(compareCreatedThenId),
			})),
	};
	validateFileSnapshotV2(canonical, sourcePath);
	return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function sessionsInSnapshot(snapshot: FileSnapshotV2): SessionId[] {
	const sessions = new Set<SessionId>();
	for (const records of [
		snapshot.thoughts,
		snapshot.branches,
		snapshot.edges,
		snapshot.summaries,
	]) {
		for (const record of records) sessions.add(record.sessionId);
	}
	return [...sessions].sort(compareCodePoint);
}

export function sessionForThought(thought: ThoughtData): SessionId {
	return asSessionId(thought.session_id);
}
