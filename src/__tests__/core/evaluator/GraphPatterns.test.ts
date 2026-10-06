import { describe, expect, it } from 'vitest';
import {
	detectRefutedHypothesisDependency,
	detectUnaddressedCritique,
} from '../../../core/evaluator/GraphPatterns.js';
import { resolveVerificationLinks } from '../../../core/evaluator/VerificationLinks.js';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import type { EdgeKind } from '../../../core/graph/Edge.js';
import type { ThoughtData } from '../../../core/thought.js';
import { buildActiveEvidenceProjection } from '../../../core/reasoning/ActiveEvidenceProjection.js';
import {
	createTestEdgeId,
	createTestSessionId,
	createTestThoughtId,
	createTestThought,
	createHypothesisThought,
	createVerificationThought,
	createCritiqueThought,
	createSynthesisThought,
} from '../../helpers/factories.js';

type TestEdge = readonly [number, number, EdgeKind];
const id = (n: number) => createTestThoughtId(`t${n}`);
const regular = (n: number) => createTestThought({ id: id(n), thought_number: n });
const hypothesis = () => createHypothesisThought({ id: id(1), thought_number: 1 });
const verifier = (n: number, result: 0 | 1) =>
	createVerificationThought({
		id: id(n),
		thought_number: n,
		verification_result: result,
	});
const critique = (n: number) => createCritiqueThought({ id: id(n), thought_number: n });

function setup(history: ThoughtData[], edges: readonly TestEdge[]) {
	const sessionId = createTestSessionId();
	const edgeStore = new EdgeStore();
	for (const [index, [from, to, kind]] of edges.entries()) {
		edgeStore.addEdge({
			id: createTestEdgeId(`e${index}`),
			from: id(from),
			to: id(to),
			kind,
			sessionId,
			createdAt: index,
		});
	}
	const verificationTargets = new Map(
		history.flatMap((t) =>
			t.id && t.thought_type === 'verification' ? [[t.id, id(1)] as const] : []
		)
	);
	const links = resolveVerificationLinks(history, {}, verificationTargets);
	const evidence = buildActiveEvidenceProjection({ sessionId, history, branches: {}, edgeStore });
	expect(evidence.graph).toBeDefined();
	if (evidence.graph === undefined) throw new Error('Expected active graph');
	return { links, activeGraph: { sessionId, view: evidence.graph } };
}

describe('refuted_hypothesis_dependency', () => {
	it.each(['derives_from', 'merge', 'branch'] as const)(
		'finds a transitive %s dependent beyond a revised direct dependent',
		(kind) => {
			const { links, activeGraph } = setup(
				[hypothesis(), regular(2), regular(3), regular(4), verifier(5, 0)],
				[
					[1, 2, kind],
					[2, 3, kind],
					[4, 2, 'revises'],
				]
			);
			expect(detectRefutedHypothesisDependency(links, activeGraph)).toMatchObject([
				{ thought_range: [1, 3] },
			]);
		}
	);
	it('warns once for direct and transitive derives_from, merge, and branch dependents', () => {
		const { links, activeGraph } = setup(
			[
				hypothesis(),
				regular(2),
				createSynthesisThought({ id: id(3), thought_number: 3 }),
				regular(4),
				verifier(6, 0),
			],
			[
				[1, 2, 'derives_from'],
				[2, 3, 'merge'],
				[1, 4, 'branch'],
				[6, 1, 'verifies'],
			]
		);
		expect(detectRefutedHypothesisDependency(links, activeGraph)).toMatchObject([
			{ pattern: 'refuted_hypothesis_dependency', severity: 'warning', thought_range: [1, 4] },
		]);
	});
	it('suppresses a revised dependent', () => {
		const { links, activeGraph } = setup(
			[hypothesis(), regular(2), regular(3), verifier(4, 0)],
			[
				[1, 2, 'merge'],
				[3, 2, 'revises'],
			]
		);
		expect(detectRefutedHypothesisDependency(links, activeGraph)).toEqual([]);
	});
	it('suppresses retracted dependents through the active projection', () => {
		const { links, activeGraph } = setup(
			[
				hypothesis(),
				createTestThought({ id: id(2), thought_number: 2, retracted: true }),
				verifier(3, 0),
			],
			[[1, 2, 'branch']]
		);
		expect(detectRefutedHypothesisDependency(links, activeGraph)).toEqual([]);
	});
	it('does not treat sequence edges as dependencies', () => {
		const { links, activeGraph } = setup(
			[hypothesis(), regular(2), verifier(3, 0)],
			[[1, 2, 'sequence']]
		);
		expect(detectRefutedHypothesisDependency(links, activeGraph)).toEqual([]);
	});
	it('does not warn for a confirmed hypothesis', () => {
		const { links, activeGraph } = setup(
			[hypothesis(), regular(2), verifier(3, 1)],
			[[1, 2, 'derives_from']]
		);
		expect(detectRefutedHypothesisDependency(links, activeGraph)).toEqual([]);
	});
	it.each([
		[0, 1, 0],
		[1, 0, 1],
	] as const)('uses latest result when %i is followed by %i', (first, last, count) => {
		const { links, activeGraph } = setup(
			[hypothesis(), regular(2), verifier(9, first), verifier(3, last)],
			[[1, 2, 'merge']]
		);
		expect(detectRefutedHypothesisDependency(links, activeGraph)).toHaveLength(count);
	});
	it('emits nothing without a graph context', () => {
		const { links } = setup([hypothesis(), regular(2), verifier(3, 0)], [[1, 2, 'merge']]);
		expect(detectRefutedHypothesisDependency(links)).toEqual([]);
	});
});

describe('unaddressed_critique', () => {
	it('stays silent within the three-active-thought grace window', () => {
		const { links, activeGraph } = setup(
			[hypothesis(), critique(2), regular(3), regular(4)],
			[[2, 1, 'critiques']]
		);
		expect(detectUnaddressedCritique(links, activeGraph)).toEqual([]);
	});
	it('warns after three active thoughts follow an unaddressed critique', () => {
		const { links, activeGraph } = setup(
			[hypothesis(), critique(2), regular(3), regular(4), regular(5)],
			[[2, 1, 'critiques']]
		);
		expect(detectUnaddressedCritique(links, activeGraph)).toMatchObject([
			{ pattern: 'unaddressed_critique', severity: 'warning', thought_range: [1, 2] },
		]);
	});
	it('does not count retracted thoughts toward the grace window', () => {
		const { links, activeGraph } = setup(
			[
				hypothesis(),
				critique(2),
				regular(3),
				regular(4),
				createTestThought({ id: id(5), thought_number: 5, retracted: true }),
			],
			[[2, 1, 'critiques']]
		);
		expect(detectUnaddressedCritique(links, activeGraph)).toEqual([]);
	});
	it.each(['revises', 'verifies'] as const)(
		'accepts a later %s relation as addressing the target',
		(kind) => {
			const { links, activeGraph } = setup(
				[hypothesis(), critique(2), verifier(3, 1), regular(4), regular(5)],
				[
					[2, 1, 'critiques'],
					[3, 1, kind],
				]
			);
			expect(detectUnaddressedCritique(links, activeGraph)).toEqual([]);
		}
	);
	it('does not accept a verification positioned before the critique', () => {
		const { links, activeGraph } = setup(
			[hypothesis(), verifier(9, 1), critique(2), regular(3), regular(4), regular(5)],
			[
				[2, 1, 'critiques'],
				[9, 1, 'verifies'],
			]
		);
		expect(detectUnaddressedCritique(links, activeGraph)).toHaveLength(1);
	});
	it('emits nothing without a graph context', () => {
		const { links } = setup(
			[hypothesis(), critique(2), regular(3), regular(4), regular(5)],
			[[2, 1, 'critiques']]
		);
		expect(detectUnaddressedCritique(links)).toEqual([]);
	});
});
