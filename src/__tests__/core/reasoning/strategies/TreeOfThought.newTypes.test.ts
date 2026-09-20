import { describe, it, expect } from 'vitest';
import { scoreThought } from '../../../../core/reasoning/strategies/totScoring.js';
import type { ThoughtData } from '../../../../core/thought.js';
import type { ThoughtType } from '../../../../contracts/reasoning-types.js';
import { asSessionId } from '../../../../contracts/ids.js';

const TREE_SESSION = asSessionId('tree-new-types-session');

function thoughtOf(
	type: ThoughtType | undefined,
	overrides: Partial<ThoughtData> = {}
): ThoughtData {
	return {
		session_id: TREE_SESSION,
		thought: 't',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		thought_type: type,
		confidence: 1,
		quality_score: 1,
		...overrides,
	};
}

describe('scoreThought — per-type weights for new thought types', () => {
	it('assumption applies a 0.5 weight (low confidence until verified)', () => {
		// confidence=1, quality=1, weight=0.5 → raw=0.5, clamped to 0.5
		expect(scoreThought(thoughtOf('assumption'))).toBeCloseTo(0.5, 10);
	});

	it('decomposition applies a 1.2 weight, clamped to the [0, 1] range', () => {
		// confidence=1, quality=1, weight=1.2 → raw=1.2, clamped to 1.0
		expect(scoreThought(thoughtOf('decomposition'))).toBe(1);
	});

	it('decomposition with sub-maximal inputs reflects the 1.2 boost without clamping', () => {
		// confidence=0.5, quality=0.5, weight=1.2 → 0.3
		const score = scoreThought(thoughtOf('decomposition', { confidence: 0.5, quality_score: 0.5 }));
		expect(score).toBeCloseTo(0.3, 10);
	});

	it('backtrack applies a 0.8 weight', () => {
		// confidence=1, quality=1, weight=0.8 → 0.8
		expect(scoreThought(thoughtOf('backtrack'))).toBeCloseTo(0.8, 10);
	});

	it('tool_call applies a neutral 1.0 weight', () => {
		expect(scoreThought(thoughtOf('tool_call'))).toBe(1);
	});

	it('tool_observation applies a neutral 1.0 weight', () => {
		expect(scoreThought(thoughtOf('tool_observation'))).toBe(1);
	});

	it('unknown / regular thought types fall back to a 1.0 weight', () => {
		expect(scoreThought(thoughtOf('regular'))).toBe(1);
		expect(scoreThought(thoughtOf(undefined))).toBe(1);
	});

	it('clamps negative scores to 0 and respects the assumption weight ordering', () => {
		// quality_score defaults to 0.5 when undefined; confidence default 0
		const noConfidence = scoreThought(
			thoughtOf('assumption', { confidence: undefined, quality_score: undefined })
		);
		expect(noConfidence).toBe(0);
	});
});
