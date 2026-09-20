/**
 * Shared internal helpers for evaluator submodules.
 *
 * Pure utility functions used by SignalComputer (and future evaluator
 * components such as StatsComputer / PatternDetector). All helpers are
 * stateless and have no side effects.
 *
 * @module core/evaluator/internals
 */

import type { ThoughtType } from '../../contracts/reasoning-types.js';
import type { ThoughtData } from '../thought.js';

/** All valid thought types for distribution counting. */
export const ALL_THOUGHT_TYPES: ThoughtType[] = [
	'regular',
	'hypothesis',
	'verification',
	'critique',
	'synthesis',
	'meta',
	'tool_call',
	'tool_observation',
	'assumption',
	'decomposition',
	'backtrack',
];

/**
 * Count thoughts in `history` grouped by {@link ThoughtType}.
 *
 * Thoughts without an explicit `thought_type` are counted as `'regular'`.
 *
 * @param history - Thoughts to count
 * @returns Record mapping each ThoughtType to its occurrence count
 */
export function _countByType(history: ThoughtData[]): Record<ThoughtType, number> {
	const counts = Object.fromEntries(ALL_THOUGHT_TYPES.map((t) => [t, 0])) as Record<
		ThoughtType,
		number
	>;

	for (const thought of history) {
		const type = thought.thought_type ?? 'regular';
		if (type in counts) {
			counts[type]++;
		}
	}

	return counts;
}

/**
 * Compute the longest contiguous chain depth (sequence of thoughts without branching).
 *
 * A new chain starts whenever a thought has `branch_from_thought` set.
 *
 * @param history - Thoughts in chronological order
 * @returns Length of the longest non-branching chain (0 for empty history)
 */
export function _computeChainDepth(history: ThoughtData[]): number {
	if (history.length === 0) return 0;
	let maxDepth = 1;
	let currentDepth = 1;

	for (let i = 1; i < history.length; i++) {
		const thought = history[i]!;
		if (!thought.branch_from_thought) {
			currentDepth++;
			maxDepth = Math.max(maxDepth, currentDepth);
		} else {
			currentDepth = 1;
		}
	}

	return maxDepth;
}
