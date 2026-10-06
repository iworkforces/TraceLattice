/**
 * Tests for the GraphView read-only graph traversal.
 */

import { describe, it, expect } from 'vitest';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import { GraphView } from '../../../core/graph/GraphView.js';
import { CycleDetectedError } from '../../../errors.js';
import type { Edge, EdgeKind } from '../../../core/graph/Edge.js';
import { asSessionId, asThoughtId, type SessionId } from '../../../contracts/ids.js';
import type { IGraphViewStore } from '../../../contracts/interfaces.js';
import { createTestEdgeId } from '../../helpers/factories.js';

const SESSION: SessionId = asSessionId('s1');

function makeEdge(
	from: string,
	to: string,
	createdAt: number,
	kind: EdgeKind = 'sequence',
	sessionId: SessionId = SESSION
): Edge {
	return {
		id: createTestEdgeId(`${sessionId}:${from}:${to}:${kind}:${createdAt}`),
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind,
		sessionId,
		createdAt,
	};
}

function setup(edges: Edge[]): GraphView {
	const store = new EdgeStore();
	for (const edge of edges) {
		store.addEdge(edge);
	}
	return new GraphView(store);
}

const ALL_EDGE_KINDS: readonly EdgeKind[] = [
	'sequence',
	'branch',
	'merge',
	'verifies',
	'critiques',
	'derives_from',
	'tool_invocation',
	'revises',
];

describe('GraphView', () => {
	describe('metrics', () => {
		const zeroKinds = {
			sequence: 0,
			branch: 0,
			merge: 0,
			verifies: 0,
			critiques: 0,
			derives_from: 0,
			tool_invocation: 0,
			revises: 0,
		};
		it('returns all zero metrics for an empty session', () => {
			const view = setup([makeEdge('a', 'b', 1)]);
			expect(view.metrics(asSessionId('empty'))).toEqual({
				node_count: 0,
				edge_count: 0,
				root_count: 0,
				leaf_count: 0,
				longest_path: 0,
				max_out_degree: 0,
				max_in_degree: 0,
				edge_kind_counts: zeroKinds,
				component_count: 0,
			});
		});
		it('computes single-edge metrics', () => {
			const view = setup([makeEdge('a', 'b', 1, 'branch')]);
			expect(view.metrics(SESSION)).toEqual({
				node_count: 2,
				edge_count: 1,
				root_count: 1,
				leaf_count: 1,
				longest_path: 1,
				max_out_degree: 1,
				max_in_degree: 1,
				edge_kind_counts: { ...zeroKinds, branch: 1 },
				component_count: 1,
			});
		});
		it('computes longest path and fan-in/out for a diamond', () => {
			const view = setup([
				makeEdge('a', 'b', 1),
				makeEdge('a', 'c', 2),
				makeEdge('b', 'd', 3, 'merge'),
				makeEdge('c', 'd', 4, 'merge'),
			]);
			expect(view.metrics(SESSION)).toEqual({
				node_count: 4,
				edge_count: 4,
				root_count: 1,
				leaf_count: 1,
				longest_path: 2,
				max_out_degree: 2,
				max_in_degree: 2,
				edge_kind_counts: { ...zeroKinds, sequence: 2, merge: 2 },
				component_count: 1,
			});
		});
		it('counts disconnected components and their longest path', () => {
			const view = setup([makeEdge('a', 'b', 1), makeEdge('x', 'y', 2), makeEdge('y', 'z', 3)]);
			expect(view.metrics(SESSION)).toMatchObject({
				node_count: 5,
				root_count: 2,
				leaf_count: 2,
				longest_path: 2,
				component_count: 2,
			});
		});
		it('returns null for a cycle while computing other metrics', () => {
			const view = setup([makeEdge('a', 'b', 1), makeEdge('b', 'a', 2), makeEdge('x', 'y', 3)]);
			expect(view.metrics(SESSION)).toEqual({
				node_count: 4,
				edge_count: 3,
				root_count: 1,
				leaf_count: 1,
				longest_path: null,
				max_out_degree: 1,
				max_in_degree: 1,
				edge_kind_counts: { ...zeroKinds, sequence: 3 },
				component_count: 2,
			});
		});
		it('includes distinct explicit isolated nodes as roots, leaves, and components', () => {
			const store = new EdgeStore();
			store.addEdge(makeEdge('a', 'b', 1));
			const projected: IGraphViewStore = {
				outgoing: (session, id) => store.outgoing(session, id),
				incoming: (session, id) => store.incoming(session, id),
				edgesForSession: (session) => store.edgesForSession(session),
				nodesForSession: (session) =>
					session === SESSION
						? [asThoughtId('isolated'), asThoughtId('isolated'), asThoughtId('a')]
						: [],
			};
			const view = new GraphView(projected);
			expect(view.metrics(SESSION)).toMatchObject({
				node_count: 3,
				root_count: 2,
				leaf_count: 2,
				component_count: 2,
				longest_path: 1,
			});
		});
		it('returns zero path length for explicit nodes without edges', () => {
			const store: IGraphViewStore = {
				outgoing: () => [],
				incoming: () => [],
				edgesForSession: () => [],
				nodesForSession: () => [asThoughtId('isolated')],
			};
			expect(new GraphView(store).metrics(SESSION)).toMatchObject({
				node_count: 1,
				root_count: 1,
				leaf_count: 1,
				component_count: 1,
				longest_path: 0,
			});
		});
		it('counts all kinds and parallel endpoint edges', () => {
			const view = setup(ALL_EDGE_KINDS.map((kind, i) => makeEdge('a', 'b', i, kind)));
			expect(view.metrics(SESSION)).toMatchObject({
				longest_path: 1,
				max_in_degree: 8,
				max_out_degree: 8,
				edge_kind_counts: {
					sequence: 1,
					branch: 1,
					merge: 1,
					verifies: 1,
					critiques: 1,
					derives_from: 1,
					tool_invocation: 1,
					revises: 1,
				},
			});
		});
		it('reads the live store on each query', () => {
			const store = new EdgeStore();
			const view = new GraphView(store);
			expect(view.metrics(SESSION).node_count).toBe(0);
			store.addEdge(makeEdge('a', 'b', 1));
			expect(view.metrics(SESSION).node_count).toBe(2);
		});
	});

	describe('kind-filtered ancestors/descendants', () => {
		it.each(['ancestors', 'descendants'] as const)('filters %s and respects depth', (method) => {
			const view = setup([
				makeEdge('a', 'b', 1, 'branch'),
				makeEdge('b', 'c', 2, 'branch'),
				makeEdge('a', 'x', 3),
				makeEdge('x', 'c', 4),
			]);
			const start = asThoughtId(method === 'ancestors' ? 'c' : 'a');
			expect(view[method](SESSION, start, undefined, ['branch'])).toEqual(
				method === 'ancestors' ? ['b', 'a'] : ['b', 'c']
			);
			expect(view[method](SESSION, start, 1, ['branch'])).toEqual(['b']);
			expect(view[method](SESSION, start, undefined, ['merge'])).toEqual([]);
			expect(view[method](SESSION, start, undefined, [])).toEqual(view[method](SESSION, start));
			expect(view[method](SESSION, start, 0, ['branch'])).toEqual([]);
		});
	});

	describe('inbound/outbound', () => {
		it('lists incoming source ids and kinds in store order', () => {
			const view = setup([makeEdge('a', 'd', 3), makeEdge('b', 'd', 1, 'merge')]);
			expect(view.inbound(SESSION, asThoughtId('d'))).toEqual([
				{ id: 'b', kind: 'merge' },
				{ id: 'a', kind: 'sequence' },
			]);
		});
		it('lists outgoing target ids and kinds in store order', () => {
			const view = setup([makeEdge('a', 'b', 3), makeEdge('a', 'c', 1, 'branch')]);
			expect(view.outbound(SESSION, asThoughtId('a'))).toEqual([
				{ id: 'c', kind: 'branch' },
				{ id: 'b', kind: 'sequence' },
			]);
		});
		it.each(['inbound', 'outbound'] as const)(
			'returns empty %s for unknown node/session',
			(method) => {
				const view = setup([makeEdge('a', 'b', 1)]);
				expect(view[method](SESSION, asThoughtId('missing'))).toEqual([]);
				expect(view[method](asSessionId('empty'), asThoughtId('a'))).toEqual([]);
			}
		);
	});

	describe('hasPath', () => {
		it.each([
			['a', 'c', true],
			['c', 'a', false],
			['a', 'a', false],
			['missing', 'c', false],
			['a', 'missing', false],
			['missing', 'missing', false],
		] as const)('checks directed reachability from %s to %s', (from, to, expected) => {
			const view = setup([makeEdge('a', 'b', 1), makeEdge('b', 'c', 2)]);
			expect(view.hasPath(SESSION, asThoughtId(from), asThoughtId(to))).toBe(expected);
		});
		it('requires every path edge to match the filter', () => {
			const view = setup([makeEdge('a', 'b', 1, 'branch'), makeEdge('b', 'c', 2)]);
			expect(view.hasPath(SESSION, asThoughtId('a'), asThoughtId('c'), ['branch'])).toBe(false);
			expect(
				view.hasPath(SESSION, asThoughtId('a'), asThoughtId('c'), ['branch', 'sequence'])
			).toBe(true);
			expect(view.hasPath(SESSION, asThoughtId('a'), asThoughtId('c'), [])).toBe(true);
		});
		it('returns true for self only when a permitted cycle returns to it', () => {
			const view = setup([makeEdge('a', 'b', 1, 'branch'), makeEdge('b', 'a', 2)]);
			expect(view.hasPath(SESSION, asThoughtId('a'), asThoughtId('a'))).toBe(true);
			expect(view.hasPath(SESSION, asThoughtId('a'), asThoughtId('a'), ['branch'])).toBe(false);
			expect(view.hasPath(SESSION, asThoughtId('a'), asThoughtId('missing'))).toBe(false);
			expect(view.hasPath(asSessionId('empty'), asThoughtId('a'), asThoughtId('b'))).toBe(false);
		});
	});

	describe('chronological', () => {
		it('returns empty array when session has no edges', () => {
			const view = setup([]);
			expect(view.chronological(asSessionId('empty'))).toEqual([]);
		});

		it('returns thoughts ordered by BFS from roots following createdAt', () => {
			// a -> b -> c, a -> d
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('a', 'd', 300)];
			const view = setup(edges);
			const result = view.chronological(SESSION);
			// roots first (a), then BFS by createdAt
			expect(result[0]).toBe('a');
			expect(result).toContain('b');
			expect(result).toContain('c');
			expect(result).toContain('d');
			expect(result).toHaveLength(4);
			// b appears before c (since c depends on b)
			expect(result.indexOf(asThoughtId('b'))).toBeLessThan(result.indexOf(asThoughtId('c')));
		});

		it('handles disconnected components with multiple roots', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('x', 'y', 50)];
			const view = setup(edges);
			const result = view.chronological(SESSION);
			expect(result).toHaveLength(4);
			expect(result).toEqual(expect.arrayContaining(['a', 'b', 'x', 'y']));
		});
	});

	describe('branchThoughts', () => {
		it('returns thoughts reachable via branch edges from root', () => {
			const edges = [
				makeEdge('root', 'b1', 100, 'branch'),
				makeEdge('b1', 'b2', 200, 'branch'),
				makeEdge('root', 'seq', 150, 'sequence'),
			];
			const view = setup(edges);
			const result = view.branchThoughts(SESSION, asThoughtId('root'));
			expect(result).toEqual(expect.arrayContaining(['root', 'b1', 'b2']));
			expect(result).not.toContain('seq');
		});

		it('returns just the root id when no branch edges exist', () => {
			const edges = [makeEdge('root', 'x', 100, 'sequence')];
			const view = setup(edges);
			expect(view.branchThoughts(SESSION, asThoughtId('root'))).toEqual(['root']);
		});
	});

	describe('topological', () => {
		it('returns valid topological order for a DAG', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('a', 'c', 150)];
			const view = setup(edges);
			const result = view.topological(SESSION);
			expect(result).toHaveLength(3);
			expect(result.indexOf(asThoughtId('a'))).toBeLessThan(result.indexOf(asThoughtId('b')));
			expect(result.indexOf(asThoughtId('b'))).toBeLessThan(result.indexOf(asThoughtId('c')));
			expect(result.indexOf(asThoughtId('a'))).toBeLessThan(result.indexOf(asThoughtId('c')));
		});

		it('throws CycleDetectedError on cycle', () => {
			// EdgeStore allows non-self cycles: a->b->a
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'a', 200)];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('returns empty array when session has no edges', () => {
			const view = setup([]);
			expect(view.topological(asSessionId('nope'))).toEqual([]);
		});
	});

	describe('ancestors', () => {
		it('returns all ancestors via incoming closure (BFS)', () => {
			// a -> b -> c -> d
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'd', 300)];
			const view = setup(edges);
			const result = view.ancestors(SESSION, asThoughtId('d'));
			expect(result).toEqual(expect.arrayContaining(['a', 'b', 'c']));
			expect(result).not.toContain('d');
		});

		it('respects maxDepth parameter', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'd', 300)];
			const view = setup(edges);
			const result = view.ancestors(SESSION, asThoughtId('d'), 1);
			expect(result).toEqual(['c']);
		});

		it('returns empty when no ancestors', () => {
			const edges = [makeEdge('a', 'b', 100)];
			const view = setup(edges);
			expect(view.ancestors(SESSION, asThoughtId('a'))).toEqual([]);
		});
	});

	describe('descendants', () => {
		it('returns all descendants via outgoing closure (BFS)', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'd', 300)];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'));
			expect(result).toEqual(expect.arrayContaining(['b', 'c', 'd']));
			expect(result).not.toContain('a');
		});

		it('respects maxDepth parameter', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'd', 300)];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'), 2);
			expect(result).toEqual(expect.arrayContaining(['b', 'c']));
			expect(result).not.toContain('d');
		});

		it('handles cycles without infinite loop', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'a', 200)];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'));
			expect(result).toEqual(expect.arrayContaining(['b']));
		});
	});

	describe('leaves', () => {
		it('returns thoughts with no outgoing edges', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('a', 'c', 200), makeEdge('b', 'd', 300)];
			const view = setup(edges);
			const result = view.leaves(SESSION);
			// c and d have no outgoing
			expect(result).toEqual(expect.arrayContaining(['c', 'd']));
			expect(result).not.toContain('a');
			expect(result).not.toContain('b');
		});

		it('returns empty for empty session', () => {
			const view = setup([]);
			expect(view.leaves(asSessionId('nope'))).toEqual([]);
		});
	});

	describe('depthFromRoots', () => {
		it('counts every edge kind from a zero-incoming root', () => {
			// Given
			const edges = ALL_EDGE_KINDS.map((kind, index) =>
				makeEdge(`t${index}`, `t${index + 1}`, index, kind)
			);
			const view = setup(edges);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('t8'));

			// Then
			expect(distance).toBe(8);
		});

		it('assigns depth zero to a root', () => {
			// Given
			const view = setup([makeEdge('root', 'child', 1)]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('root'));

			// Then
			expect(distance).toBe(0);
		});

		it('chooses the shortest path across multiple roots and a merge', () => {
			// Given
			const view = setup([
				makeEdge('long-root', 'a', 1),
				makeEdge('a', 'b', 2),
				makeEdge('b', 'current', 3, 'merge'),
				makeEdge('short-root', 'current', 4, 'merge'),
			]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('current'));

			// Then
			expect(distance).toBe(1);
		});

		it('treats a retained node as a new root after pruning removes its parent', () => {
			// Given
			const store = new EdgeStore();
			store.addEdge(makeEdge('evicted', 'retained-root', 1));
			store.addEdge(makeEdge('retained-root', 'current', 2));
			store.pruneSession(SESSION, new Set([asThoughtId('retained-root'), asThoughtId('current')]));
			const view = new GraphView(store);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('current'));

			// Then
			expect(distance).toBe(1);
		});

		it('finds a root-reachable node despite a cycle', () => {
			// Given
			const view = setup([
				makeEdge('root', 'a', 1),
				makeEdge('a', 'b', 2),
				makeEdge('b', 'a', 3),
				makeEdge('b', 'current', 4),
			]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId('current'));

			// Then
			expect(distance).toBe(3);
		});

		it.each([
			['an empty graph', [], 'missing'],
			['a rootless cycle', [makeEdge('a', 'b', 1), makeEdge('b', 'a', 2)], 'a'],
		] as const)('returns undefined for %s', (_label, edges, target) => {
			// Given
			const view = setup([...edges]);

			// When
			const distance = view.depthFromRoots(SESSION, asThoughtId(target));

			// Then
			expect(distance).toBeUndefined();
		});

		it('keeps root distance isolated by session', () => {
			// Given
			const otherSession = asSessionId('s2');
			const view = setup([
				makeEdge('root', 'current', 1),
				makeEdge('other-root', 'other-current', 2, 'sequence', otherSession),
			]);

			// When
			const localDistance = view.depthFromRoots(SESSION, asThoughtId('current'));
			const foreignDistance = view.depthFromRoots(SESSION, asThoughtId('other-current'));

			// Then
			expect(localDistance).toBe(1);
			expect(foreignDistance).toBeUndefined();
		});
	});

	describe('session isolation', () => {
		it('does not leak across sessions', () => {
			const edges = [
				makeEdge('a', 'b', 100, 'sequence', asSessionId('s1')),
				makeEdge('x', 'y', 200, 'sequence', asSessionId('s2')),
			];
			const view = setup(edges);
			expect(view.chronological(asSessionId('s1'))).toEqual(expect.arrayContaining(['a', 'b']));
			expect(view.chronological(asSessionId('s1'))).not.toContain('x');
			expect(view.descendants(asSessionId('s1'), asThoughtId('x'))).toEqual([]);
		});
	});

	describe('multi-node cycle detection', () => {
		it('throws CycleDetectedError on 3-node cycle a->b->c->b', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'b', 300)];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('throws CycleDetectedError on 4-node mixed-edge-kind cycle', () => {
			const edges = [
				makeEdge('a', 'b', 100, 'sequence'),
				makeEdge('b', 'c', 200, 'derives_from'),
				makeEdge('c', 'd', 300, 'verifies'),
				makeEdge('d', 'a', 400, 'critiques'),
			];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('throws CycleDetectedError on cycle formed by merge edges', () => {
			const edges = [
				makeEdge('a', 'b', 100, 'sequence'),
				makeEdge('b', 'c', 200, 'merge'),
				makeEdge('c', 'a', 300, 'merge'),
			];
			const view = setup(edges);
			expect(() => view.topological(SESSION)).toThrow(CycleDetectedError);
		});

		it('descendants() terminates on 3-node cycle and visits each node at most once', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'b', 300)];
			const view = setup(edges);
			const result = view.descendants(SESSION, asThoughtId('a'));
			expect(result).toEqual(expect.arrayContaining(['b', 'c']));
			expect(result).not.toContain('a');
			// Each visited at most once: no duplicates
			expect(new Set(result).size).toBe(result.length);
		});

		it('ancestors() terminates on 3-node cycle without infinite loop', () => {
			const edges = [makeEdge('a', 'b', 100), makeEdge('b', 'c', 200), makeEdge('c', 'b', 300)];
			const view = setup(edges);
			const result = view.ancestors(SESSION, asThoughtId('c'));
			expect(result).toEqual(expect.arrayContaining(['a', 'b']));
			expect(new Set(result).size).toBe(result.length);
		});
	});
});
