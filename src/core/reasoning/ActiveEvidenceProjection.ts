import type { IEdgeStore, IGraphViewStore } from '../../contracts/interfaces.js';
import type { ActiveEvidenceProjection } from '../../contracts/strategy.js';
import type { SessionId, ThoughtId } from '../../contracts/ids.js';
import {
	collectActiveMainThoughts,
	collectActiveThoughts,
	type ActiveThoughtBranches,
} from '../evaluator/VerificationLinks.js';
import { GraphView } from '../graph/GraphView.js';
import type { Edge } from '../graph/Edge.js';
import type { ThoughtData } from '../thought.js';

export interface ActiveEvidenceProjectionInput {
	readonly sessionId: SessionId;
	readonly history: readonly ThoughtData[];
	readonly branches: ActiveThoughtBranches;
	readonly edgeStore: IEdgeStore | undefined;
}

class ProjectedGraphStore implements IGraphViewStore {
	private readonly _edges: readonly Edge[];
	private readonly _nodes: readonly ThoughtId[];
	private readonly _outgoing: ReadonlyMap<ThoughtId, readonly Edge[]>;
	private readonly _incoming: ReadonlyMap<ThoughtId, readonly Edge[]>;
	private readonly _sessionId: SessionId;

	constructor(sessionId: SessionId, edges: readonly Edge[], nodes: readonly ThoughtId[]) {
		this._sessionId = sessionId;
		this._edges = Object.freeze(edges.map(copyEdge));
		this._nodes = Object.freeze([...nodes]);
		this._outgoing = buildAdjacency(this._edges, 'from');
		this._incoming = buildAdjacency(this._edges, 'to');
	}

	outgoing(sessionId: SessionId, from: ThoughtId): readonly Edge[] {
		return sessionId === this._sessionId ? (this._outgoing.get(from) ?? []) : [];
	}

	incoming(sessionId: SessionId, to: ThoughtId): readonly Edge[] {
		return sessionId === this._sessionId ? (this._incoming.get(to) ?? []) : [];
	}

	edgesForSession(sessionId: SessionId): readonly Edge[] {
		return sessionId === this._sessionId ? this._edges : [];
	}

	nodesForSession(sessionId: SessionId): readonly ThoughtId[] {
		return sessionId === this._sessionId ? this._nodes : [];
	}
}

/**
 * Build immutable, deep-copied active evidence for strategy reads.
 *
 * Main history keeps retained main order. Active thoughts include branch-only retained entries.
 * The graph is induced by active endpoints only, without path contraction, and never mutates the
 * audit edge store.
 */
export function buildActiveEvidenceProjection(
	input: ActiveEvidenceProjectionInput
): ActiveEvidenceProjection {
	const mainHistory = freezeThoughts(collectActiveMainThoughts(input.history, input.branches));
	const activeThoughts = freezeThoughts(collectActiveThoughts(input.history, input.branches));
	const graph = input.edgeStore
		? projectGraph(input.sessionId, activeThoughts, input.edgeStore)
		: undefined;
	return Object.freeze({ mainHistory, activeThoughts, graph });
}

function projectGraph(
	sessionId: SessionId,
	activeThoughts: readonly ThoughtData[],
	edgeStore: IEdgeStore
): GraphView {
	const activeIds = new Set(activeThoughts.flatMap((thought) => (thought.id ? [thought.id] : [])));
	const auditEdges = edgeStore.edgesForSession(sessionId);
	const visibleNodes = new Set<ThoughtId>();
	for (const edge of auditEdges) {
		if (activeIds.has(edge.from)) visibleNodes.add(edge.from);
		if (activeIds.has(edge.to)) visibleNodes.add(edge.to);
	}
	const edges = auditEdges.filter((edge) => activeIds.has(edge.from) && activeIds.has(edge.to));
	return new GraphView(new ProjectedGraphStore(sessionId, edges, [...visibleNodes]));
}

function freezeThoughts(thoughts: readonly ThoughtData[]): readonly ThoughtData[] {
	return Object.freeze(thoughts.map((thought) => Object.freeze(structuredClone(thought))));
}

function copyEdge(edge: Edge): Edge {
	return Object.freeze({
		...edge,
		...(edge.metadata === undefined ? {} : { metadata: copyMetadata(edge.metadata) }),
	});
}

function copyMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(metadata).map(([key, value]) => [key, copyMetadataValue(value)])
		)
	);
}

function copyMetadataValue(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(copyMetadataValue));
	if (isMetadataRecord(value)) return copyMetadata(value);
	return value;
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function buildAdjacency(
	edges: readonly Edge[],
	endpoint: 'from' | 'to'
): ReadonlyMap<ThoughtId, readonly Edge[]> {
	const mutable = new Map<ThoughtId, Edge[]>();
	for (const edge of edges) {
		const key = edge[endpoint];
		const bucket = mutable.get(key);
		if (bucket === undefined) mutable.set(key, [edge]);
		else bucket.push(edge);
	}
	return new Map([...mutable].map(([key, bucket]) => [key, Object.freeze(bucket)]));
}
