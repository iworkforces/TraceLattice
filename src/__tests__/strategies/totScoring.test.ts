import { describe, it, expect } from 'vitest';
import {
	scoreThought,
	selectBeam,
	breadthFirstFrontier,
} from '../../core/reasoning/strategies/totScoring.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { GraphView } from '../../core/graph/GraphView.js';
import type { ThoughtData } from '../../core/thought.js';
import type { ConfidenceSignals } from '../../core/reasoning.js';
import type { Edge, EdgeKind } from '../../core/graph/Edge.js';
import { asSessionId, asThoughtId, type EdgeId, type SessionId } from '../../contracts/ids.js';

const SESSION: SessionId = asSessionId('s1');

type ThoughtWithSignals = ThoughtData & {
	readonly confidence_signals?: ConfidenceSignals;
};

function makeThought(overrides: Partial<ThoughtWithSignals> = {}): ThoughtWithSignals {
	return {
		session_id: SESSION,
		thought: 't',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		...overrides,
	};
}

let edgeCounter = 0;
function addEdge(store: EdgeStore, from: string, to: string, kind: EdgeKind = 'sequence'): Edge {
	const edge: Edge = {
		id: `e${++edgeCounter}` as EdgeId,
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind,
		sessionId: SESSION,
		createdAt: edgeCounter,
	};
	store.addEdge(edge);
	return edge;
}

describe('scoreThought', () => {
	it('uses calibrated_confidence when present', () => {
		const t = makeThought({
			confidence: 0.2,
			quality_score: 1,
			confidence_signals: {
				reasoning_depth: 1,
				revision_count: 0,
				branch_count: 0,
				thought_type_distribution: {
					regular: 1,
					hypothesis: 0,
					verification: 0,
					critique: 0,
					synthesis: 0,
					meta: 0,
					tool_call: 0,
					tool_observation: 0,
					assumption: 0,
					decomposition: 0,
					backtrack: 0,
				},
				has_hypothesis: false,
				has_verification: false,
				average_confidence: null,
				calibrated_confidence: 0.9,
			},
		});
		expect(scoreThought(t)).toBeCloseTo(0.9);
	});

	it('falls back to confidence when no calibrated_confidence', () => {
		const t = makeThought({ confidence: 0.6, quality_score: 0.5 });
		expect(scoreThought(t)).toBeCloseTo(0.3);
	});

	it('returns 0 when neither confidence nor calibrated is set', () => {
		const t = makeThought({ quality_score: 0.9 });
		expect(scoreThought(t)).toBe(0);
	});

	it('defaults quality_score to 0.5 when missing', () => {
		const t = makeThought({ confidence: 0.8 });
		expect(scoreThought(t)).toBeCloseTo(0.4);
	});

	it('uses provided quality_score', () => {
		const t = makeThought({ confidence: 0.8, quality_score: 1 });
		expect(scoreThought(t)).toBeCloseTo(0.8);
	});

	it('clamps result into [0, 1]', () => {
		const high = makeThought({ confidence: 5, quality_score: 5 });
		expect(scoreThought(high)).toBe(1);
		const neg = makeThought({ confidence: -2, quality_score: 1 });
		expect(scoreThought(neg)).toBe(0);
	});
});

describe('selectBeam', () => {
	it('returns top-K by descending score', () => {
		const top = selectBeam(
			[
				{ id: 'a', score: 0.1 },
				{ id: 'b', score: 0.9 },
				{ id: 'c', score: 0.5 },
			],
			2
		);
		expect(top).toEqual(['b', 'c']);
	});

	it('breaks ties by id ascending (deterministic)', () => {
		const top = selectBeam(
			[
				{ id: 'z', score: 0.5 },
				{ id: 'a', score: 0.5 },
				{ id: 'm', score: 0.5 },
			],
			2
		);
		expect(top).toEqual(['a', 'm']);
	});

	it('returns all when width >= candidates.length', () => {
		const top = selectBeam(
			[
				{ id: 'a', score: 0.1 },
				{ id: 'b', score: 0.9 },
			],
			5
		);
		expect(top).toEqual(['b', 'a']);
	});

	it('returns empty when width <= 0', () => {
		expect(selectBeam([{ id: 'a', score: 0.5 }], 0)).toEqual([]);
		expect(selectBeam([{ id: 'a', score: 0.5 }], -3)).toEqual([]);
	});

	it('returns empty for empty candidates', () => {
		expect(selectBeam([], 5)).toEqual([]);
	});

	it('does not mutate the input array', () => {
		const input = [
			{ id: 'a', score: 0.1 },
			{ id: 'b', score: 0.9 },
		];
		const snapshot = [...input];
		selectBeam(input, 1);
		expect(input).toEqual(snapshot);
	});
});

describe('breadthFirstFrontier', () => {
	it('returns roots when depthCap is 0', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		addEdge(store, 'r', 'a');
		expect(breadthFirstFrontier(view, SESSION, ['r'], 0)).toEqual(['r']);
	});

	it('returns empty for empty roots', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		expect(breadthFirstFrontier(view, SESSION, [], 5)).toEqual([]);
	});

	it('walks a linear chain to the natural leaf', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		addEdge(store, 'r', 'a');
		addEdge(store, 'a', 'b');
		addEdge(store, 'b', 'c');
		const frontier = breadthFirstFrontier(view, SESSION, ['r'], 10);
		expect(frontier).toEqual(['c']);
	});

	it('collects multiple leaves of a diamond graph', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		// r -> a -> c (leaf)
		// r -> b -> d (leaf)
		addEdge(store, 'r', 'a');
		addEdge(store, 'r', 'b');
		addEdge(store, 'a', 'c');
		addEdge(store, 'b', 'd');
		const frontier = breadthFirstFrontier(view, SESSION, ['r'], 10);
		expect([...frontier].sort()).toEqual(['c', 'd']);
	});

	it('truncates at depthCap (frontier == nodes at cap)', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		addEdge(store, 'r', 'a');
		addEdge(store, 'a', 'b');
		addEdge(store, 'b', 'c');
		const frontier = breadthFirstFrontier(view, SESSION, ['r'], 1);
		// depthCap=1: explored {r, a}, a still has unexplored child -> frontier = ['a']
		expect(frontier).toEqual(['a']);
	});

	it('treats roots as leaves when they have no outgoing edges', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		// no edges at all
		expect(breadthFirstFrontier(view, SESSION, ['lonely'], 5)).toEqual(['lonely']);
	});

	it('handles cycles without infinite loops', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		addEdge(store, 'a', 'b');
		addEdge(store, 'b', 'c');
		addEdge(store, 'c', 'a'); // cycle
		const frontier = breadthFirstFrontier(view, SESSION, ['a'], 10);
		// All nodes get visited; every explored node has an explored child via the cycle,
		// so result is empty (no natural leaves, depth cap not hit).
		expect(frontier).toEqual([]);
	});

	it('dedupes duplicate roots', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		expect(breadthFirstFrontier(view, SESSION, ['x', 'x', 'x'], 0)).toEqual(['x']);
	});

	it('mixes depth-capped and naturally-terminated leaves', () => {
		const store = new EdgeStore();
		const view = new GraphView(store);
		// r -> a (leaf, no children)
		// r -> b -> c -> d (deep)
		addEdge(store, 'r', 'a');
		addEdge(store, 'r', 'b');
		addEdge(store, 'b', 'c');
		addEdge(store, 'c', 'd');
		const frontier = breadthFirstFrontier(view, SESSION, ['r'], 2);
		// depth=2: explored {r, a, b, c}. 'a' has no outgoing (leaf). 'c' has unexplored child 'd', but is in frontier at cap.
		expect([...frontier].sort()).toEqual(['a', 'c']);
	});
});
