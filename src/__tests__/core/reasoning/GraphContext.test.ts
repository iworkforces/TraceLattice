import { describe, expect, it } from 'vitest';
import { asBranchId } from '../../../contracts/ids.js';
import type { ActiveEvidenceProjection } from '../../../contracts/strategy.js';
import type { EdgeKind } from '../../../core/graph/Edge.js';
import { EdgeStore } from '../../../core/graph/EdgeStore.js';
import { buildActiveEvidenceProjection } from '../../../core/reasoning/ActiveEvidenceProjection.js';
import { buildGraphContext } from '../../../core/reasoning/GraphContext.js';
import type { ThoughtData } from '../../../core/thought.js';
import {
	createTestEdgeId,
	createTestSessionId,
	createTestThought,
	createTestThoughtId,
	createVerificationThought,
} from '../../helpers/factories.js';

const sessionId = createTestSessionId();

function project(
	history: readonly ThoughtData[],
	edges: readonly [string, string, EdgeKind][] = []
) {
	const edgeStore = new EdgeStore();
	for (const [index, [from, to, kind]] of edges.entries()) {
		edgeStore.addEdge({
			id: createTestEdgeId(`edge-${index}`),
			from: createTestThoughtId(from),
			to: createTestThoughtId(to),
			kind,
			sessionId,
			createdAt: index,
		});
	}
	return buildActiveEvidenceProjection({ sessionId, history, branches: {}, edgeStore });
}

describe('buildGraphContext', () => {
	it('returns undefined without an edge store', () => {
		// Given
		const thought = createTestThought({ id: 'one' });
		const evidence = buildActiveEvidenceProjection({
			sessionId,
			history: [thought],
			branches: {},
			edgeStore: undefined,
		});
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context).toBeUndefined();
	});

	it('returns undefined for a thought without an id', () => {
		// Given
		const thought = createTestThought();
		const evidence = project([thought]);
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context).toBeUndefined();
	});

	it('returns undefined for an isolated thought', () => {
		// Given
		const thought = createTestThought({ id: 'isolated' });
		const evidence = project([thought]);
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context).toBeUndefined();
	});

	it('describes the last thought in a sequence chain', () => {
		// Given
		const one = createTestThought({ id: 'one', thought_number: 1 });
		const two = createTestThought({ id: 'two', thought_number: 2 });
		const three = createTestThought({ id: 'three', thought_number: 3 });
		const evidence = project(
			[one, two, three],
			[
				['one', 'two', 'sequence'],
				['two', 'three', 'sequence'],
			]
		);
		// When
		const context = buildGraphContext(sessionId, three, evidence);
		// Then
		expect(context).toStrictEqual({
			root_distance: 2,
			ancestor_count: 2,
			inbound: [{ thought_number: 2, kind: 'sequence' }],
			outbound: [],
		});
	});

	it('lists an outbound verifies edge on a verification thought', () => {
		// Given
		const target = createTestThought({ id: 'target', thought_number: 1 });
		const thought = createVerificationThought({
			id: createTestThoughtId('verify'),
			thought_number: 2,
		});
		const evidence = project([target, thought], [['verify', 'target', 'verifies']]);
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context?.outbound).toStrictEqual([{ thought_number: 1, kind: 'verifies' }]);
	});

	it('includes a branch neighbour branch_id', () => {
		// Given
		const thought = createTestThought({ id: 'root' });
		const branch = createTestThought({
			id: 'branch',
			thought_number: 2,
			branch_id: asBranchId('alt'),
		});
		const evidence = project([thought, branch], [['root', 'branch', 'branch']]);
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context?.outbound).toStrictEqual([
			{ thought_number: 2, kind: 'branch', branch_id: 'alt' },
		]);
	});

	it('excludes a retracted neighbour from projected relations', () => {
		// Given
		const thought = createTestThought({ id: 'current', thought_number: 3 });
		const active = createTestThought({ id: 'active', thought_number: 1 });
		const retracted = createTestThought({ id: 'retracted', thought_number: 2, retracted: true });
		const evidence = project(
			[active, retracted, thought],
			[
				['active', 'current', 'sequence'],
				['retracted', 'current', 'derives_from'],
			]
		);
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context?.inbound).toStrictEqual([{ thought_number: 1, kind: 'sequence' }]);
	});

	it('returns null root distance for a cycle without a root', () => {
		// Given
		const one = createTestThought({ id: 'one' });
		const two = createTestThought({ id: 'two', thought_number: 2 });
		const evidence = project(
			[one, two],
			[
				['one', 'two', 'sequence'],
				['two', 'one', 'verifies'],
			]
		);
		// When
		const context = buildGraphContext(sessionId, one, evidence);
		// Then
		expect(context?.root_distance).toBeNull();
	});

	it('preserves relation store order across edge kinds', () => {
		// Given
		const thought = createTestThought({ id: 'root' });
		const two = createTestThought({ id: 'two', thought_number: 2 });
		const three = createTestThought({ id: 'three', thought_number: 3 });
		const evidence = project(
			[thought, two, three],
			[
				['root', 'three', 'merge'],
				['root', 'two', 'sequence'],
			]
		);
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context?.outbound).toStrictEqual([
			{ thought_number: 3, kind: 'merge' },
			{ thought_number: 2, kind: 'sequence' },
		]);
	});

	it('skips neighbours absent from the active thought map', () => {
		// Given
		const thought = createTestThought({ id: 'root' });
		const neighbour = createTestThought({ id: 'neighbour', thought_number: 2 });
		const projection = project([thought, neighbour], [['root', 'neighbour', 'sequence']]);
		const evidence: ActiveEvidenceProjection = { ...projection, activeThoughts: [thought] };
		// When
		const context = buildGraphContext(sessionId, thought, evidence);
		// Then
		expect(context?.outbound).toStrictEqual([]);
	});
});
