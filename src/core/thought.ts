/**
 * Core data structure for a thought in the sequential thinking process.
 *
 * @module types/thought
 */

import type { BranchId, SessionId, ThoughtId, SuspensionToken } from '../contracts/ids.js';
import type { SchemaOutput } from '../schema.js';
import type { StepRecommendation } from './step.js';
/**
 * Core data structure for a thought in the sequential thinking process.
 *
 * Thoughts represent individual reasoning steps that can be chained together
 * to form complex reasoning chains. Each thought can reference previous thoughts,
 * create branches, and include tool/skill recommendations.
 *
 * @remarks
 * - Thoughts are numbered sequentially within a branch
 * - Branching allows exploring alternative reasoning paths
 * - Revisions allow correcting or updating previous thoughts
 * - The `next_thought_needed` flag controls continuation
 *
 * @example
 * ```typescript
 * const thought: ThoughtData = {
 *   available_mcp_tools: ['Read', 'Write', 'Bash'],
 *   available_skills: ['commit', 'pdf'],
 *   thought: 'I should read the package.json to understand dependencies',
 *   thought_number: 1,
 *   total_thoughts: 5,
 *   session_id: asSessionId('package-analysis'),
 *   next_thought_needed: true,
 *   current_step: {
 *     step_description: 'Read package.json',
 *     recommended_tools: [{
 *       tool_name: 'Read',
 *       confidence: 1.0,
 *       rationale: 'Direct file reading',
 *       priority: 1
 *     }],
 *     expected_outcome: 'Contents of package.json'
 *   }
 * };
 * ```
 */
export type ThoughtData = Omit<
	SchemaOutput,
	| 'id'
	| 'session_id'
	| 'continuation_token'
	| 'register_branch_id'
	| 'branch_id'
	| 'merge_branch_ids'
	| 'current_step'
	| 'previous_steps'
> & {
	/** Unique identifier for this thought (branded ThoughtId). Auto-generated when not provided. */
	id?: ThoughtId;

	/** Session identifier (branded SessionId) for state isolation. */
	session_id: SessionId;

	/** Continuation token (branded SuspensionToken) linking tool_observation back to suspended tool_call. */
	continuation_token?: SuspensionToken;

	/** Branch identifier (branded BranchId) for branching reasoning paths. */
	branch_id?: BranchId;

	/** Branch identifiers (branded BranchId[]) being merged into current context. */
	merge_branch_ids?: BranchId[];

	/**
	 * When true, this thought has been logically retracted by a subsequent
	 * `backtrack` thought. The thought remains in history (append-only,
	 * event-sourcing) but is excluded from quality calculations.
	 * Default: false. Not part of schema input — set by ThoughtProcessor during processing.
	 */
	retracted?: boolean;

	/** Current step recommendation (post-normalization, with defaults filled). */
	current_step?: StepRecommendation;

	/** Previously recommended steps (post-normalization, with defaults filled). */
	previous_steps?: StepRecommendation[];
};

/**
 * Discriminated union variants of `ThoughtData` after `_validateNewTypes`
 * has guaranteed per-type invariants. Allows downstream methods to consume
 * narrowed thoughts without `!` non-null assertions.
 */
import type { ThoughtType } from '../contracts/reasoning-types.js';

/** A `tool_call` thought with `tool_name` guaranteed by validation. */
export type ToolCallThought = ThoughtData & {
	readonly thought_type: 'tool_call';
	readonly tool_name: string;
};

/** A `tool_observation` thought with `continuation_token` guaranteed. */
export type ToolObservationThought = ThoughtData & {
	readonly thought_type: 'tool_observation';
	readonly continuation_token: SuspensionToken;
};

/** A `backtrack` thought with `backtrack_target` guaranteed. */
export type BacktrackThought = ThoughtData & {
	readonly thought_type: 'backtrack';
	readonly backtrack_target: number;
};

/** A `verification` thought with `verification_target` guaranteed. */
export type VerificationThought = ThoughtData & {
	readonly thought_type: 'verification';
	readonly verification_target: number;
};

/** A `critique` thought with `verification_target` guaranteed. */
export type CritiqueThought = ThoughtData & {
	readonly thought_type: 'critique';
	readonly verification_target: number;
};

/** A `synthesis` thought with non-empty `synthesis_sources` guaranteed. */
export type SynthesisThought = ThoughtData & {
	readonly thought_type: 'synthesis';
	readonly synthesis_sources: readonly number[];
};

/** Catch-all for thought types with no per-type field invariants. */
export type BaseThought = ThoughtData & {
	readonly thought_type: Exclude<
		ThoughtType,
		'tool_call' | 'tool_observation' | 'backtrack' | 'verification' | 'critique' | 'synthesis'
	>;
};

/**
 * Discriminated union of validated thoughts. Returned by
 * `ThoughtProcessor._validateNewTypes` to encode invariants in the type system
 * and eliminate `!` non-null assertions in downstream handlers.
 */
export type ValidatedThought =
	| ToolCallThought
	| ToolObservationThought
	| BacktrackThought
	| VerificationThought
	| CritiqueThought
	| SynthesisThought
	| BaseThought;
