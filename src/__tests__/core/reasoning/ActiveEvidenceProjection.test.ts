import { describe, expect, it } from 'vitest';
import { asBranchId, asEdgeId, asSessionId, asThoughtId } from '../../../contracts/ids.js';
import { buildActiveEvidenceProjection } from '../../../core/reasoning/ActiveEvidenceProjection.js';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import type { Edge, EdgeKind } from '../../../core/graph/Edge.js';
import type { GraphView } from '../../../core/graph/GraphView.js';
import { createTestThought } from '../../helpers/factories.js';

const SESSION_ID = asSessionId('active-evidence');

function addEdge(
	store: EdgeStore,
	from: string,
	to: string,
	kind: EdgeKind,
	createdAt: number,
	metadata?: Record<string, unknown>
): void {
	store.addEdge({
		id: asEdgeId(`${kind}-${from}-${to}`),
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind,
		sessionId: SESSION_ID,
		createdAt,
		...(metadata === undefined ? {} : { metadata }),
	});
}

function getProjectionEdges(graph: GraphView): readonly Edge[] {
	const store = Reflect.get(graph, '_store');
	if (!hasEdgeReader(store)) throw new TypeError('Expected an edge reader');
	return store.edgesForSession(SESSION_ID);
}

function hasEdgeReader(
	value: unknown
): value is { edgesForSession(sessionId: typeof SESSION_ID): readonly Edge[] } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'edgesForSession' in value &&
		typeof value.edgesForSession === 'function'
	);
}

function getRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError('Expected metadata record');
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new TypeError('Expected metadata array');
	return value;
}

describe('buildActiveEvidenceProjection', () => {
	it('keeps active main order, appends branch-only identities, and lets any mirrored retraction win', () => {
		// Given
		const main = [
			createTestThought({ id: 'main', thought_number: 1 }),
			createTestThought({ id: 'retracted-mirror', thought_number: 2 }),
			createTestThought({ thought_number: 3 }),
		];
		const branches = {
			alt: [
				createTestThought({ id: 'main', thought_number: 1, branch_id: asBranchId('alt') }),
				createTestThought({ id: 'retracted-mirror', thought_number: 2, retracted: true }),
				createTestThought({ id: 'branch-only', thought_number: 4, branch_id: asBranchId('alt') }),
			],
		};

		// When
		const projection = buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history: main,
			branches,
			edgeStore: undefined,
		});

		// Then
		expect(
			projection.mainHistory.map((thought) => thought.id ?? `number-${thought.thought_number}`)
		).toEqual(['main', 'number-3']);
		expect(
			projection.activeThoughts.map((thought) => thought.id ?? `number-${thought.thought_number}`)
		).toEqual(['main', 'number-3', 'branch-only']);
		expect(projection.graph).toBeUndefined();
	});

	it('induces every edge kind without contracting a retracted interior and exposes retained endpoints only', () => {
		// Given
		const store = new EdgeStore();
		const kinds: readonly EdgeKind[] = [
			'sequence',
			'branch',
			'merge',
			'verifies',
			'critiques',
			'derives_from',
			'tool_invocation',
			'revises',
		];
		for (const [index, kind] of kinds.entries())
			addEdge(store, 'root', `leaf-${kind}`, kind, index);
		addEdge(store, 'interior-root', 'interior', 'sequence', 20);
		addEdge(store, 'interior', 'interior-leaf', 'sequence', 21);
		const history = [
			createTestThought({ id: 'root', thought_number: 1 }),
			...kinds.map((kind, index) =>
				createTestThought({ id: `leaf-${kind}`, thought_number: index + 2 })
			),
			createTestThought({ id: 'interior-root', thought_number: 20 }),
			createTestThought({ id: 'interior', thought_number: 21, retracted: true }),
			createTestThought({ id: 'interior-leaf', thought_number: 22 }),
			createTestThought({ id: 'never-edge', thought_number: 23 }),
		];

		// When
		const projection = buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history,
			branches: {},
			edgeStore: store,
		});
		const graph = projection.graph;
		if (graph === undefined) throw new TypeError('Expected projected graph');

		// Then
		expect(graph.leaves(SESSION_ID)).toEqual([
			...kinds.map((kind) => asThoughtId(`leaf-${kind}`)),
			asThoughtId('interior-root'),
			asThoughtId('interior-leaf'),
		]);
		expect(graph.depthFromRoots(SESSION_ID, asThoughtId('interior-root'))).toBe(0);
		expect(graph.depthFromRoots(SESSION_ID, asThoughtId('interior-leaf'))).toBe(0);
		expect(graph.depthFromRoots(SESSION_ID, asThoughtId('never-edge'))).toBeUndefined();
		expect(graph.descendants(SESSION_ID, asThoughtId('interior-root'))).toEqual([]);
	});

	it('is a stable copied snapshot when audit edges are appended after construction', () => {
		// Given
		const store = new EdgeStore();
		addEdge(store, 'root', 'leaf', 'sequence', 1);
		const history = [
			createTestThought({ id: 'root', thought_number: 1 }),
			createTestThought({ id: 'leaf', thought_number: 2 }),
			createTestThought({ id: 'later', thought_number: 3 }),
		];
		const projection = buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history,
			branches: {},
			edgeStore: store,
		});
		const graph = projection.graph;
		if (graph === undefined) throw new TypeError('Expected projected graph');

		// When
		addEdge(store, 'leaf', 'later', 'sequence', 2);

		// Then
		expect(graph.leaves(SESSION_ID)).toEqual([asThoughtId('leaf')]);
		expect(Object.isFrozen(projection.mainHistory)).toBe(true);
		expect(Object.isFrozen(projection.activeThoughts)).toBe(true);
	});

	it('does not make id-less records graph-visible even when an audit edge uses their number', () => {
		const store = new EdgeStore();
		addEdge(store, 'root', '2', 'sequence', 1);
		const projection = buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history: [
				createTestThought({ id: 'root', thought_number: 1 }),
				createTestThought({ thought_number: 2 }),
			],
			branches: {},
			edgeStore: store,
		});
		const graph = projection.graph;
		if (graph === undefined) throw new TypeError('Expected projected graph');

		expect(graph.leaves(SESSION_ID)).toEqual([asThoughtId('root')]);
		expect(graph.depthFromRoots(SESSION_ID, asThoughtId('2'))).toBeUndefined();
	});

	it('deeply snapshots and freezes nested metadata without mutating the audit edge', () => {
		const store = new EdgeStore();
		const metadata: Record<string, unknown> = {
			flag: true,
			count: 1,
			label: 'source',
			empty: null,
			nested: { value: 1 },
			items: [{ label: 'first' }, ['second']],
		};
		addEdge(store, 'root', 'leaf', 'sequence', 1, metadata);
		const projection = buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history: [
				createTestThought({ id: 'root', thought_number: 1 }),
				createTestThought({ id: 'leaf', thought_number: 2 }),
			],
			branches: {},
			edgeStore: store,
		});
		const graph = projection.graph;
		if (graph === undefined) throw new TypeError('Expected projected graph');

		const sourceNested = getRecord(metadata.nested);
		const sourceItems = getArray(metadata.items);
		sourceNested.value = 2;
		getRecord(sourceItems[0]).label = 'changed';
		getArray(sourceItems[1])[0] = 'changed';

		const snapshotMetadata = getProjectionEdges(graph)[0]?.metadata;
		if (snapshotMetadata === undefined) throw new TypeError('Expected snapshot metadata');
		const snapshotNested = getRecord(snapshotMetadata.nested);
		const snapshotItems = getArray(snapshotMetadata.items);
		const snapshotItemRecord = getRecord(snapshotItems[0]);
		const snapshotItemArray = getArray(snapshotItems[1]);

		expect(snapshotMetadata).toEqual({
			flag: true,
			count: 1,
			label: 'source',
			empty: null,
			nested: { value: 1 },
			items: [{ label: 'first' }, ['second']],
		});
		expect(Object.isFrozen(snapshotMetadata)).toBe(true);
		expect(Object.isFrozen(snapshotNested)).toBe(true);
		expect(Object.isFrozen(snapshotItems)).toBe(true);
		expect(Object.isFrozen(snapshotItemRecord)).toBe(true);
		expect(Object.isFrozen(snapshotItemArray)).toBe(true);
		expect(Reflect.set(snapshotNested, 'value', 3)).toBe(false);
		expect(Reflect.set(snapshotItemRecord, 'label', 'mutated')).toBe(false);
		expect(Reflect.set(snapshotItemArray, 0, 'mutated')).toBe(false);
		expect(metadata).toEqual({
			flag: true,
			count: 1,
			label: 'source',
			empty: null,
			nested: { value: 2 },
			items: [{ label: 'changed' }, ['changed']],
		});
	});

	it('creates isolated metadata copies for repeated projections', () => {
		const store = new EdgeStore();
		const metadata: Record<string, unknown> = { nested: { value: 1 } };
		addEdge(store, 'root', 'leaf', 'sequence', 1, metadata);
		const input = {
			sessionId: SESSION_ID,
			history: [
				createTestThought({ id: 'root', thought_number: 1 }),
				createTestThought({ id: 'leaf', thought_number: 2 }),
			],
			branches: {},
			edgeStore: store,
		};
		const firstProjection = buildActiveEvidenceProjection(input);
		getRecord(metadata.nested).value = 2;
		const secondProjection = buildActiveEvidenceProjection(input);
		getRecord(metadata.nested).value = 3;
		const firstGraph = firstProjection.graph;
		const secondGraph = secondProjection.graph;
		if (firstGraph === undefined || secondGraph === undefined) {
			throw new TypeError('Expected projected graphs');
		}

		expect(getProjectionEdges(firstGraph)[0]?.metadata).toEqual({ nested: { value: 1 } });
		expect(getProjectionEdges(secondGraph)[0]?.metadata).toEqual({ nested: { value: 2 } });
	});

	it('preserves absent metadata and snapshots empty metadata', () => {
		const store = new EdgeStore();
		addEdge(store, 'root', 'leaf', 'sequence', 1);
		addEdge(store, 'leaf', 'last', 'branch', 2, {});
		const projection = buildActiveEvidenceProjection({
			sessionId: SESSION_ID,
			history: [
				createTestThought({ id: 'root', thought_number: 1 }),
				createTestThought({ id: 'leaf', thought_number: 2 }),
				createTestThought({ id: 'last', thought_number: 3 }),
			],
			branches: {},
			edgeStore: store,
		});
		const graph = projection.graph;
		if (graph === undefined) throw new TypeError('Expected projected graph');
		const [withoutMetadata, withEmptyMetadata] = getProjectionEdges(graph);

		expect(withoutMetadata?.metadata).toBeUndefined();
		expect(withEmptyMetadata?.metadata).toEqual({});
		expect(Object.isFrozen(withEmptyMetadata?.metadata)).toBe(true);
	});
});
