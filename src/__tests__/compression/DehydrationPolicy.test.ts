/**
 * Tests for {@link DehydrationPolicy}.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { DehydrationPolicy, type SummaryRef } from '../../core/compression/DehydrationPolicy.js';
import { InMemorySummaryStore } from '../../core/compression/InMemorySummaryStore.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { ThoughtData } from '../../core/thought.js';
import { asSessionId, asThoughtId } from '../../contracts/ids.js';

const SID = asSessionId('s1');

let summaryCounter = 0;

function makeThought(n: number, overrides?: Partial<ThoughtData>): ThoughtData {
	return {
		session_id: SID,
		id: asThoughtId(`t-${n}`),
		thought: `t${n}`,
		thought_number: n,
		total_thoughts: 100,
		next_thought_needed: true,
		...overrides,
	};
}

function makeHistory(count: number): ThoughtData[] {
	const out: ThoughtData[] = [];
	for (let i = 1; i <= count; i++) out.push(makeThought(i));
	return out;
}

function makeSummary(
	overrides: Partial<Omit<Summary, 'sessionId' | 'rootThoughtId'>> &
		Pick<Summary, 'coveredRange'> & { sessionId?: string; rootThoughtId?: string }
): Summary {
	summaryCounter += 1;
	return {
		id: overrides.id ?? `sum-${summaryCounter}`,
		sessionId: overrides.sessionId ? asSessionId(overrides.sessionId) : SID,
		branchId: overrides.branchId,
		rootThoughtId: asThoughtId(overrides.rootThoughtId ?? `t-root-${summaryCounter}`),
		coveredIds:
			overrides.coveredIds ??
			Array.from(
				{ length: overrides.coveredRange[1] - overrides.coveredRange[0] + 1 },
				(_, index) => asThoughtId(`t-${overrides.coveredRange[0] + index}`)
			),
		coveredRange: overrides.coveredRange,
		topics: overrides.topics ?? [],
		aggregateConfidence: overrides.aggregateConfidence ?? 0.5,
		createdAt: overrides.createdAt ?? summaryCounter,
		meta: overrides.meta,
	};
}

function isRef(e: unknown): e is SummaryRef {
	return typeof e === 'object' && e !== null && (e as { kind?: string }).kind === 'summary';
}

describe('DehydrationPolicy', () => {
	let store: InMemorySummaryStore;
	let policy: DehydrationPolicy;

	beforeEach(() => {
		store = new InMemorySummaryStore();
		policy = new DehydrationPolicy(store);
		summaryCounter = 0;
	});

	it('returns empty array for empty history', () => {
		expect(policy.apply([], SID)).toEqual([]);
	});

	it('returns identity (copy) when history.length <= keepLastK', () => {
		const history = makeHistory(10);
		const result = policy.apply(history, SID, { keepLastK: 50 });
		expect(result).toEqual(history);
		expect(result).not.toBe(history);
	});

	it('returns identity exactly at boundary length === keepLastK', () => {
		const history = makeHistory(50);
		const result = policy.apply(history, SID, { keepLastK: 50 });
		expect(result).toHaveLength(50);
		expect(result).toEqual(history);
	});

	it('uses default keepLastK=50 when not specified', () => {
		const history = makeHistory(50);
		const result = policy.apply(history, SID);
		expect(result).toEqual(history);
	});

	it('returns all original thoughts when history > K but no summaries exist', () => {
		const history = makeHistory(100);
		const result = policy.apply(history, SID, { keepLastK: 50 });
		expect(result).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(result[i]).toBe(history[i]);
		}
	});

	it('replaces cold section with SummaryRef when single summary covers it', () => {
		const history = makeHistory(60); // cold = 1..10, hot = 11..60
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 10] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		// 1 ref + 50 hot
		expect(result).toHaveLength(51);
		expect(isRef(result[0])).toBe(true);
		const ref = result[0] as SummaryRef;
		expect(ref.summaryId).toBe('S1');
		expect(ref.coveredRange).toEqual([1, 10]);
		// Hot remains verbatim
		expect((result[1] as ThoughtData).thought_number).toBe(11);
		expect((result[50] as ThoughtData).thought_number).toBe(60);
	});

	it('dedups consecutive cold thoughts covered by same summary into single ref', () => {
		const history = makeHistory(60); // cold = 1..10
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 10] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		const refs = result.filter(isRef);
		expect(refs).toHaveLength(1);
		expect(refs[0]!.summaryId).toBe('S1');
	});

	it('leaves an uncovered duplicate-number thought untouched', () => {
		const covered = makeThought(1, { id: asThoughtId('covered-id') });
		const duplicate = makeThought(1, { id: asThoughtId('uncovered-id'), thought: 'duplicate' });
		store.add(
			makeSummary({
				id: 'S1',
				coveredIds: [asThoughtId('covered-id')],
				coveredRange: [1, 1],
			})
		);

		const result = policy.apply([covered, duplicate], SID, { keepLastK: 0 });

		expect(result).toEqual([{ kind: 'summary', summaryId: 'S1', coveredRange: [1, 1] }, duplicate]);
	});

	it('leaves idless cold thoughts untouched even when their number is in a summary range', () => {
		const idless: ThoughtData = {
			session_id: SID,
			thought: 'idless duplicate',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
		};
		store.add(
			makeSummary({
				id: 'S1',
				coveredIds: [asThoughtId('different-id')],
				coveredRange: [1, 1],
			})
		);

		const result = policy.apply([idless], SID, { keepLastK: 0 });

		expect(result).toEqual([idless]);
		expect(result[0]).toBe(idless);
	});

	it('uses the first summary when coveredIds overlap', () => {
		const history = [makeThought(1)];
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 3] }));
		store.add(makeSummary({ id: 'S2', coveredIds: [asThoughtId('t-1')], coveredRange: [1, 1] }));

		const result = policy.apply(history, SID, { keepLastK: 0 });

		expect(result).toEqual([{ kind: 'summary', summaryId: 'S1', coveredRange: [1, 3] }]);
	});

	it('re-emits one summary after an uncovered identity gap', () => {
		const history = makeHistory(3);
		store.add(
			makeSummary({
				id: 'S1',
				coveredIds: [asThoughtId('t-1'), asThoughtId('t-3')],
				coveredRange: [1, 3],
			})
		);

		const result = policy.apply(history, SID, { keepLastK: 0 });

		expect(result).toEqual([
			{ kind: 'summary', summaryId: 'S1', coveredRange: [1, 3] },
			history[1],
			{ kind: 'summary', summaryId: 'S1', coveredRange: [1, 3] },
		]);
	});

	it('emits separate refs for different non-overlapping summaries', () => {
		const history = makeHistory(60); // cold = 1..10
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 5] }));
		store.add(makeSummary({ id: 'S2', coveredRange: [6, 10] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		const refs = result.filter(isRef) as SummaryRef[];
		expect(refs.map((r) => r.summaryId)).toEqual(['S1', 'S2']);
		// 2 refs + 50 hot
		expect(result).toHaveLength(52);
	});

	it('mixes original cold thoughts and refs when only some are covered', () => {
		const history = makeHistory(60); // cold = 1..10
		store.add(makeSummary({ id: 'S1', coveredRange: [3, 5] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		// cold: t1, t2 (raw), S1 ref (covers 3..5), t6, t7, t8, t9, t10 (raw) = 8 entries + 50 hot
		expect(result).toHaveLength(58);
		expect((result[0] as ThoughtData).thought_number).toBe(1);
		expect((result[1] as ThoughtData).thought_number).toBe(2);
		expect(isRef(result[2])).toBe(true);
		expect((result[2] as SummaryRef).summaryId).toBe('S1');
		expect((result[3] as ThoughtData).thought_number).toBe(6);
		expect((result[7] as ThoughtData).thought_number).toBe(10);
		expect((result[8] as ThoughtData).thought_number).toBe(11);
	});

	it('does NOT mutate the input history array', () => {
		const history = makeHistory(60);
		const snapshot = history.slice();
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 10] }));
		policy.apply(history, SID, { keepLastK: 50 });
		expect(history).toEqual(snapshot);
		expect(history).toHaveLength(60);
	});

	it('does NOT mutate original thought objects', () => {
		const history = makeHistory(60);
		const original = { ...history[0]! };
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 10] }));
		policy.apply(history, SID, { keepLastK: 50 });
		expect(history[0]).toEqual(original);
	});

	it('ignores summaries from other sessions', () => {
		const history = makeHistory(60);
		store.add(makeSummary({ id: 'S-other', sessionId: 'other', coveredRange: [1, 10] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		// No summaries for SID → all 60 thoughts preserved
		expect(result).toHaveLength(60);
		expect(result.filter(isRef)).toHaveLength(0);
	});

	it('re-emits ref when same-summary thoughts are separated by an uncovered gap', () => {
		const history = makeHistory(60); // cold = 1..10
		// Summary covers 1..3 and 7..9 (we model two summaries to test re-emission)
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 3] }));
		store.add(makeSummary({ id: 'S2', coveredRange: [7, 9] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		// cold: S1, t4, t5, t6, S2, t10 = 6 entries + 50 hot
		expect(result).toHaveLength(56);
		expect(isRef(result[0])).toBe(true);
		expect((result[0] as SummaryRef).summaryId).toBe('S1');
		expect((result[1] as ThoughtData).thought_number).toBe(4);
		expect((result[3] as ThoughtData).thought_number).toBe(6);
		expect(isRef(result[4])).toBe(true);
		expect((result[4] as SummaryRef).summaryId).toBe('S2');
		expect((result[5] as ThoughtData).thought_number).toBe(10);
	});

	it('coveredRange in the emitted ref matches the source summary', () => {
		const history = makeHistory(60);
		store.add(makeSummary({ id: 'S1', coveredRange: [2, 8] }));
		const result = policy.apply(history, SID, { keepLastK: 50 });
		const ref = result.find(isRef) as SummaryRef;
		expect(ref.coveredRange).toEqual([2, 8]);
	});

	it('respects custom keepLastK smaller than default', () => {
		const history = makeHistory(20);
		store.add(makeSummary({ id: 'S1', coveredRange: [1, 5] }));
		const result = policy.apply(history, SID, { keepLastK: 10 });
		// cold = 1..10; S1 covers 1..5, then t6..t10 raw → 1 + 5 = 6, +10 hot = 16
		expect(result).toHaveLength(16);
		expect((result[0] as SummaryRef).summaryId).toBe('S1');
		expect((result[1] as ThoughtData).thought_number).toBe(6);
		expect((result[5] as ThoughtData).thought_number).toBe(10);
		expect((result[6] as ThoughtData).thought_number).toBe(11);
	});
});
