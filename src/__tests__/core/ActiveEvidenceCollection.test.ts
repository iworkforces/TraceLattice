import { describe, expect, it } from 'vitest';
import { collectActiveEvidence } from '../../core/evaluator/VerificationLinks.js';
import { createTestThought } from '../helpers/factories.js';

describe('active evidence collection', () => {
	it.each([10, 50, 200])('visits each of %i retained records once', (size) => {
		let visits = 0;
		const history = Array.from({ length: size }, (_, index) =>
			Object.defineProperty(createTestThought({ id: `h${index}` }), 'retracted', {
				get: () => {
					visits++;
					return false;
				},
			})
		);

		const active = collectActiveEvidence(history, { duplicate: history });

		expect(visits).toBe(size * 2);
		expect(active.mainCount).toBe(size);
		expect(active.thoughts).toEqual(history);
	});

	it('preserves first live objects and id-less main entries while any retracted copy wins', () => {
		const first = createTestThought({ id: 'first', thought: 'main original' });
		const idless = createTestThought();
		const lateRetraction = createTestThought({ id: 'late' });
		const branchOnly = createTestThought({ id: 'branch-only' });
		const lastBranch = createTestThought({ id: 'last-branch' });

		const active = collectActiveEvidence(
			[
				first,
				idless,
				idless,
				lateRetraction,
				createTestThought({ id: 'early', retracted: true }),
				createTestThought({ id: 'early' }),
				createTestThought({ id: 'first', thought: 'duplicate' }),
			],
			{
				z: [
					createTestThought(),
					createTestThought({ id: 'first', thought: 'branch duplicate' }),
					branchOnly,
					createTestThought({ id: 'late', retracted: true }),
				],
				a: [createTestThought({ id: 'early' }), lastBranch],
			}
		);

		expect(active.mainCount).toBe(3);
		expect(active.thoughts).toEqual([first, idless, idless, branchOnly, lastBranch]);
		expect(active.thoughts[0]).toBe(first);
		expect(active.thoughts[3]).toBe(branchOnly);
	});
});
