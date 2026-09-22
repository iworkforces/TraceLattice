/**
 * Integration tests for DAG edge emission and persistence.
 *
 * Covers end-to-end behavior across all 3 persistence backends:
 *   - Memory (MemoryPersistence)
 *   - File   (FilePersistence with os.tmpdir())
 *   - SQLite (SqlitePersistence with :memory:)
 *
 * Scenarios:
 *   1. Flag-OFF parity     — no edges emitted/persisted when dagEdges=false
 *   2. Flag-ON edge kinds   — every relational edge kind (except tool_invocation)
 *   3. Three-backend roundtrip — flush + load preserves edges across all backends
 *   4. Multi-session isolation — edges stay scoped to their session
 *   5. Restart roundtrip with GraphView — restored edges traverse correctly
 */

import { asBranchId, asSessionId, type ThoughtId } from '../../contracts/ids.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HistoryManager } from '../../core/HistoryManager.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { GraphView } from '../../core/graph/GraphView.js';
import { generateUlid } from '../../core/ids.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { buildActiveEvidenceProjection } from '../../core/reasoning/ActiveEvidenceProjection.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { FilePersistence } from '../../persistence/FilePersistence.js';
import { SqlitePersistence } from '../../persistence/SqlitePersistence.js';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import type { Edge, EdgeKind } from '../../core/graph/Edge.js';
import type { ThoughtData } from '../../core/thought.js';
import { createTestThought } from '../helpers/factories.js';
import { createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

const DAG_SESSION = asSessionId('dag-edges-session');

// SQLite persistence requires the optional `better-sqlite3` package.
// Detect availability at module load so tests can be skipped gracefully.
const SQLITE_AVAILABLE = await (async () => {
	try {
		await import('better-sqlite3');
		return true;
	} catch {
		return false;
	}
})();

function makeThought(
	num: number,
	overrides?: Partial<Omit<ThoughtData, 'session_id'>> & { session_id?: string }
): ThoughtData {
	return createTestThought({
		session_id: DAG_SESSION,
		id: generateUlid(),
		thought_number: num,
		total_thoughts: 10,
		thought: `t${num}`,
		next_thought_needed: true,
		...overrides,
	});
}

function makeManager(opts: {
	persistence: PersistenceBackend;
	dagEdges: boolean;
	edgeStore?: EdgeStore;
}): { manager: HistoryManager; edgeStore: EdgeStore } {
	const edgeStore = opts.edgeStore ?? new EdgeStore();
	const manager = new HistoryManager({
		edgeStore,
		dagEdges: opts.dagEdges,
		persistence: opts.persistence,
		// Disable timer-driven flushes so tests are deterministic.
		persistenceFlushInterval: 60_000,
		persistenceBufferSize: 1000,
	});
	return { manager, edgeStore };
}

// ---------------------------------------------------------------------------
// Scenario 1: Flag-OFF parity — no edges emitted, no saveEdges call
// ---------------------------------------------------------------------------

describe('DAG edges integration — Scenario 1: flag OFF parity', () => {
	it('emits zero edges into EdgeStore when dagEdges=false (Memory)', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: false });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));

		expect(edgeStore.size(DAG_SESSION)).toBe(0);
		await manager.shutdown();
	});

	it('does not call saveEdges on the persistence backend when flag is OFF', async () => {
		const persistence = new MemoryPersistence();
		const spy = vi.spyOn(persistence, 'saveEdges');
		const { manager } = makeManager({ persistence, dagEdges: false });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		await manager._flushBuffer();

		expect(spy).not.toHaveBeenCalled();
		await manager.shutdown();
	});

	it('thought history is unaffected by the flag setting (parity)', async () => {
		const persistence = new MemoryPersistence();
		const { manager } = makeManager({ persistence, dagEdges: false });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));

		expect(manager.getHistoryLength(DAG_SESSION)).toBe(3);
		await manager.shutdown();
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: Flag-ON edge emission — each relational kind except tool_invocation
// ---------------------------------------------------------------------------

describe('DAG edges integration — Scenario 2: edge kind emission', () => {
	it('emits sequence edges between consecutive non-relational thoughts', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		manager.addThought(makeThought(1));
		manager.addThought(makeThought(2));
		manager.addThought(makeThought(3));

		const edges = edgeStore.edgesForSession(DAG_SESSION);
		expect(edges).toHaveLength(2);
		expect(edges.every((e) => e.kind === 'sequence')).toBe(true);
		await manager.shutdown();
	});

	it('emits a branch edge when branch_from_thought + branch_id are set', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		manager.addThought(t1);
		const t2 = makeThought(2, { branch_from_thought: 1, branch_id: asBranchId('alt') });
		manager.addThought(t2);

		const edges = edgeStore.edgesForSession(DAG_SESSION);
		const branchEdges = edges.filter((e) => e.kind === 'branch');
		expect(branchEdges).toHaveLength(1);
		expect(branchEdges[0]!.from).toBe(t1.id);
		expect(branchEdges[0]!.to).toBe(t2.id);
		await manager.shutdown();
	});

	it('emits merge edges from each merge source', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		const t2 = makeThought(2);
		manager.addThought(t1);
		manager.addThought(t2);
		const t3 = makeThought(3, { merge_from_thoughts: [1, 2] });
		manager.addThought(t3);

		const merges = edgeStore.edgesForSession(DAG_SESSION).filter((e) => e.kind === 'merge');
		expect(merges).toHaveLength(2);
		expect(merges.map((e) => e.from).sort()).toEqual([t1.id, t2.id].sort());
		expect(merges.every((e) => e.to === t3.id)).toBe(true);
		await manager.shutdown();
	});

	it('emits a verifies edge when thought_type=verification + verification_target', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		manager.addThought(t1);
		const t2 = makeThought(2, { thought_type: 'verification', verification_target: 1 });
		manager.addThought(t2);

		const verifies = edgeStore.edgesForSession(DAG_SESSION).filter((e) => e.kind === 'verifies');
		expect(verifies).toHaveLength(1);
		expect(verifies[0]!.from).toBe(t2.id);
		expect(verifies[0]!.to).toBe(t1.id);
		await manager.shutdown();
	});

	it('emits a critiques edge when thought_type=critique + verification_target', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		manager.addThought(t1);
		const t2 = makeThought(2, { thought_type: 'critique', verification_target: 1 });
		manager.addThought(t2);

		const crits = edgeStore.edgesForSession(DAG_SESSION).filter((e) => e.kind === 'critiques');
		expect(crits).toHaveLength(1);
		expect(crits[0]!.from).toBe(t2.id);
		expect(crits[0]!.to).toBe(t1.id);
		await manager.shutdown();
	});

	it('emits derives_from edges for each synthesis source', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		const t2 = makeThought(2);
		manager.addThought(t1);
		manager.addThought(t2);
		const t3 = makeThought(3, { synthesis_sources: [1, 2] });
		manager.addThought(t3);

		const derives = edgeStore.edgesForSession(DAG_SESSION).filter((e) => e.kind === 'derives_from');
		expect(derives).toHaveLength(2);
		expect(derives.map((e) => e.from).sort()).toEqual([t1.id, t2.id].sort());
		expect(derives.every((e) => e.to === t3.id)).toBe(true);
		await manager.shutdown();
	});

	it('emits a revises edge when revises_thought is set', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		manager.addThought(t1);
		const t2 = makeThought(2, { revises_thought: 1, is_revision: true });
		manager.addThought(t2);

		const revises = edgeStore.edgesForSession(DAG_SESSION).filter((e) => e.kind === 'revises');
		expect(revises).toHaveLength(1);
		expect(revises[0]!.from).toBe(t2.id);
		expect(revises[0]!.to).toBe(t1.id);
		await manager.shutdown();
	});

	it('does NOT emit a sequence edge when a relational edge already covers the thought', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		const t1 = makeThought(1);
		manager.addThought(t1);
		manager.addThought(makeThought(2, { revises_thought: 1, is_revision: true }));

		const kinds = edgeStore.edgesForSession(DAG_SESSION).map((e) => e.kind);
		expect(kinds).toContain('revises');
		expect(kinds).not.toContain('sequence');
		await manager.shutdown();
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: Three-backend roundtrip — flush + load across Memory / File / SQLite
// ---------------------------------------------------------------------------

describe('DAG edges integration — Scenario 3: three-backend roundtrip', () => {
	let tmpRoot: string;

	beforeAll(async () => {
		tmpRoot = await mkdtemp(join(tmpdir(), 'dag-edges-roundtrip-'));
	});

	afterAll(async () => {
		await rm(tmpRoot, { recursive: true, force: true });
	});

	async function makeBackend(kind: 'memory' | 'file' | 'sqlite'): Promise<PersistenceBackend> {
		switch (kind) {
			case 'memory':
				return new MemoryPersistence();
			case 'file':
				return new FilePersistence({ dataDir: await mkdtemp(join(tmpRoot, 'file-')) });
			case 'sqlite':
				return await SqlitePersistence.create({ dbPath: ':memory:' });
		}
	}

	const backends: Array<'memory' | 'file' | 'sqlite'> = ['memory', 'file', 'sqlite'];

	for (const kind of backends) {
		const skip = kind === 'sqlite' && !SQLITE_AVAILABLE;
		it.skipIf(skip)(`persists and reloads a mixed edge set (${kind})`, async () => {
			const persistence = await makeBackend(kind);
			const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

			const t1 = makeThought(1);
			const t2 = makeThought(2);
			manager.addThought(t1); // (no edge for first)
			manager.addThought(t2); // sequence: t1 -> t2
			manager.addThought(makeThought(3, { revises_thought: 1, is_revision: true })); // revises t1
			manager.addThought(makeThought(4, { synthesis_sources: [1, 2] })); // 2× derives_from
			manager.addThought(makeThought(5, { thought_type: 'verification', verification_target: 4 })); // verifies

			const beforeKinds = edgeStore
				.edgesForSession(DAG_SESSION)
				.map((e) => e.kind)
				.sort();
			await manager._flushBuffer();
			await manager.shutdown();

			// Spin up a fresh manager + EdgeStore using the same backend.
			const freshStore = new EdgeStore();
			const fresh = new HistoryManager({
				edgeStore: freshStore,
				dagEdges: true,
				persistence,
				persistenceFlushInterval: 60_000,
			});
			await fresh.loadFromPersistence();

			const afterKinds = freshStore
				.edgesForSession(DAG_SESSION)
				.map((e) => e.kind)
				.sort();
			expect(afterKinds).toEqual(beforeKinds);
			expect(freshStore.size(DAG_SESSION)).toBeGreaterThan(0);
			await fresh.shutdown();
		});
	}
});

// ---------------------------------------------------------------------------
// Scenario 4: Multi-session isolation
// ---------------------------------------------------------------------------

describe('DAG edges integration — Scenario 4: multi-session isolation', () => {
	it('keeps edges from different sessions in separate buckets in the EdgeStore', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		manager.addThought(makeThought(1, { session_id: 'sess-a' }));
		manager.addThought(makeThought(2, { session_id: 'sess-a' }));
		manager.addThought(makeThought(1, { session_id: 'sess-b' }));
		manager.addThought(makeThought(2, { session_id: 'sess-b' }));
		manager.addThought(makeThought(3, { session_id: 'sess-b' }));

		expect(edgeStore.size(asSessionId('sess-a'))).toBe(1); // 2 thoughts → 1 sequence edge
		expect(edgeStore.size(asSessionId('sess-b'))).toBe(2); // 3 thoughts → 2 sequence edges
		expect(edgeStore.size(DAG_SESSION)).toBe(0);
		await manager.shutdown();
	});

	it('persists edges per-session via saveEdges with the correct session id', async () => {
		const persistence = new MemoryPersistence();
		const spy = vi.spyOn(persistence, 'saveEdges');
		const { manager } = makeManager({ persistence, dagEdges: true });

		manager.addThought(makeThought(1, { session_id: 'sess-x' }));
		manager.addThought(makeThought(2, { session_id: 'sess-x' }));
		manager.addThought(makeThought(1, { session_id: 'sess-y' }));
		manager.addThought(makeThought(2, { session_id: 'sess-y' }));

		await manager._flushBuffer();

		const sessionsCalled = new Set(spy.mock.calls.map((c) => c[0]));
		expect(sessionsCalled.has(asSessionId('sess-x'))).toBe(true);
		expect(sessionsCalled.has(asSessionId('sess-y'))).toBe(true);

		const xEdges = await persistence.loadEdges(asSessionId('sess-x'));
		const yEdges = await persistence.loadEdges(asSessionId('sess-y'));
		expect(xEdges).toHaveLength(1);
		expect(yEdges).toHaveLength(1);
		expect(xEdges.every((e: Edge) => e.sessionId === 'sess-x')).toBe(true);
		expect(yEdges.every((e: Edge) => e.sessionId === 'sess-y')).toBe(true);
		await manager.shutdown();
	});

	it('edgesForSession of one session never returns edges of another', async () => {
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });

		manager.addThought(makeThought(1, { session_id: 'A' }));
		manager.addThought(makeThought(2, { session_id: 'A' }));
		manager.addThought(makeThought(1, { session_id: 'B' }));
		manager.addThought(makeThought(2, { session_id: 'B' }));

		const aEdges = edgeStore.edgesForSession(asSessionId('A'));
		const bEdges = edgeStore.edgesForSession(asSessionId('B'));
		expect(aEdges.every((e) => e.sessionId === 'A')).toBe(true);
		expect(bEdges.every((e) => e.sessionId === 'B')).toBe(true);
		expect(aEdges.some((e) => bEdges.includes(e))).toBe(false);
		await manager.shutdown();
	});
});

// ---------------------------------------------------------------------------
// Scenario 5: Restart roundtrip with GraphView traversal
// ---------------------------------------------------------------------------

describe('DAG edges integration — Scenario 5: restart + GraphView', () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'dag-edges-restart-'));
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('reconstructs a chain via GraphView.descendants after restart (FilePersistence)', async () => {
		const dataDir = await mkdtemp(join(tmpDir, 'chain-'));
		const persistence = new FilePersistence({ dataDir });

		const ids: string[] = [];
		const { manager } = makeManager({ persistence, dagEdges: true });
		for (let i = 1; i <= 4; i++) {
			const t = makeThought(i);
			ids.push(t.id!);
			manager.addThought(t);
		}
		await manager._flushBuffer();
		await manager.shutdown();

		const freshStore = new EdgeStore();
		const fresh = new HistoryManager({
			edgeStore: freshStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});
		await fresh.loadFromPersistence();

		const view = new GraphView(freshStore);
		const descendants = view.descendants(DAG_SESSION, ids[0]! as ThoughtId);
		expect(descendants).toEqual([ids[1]!, ids[2]!, ids[3]!]);

		const ancestors = view.ancestors(DAG_SESSION, ids[3]! as ThoughtId);
		expect(ancestors).toEqual([ids[2]!, ids[1]!, ids[0]!]);

		await fresh.shutdown();
	});

	it.skipIf(!SQLITE_AVAILABLE)(
		'preserves topological order across restart (SQLite :memory:)',
		async () => {
			const persistence = await SqlitePersistence.create({ dbPath: ':memory:' });

			const ids: string[] = [];
			const { manager } = makeManager({ persistence, dagEdges: true });
			for (let i = 1; i <= 5; i++) {
				const t = makeThought(i);
				ids.push(t.id!);
				manager.addThought(t);
			}
			await manager._flushBuffer();
			await manager.shutdown();

			const freshStore = new EdgeStore();
			const fresh = new HistoryManager({
				edgeStore: freshStore,
				dagEdges: true,
				persistence,
				persistenceFlushInterval: 60_000,
			});
			await fresh.loadFromPersistence();

			const view = new GraphView(freshStore);
			const order = view.topological(DAG_SESSION);
			expect(order).toEqual(ids);

			const leaves = view.leaves(DAG_SESSION);
			expect(leaves).toEqual([ids[4]!]);

			await fresh.shutdown();
		}
	);

	it('preserves a branch traversal via GraphView.branchThoughts after restart (Memory)', async () => {
		const persistence = new MemoryPersistence();

		const t1 = makeThought(1);
		const t2 = makeThought(2, { branch_from_thought: 1, branch_id: asBranchId('alt') });
		const t3 = makeThought(3, { branch_from_thought: 2, branch_id: asBranchId('alt') });

		const { manager } = makeManager({ persistence, dagEdges: true });
		manager.addThought(t1);
		manager.addThought(t2);
		manager.addThought(t3);
		await manager._flushBuffer();
		await manager.shutdown();

		const freshStore = new EdgeStore();
		const fresh = new HistoryManager({
			edgeStore: freshStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});
		await fresh.loadFromPersistence();

		const view = new GraphView(freshStore);
		const branchOrder = view.branchThoughts(DAG_SESSION, t1.id!);
		expect(branchOrder).toEqual([t1.id!, t2.id!, t3.id!]);

		// Sanity: every restored edge has a known kind.
		const validKinds: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
			'sequence',
			'branch',
			'merge',
			'verifies',
			'critiques',
			'derives_from',
			'tool_invocation',
			'revises',
		]);
		for (const e of freshStore.edgesForSession(DAG_SESSION)) {
			expect(validKinds.has(e.kind)).toBe(true);
		}

		await fresh.shutdown();
	});

	it('preserves the ToT depth-cap decision after graph persistence restore', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const { manager, edgeStore } = makeManager({ persistence, dagEdges: true });
		for (let number = 1; number <= 3; number++) {
			manager.addThought(makeThought(number, { confidence: number / 10 }));
		}
		const strategy = new TreeOfThoughtStrategy({
			depthCap: 2,
			terminationConfidence: 1,
			plateauWindow: 10,
		});
		const evaluator = createDisabledThoughtEvaluator();
		const beforeHistory = manager.getHistory(DAG_SESSION);
		const beforeCurrent = beforeHistory[2];
		if (beforeCurrent === undefined) throw new TypeError('Expected current thought before restore');
		const before = strategy.decide({
			sessionId: DAG_SESSION,
			evidence: buildActiveEvidenceProjection({
				sessionId: DAG_SESSION,
				history: beforeHistory,
				branches: manager.getBranches(DAG_SESSION),
				edgeStore,
			}),
			stats: evaluator.computeReasoningStats(beforeHistory, manager.getBranches(DAG_SESSION)),
			currentThought: beforeCurrent,
		});
		await manager._flushBuffer();
		await manager.shutdown();

		// When
		const restoredStore = new EdgeStore();
		const restored = new HistoryManager({
			edgeStore: restoredStore,
			dagEdges: true,
			persistence,
			persistenceFlushInterval: 60_000,
		});
		await restored.loadFromPersistence();
		const restoredHistory = restored.getHistory(DAG_SESSION);
		const restoredCurrent = restoredHistory[2];
		if (restoredCurrent === undefined)
			throw new TypeError('Expected current thought after restore');
		const after = strategy.decide({
			sessionId: DAG_SESSION,
			evidence: buildActiveEvidenceProjection({
				sessionId: DAG_SESSION,
				history: restoredHistory,
				branches: restored.getBranches(DAG_SESSION),
				edgeStore: restoredStore,
			}),
			stats: evaluator.computeReasoningStats(restoredHistory, restored.getBranches(DAG_SESSION)),
			currentThought: restoredCurrent,
		});
		await restored.shutdown();

		// Then
		expect(before).toEqual({ action: 'terminate', reason: 'depth cap' });
		expect(after).toEqual(before);
	});
});
