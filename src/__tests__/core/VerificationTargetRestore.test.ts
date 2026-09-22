import { afterEach, describe, expect, it } from 'vitest';

import { asBranchId, asSessionId, asThoughtId } from '../../contracts/ids.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { reconstructVerificationTargets } from '../../core/VerificationTargetRestore.js';
import { resolveVerificationLinks } from '../../core/evaluator/VerificationLinks.js';
import { MemoryPersistence } from '../../persistence/MemoryPersistence.js';
import { createTestThought } from '../helpers/factories.js';

const managers = new Set<HistoryManager>();
const sessionId = asSessionId('verification-target-restore');

function manager(persistence: MemoryPersistence, maxHistorySize = 100): HistoryManager {
	const value = new HistoryManager({
		persistence,
		maxHistorySize,
		persistenceFlushInterval: 60_000,
	});
	managers.add(value);
	return value;
}

afterEach(async () => {
	for (const value of managers) await value.shutdown();
	managers.clear();
});

describe('verification target restoration', () => {
	it('keeps an explicit target stable when a later duplicate number is restored', () => {
		// Given
		const history = [
			createTestThought({
				id: 'target',
				session_id: sessionId,
				thought_number: 1,
				thought_type: 'hypothesis',
			}),
			createTestThought({
				id: 'verifier',
				session_id: sessionId,
				thought_number: 2,
				thought_type: 'verification',
				verification_target: 1,
			}),
			createTestThought({
				id: 'later-duplicate',
				session_id: sessionId,
				thought_number: 1,
				thought_type: 'hypothesis',
			}),
		];

		// When
		const targets = reconstructVerificationTargets(sessionId, history, []);

		// Then
		expect(targets).toEqual(new Map([[asThoughtId('verifier'), asThoughtId('target')]]));
	});

	it('omits missing, ambiguous, and id-less explicit verifiers', () => {
		// Given
		const history = [
			createTestThought({ id: 'first', session_id: sessionId, thought_number: 1 }),
			createTestThought({ id: 'second', session_id: sessionId, thought_number: 1 }),
			createTestThought({
				id: 'ambiguous-verifier',
				session_id: sessionId,
				thought_number: 2,
				thought_type: 'verification',
				verification_target: 1,
			}),
			createTestThought({
				id: 'missing-verifier',
				session_id: sessionId,
				thought_number: 3,
				thought_type: 'verification',
				verification_target: 9,
			}),
			createTestThought({
				session_id: sessionId,
				thought_number: 4,
				thought_type: 'verification',
				verification_target: 1,
			}),
		];

		// When
		const targets = reconstructVerificationTargets(sessionId, history, []);

		// Then
		expect(targets).toEqual(new Map());
	});

	it('keeps unique legacy labels available without falling back from explicit targets', () => {
		// Given
		const hypothesis = createTestThought({
			id: 'legacy-target',
			session_id: sessionId,
			thought_number: 1,
			thought_type: 'hypothesis',
			hypothesis_id: 'unique-label',
		});
		const explicit = createTestThought({
			id: 'explicit-missing',
			session_id: sessionId,
			thought_number: 2,
			thought_type: 'verification',
			verification_target: 9,
			hypothesis_id: 'unique-label',
		});
		const legacy = createTestThought({
			id: 'legacy-verifier',
			session_id: sessionId,
			thought_number: 3,
			thought_type: 'verification',
			hypothesis_id: 'unique-label',
		});

		// When
		const targets = reconstructVerificationTargets(sessionId, [hypothesis, explicit, legacy], []);
		const links = resolveVerificationLinks([hypothesis, explicit, legacy], {}, targets);

		// Then
		expect(links.targetFor(asThoughtId('explicit-missing'))).toBeUndefined();
		expect(links.targetFor(asThoughtId('legacy-verifier'))).toBe(asThoughtId('legacy-target'));
	});

	it('preserves a branch-only retained target after restore trimming without leaking snapshots', async () => {
		// Given
		const persistence = new MemoryPersistence();
		const branchId = asBranchId('retained-target');
		const target = createTestThought({
			id: 'branch-target',
			session_id: sessionId,
			thought_number: 1,
			thought_type: 'hypothesis',
			branch_id: branchId,
		});
		const verifier = createTestThought({
			id: 'branch-verifier',
			session_id: sessionId,
			thought_number: 2,
			thought_type: 'verification',
			verification_target: 1,
		});
		await persistence.saveThoughtForSession(sessionId, target);
		await persistence.saveThoughtForSession(sessionId, verifier);
		await persistence.saveBranchForSession(sessionId, branchId, [target]);
		const history = manager(persistence, 1);

		// When
		await history.loadFromPersistence();
		const snapshot = history.inspectSession(sessionId);
		const nextSnapshot = history.inspectSession(sessionId);
		const links = resolveVerificationLinks(
			history.getHistory(sessionId),
			history.getBranches(sessionId),
			nextSnapshot.verificationTargets
		);

		// Then
		expect(history.getHistory(sessionId).map((thought) => thought.id)).toEqual(['branch-verifier']);
		expect(history.getBranches(sessionId)[branchId]?.map((thought) => thought.id)).toEqual([
			'branch-target',
		]);
		expect(snapshot.verificationTargets).not.toBe(nextSnapshot.verificationTargets);
		expect(links.targetFor(asThoughtId('branch-verifier'))).toBe(asThoughtId('branch-target'));
		expect(links.verifiedHypothesisIds).toEqual(new Set([asThoughtId('branch-target')]));
	});
});
