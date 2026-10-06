/**
 * GraphContext — describe a thought's position in the active-evidence graph.
 * @module core/reasoning/GraphContext
 */

import type { SessionId, ThoughtId } from '../../contracts/ids.js';
import type { ActiveEvidenceProjection } from '../../contracts/strategy.js';
import type { EdgeKind } from '../graph/Edge.js';
import type { GraphRelation } from '../graph/GraphView.js';
import type { ThoughtData } from '../thought.js';

export interface GraphNeighbour {
	readonly thought_number: number;
	readonly kind: EdgeKind;
	readonly branch_id?: string;
}

export interface GraphContext {
	/** Shortest directed distance from a root; null when no root reaches the thought. */
	readonly root_distance: number | null;
	/** Distinct thoughts this thought transitively rests on (all edge kinds, incoming BFS). */
	readonly ancestor_count: number;
	/** Incoming edges (neighbour -> this thought), store order. */
	readonly inbound: readonly GraphNeighbour[];
	/** Outgoing edges (this thought -> neighbour), store order. */
	readonly outbound: readonly GraphNeighbour[];
}

export function buildGraphContext(
	sessionId: SessionId,
	thought: ThoughtData,
	evidence: ActiveEvidenceProjection
): GraphContext | undefined {
	const graph = evidence.graph;
	if (graph === undefined || thought.id === undefined) return undefined;
	const inbound = graph.inbound(sessionId, thought.id);
	const outbound = graph.outbound(sessionId, thought.id);
	if (inbound.length === 0 && outbound.length === 0) return undefined;

	const thoughts = new Map<ThoughtId, ThoughtData>();
	for (const activeThought of evidence.activeThoughts) {
		if (activeThought.id !== undefined) thoughts.set(activeThought.id, activeThought);
	}
	return {
		root_distance: graph.depthFromRoots(sessionId, thought.id) ?? null,
		ancestor_count: graph.ancestors(sessionId, thought.id).length,
		inbound: mapNeighbours(inbound, thoughts),
		outbound: mapNeighbours(outbound, thoughts),
	};
}

function mapNeighbours(
	relations: readonly GraphRelation[],
	thoughts: ReadonlyMap<ThoughtId, ThoughtData>
): readonly GraphNeighbour[] {
	return relations.flatMap(({ id, kind }) => {
		const neighbour = thoughts.get(id);
		return neighbour === undefined
			? []
			: [
					{
						thought_number: neighbour.thought_number,
						kind,
						...(neighbour.branch_id === undefined ? {} : { branch_id: neighbour.branch_id }),
					},
				];
	});
}
