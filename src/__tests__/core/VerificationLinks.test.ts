import { describe, expect, it } from 'vitest';

import { asBranchId, asThoughtId } from '../../contracts/ids.js';
import { Aggregator } from '../../core/evaluator/Aggregator.js';
import { PatternDetector } from '../../core/evaluator/PatternDetector.js';
import { SignalComputer } from '../../core/evaluator/SignalComputer.js';
import { resolveVerificationLinks } from '../../core/evaluator/VerificationLinks.js';
import { createTestThought } from '../helpers/factories.js';

describe('VerificationLinks', () => {
	it('excludes the receipt id-less hypothesis and verifier legacy pair from canonical links', () => {
		// Given: direct IHistoryManager-compatible thoughts with no stable identities.
		const idlessHypothesis = createTestThought({
			thought_type: 'hypothesis',
			hypothesis_id: 'idless-receipt-label',
		});
		const idlessVerifier = createTestThought({
			thought_type: 'verification',
			hypothesis_id: 'idless-receipt-label',
		});

		// When: canonical verification links resolve the retained history.
		const links = resolveVerificationLinks([idlessHypothesis, idlessVerifier], {});

		// Then: no unrepresentable relation contributes to canonical state.
		expect(links.hypotheses).toEqual([]);
		expect(links.hypothesisIds).toEqual(new Set());
		expect(links.verifiedHypothesisIds).toEqual(new Set());
		expect(links.verifiedHypothesisCount).toBe(0);
	});

	it('retains only identity-bearing legacy pairs when missing or empty identities share labels', () => {
		// Given: all id-less permutations plus one valid pair with colliding labels.
		const validHypothesis = createTestThought({
			id: 'valid-hypothesis',
			thought_type: 'hypothesis',
			hypothesis_id: 'shared-label',
		});
		const idlessDuplicate = createTestThought({
			thought_type: 'hypothesis',
			hypothesis_id: 'shared-label',
		});
		const emptyIdDuplicate = createTestThought({
			id: '',
			thought_type: 'hypothesis',
			hypothesis_id: 'shared-label',
		});
		const validVerifier = createTestThought({
			id: 'valid-verifier',
			thought_type: 'verification',
			hypothesis_id: 'shared-label',
		});
		const idlessHypothesis = createTestThought({
			thought_type: 'hypothesis',
			hypothesis_id: 'idless-target',
		});
		const identityVerifier = createTestThought({
			id: 'identity-verifier',
			thought_type: 'verification',
			hypothesis_id: 'idless-target',
		});
		const identityHypothesis = createTestThought({
			id: 'identity-hypothesis',
			thought_type: 'hypothesis',
			hypothesis_id: 'idless-verifier',
		});
		const idlessVerifier = createTestThought({
			thought_type: 'verification',
			hypothesis_id: 'idless-verifier',
		});
		const emptyIdVerifier = createTestThought({
			id: '',
			thought_type: 'verification',
			hypothesis_id: 'idless-verifier',
		});

		// When: legacy resolution runs over mixed identity-bearing and id-less input.
		const links = resolveVerificationLinks(
			[
				validHypothesis,
				idlessDuplicate,
				emptyIdDuplicate,
				validVerifier,
				idlessHypothesis,
				identityVerifier,
				identityHypothesis,
				idlessVerifier,
				emptyIdVerifier,
			],
			{}
		);

		// Then: only the valid pair exists; invalid duplicates cannot make it ambiguous.
		expect(links.hypothesisIds).toEqual(
			new Set([asThoughtId('valid-hypothesis'), asThoughtId('identity-hypothesis')])
		);
		expect(links.verifiedHypothesisIds).toEqual(new Set([asThoughtId('valid-hypothesis')]));
		expect(links.targetFor(asThoughtId('valid-verifier'))).toBe(asThoughtId('valid-hypothesis'));
		expect(links.targetFor(asThoughtId('identity-verifier'))).toBeUndefined();
		expect(links.verifiedHypothesisCount).toBe(1);
	});

	it('keeps id-less legacy pairs out of coverage, stats, and target-specific patterns', () => {
		// Given: an id-less verifier beside an unverified stable hypothesis and an id-less duplicate.
		const unverifiedStable = createTestThought({
			id: 'unverified-stable',
			thought_number: 1,
			thought_type: 'hypothesis',
			hypothesis_id: 'unverified-stable',
		});
		const idlessVerifier = createTestThought({
			thought_number: 2,
			thought_type: 'verification',
			hypothesis_id: 'unverified-stable',
		});
		const healthyStable = createTestThought({
			id: 'healthy-stable',
			thought_number: 5,
			thought_type: 'hypothesis',
			hypothesis_id: 'healthy-stable',
		});
		const idlessDuplicate = createTestThought({
			thought_number: 6,
			thought_type: 'hypothesis',
			hypothesis_id: 'healthy-stable',
		});
		const healthyVerifier = createTestThought({
			id: 'healthy-verifier',
			thought_number: 7,
			thought_type: 'verification',
			hypothesis_id: 'healthy-stable',
		});
		const history = [
			unverifiedStable,
			idlessVerifier,
			createTestThought({ thought_number: 3 }),
			createTestThought({ thought_number: 4 }),
			healthyStable,
			idlessDuplicate,
			healthyVerifier,
			createTestThought({ thought_number: 8 }),
			createTestThought({ thought_number: 9 }),
		];
		const links = resolveVerificationLinks(history, {});

		// When: all evaluator consumers use the canonical links.
		const signals = new SignalComputer().computeConfidenceSignals(history, {}, links);
		const stats = new Aggregator().computeReasoningStats(history, {}, links);
		const patterns = new PatternDetector().computePatternSignals(history, {}, links);

		// Then: invalid entries neither change canonical counts nor suppress or create target patterns.
		expect(signals.quality_components_raw?.verification_coverage).toBe(0.5);
		expect(stats).toMatchObject({
			hypothesis_count: 2,
			verified_hypothesis_count: 1,
			unresolved_hypothesis_count: 1,
		});
		expect(
			patterns.some(
				(pattern) => pattern.pattern === 'unverified_hypothesis' && pattern.thought_range[0] === 1
			)
		).toBe(true);
		expect(
			patterns.some(
				(pattern) => pattern.pattern === 'unverified_hypothesis' && pattern.thought_range[0] === 6
			)
		).toBe(false);
		expect(
			patterns.some(
				(pattern) => pattern.pattern === 'healthy_verification' && pattern.thought_range[0] === 5
			)
		).toBe(true);
	});

	it('uses the admission-resolved stable target instead of conflicting labels or later duplicate numbers', () => {
		const target = createTestThought({
			id: asThoughtId('target'),
			thought_number: 1,
			thought_type: 'hypothesis',
			hypothesis_id: 'target-label',
		});
		const duplicateNumber = createTestThought({
			id: asThoughtId('duplicate-number'),
			thought_number: 1,
			thought_type: 'hypothesis',
			hypothesis_id: 'conflicting-label',
		});
		const verifier = createTestThought({
			id: asThoughtId('verifier'),
			thought_number: 2,
			thought_type: 'verification',
			verification_target: 1,
			hypothesis_id: 'conflicting-label',
		});

		const links = resolveVerificationLinks(
			[target, duplicateNumber, verifier],
			{},
			new Map([[asThoughtId('verifier'), asThoughtId('target')]])
		);

		expect(links.hypothesisIds).toEqual(
			new Set([asThoughtId('target'), asThoughtId('duplicate-number')])
		);
		expect(links.verifiedHypothesisIds).toEqual(new Set([asThoughtId('target')]));
		expect(links.targetFor(asThoughtId('verifier'))).toBe(asThoughtId('target'));
	});

	it('falls back to a legacy hypothesis_id only when exactly one active hypothesis has it', () => {
		const unique = createTestThought({
			id: asThoughtId('unique'),
			thought_type: 'hypothesis',
			hypothesis_id: 'unique-label',
		});
		const duplicateA = createTestThought({
			id: asThoughtId('duplicate-a'),
			thought_type: 'hypothesis',
			hypothesis_id: 'duplicate-label',
		});
		const duplicateB = createTestThought({
			id: asThoughtId('duplicate-b'),
			thought_type: 'hypothesis',
			hypothesis_id: 'duplicate-label',
		});
		const legacyUnique = createTestThought({
			id: asThoughtId('legacy-unique'),
			thought_type: 'verification',
			hypothesis_id: 'unique-label',
		});
		const legacyAmbiguous = createTestThought({
			id: asThoughtId('legacy-ambiguous'),
			thought_type: 'verification',
			hypothesis_id: 'duplicate-label',
		});
		const explicitWithoutAdmissionTarget = createTestThought({
			id: asThoughtId('explicit-without-admission-target'),
			thought_type: 'verification',
			verification_target: 1,
			hypothesis_id: 'unique-label',
		});

		const links = resolveVerificationLinks(
			[
				unique,
				duplicateA,
				duplicateB,
				legacyUnique,
				legacyAmbiguous,
				explicitWithoutAdmissionTarget,
			],
			{}
		);

		expect(links.targetFor(asThoughtId('legacy-unique'))).toBe(asThoughtId('unique'));
		expect(links.targetFor(asThoughtId('legacy-ambiguous'))).toBeUndefined();
		expect(links.targetFor(asThoughtId('explicit-without-admission-target'))).toBeUndefined();
		expect(links.verifiedHypothesisIds).toEqual(new Set([asThoughtId('unique')]));
	});

	it('deduplicates branch copies, supports branch-only targets, and excludes every retracted copy', () => {
		const branchOnly = createTestThought({
			id: asThoughtId('branch-only'),
			thought_number: 7,
			thought_type: 'hypothesis',
			branch_id: asBranchId('retained'),
		});
		const branchCopy = { ...branchOnly };
		const verifier = createTestThought({
			id: asThoughtId('branch-verifier'),
			thought_number: 8,
			thought_type: 'verification',
			verification_target: 7,
		});
		const retractedCopy = { ...branchOnly, retracted: true };
		const retractedVerifier = { ...verifier, retracted: true };

		const active = resolveVerificationLinks(
			[branchCopy, verifier],
			{ retained: [branchOnly] },
			new Map([[asThoughtId('branch-verifier'), asThoughtId('branch-only')]])
		);
		const retracted = resolveVerificationLinks(
			[retractedCopy, retractedVerifier],
			{ retained: [branchOnly] },
			new Map([[asThoughtId('branch-verifier'), asThoughtId('branch-only')]])
		);

		expect(active.thoughts.map((thought) => thought.id)).toEqual([
			asThoughtId('branch-only'),
			asThoughtId('branch-verifier'),
		]);
		expect(active.verifiedHypothesisIds).toEqual(new Set([asThoughtId('branch-only')]));
		expect(retracted.thoughts.map((thought) => thought.id)).toEqual([]);
		expect(retracted.verifiedHypothesisIds).toEqual(new Set());
		const repeated = resolveVerificationLinks(
			[branchCopy, verifier],
			{ retained: [branchOnly] },
			new Map([[asThoughtId('branch-verifier'), asThoughtId('branch-only')]])
		);
		expect(repeated.thoughts.map((thought) => thought.id)).toEqual(
			active.thoughts.map((thought) => thought.id)
		);
		expect(repeated.verifiedHypothesisIds).toEqual(active.verifiedHypothesisIds);
	});
});
