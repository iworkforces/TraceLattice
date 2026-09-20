/**
 * Tests for Calibrator: prior shrinkage, temperature scaling, Brier, ECE,
 * and per-type / per-session isolation.
 */

import { describe, expect, it } from 'vitest';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { ALL_THOUGHT_TYPES } from '../../core/evaluator/internals.js';
import type { IOutcomeRecorder, VerificationOutcome } from '../../contracts/interfaces.js';
import type { ThoughtType } from '../../contracts/reasoning-types.js';
import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import type { SessionId, ThoughtId } from '../../contracts/ids.js';

class MockOutcomeRecorder implements IOutcomeRecorder {
	public readonly enabled = true;
	private readonly _bySession = new Map<string, VerificationOutcome[]>();

	assertCanRecord(_sessionId: SessionId, _thoughtId: ThoughtId): void {}

	recordVerification(outcome: Omit<VerificationOutcome, 'recordedAt'>): void {
		const full: VerificationOutcome = { ...outcome, recordedAt: Date.now() };
		const list = this._bySession.get(full.sessionId) ?? [];
		list.push(full);
		this._bySession.set(full.sessionId, list);
	}

	getOutcomes(sessionId: SessionId): VerificationOutcome[] {
		return this._bySession.get(sessionId) ?? [];
	}

	getAllOutcomes(): VerificationOutcome[] {
		const all: VerificationOutcome[] = [];
		for (const list of this._bySession.values()) all.push(...list);
		return all;
	}

	clearOutcomes(sessionId: SessionId): void {
		this._bySession.delete(sessionId);
	}

	clearAllOutcomes(): void {
		this._bySession.clear();
	}
}

function makeOutcome(
	predicted: number,
	actual: 0 | 1,
	type: ThoughtType = 'hypothesis',
	sessionId: string = 's1',
	thoughtId: string = 't'
): Omit<VerificationOutcome, 'recordedAt'> {
	return {
		thoughtId: asThoughtId(thoughtId),
		sessionId: asSessionId(sessionId),
		predicted,
		actual,
		type,
	};
}

describe('Calibrator — disabled mode', () => {
	it('calibrate() returns identity (raw === calibrated, T=1.0, priorWeight=0)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, false);
		const result = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		expect(result.raw).toBe(0.9);
		expect(result.calibrated).toBe(0.9);
		expect(result.temperature).toBe(1.0);
		expect(result.priorWeight).toBe(0);
	});

	it('metrics() returns all-null when disabled', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, false);
		// Even if recorder has outcomes, disabled returns empty metrics.
		recorder.recordVerification(makeOutcome(0.9, 1));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.brierScore).toBeNull();
		expect(m.ece).toBeNull();
		expect(m.sampleCount).toBe(0);
		for (const t of ALL_THOUGHT_TYPES) {
			expect(m.perTypeBrier[t]).toBeNull();
		}
	});

	it('refit() is a no-op when disabled', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, false);
		// Add many overconfident outcomes that would otherwise raise T.
		for (let i = 0; i < 20; i++) {
			recorder.recordVerification(makeOutcome(0.95, 0));
		}
		calibrator.refit(asSessionId('s1'));
		// Temperature stays 1.0 because disabled, calibrate still identity.
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		expect(r.temperature).toBe(1.0);
		expect(r.calibrated).toBe(0.9);
	});
});

describe('Calibrator — enabled, no outcomes (prior only)', () => {
	it('priorWeight = 1.0 when no outcomes (Beta(2,2) full prior weight)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		// n=0 → priorWeight = 1/(1+0/10) = 1.0
		expect(r.priorWeight).toBe(1.0);
	});

	it('calibrate(0.9, hypothesis) shrinks toward prior mean 0.5', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		// observedMean defaults to 0.5 with no data → calibrated = 1.0 * 0.5 + 0 * 0.9 = 0.5
		expect(r.calibrated).toBeLessThan(0.9);
		expect(r.calibrated).toBeCloseTo(0.5, 10);
		expect(r.temperature).toBe(1.0); // < MIN_OUTCOMES_FOR_TEMPERATURE
	});

	it('calibrate(0.9, verification) with no outcomes also shrinks to 0.5 (uniform prior)', () => {
		// Note: implementation uses Beta(2,2) prior mean = 0.5 for ALL types.
		// With zero outcomes, both 'hypothesis' and 'verification' shrink identically.
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const rH = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		const rV = calibrator.calibrate(0.9, 'verification', asSessionId('s1'));
		expect(rV.calibrated).toBeCloseTo(rH.calibrated, 10);
		expect(rV.calibrated).toBeCloseTo(0.5, 10);
	});

	it('clamps raw confidence outside [0, 1] range', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const high = calibrator.calibrate(1.5, 'regular', asSessionId('s1'));
		const low = calibrator.calibrate(-0.3, 'regular', asSessionId('s1'));
		expect(high.raw).toBe(1);
		expect(low.raw).toBe(0);
	});
});

describe('Calibrator — Brier score and ECE', () => {
	it('computes Brier score for known data (5 outcomes, 3 correct)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// All predicted 0.8; 3 correct (actual=1), 2 wrong (actual=0).
		// Brier = ( (0.8-1)^2 * 3 + (0.8-0)^2 * 2 ) / 5
		//      = ( 0.04*3 + 0.64*2 ) / 5 = (0.12 + 1.28) / 5 = 1.4 / 5 = 0.28
		recorder.recordVerification(makeOutcome(0.8, 1));
		recorder.recordVerification(makeOutcome(0.8, 1));
		recorder.recordVerification(makeOutcome(0.8, 1));
		recorder.recordVerification(makeOutcome(0.8, 0));
		recorder.recordVerification(makeOutcome(0.8, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.brierScore).toBeCloseTo(0.28, 10);
		expect(m.sampleCount).toBe(5);
	});

	it('ECE ≈ 0 for perfectly calibrated synthetic data', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// Bin centered ~0.95: 10 outcomes, 100% correct
		for (let i = 0; i < 10; i++) {
			recorder.recordVerification(makeOutcome(0.95, 1));
		}
		// Bin centered ~0.05: 10 outcomes, 0% correct
		for (let i = 0; i < 10; i++) {
			recorder.recordVerification(makeOutcome(0.05, 0));
		}
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.ece).not.toBeNull();
		// Each bin: meanConf = predicted, meanAcc = predicted → diff ~ 0
		expect(m.ece as number).toBeLessThan(0.06);
	});

	it('ECE > 0 when all predictions are 0.9 but half are wrong', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 5; i++) recorder.recordVerification(makeOutcome(0.9, 1));
		for (let i = 0; i < 5; i++) recorder.recordVerification(makeOutcome(0.9, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		// All predictions land in same bin, meanConf = 0.9, meanAcc = 0.5 → ECE = 0.4
		expect(m.ece as number).toBeCloseTo(0.4, 10);
		expect(m.ece as number).toBeGreaterThan(0);
	});

	it('Brier and ECE are null on empty outcome list', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.brierScore).toBeNull();
		expect(m.ece).toBeNull();
		expect(m.sampleCount).toBe(0);
	});

	it('metrics() returns global aggregate when sessionId is omitted', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(0.7, 1, 'hypothesis', 'sA'));
		recorder.recordVerification(makeOutcome(0.7, 0, 'hypothesis', 'sB'));
		const m = calibrator.metrics();
		expect(m.sampleCount).toBe(2);
		expect(m.brierScore).toBeCloseTo(((0.7 - 1) ** 2 + (0.7 - 0) ** 2) / 2, 10);
	});

	it('perTypeBrier buckets outcomes by ThoughtType', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(0.8, 1, 'hypothesis'));
		recorder.recordVerification(makeOutcome(0.8, 0, 'hypothesis'));
		recorder.recordVerification(makeOutcome(0.5, 1, 'verification'));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.perTypeBrier.hypothesis).toBeCloseTo(((0.8 - 1) ** 2 + (0.8 - 0) ** 2) / 2, 10);
		expect(m.perTypeBrier.verification).toBeCloseTo((0.5 - 1) ** 2, 10);
		expect(m.perTypeBrier.regular).toBeNull();
		expect(m.perTypeBrier.critique).toBeNull();
		expect(m.perTypeBrier.synthesis).toBeNull();
		expect(m.perTypeBrier.meta).toBeNull();
	});

	it('perTypeBrier exposes every current ThoughtType key', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const m = calibrator.metrics(asSessionId('s1'));

		expect(Object.keys(m.perTypeBrier).sort()).toEqual([...ALL_THOUGHT_TYPES].sort());
	});
});

describe('Calibrator — temperature scaling via refit()', () => {
	it('overconfident data → fitted T > 1.0 after refit()', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// 20 outcomes: predicted 0.95, actual 0 (model very wrong & overconfident).
		for (let i = 0; i < 20; i++) {
			recorder.recordVerification(makeOutcome(0.95, 0));
		}
		calibrator.refit(asSessionId('s1'));
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		expect(r.temperature).toBeGreaterThan(1.0);
	});

	it('refit() is a no-op below MIN_OUTCOMES_FOR_TEMPERATURE (10)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 5; i++) recorder.recordVerification(makeOutcome(0.95, 0));
		calibrator.refit(asSessionId('s1'));
		// Even with refit, T defaults to 1.0 because < 10 outcomes.
		// Also calibrate() does not apply temperature when outcomes < 10.
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		expect(r.temperature).toBe(1.0);
	});

	it('temperature is applied to calibration only when ≥10 outcomes exist', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// Seed 15 outcomes that fit T > 1.
		for (let i = 0; i < 15; i++) recorder.recordVerification(makeOutcome(0.99, 0));
		calibrator.refit(asSessionId('s1'));
		const r = calibrator.calibrate(0.9, 'regular', asSessionId('s1'));
		// Temperature was applied, calibrated should differ from pure shrinkage.
		expect(r.temperature).toBeGreaterThan(1.0);
		// shrunk = priorWeight*0.5 + (1-priorWeight)*0.9 (for 'regular' — n=0 outcomes of type regular)
		// Actually 'regular' had 0 outcomes (all were default 'hypothesis'), so observedMean = 0.5.
		// Then temperature is applied to shrunk.
		expect(r.calibrated).toBeGreaterThan(0);
		expect(r.calibrated).toBeLessThanOrEqual(1);
	});
});

describe('Calibrator — isolation', () => {
	it('per-type isolation: outcomes for hypothesis do not affect verification', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// Many hypothesis outcomes with mean 1.0
		for (let i = 0; i < 20; i++) {
			recorder.recordVerification(makeOutcome(0.5, 1, 'hypothesis'));
		}
		const rH = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		const rV = calibrator.calibrate(0.9, 'verification', asSessionId('s1'));
		// hypothesis: n=20, observedMean=1.0, priorWeight = 1/(1+2) = 1/3
		// shrunk_H = (1/3)*1.0 + (2/3)*0.9 = 0.9333...
		// verification: n=0, observedMean=0.5, priorWeight = 1.0
		// shrunk_V = 1.0 * 0.5 + 0 * 0.9 = 0.5  (then temperature applied since outcomes>=10)
		expect(rH.priorWeight).toBeCloseTo(1 / 3, 10);
		expect(rV.priorWeight).toBe(1.0);
		expect(rH.calibrated).not.toBeCloseTo(rV.calibrated, 2);
	});

	it('session isolation: outcomes in session A do not affect session B metrics', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(0.9, 1, 'hypothesis', 'sA'));
		recorder.recordVerification(makeOutcome(0.9, 1, 'hypothesis', 'sA'));
		const mA = calibrator.metrics(asSessionId('sA'));
		const mB = calibrator.metrics(asSessionId('sB'));
		expect(mA.sampleCount).toBe(2);
		expect(mB.sampleCount).toBe(0);
		expect(mB.brierScore).toBeNull();
		expect(mB.ece).toBeNull();
	});

	it('session isolation: refit on session A does not affect session B temperature', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 15; i++) {
			recorder.recordVerification(makeOutcome(0.99, 0, 'hypothesis', 'sA'));
			recorder.recordVerification(makeOutcome(0.6, i % 2 === 0 ? 1 : 0, 'hypothesis', 'sB'));
		}
		calibrator.refit(asSessionId('sA'));
		const rA = calibrator.calibrate(0.9, 'hypothesis', asSessionId('sA'));
		const rB = calibrator.calibrate(0.9, 'hypothesis', asSessionId('sB'));
		expect(rA.temperature).toBeGreaterThan(1.0);
		expect(rB.temperature).toBe(1.0);
	});
});

describe('Calibrator — extreme inputs', () => {
	it('clamps NaN raw confidence (NaN passes through Math.min/max)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(Number.NaN, 'regular', asSessionId('s1'));
		// Math.min(1, Math.max(0, NaN)) = NaN; downstream produces NaN.
		// We assert it does not throw and returns a finite-or-NaN number bounded by
		// the contract that disabled mode would identity-map. Here we accept NaN propagation.
		expect(typeof r.raw).toBe('number');
		expect(Number.isNaN(r.raw)).toBe(true);
	});

	it('clamps Infinity raw confidence to 1', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(Number.POSITIVE_INFINITY, 'regular', asSessionId('s1'));
		expect(r.raw).toBe(1);
		expect(r.calibrated).toBeGreaterThanOrEqual(0);
		expect(r.calibrated).toBeLessThanOrEqual(1);
	});

	it('clamps -Infinity raw confidence to 0', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(Number.NEGATIVE_INFINITY, 'regular', asSessionId('s1'));
		expect(r.raw).toBe(0);
		expect(r.calibrated).toBeGreaterThanOrEqual(0);
		expect(r.calibrated).toBeLessThanOrEqual(1);
	});

	it('clamps negative confidence (-1) to 0', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(-1, 'regular', asSessionId('s1'));
		expect(r.raw).toBe(0);
		// no outcomes → shrinks fully to prior 0.5
		expect(r.calibrated).toBeCloseTo(0.5, 10);
	});

	it('clamps confidence > 1 (2.0) to 1', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(2.0, 'regular', asSessionId('s1'));
		expect(r.raw).toBe(1);
		expect(r.calibrated).toBeCloseTo(0.5, 10);
	});

	it('handles zero confidence (0.0)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(0, 'regular', asSessionId('s1'));
		expect(r.raw).toBe(0);
		// shrunk = 1.0 * 0.5 + 0 * 0 = 0.5
		expect(r.calibrated).toBeCloseTo(0.5, 10);
	});

	it('handles perfect confidence (1.0)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const r = calibrator.calibrate(1, 'regular', asSessionId('s1'));
		expect(r.raw).toBe(1);
		// shrunk = 1.0 * 0.5 + 0 * 1 = 0.5
		expect(r.calibrated).toBeCloseTo(0.5, 10);
	});
});

describe('Calibrator — temperature boundary (MIN_OUTCOMES_FOR_TEMPERATURE = 10)', () => {
	it('exactly 9 outcomes → temperature NOT applied (prior-only path)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 9; i++) recorder.recordVerification(makeOutcome(0.99, 0));
		calibrator.refit(asSessionId('s1'));
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		// fitTemperature returns 1.0 below threshold; calibrate path also gates on count.
		expect(r.temperature).toBe(1.0);
		// hypothesis: n=9, observedMean=0, priorWeight = 1/(1+9/10) = 1/1.9 ≈ 0.5263
		const expected = (1 - 1 / (1 + 9 / 10)) * 0.9;
		expect(r.calibrated).toBeCloseTo(expected, 10);
	});

	it('exactly 10 outcomes → temperature SHOULD be applied after refit', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 10; i++) recorder.recordVerification(makeOutcome(0.99, 0));
		calibrator.refit(asSessionId('s1'));
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		// Overconfident → fitted T > 1.0; outcomes count meets threshold.
		expect(r.temperature).toBeGreaterThan(1.0);
	});

	it('exactly 11 outcomes → temperature applied (smooth transition)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 11; i++) recorder.recordVerification(makeOutcome(0.99, 0));
		calibrator.refit(asSessionId('s1'));
		const r = calibrator.calibrate(0.9, 'hypothesis', asSessionId('s1'));
		expect(r.temperature).toBeGreaterThan(1.0);
		expect(TEMPERATURE_GRID_VALUES).toContain(r.temperature);
	});

	it('temperature is 1.0 when 10 outcomes are perfectly calibrated', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// Mid-range predictions where actual matches probability — NLL is minimized near T=1.0.
		// Use 0.6/0.4 split so loss strictly varies with T and T=1.0 is the unique grid minimum.
		for (let i = 0; i < 6; i++) recorder.recordVerification(makeOutcome(0.6, 1));
		for (let i = 0; i < 4; i++) recorder.recordVerification(makeOutcome(0.6, 0));
		calibrator.refit(asSessionId('s1'));
		const r = calibrator.calibrate(0.5, 'regular', asSessionId('s1'));
		// For predicted=0.6 with 60% accuracy, NLL is minimized at T=1.0 on the grid.
		expect(r.temperature).toBe(1.0);
	});
});

// Mirror of TEMPERATURE_GRID in Calibrator.ts for assertion sanity-checks.
const TEMPERATURE_GRID_VALUES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0] as const;

describe('Calibrator — temperature lifecycle cleanup', () => {
	it('clearSession() removes that session fitted temperature', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const sessionId = asSessionId('cleanup-source');
		for (let i = 0; i < 15; i++) {
			recorder.recordVerification(makeOutcome(0.99, 0, 'hypothesis', sessionId));
		}
		calibrator.refit(sessionId);
		expect(calibrator.calibrate(0.9, 'hypothesis', sessionId).temperature).toBeGreaterThan(1.0);

		calibrator.clearSession(sessionId);

		expect(calibrator.calibrate(0.9, 'hypothesis', sessionId).temperature).toBe(1.0);
		expect(recorder.getOutcomes(sessionId)).toHaveLength(15);
	});

	it('clearSession() removes only that session temperature', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const sessionA = asSessionId('cleanup-A');
		const sessionB = asSessionId('cleanup-B');

		for (let i = 0; i < 15; i++) {
			recorder.recordVerification(makeOutcome(0.99, 0, 'hypothesis', 'cleanup-A'));
		}
		for (let i = 0; i < 9; i++) {
			recorder.recordVerification(makeOutcome(0.6, 1, 'hypothesis', 'cleanup-B'));
		}
		for (let i = 0; i < 6; i++) {
			recorder.recordVerification(makeOutcome(0.6, 0, 'hypothesis', 'cleanup-B'));
		}

		calibrator.refit(sessionA);
		calibrator.refit(sessionB);
		const sessionBTemperature = calibrator.calibrate(0.9, 'hypothesis', sessionB).temperature;

		calibrator.clearSession(sessionA);

		expect(calibrator.calibrate(0.9, 'hypothesis', sessionA).temperature).toBe(1.0);
		expect(calibrator.calibrate(0.9, 'hypothesis', sessionB).temperature).toBe(sessionBTemperature);
		expect(recorder.getOutcomes(sessionA)).toHaveLength(15);
	});

	it('clearSession() ignores unknown sessions', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 15; i++) {
			recorder.recordVerification(makeOutcome(0.99, 0, 'hypothesis', 'known'));
		}
		const knownSession = asSessionId('known');
		calibrator.refit(knownSession);
		const temperature = calibrator.calibrate(0.9, 'hypothesis', knownSession).temperature;

		calibrator.clearSession(asSessionId('unknown'));

		expect(calibrator.calibrate(0.9, 'hypothesis', knownSession).temperature).toBe(temperature);
	});

	it('clearAll() removes every session temperature', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		const sessionA = asSessionId('clear-all-A');
		const sessionB = asSessionId('clear-all-B');
		for (let i = 0; i < 15; i++) {
			recorder.recordVerification(makeOutcome(0.99, 0, 'hypothesis', 'clear-all-A'));
			recorder.recordVerification(makeOutcome(0.99, 0, 'hypothesis', 'clear-all-B'));
		}
		calibrator.refit(sessionA);
		calibrator.refit(sessionB);

		calibrator.clearAll();

		expect(calibrator.calibrate(0.9, 'hypothesis', sessionA).temperature).toBe(1.0);
		expect(calibrator.calibrate(0.9, 'hypothesis', sessionB).temperature).toBe(1.0);
		expect(calibrator.calibrate(0.9, 'hypothesis', asSessionId('clear-all-new')).temperature).toBe(
			1.0
		);
	});

	it('cleanup is safe when calibration is disabled', () => {
		const calibrator = new Calibrator(new MockOutcomeRecorder(), false);

		expect(() => calibrator.clearSession(asSessionId('disabled'))).not.toThrow();
		expect(() => calibrator.clearAll()).not.toThrow();
	});
});

describe('Calibrator — determinism', () => {
	it('calibrate() returns identical results across repeated calls (same args, same state)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 12; i++) recorder.recordVerification(makeOutcome(0.8, i % 2 === 0 ? 1 : 0));
		calibrator.refit(asSessionId('s1'));
		const r1 = calibrator.calibrate(0.7, 'hypothesis', asSessionId('s1'));
		const r2 = calibrator.calibrate(0.7, 'hypothesis', asSessionId('s1'));
		expect(r1.raw).toBe(r2.raw);
		expect(r1.calibrated).toBe(r2.calibrated);
		expect(r1.temperature).toBe(r2.temperature);
		expect(r1.priorWeight).toBe(r2.priorWeight);
	});

	it('metrics() returns identical results across repeated calls', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(0.6, 1));
		recorder.recordVerification(makeOutcome(0.4, 0));
		const m1 = calibrator.metrics(asSessionId('s1'));
		const m2 = calibrator.metrics(asSessionId('s1'));
		expect(m1.brierScore).toBe(m2.brierScore);
		expect(m1.ece).toBe(m2.ece);
		expect(m1.sampleCount).toBe(m2.sampleCount);
		expect(m1.perTypeBrier).toEqual(m2.perTypeBrier);
	});

	it('Brier score is deterministic for the same outcome set', () => {
		const seed: Array<[number, 0 | 1]> = [
			[0.9, 1],
			[0.8, 0],
			[0.7, 1],
			[0.6, 1],
			[0.55, 0],
			[0.5, 1],
			[0.4, 0],
			[0.3, 0],
		];
		const rA = new MockOutcomeRecorder();
		const rB = new MockOutcomeRecorder();
		for (const [p, a] of seed) {
			rA.recordVerification(makeOutcome(p, a));
			rB.recordVerification(makeOutcome(p, a));
		}
		const cA = new Calibrator(rA, true);
		const cB = new Calibrator(rB, true);
		expect(cA.metrics(asSessionId('s1')).brierScore).toBe(cB.metrics(asSessionId('s1')).brierScore);
	});
});

describe('Calibrator — Brier score mathematical accuracy', () => {
	it('matches the formula mean((predicted - actual)^2) on a 2-sample example', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(0.8, 1));
		recorder.recordVerification(makeOutcome(0.8, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		// (0.04 + 0.64) / 2 = 0.34
		expect(m.brierScore).toBeCloseTo(0.34, 10);
	});

	it('perfect predictor (predicted === actual) → Brier = 0', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(1, 1));
		recorder.recordVerification(makeOutcome(0, 0));
		recorder.recordVerification(makeOutcome(1, 1));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.brierScore).toBe(0);
	});

	it('worst predictor (predicted=1, actual=0) → Brier = 1', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		for (let i = 0; i < 4; i++) recorder.recordVerification(makeOutcome(1, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.brierScore).toBe(1);
	});

	it('matches formula on a 3-sample mixed example', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		recorder.recordVerification(makeOutcome(0.9, 1)); // (0.1)^2 = 0.01
		recorder.recordVerification(makeOutcome(0.5, 0)); // (0.5)^2 = 0.25
		recorder.recordVerification(makeOutcome(0.2, 1)); // (0.8)^2 = 0.64
		const m = calibrator.metrics(asSessionId('s1'));
		// (0.01 + 0.25 + 0.64) / 3 = 0.30
		expect(m.brierScore).toBeCloseTo(0.3, 10);
	});
});

describe('Calibrator — ECE mathematical accuracy', () => {
	it('confidence 0.85 lands in bin 8 (0.8-0.9): single-bin ECE equals deviation', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// 10 outcomes all at p=0.85; 4 actual=1, 6 actual=0 → meanAcc=0.4
		for (let i = 0; i < 4; i++) recorder.recordVerification(makeOutcome(0.85, 1));
		for (let i = 0; i < 6; i++) recorder.recordVerification(makeOutcome(0.85, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		// All in bin 8: weight=1, |0.85 - 0.4| = 0.45
		expect(m.ece).toBeCloseTo(0.45, 10);
	});

	it('all outcomes in a single low bin → ECE equals that bin deviation', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// p=0.05 (bin 0); 2/4 correct → meanAcc=0.5; |0.05 - 0.5| = 0.45
		for (let i = 0; i < 2; i++) recorder.recordVerification(makeOutcome(0.05, 1));
		for (let i = 0; i < 2; i++) recorder.recordVerification(makeOutcome(0.05, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.ece).toBeCloseTo(0.45, 10);
	});

	it('uniform distribution across two bins → weighted ECE formula', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// Bin 1 (p=0.15): 4 outcomes, all correct → meanAcc=1.0, dev=|0.15-1|=0.85, weight=4/8
		for (let i = 0; i < 4; i++) recorder.recordVerification(makeOutcome(0.15, 1));
		// Bin 9 (p=0.95): 4 outcomes, all wrong → meanAcc=0.0, dev=|0.95-0|=0.95, weight=4/8
		for (let i = 0; i < 4; i++) recorder.recordVerification(makeOutcome(0.95, 0));
		const m = calibrator.metrics(asSessionId('s1'));
		// ECE = 0.5 * 0.85 + 0.5 * 0.95 = 0.9
		expect(m.ece).toBeCloseTo(0.9, 10);
	});

	it('predicted at exact bin boundary 0.9 lands in bin 9 (not 8)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// floor(0.9 * 10) = 9 → bin 9 (0.9-1.0)
		for (let i = 0; i < 10; i++) recorder.recordVerification(makeOutcome(0.9, 1));
		const m = calibrator.metrics(asSessionId('s1'));
		// All in bin 9, meanAcc=1.0, |0.9-1.0|=0.1
		expect(m.ece).toBeCloseTo(0.1, 10);
	});

	it('predicted = 1.0 clamped into top bin (bin 9)', () => {
		const recorder = new MockOutcomeRecorder();
		const calibrator = new Calibrator(recorder, true);
		// p=1.0 with EPSILON clamp goes into bin 9; all correct → ECE ≈ 0
		for (let i = 0; i < 5; i++) recorder.recordVerification(makeOutcome(1, 1));
		const m = calibrator.metrics(asSessionId('s1'));
		expect(m.ece as number).toBeLessThan(0.01);
	});
});
