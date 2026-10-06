/**
 * GraphView — read-only graph traversal queries over an {@link IEdgeStore}.
 *
 * Provides BFS / topological / ancestor / descendant queries over the
 * thought DAG. Queries return thought ids or graph distances,
 * never `ThoughtData` objects — the view is intentionally decoupled from
 * `HistoryManager` so it can be reused by strategies that work purely in
 * terms of graph structure.
 *
 * Construction is cheap (stores a reference to the underlying store).
 * Each query reads the latest store state — no caching, no snapshots.
 *
 * @module core/graph/GraphView
 */

import type { IGraphViewStore } from '../../contracts/interfaces.js';
import type { SessionId, ThoughtId } from '../../contracts/ids.js';
import { CycleDetectedError } from '../../errors.js';
import type { Edge, EdgeKind } from './Edge.js';

export interface GraphMetrics {
	/** Distinct visible edge endpoints and explicit nodes. */
	readonly node_count: number;
	readonly edge_count: number;
	/** Nodes with no incoming edge. */
	readonly root_count: number;
	/** Nodes with no outgoing edge. */
	readonly leaf_count: number;
	/** Longest path in edges; zero without edges, null when any cycle exists. */
	readonly longest_path: number | null;
	/** Maximum outgoing edge count; zero without edges. */
	readonly max_out_degree: number;
	/** Maximum incoming edge count; zero without edges. */
	readonly max_in_degree: number;
	/** Counts for all eight kinds, including absent kinds. */
	readonly edge_kind_counts: Readonly<Record<EdgeKind, number>>;
	/** Weakly connected components; zero for an empty graph. */
	readonly component_count: number;
}

export interface GraphRelation {
	readonly id: ThoughtId;
	readonly kind: EdgeKind;
}

/**
 * Read-only traversal queries over an {@link IEdgeStore}.
 *
 * @example
 * ```typescript
 * const store = new EdgeStore();
 * // ... populate store ...
 * const view = new GraphView(store);
 * const order = view.topological('s1');
 * ```
 */
export class GraphView {
	private readonly _store: IGraphViewStore;

	/**
	 * Create a new GraphView backed by the given edge store.
	 *
	 * @param store - The edge store to query (held by reference, read-only access)
	 *
	 * @example
	 * ```typescript
	 * const view = new GraphView(edgeStore);
	 * ```
	 */
	constructor(store: IGraphViewStore) {
		this._store = store;
	}

	/**
	 * Return all thought ids in the session, ordered by BFS from roots.
	 *
	 * Roots are nodes with no incoming edges. Within a layer, neighbours
	 * are visited in `outgoing` order (which the underlying store keeps
	 * sorted by `createdAt` ascending).
	 *
	 * @param sessionId - Session to query
	 * @returns Thought ids in chronological BFS order
	 *
	 * @example
	 * ```typescript
	 * const ids = view.chronological('s1');
	 * ```
	 */
	chronological(sessionId: SessionId): readonly ThoughtId[] {
		const edges = this._store.edgesForSession(sessionId);
		const { nodes, hasIncoming } = this._collectNodes(
			edges,
			this._store.nodesForSession?.(sessionId)
		);
		if (nodes.size === 0) return [];
		const roots = this._findRoots(nodes, hasIncoming, edges);
		return this._bfsFromRoots(sessionId, roots) as readonly ThoughtId[];
	}

	/**
	 * Return the shortest directed distance from any retained root to a thought.
	 *
	 * Nodes are derived from edges unless an immutable snapshot supplies original
	 * endpoint nodes. Thoughts never referenced by an audit edge remain invisible.
	 * Every edge kind participates in the traversal.
	 *
	 * @param sessionId - Session to query
	 * @param thoughtId - Thought whose root distance to resolve
	 * @returns Zero for a root, or `undefined` when no root can reach the thought
	 */
	depthFromRoots(sessionId: SessionId, thoughtId: ThoughtId): number | undefined {
		const edges = this._store.edgesForSession(sessionId);
		const nodes = new Set<ThoughtId>(this._store.nodesForSession?.(sessionId) ?? []);
		const hasIncoming = new Set<ThoughtId>();
		const outgoing = new Map<ThoughtId, ThoughtId[]>();
		for (const edge of edges) {
			nodes.add(edge.from);
			nodes.add(edge.to);
			hasIncoming.add(edge.to);
			const children = outgoing.get(edge.from);
			if (children === undefined) outgoing.set(edge.from, [edge.to]);
			else children.push(edge.to);
		}
		if (!nodes.has(thoughtId)) return undefined;

		let frontier: ThoughtId[] = [];
		for (const node of nodes) {
			if (!hasIncoming.has(node)) frontier.push(node);
		}
		const visited = new Set<ThoughtId>(frontier);
		let depth = 0;
		while (frontier.length > 0) {
			const next: ThoughtId[] = [];
			for (const node of frontier) {
				if (node === thoughtId) return depth;
				for (const child of outgoing.get(node) ?? []) {
					if (visited.has(child)) continue;
					visited.add(child);
					next.push(child);
				}
			}
			frontier = next;
			depth++;
		}
		return undefined;
	}

	/**
	 * Return all thought ids reachable from `rootThoughtId` via `'branch'`
	 * edges, including the root itself.
	 *
	 * Non-branch edges are ignored. Cycles (if any) do not cause infinite
	 * loops because each node is visited at most once.
	 *
	 * @param sessionId - Session to query
	 * @param rootThoughtId - The starting thought id (typically the branch root)
	 * @returns Thought ids forming the branch (includes root)
	 *
	 * @example
	 * ```typescript
	 * const branchIds = view.branchThoughts('s1', 'thought-root');
	 * ```
	 */
	branchThoughts(sessionId: SessionId, rootThoughtId: ThoughtId): readonly ThoughtId[] {
		const visited = new Set<string>([rootThoughtId]);
		const order: string[] = [rootThoughtId];
		const queue: string[] = [rootThoughtId];
		let head = 0;
		while (head < queue.length) {
			const current = queue[head++]!;
			const out = this._store.outgoing(sessionId, current as ThoughtId);
			for (const edge of out) {
				if (edge.kind !== 'branch') continue;
				if (visited.has(edge.to)) continue;
				visited.add(edge.to);
				order.push(edge.to);
				queue.push(edge.to);
			}
		}
		return order as ThoughtId[];
	}

	/**
	 * Return a topological ordering of all thought ids in the session
	 * using Kahn's algorithm.
	 *
	 * @param sessionId - Session to query
	 * @returns Thought ids in topological order
	 * @throws {CycleDetectedError} If the graph contains a cycle
	 *
	 * @example
	 * ```typescript
	 * const order = view.topological('s1');
	 * ```
	 */
	topological(sessionId: SessionId): readonly ThoughtId[] {
		const edges = this._store.edgesForSession(sessionId);
		const inDegree = this._buildInDegree(edges, this._store.nodesForSession?.(sessionId));
		if (inDegree.size === 0) return [];
		const queue: string[] = [];
		for (const [node, deg] of inDegree) {
			if (deg === 0) queue.push(node);
		}
		const order: string[] = [];
		let head = 0;
		while (head < queue.length) {
			const node = queue[head++]!;
			order.push(node);
			for (const edge of this._store.outgoing(sessionId, node as ThoughtId)) {
				const next = (inDegree.get(edge.to) ?? 0) - 1;
				inDegree.set(edge.to, next);
				if (next === 0) queue.push(edge.to);
			}
		}
		if (order.length !== inDegree.size) {
			throw new CycleDetectedError(
				`Cycle detected in session '${sessionId}': topological sort incomplete (${order.length}/${inDegree.size})`
			);
		}
		return order as ThoughtId[];
	}

	/**
	 * Return all ancestors of `thoughtId` via incoming-edge BFS.
	 *
	 * The starting node is NOT included. Cycles do not cause infinite loops.
	 *
	 * @param sessionId - Session to query
	 * @param thoughtId - The thought to traverse from
	 * @param maxDepth - Optional maximum traversal depth (1 = direct parents only)
	 * @param kinds - Optional edge kinds to follow; empty follows all kinds
	 * @returns Ancestor thought ids in BFS order
	 *
	 * @example
	 * ```typescript
	 * const parents = view.ancestors('s1', 'thought-id', 1);
	 * ```
	 */
	ancestors(
		sessionId: SessionId,
		thoughtId: ThoughtId,
		maxDepth?: number,
		kinds?: readonly EdgeKind[]
	): readonly ThoughtId[] {
		return this._bfsClosure(
			sessionId,
			thoughtId,
			maxDepth,
			'incoming',
			kinds
		) as readonly ThoughtId[];
	}

	/**
	 * Return all descendants of `thoughtId` via outgoing-edge BFS.
	 *
	 * The starting node is NOT included. Cycles do not cause infinite loops.
	 *
	 * @param sessionId - Session to query
	 * @param thoughtId - The thought to traverse from
	 * @param maxDepth - Optional maximum traversal depth (1 = direct children only)
	 * @param kinds - Optional edge kinds to follow; empty follows all kinds
	 * @returns Descendant thought ids in BFS order
	 *
	 * @example
	 * ```typescript
	 * const children = view.descendants('s1', 'thought-id');
	 * ```
	 */
	descendants(
		sessionId: SessionId,
		thoughtId: ThoughtId,
		maxDepth?: number,
		kinds?: readonly EdgeKind[]
	): readonly ThoughtId[] {
		return this._bfsClosure(
			sessionId,
			thoughtId,
			maxDepth,
			'outgoing',
			kinds
		) as readonly ThoughtId[];
	}

	/**
	 * Return incoming relations in store order.
	 * @param sessionId - Session to query
	 * @param thoughtId - Thought whose incoming edges to list
	 * @returns Source ids and edge kinds, or an empty array for an unknown node
	 */
	inbound(sessionId: SessionId, thoughtId: ThoughtId): readonly GraphRelation[] {
		return this._store.incoming(sessionId, thoughtId).map((edge) => ({
			id: edge.from,
			kind: edge.kind,
		}));
	}

	/**
	 * Return outgoing relations in store order.
	 * @param sessionId - Session to query
	 * @param thoughtId - Thought whose outgoing edges to list
	 * @returns Target ids and edge kinds, or an empty array for an unknown node
	 */
	outbound(sessionId: SessionId, thoughtId: ThoughtId): readonly GraphRelation[] {
		return this._store.outgoing(sessionId, thoughtId).map((edge) => ({
			id: edge.to,
			kind: edge.kind,
		}));
	}

	/**
	 * Test reachability by one or more directed edges, including cycles.
	 * @param sessionId - Session to query
	 * @param from - Starting thought id
	 * @param to - Target thought id
	 * @param kinds - Optional edge kinds to follow; empty follows all kinds
	 * @returns Whether a nonempty directed path reaches the target
	 */
	hasPath(
		sessionId: SessionId,
		from: ThoughtId,
		to: ThoughtId,
		kinds?: readonly EdgeKind[]
	): boolean {
		const allowed = kinds?.length ? new Set(kinds) : undefined;
		const visited = new Set<ThoughtId>([from]);
		const queue: ThoughtId[] = [from];
		for (const node of queue) {
			for (const edge of this._store.outgoing(sessionId, node)) {
				if (allowed !== undefined && !allowed.has(edge.kind)) continue;
				if (edge.to === to) return true;
				if (visited.has(edge.to)) continue;
				visited.add(edge.to);
				queue.push(edge.to);
			}
		}
		return false;
	}

	/**
	 * Compute structural metrics over every visible node and edge kind.
	 * @param sessionId - Session to query
	 * @returns Counts and longest path length, with null longest_path on cycles
	 */
	metrics(sessionId: SessionId): GraphMetrics {
		const edges = this._store.edgesForSession(sessionId);
		const explicitNodes = this._store.nodesForSession?.(sessionId);
		const { nodes, hasIncoming } = this._collectNodes(edges, explicitNodes);
		const inDegree = this._buildInDegree(edges, explicitNodes);
		const outDegree = new Map<string, number>();
		let maxIn = 0;
		let maxOut = 0;
		for (const edge of edges) {
			const degree = (outDegree.get(edge.from) ?? 0) + 1;
			outDegree.set(edge.from, degree);
			maxOut = Math.max(maxOut, degree);
		}
		for (const degree of inDegree.values()) maxIn = Math.max(maxIn, degree);
		return {
			node_count: nodes.size,
			edge_count: edges.length,
			root_count: nodes.size - hasIncoming.size,
			leaf_count: nodes.size - outDegree.size,
			longest_path: this._longestPath(sessionId, inDegree),
			max_out_degree: maxOut,
			max_in_degree: maxIn,
			edge_kind_counts: this._edgeKindCounts(edges),
			component_count: this._componentCount(nodes, edges),
		};
	}

	private _edgeKindCounts(edges: readonly Edge[]): Record<EdgeKind, number> {
		const counts: Record<EdgeKind, number> = {
			sequence: 0,
			branch: 0,
			merge: 0,
			verifies: 0,
			critiques: 0,
			derives_from: 0,
			tool_invocation: 0,
			revises: 0,
		};
		for (const edge of edges) counts[edge.kind]++;
		return counts;
	}

	private _longestPath(sessionId: SessionId, inDegree: Map<string, number>): number | null {
		const queue: string[] = [];
		const distances = new Map<string, number>();
		for (const [node, degree] of inDegree) {
			if (degree === 0) queue.push(node);
		}
		let longest = 0;
		let head = 0;
		while (head < queue.length) {
			const node = queue[head++]!;
			const distance = distances.get(node) ?? 0;
			longest = Math.max(longest, distance);
			for (const edge of this._store.outgoing(sessionId, node as ThoughtId)) {
				distances.set(edge.to, Math.max(distances.get(edge.to) ?? 0, distance + 1));
				const degree = (inDegree.get(edge.to) ?? 0) - 1;
				inDegree.set(edge.to, degree);
				if (degree === 0) queue.push(edge.to);
			}
		}
		return head === inDegree.size ? longest : null;
	}

	private _componentCount(nodes: ReadonlySet<string>, edges: readonly Edge[]): number {
		const neighbours = new Map<string, string[]>();
		for (const node of nodes) neighbours.set(node, []);
		for (const edge of edges) {
			neighbours.get(edge.from)?.push(edge.to);
			neighbours.get(edge.to)?.push(edge.from);
		}
		const visited = new Set<string>();
		let count = 0;
		for (const node of nodes) {
			if (visited.has(node)) continue;
			count++;
			visited.add(node);
			const queue = [node];
			for (const current of queue) {
				for (const neighbour of neighbours.get(current) ?? []) {
					if (visited.has(neighbour)) continue;
					visited.add(neighbour);
					queue.push(neighbour);
				}
			}
		}
		return count;
	}

	/**
	 * Return all thought ids in the session that have no outgoing edges.
	 *
	 * @param sessionId - Session to query
	 * @returns Thought ids that are graph leaves
	 *
	 * @example
	 * ```typescript
	 * const tips = view.leaves('s1');
	 * ```
	 */
	leaves(sessionId: SessionId): readonly ThoughtId[] {
		const edges = this._store.edgesForSession(sessionId);
		const { nodes } = this._collectNodes(edges, this._store.nodesForSession?.(sessionId));
		if (nodes.size === 0) return [];
		const result: string[] = [];
		for (const node of nodes) {
			if (this._store.outgoing(sessionId, node as ThoughtId).length === 0) {
				result.push(node);
			}
		}
		return result as ThoughtId[];
	}

	/**
	 * Collect every node id referenced by the edges and a set of nodes
	 * that have at least one incoming edge.
	 */
	private _collectNodes(
		edges: readonly Edge[],
		explicitNodes: readonly ThoughtId[] = []
	): {
		nodes: Set<string>;
		hasIncoming: Set<string>;
	} {
		const nodes = new Set<string>(explicitNodes);
		const hasIncoming = new Set<string>();
		for (const edge of edges) {
			nodes.add(edge.from);
			nodes.add(edge.to);
			hasIncoming.add(edge.to);
		}
		return { nodes, hasIncoming };
	}

	/**
	 * Find roots (no incoming) ordered by the earliest outgoing edge
	 * `createdAt`. Nodes with no outgoing edges fall back to the order
	 * they appear among edges (already sorted by `createdAt`).
	 */
	private _findRoots(
		nodes: Set<string>,
		hasIncoming: Set<string>,
		edges: readonly Edge[]
	): string[] {
		const earliest = new Map<string, number>();
		for (const edge of edges) {
			if (!earliest.has(edge.from)) {
				earliest.set(edge.from, edge.createdAt);
			}
		}
		const roots: string[] = [];
		for (const node of nodes) {
			if (!hasIncoming.has(node)) roots.push(node);
		}
		roots.sort((a, b) => (earliest.get(a) ?? Infinity) - (earliest.get(b) ?? Infinity));
		return roots;
	}

	/**
	 * BFS from a list of root ids, visiting each node at most once.
	 */
	private _bfsFromRoots(sessionId: SessionId, roots: readonly string[]): readonly string[] {
		const visited = new Set<string>();
		const order: string[] = [];
		const queue: string[] = [];
		for (const root of roots) {
			if (visited.has(root)) continue;
			visited.add(root);
			order.push(root);
			queue.push(root);
		}
		let head = 0;
		while (head < queue.length) {
			const node = queue[head++]!;
			for (const edge of this._store.outgoing(sessionId, node as ThoughtId)) {
				if (visited.has(edge.to)) continue;
				visited.add(edge.to);
				order.push(edge.to);
				queue.push(edge.to);
			}
		}
		return order;
	}

	/**
	 * Build an in-degree map covering every node referenced by the edges.
	 */
	private _buildInDegree(
		edges: readonly Edge[],
		explicitNodes: readonly ThoughtId[] = []
	): Map<string, number> {
		const inDegree = new Map<string, number>();
		for (const node of explicitNodes) inDegree.set(node, 0);
		for (const edge of edges) {
			if (!inDegree.has(edge.from)) inDegree.set(edge.from, 0);
			inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
		}
		return inDegree;
	}

	/**
	 * Generic BFS closure in either direction. Excludes the start node
	 * from the result and respects an optional depth cap.
	 */
	private _bfsClosure(
		sessionId: SessionId,
		startId: string,
		maxDepth: number | undefined,
		direction: 'incoming' | 'outgoing',
		kinds?: readonly EdgeKind[]
	): readonly string[] {
		const allowed = kinds?.length ? new Set(kinds) : undefined;
		const cap = maxDepth ?? Number.POSITIVE_INFINITY;
		const visited = new Set<string>([startId]);
		const order: string[] = [];
		let frontier: string[] = [startId];
		let depth = 0;
		while (frontier.length > 0 && depth < cap) {
			const next: string[] = [];
			for (const node of frontier) {
				const edges =
					direction === 'outgoing'
						? this._store.outgoing(sessionId, node as ThoughtId)
						: this._store.incoming(sessionId, node as ThoughtId);
				for (const edge of edges) {
					if (allowed !== undefined && !allowed.has(edge.kind)) continue;
					const neighbour = direction === 'outgoing' ? edge.to : edge.from;
					if (visited.has(neighbour)) continue;
					visited.add(neighbour);
					order.push(neighbour);
					next.push(neighbour);
				}
			}
			frontier = next;
			depth++;
		}
		return order;
	}
}
