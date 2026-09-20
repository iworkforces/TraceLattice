/**
 * Tests for OutcomeRecorder no-op and recording behavior.
 */

import { describe, expect, it } from 'vitest';
import { OutcomeRecorder } from '../../../core/reasoning/OutcomeRecorder.js';

import { asSessionId, asThoughtId } from '../../../contracts/ids.js';
import type { VerificationOutcome } from '../../../contracts/interfaces.js';
import { ValidationError } from '../../../errors.js';

function makeOutcome(
	overrides: Partial<Omit<VerificationOutcome, 'recordedAt' | 'sessionId' | 'thoughtId'>> & {
		sessionId?: string;
		thoughtId?: string;
	} = {}
): Omit<VerificationOutcome, 'recordedAt'> {
	const { sessionId, thoughtId, ...rest } = overrides;
	return {
		thoughtId: asThoughtId(thoughtId ?? 't1'),
		sessionId: asSessionId(sessionId ?? 'session-a'),
		predicted: 0.8,
		actual: 1,
		type: 'verification' as const,
		...rest,
	};
}

describe('OutcomeRecorder', () => {
	it('returns empty outcomes when disabled', () => {
		const recorder = new OutcomeRecorder({ enabled: false });
		expect(recorder.getOutcomes(asSessionId('session-a'))).toEqual([]);
	});

	it('recordVerification is no-op when disabled', () => {
		const recorder = new OutcomeRecorder({ enabled: false });
		recorder.assertCanRecord(asSessionId('session-a'), asThoughtId('t1'));
		recorder.recordVerification(makeOutcome());
		recorder.recordVerification(makeOutcome());
		expect(recorder.getOutcomes(asSessionId('session-a'))).toEqual([]);
		expect(recorder.getAllOutcomes()).toEqual([]);
	});

	it('allows duplicate preflight without reserving the target', () => {
		const recorder = new OutcomeRecorder({ enabled: true });

		recorder.assertCanRecord(asSessionId('session-a'), asThoughtId('t1'));
		recorder.assertCanRecord(asSessionId('session-a'), asThoughtId('t1'));

		expect(recorder.getOutcomes(asSessionId('session-a'))).toEqual([]);
	});

	it('rejects duplicate target during preflight after recording', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome());

		expect(() =>
			recorder.assertCanRecord(asSessionId('session-a'), asThoughtId('t1'))
		).toThrowError(ValidationError);
	});

	it('defensively rejects duplicate target during recording', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome());

		expect(() => recorder.recordVerification(makeOutcome())).toThrowError(ValidationError);
		expect(recorder.getOutcomes(asSessionId('session-a'))).toHaveLength(1);
	});

	it('permits the same target id in a different session', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome({ sessionId: 'A', thoughtId: 'target' }));

		expect(() =>
			recorder.recordVerification(makeOutcome({ sessionId: 'B', thoughtId: 'target' }))
		).not.toThrow();
	});

	it('permits distinct canonical target ids', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome({ thoughtId: 'target-a' }));

		expect(() => recorder.recordVerification(makeOutcome({ thoughtId: 'target-b' }))).not.toThrow();
	});

	it('records outcome when enabled', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome());
		const outcomes = recorder.getOutcomes(asSessionId('session-a'));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			thoughtId: 't1',
			sessionId: 'session-a',
			predicted: 0.8,
			actual: 1,
			type: 'verification',
		});
	});

	it('auto-sets recordedAt timestamp', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		const before = Date.now();
		recorder.recordVerification(makeOutcome());
		const outcomes = recorder.getOutcomes(asSessionId('session-a'));
		expect(outcomes[0]?.recordedAt).toBeGreaterThanOrEqual(before);
		expect(outcomes[0]?.recordedAt).toBeLessThanOrEqual(Date.now());
	});

	it('scopes outcomes per session', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome({ sessionId: 'A', thoughtId: 'a1' }));
		recorder.recordVerification(makeOutcome({ sessionId: 'B', thoughtId: 'b1' }));
		recorder.recordVerification(makeOutcome({ sessionId: 'A', thoughtId: 'a2' }));

		const aOutcomes = recorder.getOutcomes(asSessionId('A'));
		expect(aOutcomes).toHaveLength(2);
		expect(aOutcomes.map((o) => o.thoughtId)).toEqual(['a1', 'a2']);
		expect(recorder.getOutcomes(asSessionId('B'))).toHaveLength(1);
	});

	it('getAllOutcomes returns from all sessions', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome({ sessionId: 'A' }));
		recorder.recordVerification(makeOutcome({ sessionId: 'B' }));
		expect(recorder.getAllOutcomes()).toHaveLength(2);
	});

	it('returns copies that cannot mutate recorded outcomes', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome());
		const outcomes = recorder.getOutcomes(asSessionId('session-a'));
		const first = outcomes[0];
		if (first) first.actual = 0;
		outcomes.length = 0;

		expect(recorder.getOutcomes(asSessionId('session-a'))).toMatchObject([{ actual: 1 }]);
	});

	it('clearOutcomes removes only target session', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome({ sessionId: 'A' }));
		recorder.recordVerification(makeOutcome({ sessionId: 'B' }));
		recorder.clearOutcomes(asSessionId('A'));
		expect(recorder.getOutcomes(asSessionId('A'))).toEqual([]);
		expect(recorder.getOutcomes(asSessionId('B'))).toHaveLength(1);
	});

	it('clearAllOutcomes removes every target identity', () => {
		const recorder = new OutcomeRecorder({ enabled: true });
		recorder.recordVerification(makeOutcome({ sessionId: 'A', thoughtId: 'target' }));
		recorder.recordVerification(makeOutcome({ sessionId: 'B', thoughtId: 'target' }));

		recorder.clearAllOutcomes();

		expect(recorder.getAllOutcomes()).toEqual([]);
		expect(() =>
			recorder.recordVerification(makeOutcome({ sessionId: 'A', thoughtId: 'target' }))
		).not.toThrow();
	});

	it('enabled property reflects config', () => {
		expect(new OutcomeRecorder({ enabled: true }).enabled).toBe(true);
		expect(new OutcomeRecorder({ enabled: false }).enabled).toBe(false);
	});
});
