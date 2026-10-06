import { describe, expect, it } from 'vitest';
import { GraphSignalComputer } from '../../../core/evaluator/GraphSignalComputer.js';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import type { EdgeKind } from '../../../core/graph/Edge.js';
import { buildActiveEvidenceProjection } from '../../../core/reasoning/ActiveEvidenceProjection.js';
import {
	createTestEdgeId,
	createTestSessionId,
	createTestThought,
	createTestThoughtId,
} from '../../helpers/factories.js';

function graph(edges: readonly (readonly [number, number, EdgeKind])[]) {
	const sessionId = createTestSessionId();
	const history = Array.from({ length: 5 }, (_, i) =>
		createTestThought({ id: `t${i + 1}`, thought_number: i + 1 })
	);
	const edgeStore = new EdgeStore();
	for (const [index, [from, to, kind]] of edges.entries()) {
		edgeStore.addEdge({
			id: createTestEdgeId(`e${index}`),
			sessionId,
			kind,
			createdAt: index,
			from: createTestThoughtId(`t${from}`),
			to: createTestThoughtId(`t${to}`),
		});
	}
	const evidence = buildActiveEvidenceProjection({ sessionId, history, branches: {}, edgeStore });
	expect(evidence.graph).toBeDefined();
	if (evidence.graph === undefined) throw new Error('Expected active graph');
	return { sessionId, view: evidence.graph };
}

describe('GraphSignalComputer', () => {
	const computer = new GraphSignalComputer();
	it('omits signals when the active graph has no edges', () => {
		expect(computer.compute(graph([]))).toBeUndefined();
	});
	it('derives rounded branching and relational density from mixed kinds', () => {
		const ctx = graph([
			[1, 2, 'sequence'],
			[1, 3, 'branch'],
			[2, 4, 'merge'],
			[3, 4, 'derives_from'],
			[4, 5, 'sequence'],
		]);
		expect(computer.compute(ctx)).toEqual({
			...ctx.view.metrics(ctx.sessionId),
			branching_factor: 1.25,
			relational_density: 0.6,
		});
	});
	it('rounds recurring derived fractions to ten decimal places', () => {
		expect(
			computer.compute(
				graph([
					[1, 2, 'branch'],
					[1, 3, 'sequence'],
					[2, 4, 'sequence'],
					[3, 4, 'sequence'],
				])
			)
		).toMatchObject({
			branching_factor: 1.3333333333,
			relational_density: 0.25,
		});
	});
	it('preserves a null longest path when the graph contains a cycle', () => {
		expect(
			computer.compute(
				graph([
					[1, 2, 'sequence'],
					[2, 1, 'verifies'],
				])
			)?.longest_path
		).toBeNull();
	});
});
