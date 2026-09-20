/**
 * Tests for {@link CompressionService}.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { CompressionService } from '../../core/compression/CompressionService.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import { EdgeStore } from '../../core/graph/EdgeStore.js';
import { generateUlid } from '../../core/ids.js';
import type { HistorySessionSnapshot, IHistoryManager } from '../../core/IHistoryManager.js';
import type { ThoughtReferenceResolution } from '../../core/ThoughtReferenceIndex.js';
import type { ThoughtData } from '../../core/thought.js';
import type { ConfidenceSignals } from '../../core/reasoning.js';
import type { Edge } from '../../core/graph/Edge.js';
import type { Logger, LogLevel } from '../../logger/StructuredLogger.js';
import {
	asBranchId,
	asSessionId,
	asThoughtId,
	type BranchId,
	type EdgeId,
	type SessionId,
	type ThoughtId,
} from '../../contracts/ids.js';

const SESSION: SessionId = asSessionId('s1');
const BRANCH: BranchId = asBranchId('b1');

type Signals = Partial<ConfidenceSignals>;

function makeThought(
	id: string,
	thought: string,
	thought_number: number,
	confidence?: number,
	signals?: Signals
): ThoughtData {
	const t: ThoughtData & { confidence_signals?: ConfidenceSignals } = {
		session_id: SESSION,
		id: id as ThoughtId,
		thought,
		thought_number,
		total_thoughts: 10,
		next_thought_needed: false,
	};
	if (confidence !== undefined) t.confidence = confidence;
	if (signals !== undefined) t.confidence_signals = signals as ConfidenceSignals;
	return t;
}

class FakeHistoryManager implements IHistoryManager {
	private readonly _branches: Record<BranchId, ThoughtData[]> = {} as Record<
		BranchId,
		ThoughtData[]
	>;
	private readonly _branchIds: BranchId[] = [];
	public inspectCalls = 0;
	public getHistoryCalls = 0;

	constructor(private readonly _thoughts: ThoughtData[] = []) {}

	addBranch(branchId: BranchId, thoughts: readonly ThoughtData[]): void {
		this._branchIds.push(branchId);
		this._branches[branchId] = [...thoughts];
	}

	addThought(t: ThoughtData): void {
		this._thoughts.push(t);
	}
	resolveThoughtReference(
		_sessionId: SessionId,
		_thoughtNumber: number
	): ThoughtReferenceResolution {
		return { kind: 'missing' };
	}
	getHistory(_sessionId: string): ThoughtData[] {
		this.getHistoryCalls += 1;
		return this._thoughts;
	}
	getHistoryLength(_sessionId: string): number {
		return this._thoughts.length;
	}
	getBranches(_sessionId: string): Record<BranchId, ThoughtData[]> {
		return this._branches;
	}
	getBranchIds(_sessionId: string): BranchId[] {
		return [...this._branchIds];
	}
	registerBranch(_sessionId: string, _branchId: BranchId): void {}
	branchExists(_sessionId: string, _branchId: BranchId): boolean {
		return false;
	}
	clear(): void {
		this._thoughts.length = 0;
	}
	async resetSession(_sessionId: string, _clearAuxiliaryState?: () => void): Promise<void> {
		this.clear();
	}
	async resetSessionWithinExclusive(
		_sessionId: SessionId,
		_clearAuxiliaryState?: () => void
	): Promise<void> {
		this.clear();
	}
	async resetAll(): Promise<void> {
		this.clear();
	}
	async resetAllWithinExclusive(): Promise<void> {
		this.clear();
	}
	inspectSession(_sessionId: string): HistorySessionSnapshot {
		this.inspectCalls += 1;
		return {
			history: [...this._thoughts],
			branches: Object.fromEntries(
				this._branchIds.map((branchId) => [branchId, [...(this._branches[branchId] ?? [])]])
			) as Record<BranchId, readonly ThoughtData[]>,
			branchIds: [...this._branchIds],
			availableMcpTools: undefined,
			availableSkills: undefined,
		};
	}
	getSessionIds(): string[] {
		return [SESSION];
	}
	getAvailableSkills(_sessionId: string): string[] | undefined {
		return undefined;
	}

	getEdgeStore(): undefined {
		return undefined;
	}

	getAvailableMcpTools(_sessionId: string): string[] | undefined {
		return undefined;
	}
}

function addSeqEdge(edges: EdgeStore, from: string, to: string): Edge {
	const edge: Edge = {
		id: generateUlid() as EdgeId,
		from: asThoughtId(from),
		to: asThoughtId(to),
		kind: 'sequence',
		sessionId: SESSION,
		createdAt: Date.now(),
	};
	edges.addEdge(edge);
	return edge;
}

interface Harness {
	svc: CompressionService;
	store: InMemorySummaryStore;
	edges: EdgeStore;
	hm: FakeHistoryManager;
	logs: Array<{ msg: string; ctx?: unknown }>;
}

function newHarness(thoughts: ThoughtData[] = []): Harness {
	const hm = new FakeHistoryManager(thoughts);
	const edges = new EdgeStore();
	const store = new InMemorySummaryStore();
	const logs: Array<{ msg: string; ctx?: unknown }> = [];
	const logger: Logger = {
		debug(msg: string, ctx?: unknown): void {
			logs.push({ msg, ctx });
		},
		info(): void {},
		warn(): void {},
		error(): void {},
		setLevel(): void {},
		getLevel(): LogLevel {
			return 'debug';
		},
	};
	const svc = new CompressionService({
		historyManager: hm,
		edgeStore: edges,
		summaryStore: store,
		logger,
	});
	return { svc, store, edges, hm, logs };
}

describe('CompressionService', () => {
	let h: Harness;

	beforeEach(() => {
		h = newHarness();
	});

	it('compresses a single-thought subtree (no descendants)', () => {
		h.hm.addThought(makeThought('root', 'database connection pooling logic', 1, 0.7));
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(summary.coveredIds).toEqual(['root']);
		expect(summary.rootThoughtId).toBe('root');
		expect(summary.sessionId).toBe(SESSION);
		expect(summary.branchId).toBe(BRANCH);
		expect(summary.coveredRange).toEqual([1, 1]);
		expect(summary.aggregateConfidence).toBeCloseTo(0.7);
		expect(summary.topics.length).toBeGreaterThan(0);
	});

	it('covers root + descendants in chronological BFS order', () => {
		h.hm.addThought(makeThought('a', 'alpha word', 1));
		h.hm.addThought(makeThought('b', 'beta words', 2));
		h.hm.addThought(makeThought('c', 'gamma terms', 3));
		addSeqEdge(h.edges, 'a', 'b');
		addSeqEdge(h.edges, 'b', 'c');
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('a'));
		expect(summary.coveredIds).toEqual(['a', 'b', 'c']);
		expect(summary.coveredRange).toEqual([1, 3]);
	});

	it('resolves branch-only thoughts from exactly one session snapshot', () => {
		const root = makeThought('branch-root', 'branch snapshot root', 4, 0.6);
		const child = makeThought('branch-child', 'branch snapshot child', 5, 0.8);
		h.hm.addBranch(BRANCH, [root, child]);
		addSeqEdge(h.edges, 'branch-root', 'branch-child');

		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('branch-root'));

		expect(summary.coveredIds).toEqual(['branch-root', 'branch-child']);
		expect(summary.coveredRange).toEqual([4, 5]);
		expect(summary.aggregateConfidence).toBeCloseTo(0.7);
		expect(h.hm.inspectCalls).toBe(1);
		expect(h.hm.getHistoryCalls).toBe(0);
	});

	it('prefers the main-history record when a branch snapshot repeats its id', () => {
		h.hm.addThought(makeThought('shared', 'canonical main topic', 2, 0.9));
		h.hm.addBranch(BRANCH, [makeThought('shared', 'duplicate branch topic', 99, 0.1)]);

		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('shared'));

		expect(summary.coveredRange).toEqual([2, 2]);
		expect(summary.aggregateConfidence).toBeCloseTo(0.9);
		expect(summary.topics).toContain('canonical');
		expect(summary.topics).not.toContain('duplicate');
	});

	it('is idempotent: re-compressing returns the same Summary instance', () => {
		h.hm.addThought(makeThought('root', 'topic alpha keyword', 1));
		const first = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		const second = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(second.id).toBe(first.id);
		expect(h.store.size()).toBe(1);
	});

	it('filters stopwords from topic extraction', () => {
		h.hm.addThought(makeThought('root', 'this that with from have will would could should', 1));
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(summary.topics).toEqual([]);
	});

	it('drops tokens shorter than 4 characters', () => {
		h.hm.addThought(makeThought('root', 'a is to of in on at by go run', 1));
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		// "run" is 3 chars → dropped; nothing else qualifies
		expect(summary.topics).toEqual([]);
	});

	it('ranks topics by frequency, breaking ties by first-occurrence order', () => {
		// "alpha" 3x, "bravo" 2x, "delta" 2x, "gamma" 1x
		// Expect order: alpha (most freq), bravo (tied 2 with delta but appears first), delta
		h.hm.addThought(makeThought('root', 'alpha bravo alpha delta bravo alpha gamma delta', 1));
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(summary.topics).toEqual(['alpha', 'bravo', 'delta']);
	});

	it('aggregates confidence using calibrated_confidence over raw confidence', () => {
		h.hm.addThought(makeThought('a', 'alpha', 1, 0.2, { calibrated_confidence: 0.8 }));
		h.hm.addThought(makeThought('b', 'beta', 2, 0.4, { calibrated_confidence: 0.6 }));
		addSeqEdge(h.edges, 'a', 'b');
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('a'));
		expect(summary.aggregateConfidence).toBeCloseTo(0.7); // mean(0.8, 0.6)
	});

	it('falls back to confidence when calibrated absent, then 0 when both absent', () => {
		h.hm.addThought(makeThought('a', 'alpha', 1, 0.5));
		h.hm.addThought(makeThought('b', 'beta', 2));
		addSeqEdge(h.edges, 'a', 'b');
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('a'));
		expect(summary.aggregateConfidence).toBeCloseTo(0.25); // mean(0.5, 0)
	});

	it('computes coveredRange as inclusive [min, max] of thought_number', () => {
		h.hm.addThought(makeThought('a', 'word', 5));
		h.hm.addThought(makeThought('b', 'word', 2));
		h.hm.addThought(makeThought('c', 'word', 9));
		addSeqEdge(h.edges, 'a', 'b');
		addSeqEdge(h.edges, 'b', 'c');
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('a'));
		expect(summary.coveredRange).toEqual([2, 9]);
	});

	it('excludes graph ghost ids from every derived summary field', () => {
		h.hm.addThought(makeThought('a', 'alpha keyword', 1, 0.4));
		// 'ghost' has an edge but no thought in history
		addSeqEdge(h.edges, 'a', 'ghost');
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('a'));
		expect(summary.coveredIds).toEqual(['a']);
		expect(summary.coveredRange).toEqual([1, 1]);
		expect(summary.aggregateConfidence).toBeCloseTo(0.4);
	});

	it('retains resolved descendants when the requested root is missing', () => {
		h.hm.addThought(makeThought('child', 'resolved descendant topic', 7, 0.6));
		addSeqEdge(h.edges, 'missing-root', 'child');

		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('missing-root'));

		expect(summary.rootThoughtId).toBe('missing-root');
		expect(summary.coveredIds).toEqual(['child']);
		expect(summary.coveredRange).toEqual([7, 7]);
		expect(summary.aggregateConfidence).toBeCloseTo(0.6);
	});

	it('emits a debug log on compression when logger provided', () => {
		h.hm.addThought(makeThought('root', 'compression keyword sample', 1));
		h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(h.logs.some((l) => l.msg === 'compression.branch.compressed')).toBe(true);
	});

	it('persists the summary in the store under the given session and branch', () => {
		h.hm.addThought(makeThought('root', 'sample words present', 1));
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(h.store.get(summary.id)).toBe(summary);
		expect(h.store.forBranch(SESSION, BRANCH).map((s) => s.id)).toEqual([summary.id]);
	});

	it('limits topics to top 3', () => {
		h.hm.addThought(makeThought('root', 'alpha bravo delta gamma kappa lambda omega', 1));
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('root'));
		expect(summary.topics).toHaveLength(3);
	});

	it('returns 0 confidence and [0,0] range when history has no matching thought', () => {
		// Root id has no entry in history at all
		const summary = h.svc.compressBranch(SESSION, BRANCH, asThoughtId('orphan'));
		expect(summary.rootThoughtId).toBe('orphan');
		expect(summary.coveredIds).toEqual([]);
		expect(summary.aggregateConfidence).toBe(0);
		expect(summary.coveredRange).toEqual([0, 0]);
		expect(summary.topics).toEqual([]);
	});

	it('works without a logger (optional dep)', () => {
		const hm = new FakeHistoryManager([makeThought('r', 'topic word', 1)]);
		const edges = new EdgeStore();
		const store = new InMemorySummaryStore();
		const svc = new CompressionService({
			historyManager: hm,
			edgeStore: edges,
			summaryStore: store,
		});
		expect(() => svc.compressBranch(SESSION, BRANCH, asThoughtId('r'))).not.toThrow();
		expect(store.size()).toBe(1);
	});
});
