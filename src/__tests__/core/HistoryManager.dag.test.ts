import { asBranchId, asSessionId, asThoughtId } from '../../contracts/ids.js';
/**
 * Tests for flag-gated DAG edge emission in HistoryManager.
 *
 * Covers the seven metadata→edge mappings (sequence, branch, merge,
 * verifies, critiques, derives_from, revises) plus flag gating, missing
 * targets, missing ids, and session isolation.
 */

import { describe, it, expect } from 'vitest';
import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeEmitter } from '../../core/graph/EdgeEmitter.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { generateUlid } from '../../core/ids.js';
import { createTestThought } from '../helpers/factories.js';
import type { ThoughtData } from '../../core/thought.js';

const SESSION_ID = asSessionId('dag-session');

function makeThought(num: number, overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		id: generateUlid(),
		session_id: SESSION_ID,
		thought_number: num,
		total_thoughts: 10,
		thought: `t${num}`,
		...overrides,
	});
}

function setup(opts?: { dagEdges?: boolean }): {
	manager: HistoryManager;
	edgeStore: EdgeStore;
} {
	const edgeStore = new EdgeStore();
	const manager = new HistoryManager({
		edgeStore,
		dagEdges: opts?.dagEdges ?? true,
	});
	return { manager, edgeStore };
}

describe('HistoryManager DAG edge emission', () => {
	describe('flag gating', () => {
		it('emits no edges when dagEdges flag is off (even with edgeStore)', () => {
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore, dagEdges: false });
			for (let i = 1; i <= 5; i++) {
				manager.addThought(makeThought(i));
			}
			expect(edgeStore.size()).toBe(0);
		});

		it('emits no edges when no edgeStore is provided', () => {
			const manager = new HistoryManager({ dagEdges: true });
			// Smoke: should not throw.
			for (let i = 1; i <= 3; i++) {
				manager.addThought(makeThought(i));
			}
			// Nothing to assert beyond "no throw" — there is no store to inspect.
			expect(manager.getHistoryLength(SESSION_ID)).toBe(3);
		});

		it('defaults dagEdges to true when omitted', () => {
			const edgeStore = new EdgeStore();
			const manager = new HistoryManager({ edgeStore });
			manager.addThought(makeThought(1));
			manager.addThought(makeThought(2));
			expect(edgeStore.size()).toBe(1); // sequence edge emitted by default
		});
	});

	describe('sequence edges', () => {
		it('emits a sequence edge between consecutive thoughts', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2);
			const t3 = makeThought(3);
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(t3);

			const edges = edgeStore.edgesForSession(SESSION_ID);
			expect(edges).toHaveLength(2);
			expect(edges.every((e) => e.kind === 'sequence')).toBe(true);
			expect(edges[0]!.from).toBe(t1.id);
			expect(edges[0]!.to).toBe(t2.id);
			expect(edges[1]!.from).toBe(t2.id);
			expect(edges[1]!.to).toBe(t3.id);
		});

		it('emits no sequence edge for the very first thought', () => {
			const { manager, edgeStore } = setup();
			manager.addThought(makeThought(1));
			expect(edgeStore.size()).toBe(0);
		});
	});

	describe('branch edges', () => {
		it('emits a branch edge from parent.id to current.id', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2);
			const t3 = makeThought(3, { branch_from_thought: 2, branch_id: asBranchId('b1') });
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(t3);

			const branchEdges = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'branch');
			expect(branchEdges).toHaveLength(1);
			expect(branchEdges[0]!.from).toBe(t2.id);
			expect(branchEdges[0]!.to).toBe(t3.id);
		});
	});

	describe('merge edges', () => {
		it('emits one merge edge per source in merge_from_thoughts', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2);
			const t3 = makeThought(3);
			const t4 = makeThought(4, { merge_from_thoughts: [1, 3] });
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(t3);
			manager.addThought(t4);

			const mergeEdges = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'merge');
			expect(mergeEdges).toHaveLength(2);
			const fromIds = mergeEdges.map((e) => e.from).sort();
			expect(fromIds).toEqual([t1.id, t3.id].sort());
			expect(mergeEdges.every((e) => e.to === t4.id)).toBe(true);
		});
	});

	describe('verifies edges', () => {
		it('emits a verifies edge from current.id to target.id', () => {
			const { manager, edgeStore } = setup();
			const targets = [makeThought(1), makeThought(2), makeThought(3), makeThought(4)];
			for (const t of targets) manager.addThought(t);
			const verifier = makeThought(5, {
				thought_type: 'verification',
				verification_target: 4,
			});
			manager.addThought(verifier);

			const verifies = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'verifies');
			expect(verifies).toHaveLength(1);
			expect(verifies[0]!.from).toBe(verifier.id);
			expect(verifies[0]!.to).toBe(targets[3]!.id);
		});
	});

	describe('critiques edges', () => {
		it('emits a critiques edge from current.id to target.id', () => {
			const { manager, edgeStore } = setup();
			const targets = [makeThought(1), makeThought(2), makeThought(3), makeThought(4)];
			for (const t of targets) manager.addThought(t);
			const critic = makeThought(5, {
				thought_type: 'critique',
				verification_target: 4,
			});
			manager.addThought(critic);

			const critiques = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'critiques');
			expect(critiques).toHaveLength(1);
			expect(critiques[0]!.from).toBe(critic.id);
			expect(critiques[0]!.to).toBe(targets[3]!.id);
		});
	});

	describe('derives_from edges', () => {
		it('emits one derives_from edge per source in synthesis_sources', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2);
			const synth = makeThought(3, {
				thought_type: 'synthesis',
				synthesis_sources: [1, 2],
			});
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(synth);

			const derives = edgeStore
				.edgesForSession(SESSION_ID)
				.filter((e) => e.kind === 'derives_from');
			expect(derives).toHaveLength(2);
			const fromIds = derives.map((e) => e.from).sort();
			expect(fromIds).toEqual([t1.id, t2.id].sort());
			expect(derives.every((e) => e.to === synth.id)).toBe(true);
		});
	});

	describe('revises edges', () => {
		it('emits a revises edge from current.id to target.id', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2);
			const t3 = makeThought(3);
			const rev = makeThought(4, { is_revision: true, revises_thought: 3 });
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(t3);
			manager.addThought(rev);

			const revises = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'revises');
			expect(revises).toHaveLength(1);
			expect(revises[0]!.from).toBe(rev.id);
			expect(revises[0]!.to).toBe(t3.id);
		});
	});

	describe('robustness', () => {
		it('skips edges silently when target thought_number is missing', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			manager.addThought(t1);
			expect(() =>
				manager.addThought(makeThought(2, { merge_from_thoughts: [999] }))
			).not.toThrow();

			const merges = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'merge');
			expect(merges).toHaveLength(0);
		});

		it('emits no edges when current thought has no id', () => {
			const { manager, edgeStore } = setup();
			manager.addThought(makeThought(1));
			const idless = createTestThought({
				thought_number: 2,
				total_thoughts: 10,
				thought: 't2',
			});
			delete (idless as { id?: string }).id;
			expect(() => manager.addThought(idless)).not.toThrow();
			expect(edgeStore.size()).toBe(0);
		});

		it('does not emit a sequence edge when a relational edge fires', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2);
			const t3 = makeThought(3, { branch_from_thought: 1, branch_id: asBranchId('b1') });
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(t3);

			const all = edgeStore.edgesForSession(SESSION_ID);
			// t1->t2 sequence + t1->t3 branch (no t2->t3 sequence).
			expect(all).toHaveLength(2);
			expect(all.filter((e) => e.kind === 'sequence')).toHaveLength(1);
			expect(all.filter((e) => e.kind === 'branch')).toHaveLength(1);
		});
	});

	describe('session isolation', () => {
		it('keeps edges from session A invisible to session B', () => {
			const { manager, edgeStore } = setup();
			manager.addThought(makeThought(1, { session_id: asSessionId('A') }));
			manager.addThought(makeThought(2, { session_id: asSessionId('A') }));
			manager.addThought(makeThought(1, { session_id: asSessionId('B') }));

			expect(edgeStore.size(asSessionId('A'))).toBe(1);
			expect(edgeStore.size(asSessionId('B'))).toBe(0);
			const aEdges = edgeStore.edgesForSession(asSessionId('A'));
			expect(aEdges[0]!.sessionId).toBe('A');
		});
	});

	describe('branch-from-branch resolution', () => {
		it('resolves branch parent that lives on another branch', () => {
			const { manager, edgeStore } = setup();
			const t1 = makeThought(1);
			const t2 = makeThought(2, { branch_from_thought: 1, branch_id: asBranchId('A') });
			const t3 = makeThought(3, { branch_from_thought: 2, branch_id: asBranchId('B') });
			manager.addThought(t1);
			manager.addThought(t2);
			manager.addThought(t3);

			const branchEdges = edgeStore.edgesForSession(SESSION_ID).filter((e) => e.kind === 'branch');
			expect(branchEdges).toHaveLength(2);
			const t3BranchEdge = branchEdges.find((e) => e.to === t3.id);
			expect(t3BranchEdge).toBeDefined();
			expect(t3BranchEdge!.from).toBe(t2.id);
		});
	});
});

describe('EdgeEmitter mutation reporting', () => {
	it('returns true when a relational edge is added', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore, dagEdges: true });
		const parentId = asThoughtId('parent');
		const child = makeThought(2, {
			id: asThoughtId('child'),
			branch_from_thought: 1,
			branch_id: asBranchId('branch'),
		});

		// When
		const added = emitter.emitEdgesForThought({ thought_history: [child], branches: {} }, child, {
			resolvedReferences: { branchFromThoughtId: parentId },
		});

		// Then
		expect(added).toBe(true);
		expect(edgeStore.edgesForSession(SESSION_ID)[0]?.kind).toBe('branch');
	});

	it('returns true when a sequence edge is added', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore, dagEdges: true });
		const first = makeThought(1, { id: asThoughtId('first') });
		const second = makeThought(2, { id: asThoughtId('second') });

		// When
		const added = emitter.emitEdgesForThought(
			{ thought_history: [first, second], branches: {} },
			second
		);

		// Then
		expect(added).toBe(true);
		expect(edgeStore.edgesForSession(SESSION_ID)[0]?.kind).toBe('sequence');
	});

	it('returns false when the sequence edge is a duplicate', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore, dagEdges: true });
		const first = makeThought(1, { id: asThoughtId('first') });
		const second = makeThought(2, { id: asThoughtId('second') });
		const session = { thought_history: [first, second], branches: {} };
		emitter.emitEdgesForThought(session, second);

		// When
		const added = emitter.emitEdgesForThought(session, second);

		// Then
		expect(added).toBe(false);
		expect(edgeStore.size(SESSION_ID)).toBe(1);
	});

	it('returns false when a relational edge is a duplicate', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore, dagEdges: true });
		const parent = makeThought(1, { id: asThoughtId('parent') });
		const child = makeThought(2, {
			id: asThoughtId('child'),
			branch_from_thought: 1,
			branch_id: asBranchId('branch'),
		});
		const session = { thought_history: [parent, child], branches: {} };
		const context = { resolvedReferences: { branchFromThoughtId: parent.id } };
		emitter.emitEdgesForThought(session, child, context);

		// When
		const added = emitter.emitEdgesForThought(session, child, context);

		// Then
		expect(added).toBe(false);
		expect(edgeStore.edgesForSession(SESSION_ID)).toHaveLength(1);
	});

	it('returns false when edge emission is disabled', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({
			edgeStore,
			dagEdges: false,
		});
		const thought = makeThought(1, { id: asThoughtId('thought') });

		// When
		const added = emitter.emitEdgesForThought(
			{ thought_history: [thought], branches: {} },
			thought
		);

		// Then
		expect(added).toBe(false);
		expect(edgeStore.size(SESSION_ID)).toBe(0);
	});

	it('returns false when the current thought has no id', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore, dagEdges: true });
		const thought = createTestThought({ thought_number: 1, session_id: SESSION_ID });

		// When
		const added = emitter.emitEdgesForThought(
			{ thought_history: [thought], branches: {} },
			thought
		);

		// Then
		expect(added).toBe(false);
		expect(edgeStore.size(SESSION_ID)).toBe(0);
	});

	it('returns false when the candidate edge is invalid', () => {
		// Given
		const edgeStore = new EdgeStore();
		const emitter = new EdgeEmitter({ edgeStore, dagEdges: true });
		const sharedId = asThoughtId('same-thought');
		const first = makeThought(1, { id: sharedId });
		const second = makeThought(2, { id: sharedId });

		// When
		const added = emitter.emitEdgesForThought(
			{ thought_history: [first, second], branches: {} },
			second
		);

		// Then
		expect(added).toBe(false);
		expect(edgeStore.size(SESSION_ID)).toBe(0);
	});
});
