/**
 * Classification of thought purpose — enables type-specific formatting, evaluation, and analytics.
 *
 * @example
 * ```typescript
 * const thoughtType: ThoughtType = 'hypothesis';
 *
 * // Use in conditional formatting
 * if (thoughtType === 'verification') {
 *   console.log('Verifying a hypothesis...');
 * }
 * ```
 */
export type ThoughtType =
	| 'regular' // Standard analytical step (default)
	| 'hypothesis' // Proposed explanation/solution candidate
	| 'verification' // Testing a hypothesis against evidence
	| 'critique' // Self-critique of reasoning (Reflexion pattern)
	| 'synthesis' // Combining multiple thoughts/branches (GoT merge)
	| 'meta' // Metacognitive observation about the reasoning process itself
	| 'tool_call' // Invocation of an external tool
	| 'tool_observation' // Observation of a tool's result
	| 'assumption' // Explicitly stated assumption
	| 'decomposition' // Breaking a problem into sub-problems
	| 'backtrack'; // Backtracking from a prior thought

/**
 * Machine-readable names for the 8 detected reasoning patterns.
 *
 * Each name corresponds to a detector in PatternDetector or GraphPatterns.
 */
export type PatternName =
	| 'consecutive_without_verification'
	| 'unverified_hypothesis'
	| 'monotonic_type'
	| 'no_alternatives_explored'
	| 'confidence_drift'
	| 'healthy_verification'
	| 'refuted_hypothesis_dependency'
	| 'unaddressed_critique';
