/**
 * Valibot validation schemas for the sequential thinking MCP tool.
 *
 * This module defines the validation schemas used for the sequential thinking tool,
 * including schemas for tool recommendations, skill recommendations, step recommendations,
 * and the main sequential thinking input. All schemas use Valibot for runtime validation
 * and provide detailed descriptions for MCP protocol compatibility.
 *
 * @remarks
 * **Schema Overview:**
 * - `ToolRecommendationSchema` - Validates tool recommendation objects with confidence scores
 * - `SkillRecommendationSchema` - Validates skill recommendation objects
 * - `StepRecommendationSchema` - Validates step coordination structures
 * - `SequentialThinkingSchema` - Main schema for thought input validation
 * - Reasoning enhancement fields: thought_type, quality_score, confidence, hypothesis_id, etc.
 *
 * @example
 * ```typescript
 * import { SequentialThinkingSchema } from './schema.js';
 * import { safeParse } from 'valibot';
 *
 * const result = safeParse(SequentialThinkingSchema, inputData);
 * if (result.success) {
 *   const thought = result.output;
 *   // Process the valid thought
 * } else {
 *   console.error('Validation failed:', result.issues);
 * }
 * ```
 * @module schema
 */

import * as v from 'valibot';
import type { Tool } from './types/tool.js';
import type { Edge, EdgeKind } from './core/graph/Edge.js';
/**
 * Detailed description for the sequential thinking tool.
 *
 * This description is shown to LLMs when they consider using this tool.
 * It explains when to use the tool, its features, parameters, and best practices.
 */
const TOOL_DESCRIPTION = `A detailed tool for dynamic and reflective problem-solving through thoughts.
This tool helps analyze problems through a flexible thinking process that can adapt and evolve.
Each thought can build on, question, or revise previous insights as understanding deepens.

IMPORTANT: This server facilitates sequential thinking with MCP tool coordination and skill recommendations. The LLM analyzes available tools and skills to make intelligent recommendations, which are then tracked and organized by this server.

Each invocation records exactly one authored thought and returns. When strategy_hint.action is continue, invoke this tool again with the next thought; do not stop or provide a final answer. terminate permits stopping. The server does not author later thoughts or call itself.

When to use this tool:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope might not be clear initially
- Problems that require a multi-step solution
- Tasks that need to maintain context over multiple steps
- Situations where irrelevant information needs to be filtered out
- When you need guidance on which tools to use and in what order
- When you need guidance on which skills to invoke for specific workflows

Key features:
- You can adjust total_thoughts up or down as you progress
- You can question or revise previous thoughts
- You can add more thoughts even after reaching what seemed like the end
- You can express uncertainty and explore alternative approaches
- Not every thought needs to build linearly - you can branch or backtrack
- Generates a solution hypothesis
- Verifies the hypothesis based on the Chain of Thought steps
- Recommends appropriate tools for each step
- Recommends appropriate skills alongside tools
- Provides rationale for tool recommendations
- Suggests tool execution order and parameters
- Tracks previous recommendations and remaining steps

Parameters explained:
- available_mcp_tools: (Optional) Array of MCP tool names that are available for use (e.g., ["mcp-omnisearch", "mcp-turso-cloud"])
- available_skills: (Optional) Array of skill names that are available for use (e.g., ["commit", "review-pr", "pdf"])
- thought: Your current thinking step, which can include:
* Regular analytical steps
* Revisions of previous thoughts
* Questions about previous decisions
* Realizations about needing more analysis
* Changes in approach
* Hypothesis generation
* Hypothesis verification
* Tool recommendations and rationale
- next_thought_needed: True if you need more thinking, even if at what seemed like the end. Omission defaults to true; the effective next action is in strategy_hint.
- thought_number: Current number in sequence (can go beyond initial total if needed)
- total_thoughts: Current estimate of thoughts needed (can be adjusted up/down)
- is_revision: A boolean indicating if this thought revises previous thinking
- revises_thought: If is_revision is true, which thought number is being reconsidered
- branch_from_thought: If branching, which thought number is the branching point
- branch_id: Identifier for the current branch (if any)
- needs_more_thoughts: If reaching end but realizing more thoughts needed
- current_step: Current step recommendation, including:
* step_description: What needs to be done
* recommended_tools: (CRITICAL: PLURAL - "recommended_tools" with an 's') Tools recommended for this step - MUST be an array.
* recommended_skills: (CRITICAL: PLURAL - "recommended_skills" with an 's') Skills recommended for this step (optional) - MUST be an array.
* expected_outcome: What to expect from this step
* next_step_conditions: Conditions to consider for the next step
- previous_steps: Steps already recommended (each step MUST use "recommended_tools" PLURAL)
- remaining_steps: High-level descriptions of upcoming steps

Reasoning Enhancement Parameters:
- thought_type: Thought purpose: 'regular' (default), 'hypothesis', 'verification', 'critique', 'synthesis', 'meta', 'tool_call' (requires toolInterleave flag), 'tool_observation' (requires toolInterleave flag), 'assumption' (requires newThoughtTypes flag), 'decomposition' (requires newThoughtTypes flag), 'backtrack' (requires newThoughtTypes flag; logically retracts the thought referenced by backtrack_target - the target remains in history but is excluded from quality calculations)
- quality_score: Self-assessed quality of this thought (0-1)
- confidence: Confidence in this thought's correctness (0-1)
- hypothesis_id: Links hypothesis to verification (alphanumeric, hyphens, underscores)
- verification_target: For 'verification'/'critique' types, the thought_number being evaluated
- verification_result: Optional exact outcome label (0 = incorrect, 1 = correct) for a verification_target; only has outcome semantics on thought_type='verification'
- synthesis_sources: For 'synthesis' type, the thought_numbers being combined
- merge_from_thoughts: Thought numbers from other branches merged (graph reasoning)
- merge_branch_ids: Branch IDs merged into current context
- meta_observation: Observation about reasoning process (with thought_type 'meta')
- reasoning_depth: How deep to reason: 'shallow' (quick), 'moderate' (default), 'deep' (thorough)
- session_id: Required unique identifier that scopes thought history, branches, and statistics to an explicit session. Format: alphanumeric, hyphens, underscores, 1-100 chars; the retired value __global__ is rejected.
- reset_state: (Optional) When true, clears all state for the required session_id before processing the current thought. Use this to start a fresh reasoning chain without accumulated state from previous chains.

Response Enrichment:
- When reasoning fields are set, response includes confidence_signals (depth, revision/branch count, type distribution, avg confidence, structural_quality, quality_components) and reasoning_stats (hypothesis tracking)
- confidence_signals.structural_quality: Composite 0-1 score — weighted geometric mean of type_diversity (0.3), verification_coverage (0.3), depth_efficiency (0.2), confidence_stability (0.2). Weights: type_diversity=0.3, verification_coverage=0.3, depth_efficiency=0.2, confidence_stability=0.2 (weighted geometric mean). All components floored at 0.01 to prevent collapse.
- confidence_signals.quality_components: Individual metrics — type_diversity (Shannon entropy/log₂(6)), verification_coverage (verified/total hypotheses, 1.0 if none), depth_efficiency (max(chain_depth, branch_count+1)/total, branching rewarded), confidence_stability (1 - stddev(confidence), default 0.5, null when fewer than 2 confidence values)
- reasoning_hints: (Conditional) Array of actionable hint strings from cross-thought pattern analysis. Only warning-severity patterns produce hints. Max 3 hints per response, with 3-thought cooldown per pattern per session. Hints are prioritized: confidence_drift > unverified_hypothesis > no_alternatives_explored > consecutive_without_verification, so the most actionable patterns fill the cap first. Present only when warnings are detected.
- Detected patterns (internal, not in response): consecutive_without_verification (3+ regular thoughts without verification), unverified_hypothesis (hypothesis without verification within 3 thoughts after it), no_alternatives_explored (5+ thoughts with no critique/branches), monotonic_type (5+ consecutive same type), confidence_drift (3+ consecutive decreasing confidence), healthy_verification (hypothesis verified within 3 thoughts — info only)
You should:
1. Start with an initial estimate of needed thoughts, but be ready to adjust
2. Feel free to question or revise previous thoughts
3. Don't hesitate to add more thoughts if needed, even at the "end"
4. Express uncertainty when present
5. Mark thoughts that revise previous thinking or branch into new paths
6. Ignore information that is irrelevant to the current step
7. Generate a solution hypothesis when appropriate
8. Verify the hypothesis based on the Chain of Thought steps
9. Consider available tools that could help with the current step
10. Provide clear rationale for tool recommendations
11. Suggest specific tool parameters when appropriate
12. Consider alternative tools for each step
13. Track progress through the recommended steps
14. Consider available skills that provide workflows for complex tasks
15. Coordinate skill invocation with tool recommendations (skills may call tools)
16. Provide a single, ideally correct answer as the final output
17. Only set next_thought_needed to false when truly done and a satisfactory answer is reached
18. Classify your reasoning steps using thought_type for better analytics and self-awareness
19. Use hypothesis → verification chains to test solutions before committing
20. Self-assess quality and confidence to track reasoning reliability
21. Use merge_from_thoughts to combine insights from multiple reasoning branches
22. Use session_id to isolate independent reasoning chains from each other
23. Use reset_state: true when starting a completely new analysis to avoid statistical contamination from previous chains`;

/**
 * Valibot schema for validating tool recommendation objects.
 *
 * Validates that a tool recommendation has:
 * - A tool name (string)
 * - A confidence score between 0 and 1
 * - A rationale explaining the recommendation
 * - A priority number for ordering
 * - Optional suggested input parameters
 * - Optional alternative tools
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { ToolRecommendationSchema } from './schema.js';
 *
 * const result = safeParse(ToolRecommendationSchema, {
 *   tool_name: 'mcp__tavily-mcp__tavily-search',
 *   confidence: 0.9,
 *   rationale: 'Best for web search',
 *   priority: 1
 * });
 * ```
 */
export const ToolRecommendationSchema = v.object({
	tool_name: v.pipe(v.string(), v.description('Name of the tool being recommended')),
	confidence: v.pipe(
		v.number(),
		v.minValue(0),
		v.maxValue(1),
		v.description('0-1 indicating confidence in recommendation')
	),
	rationale: v.pipe(v.string(), v.maxLength(2000), v.description('Why this tool is recommended')),
	priority: v.optional(
		v.pipe(v.number(), v.description('Order in the recommendation sequence (default: 999)'))
	),
	suggested_inputs: v.optional(
		v.pipe(
			v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()])),
			v.description('Optional suggested parameters (flat key-value pairs only)')
		)
	),
	alternatives: v.optional(
		v.pipe(v.array(v.string()), v.description('Alternative tools that could be used'))
	),
});

/**
 * Valibot schema for validating skill recommendation objects.
 *
 * Validates that a skill recommendation has:
 * - A skill name (string)
 * - A confidence score between 0 and 1
 * - A rationale explaining the recommendation
 * - A priority number for ordering
 * - Optional alternative skills
 * - Optional allowed tools list
 * - Optional user invocable flag
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { SkillRecommendationSchema } from './schema.js';
 *
 * const result = safeParse(SkillRecommendationSchema, {
 *   skill_name: 'commit',
 *   confidence: 0.95,
 *   rationale: 'Handles git commit workflow',
 *   priority: 1,
 *   user_invocable: true
 * });
 * ```
 */
export const SkillRecommendationSchema = v.object({
	skill_name: v.pipe(v.string(), v.description('Name of the skill being recommended')),
	confidence: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1),
			v.description('0-1 indicating confidence in recommendation (default: 0.5)')
		)
	),
	rationale: v.optional(
		v.pipe(
			v.string(),
			v.maxLength(2000),
			v.description('Why this skill is recommended (default: empty string)')
		)
	),
	priority: v.optional(
		v.pipe(v.number(), v.description('Order in the recommendation sequence (default: 999)'))
	),
	alternatives: v.optional(
		v.pipe(v.array(v.string()), v.description('Alternative skills that could be used'))
	),
	allowed_tools: v.optional(
		v.pipe(
			v.array(v.string()),
			v.description('Tools this skill is allowed to use (from skill frontmatter)')
		)
	),
	user_invocable: v.optional(
		v.pipe(v.boolean(), v.description('Whether this skill can be user-invoked'))
	),
});

/**
 * Valibot schema for validating step recommendation objects.
 *
 * Validates that a step recommendation has:
 * - A step description
 * - An array of recommended tools
 * - An optional array of recommended skills
 * - An expected outcome
 * - Optional conditions for the next step
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { StepRecommendationSchema } from './schema.js';
 *
 * const result = safeParse(StepRecommendationSchema, {
 *   step_description: 'Search for TypeScript files',
 *   recommended_tools: [{ ... }],
 *   expected_outcome: 'List of all TypeScript files'
 * });
 * ```
 */
export const StepRecommendationSchema = v.object({
	step_description: v.pipe(v.string(), v.description('What needs to be done')),
	recommended_tools: v.pipe(
		v.array(ToolRecommendationSchema),
		v.description('Tools recommended for this step')
	),
	recommended_skills: v.optional(
		v.pipe(v.array(SkillRecommendationSchema), v.description('Skills recommended for this step'))
	),
	expected_outcome: v.pipe(v.string(), v.description('What to expect from this step')),
	next_step_conditions: v.optional(
		v.pipe(v.array(v.string()), v.description('Conditions to consider for the next step'))
	),
});

/**
 * Valibot schema for validating partial tool recommendation objects.
 *
 * This is a lenient version of ToolRecommendationSchema used for previous_steps,
 * where LLMs naturally provide partial/skeletal data. Only tool_name and rationale
 * are required, while confidence and priority are optional with default values.
 *
 * Validates that a partial tool recommendation has:
 * - A tool name (required)
 * - A rationale explaining the recommendation (required)
 * - An optional confidence score (defaults to 0.5)
 * - An optional priority number (defaults to 999)
 * - Optional suggested input parameters
 * - Optional alternative tools
 *
 * @remarks
 * **Design Rationale:**
 * LLMs tend to provide complete data for current_step but only partial data
 * for previous_steps (historical context). This schema accommodates that natural
 * LLM behavior while maintaining data integrity through sensible defaults.
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { PartialToolRecommendationSchema } from './schema.js';
 *
 * // Minimal valid input (LLM often generates this for previous_steps)
 * const result = safeParse(PartialToolRecommendationSchema, {
 *   tool_name: 'Read',
 *   rationale: 'Read the file'
 * });
 * // confidence and priority will be filled in by the normalizer
 * ```
 */
export const PartialToolRecommendationSchema = v.object({
	tool_name: v.pipe(v.string(), v.description('Name of the tool being recommended')),
	rationale: v.optional(
		v.pipe(
			v.string(),
			v.maxLength(2000),
			v.description('Why this tool is recommended (default: empty string)')
		)
	),
	confidence: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1),
			v.description('0-1 indicating confidence in recommendation (default: 0.5)')
		)
	),
	priority: v.optional(
		v.pipe(v.number(), v.description('Order in the recommendation sequence (default: 999)'))
	),
	suggested_inputs: v.optional(
		v.pipe(
			v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()])),
			v.description('Optional suggested parameters (flat key-value pairs only)')
		)
	),
	alternatives: v.optional(
		v.pipe(v.array(v.string()), v.description('Alternative tools that could be used'))
	),
});

/**
 * Valibot schema for validating partial step recommendation objects.
 *
 * This is a lenient version of StepRecommendationSchema used for previous_steps,
 * where LLMs naturally provide partial/skeletal data. Only step_description is
 * strictly required, while expected_outcome and tool recommendation fields are
 * optional with default values.
 *
 * Validates that a partial step recommendation has:
 * - A step description (required)
 * - An array of recommended tools (with optional confidence/priority)
 * - An optional array of recommended skills
 * - An optional expected outcome (defaults to empty string)
 * - Optional conditions for the next step
 *
 * @remarks
 * **Design Rationale:**
 * LLMs provide complete, detailed data for current_step but only brief summaries
 * for previous_steps. This schema allows the natural LLM behavior while the
 * InputNormalizer fills in sensible defaults for missing fields.
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { PartialStepRecommendationSchema } from './schema.js';
 *
 * // Minimal valid input (LLM often generates this for previous_steps)
 * const result = safeParse(PartialStepRecommendationSchema, {
 *   step_description: 'Read the file',
 *   recommended_tools: [{
 *     tool_name: 'Read',
 *     rationale: 'Read the file'
 *   }]
 * });
 * // confidence, priority, and expected_outcome will be filled in by normalizer
 * ```
 */
export const PartialStepRecommendationSchema = v.object({
	step_description: v.pipe(v.string(), v.description('What needs to be done')),
	recommended_tools: v.pipe(
		v.array(PartialToolRecommendationSchema),
		v.description('Tools recommended for this step')
	),
	recommended_skills: v.optional(
		v.pipe(v.array(SkillRecommendationSchema), v.description('Skills recommended for this step'))
	),
	expected_outcome: v.optional(
		v.pipe(v.string(), v.description('What to expect from this step (default: empty string)'))
	),
	next_step_conditions: v.optional(
		v.pipe(v.array(v.string()), v.description('Conditions to consider for the next step'))
	),
});

/**
 * Main Valibot schema for validating sequential thinking tool input.
 *
 * This is the primary schema used for the sequential thinking MCP tool.
 * It validates all thought data including:
 * - Optional available tools and skills arrays
 * - The thought content (required)
 * - Thought numbering (thought_number, total_thoughts)
 * - Revision and branching metadata
 * - Current, previous, and remaining step recommendations
 *
 * @remarks
 * **Validation Rules:**
 * - `thought_number` must be >= 1
 * - `total_thoughts` must be >= 1
 * - `branch_id` must be 1-50 characters, alphanumeric/hyphens/underscores only
 * - `confidence` values must be between 0 and 1
 * - `thought_type` must be one of: regular, hypothesis, verification, critique, synthesis, meta
 * - `quality_score` and `confidence` must be between 0 and 1
 * - `hypothesis_id` must be 1-50 characters, alphanumeric/hyphens/underscores only
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { SequentialThinkingSchema } from './schema.js';
 *
 * const result = safeParse(SequentialThinkingSchema, {
 *   thought: 'I need to analyze the problem',
 *   thought_number: 1,
 *   total_thoughts: 5,
 *   session_id: 'analysis-task',
 *   next_thought_needed: true,
 *   available_mcp_tools: ['Read', 'Write', 'Grep']
 * });
 *
 * if (result.success) {
 *   console.log('Valid thought:', result.output);
 * } else {
 *   console.error('Validation errors:', result.issues);
 * }
 * ```
 */
export const SequentialThinkingSchema = v.object({
	available_mcp_tools: v.optional(
		v.pipe(
			v.array(v.string()),
			v.description(
				'Array of MCP tool names available for use (e.g., ["mcp-omnisearch", "mcp-turso-cloud"])'
			)
		)
	),
	available_skills: v.optional(
		v.pipe(
			v.array(v.string()),
			v.description('Array of skill names available for use (e.g., ["commit", "review-pr", "pdf"])')
		)
	),
	thought: v.pipe(v.string(), v.description('Your current thinking step')),
	id: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.maxLength(30),
			v.description('Unique identifier for this thought. Auto-generated if not provided.')
		)
	),
	next_thought_needed: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'Omission defaults to true; the effective next action is returned in strategy_hint.'
			)
		)
	),
	thought_number: v.pipe(v.number(), v.minValue(1), v.description('Current thought number')),
	total_thoughts: v.pipe(
		v.number(),
		v.minValue(1),
		v.description('Estimated total thoughts needed')
	),
	is_revision: v.optional(
		v.pipe(v.boolean(), v.description('Whether this revises previous thinking'))
	),
	revises_thought: v.optional(
		v.pipe(v.number(), v.minValue(1), v.description('Which thought is being reconsidered'))
	),
	branch_from_thought: v.optional(
		v.pipe(v.number(), v.minValue(1), v.description('Branching point thought number'))
	),
	branch_id: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[a-zA-Z0-9_-]+$/,
				'Branch ID must contain only letters, numbers, hyphens, and underscores'
			),
			v.minLength(1),
			v.maxLength(50),
			v.description('Branch identifier (alphanumeric, hyphens, underscores only, max 50 chars)')
		)
	),
	needs_more_thoughts: v.optional(
		v.pipe(v.boolean(), v.description('If more thoughts are needed'))
	),
	current_step: v.optional(
		v.pipe(StepRecommendationSchema, v.description('Current step recommendation'))
	),
	previous_steps: v.optional(
		v.pipe(
			v.array(PartialStepRecommendationSchema),
			v.description(
				'Steps already recommended (lenient schema - allows partial data with defaults)'
			)
		)
	),
	remaining_steps: v.optional(
		v.pipe(v.array(v.string()), v.description('High-level descriptions of upcoming steps'))
	),
	thought_type: v.optional(
		v.pipe(
			v.picklist([
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
			]),
			v.description(
				'Classified purpose: regular (default), hypothesis, verification, critique, synthesis, meta, tool_call (requires toolInterleave), tool_observation (requires toolInterleave), assumption (requires newThoughtTypes), decomposition (requires newThoughtTypes), backtrack (requires newThoughtTypes)'
			)
		)
	),
	quality_score: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1),
			v.description('Self-assessed quality score (0-1)')
		)
	),
	confidence: v.optional(
		v.pipe(
			v.number(),
			v.minValue(0),
			v.maxValue(1),
			v.description('Explicit confidence in correctness (0-1)')
		)
	),
	hypothesis_id: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[a-zA-Z0-9_-]+$/,
				'Hypothesis ID must contain only letters, numbers, hyphens, and underscores'
			),
			v.minLength(1),
			v.maxLength(50),
			v.description('Identifier linking hypothesis to verification thoughts')
		)
	),
	verification_target: v.optional(
		v.pipe(v.number(), v.minValue(1), v.description('Thought number being verified or critiqued'))
	),
	verification_result: v.optional(
		v.pipe(
			v.union([v.literal(0), v.literal(1)]),
			v.description('Exact verification outcome label: 0 for incorrect, 1 for correct')
		)
	),
	synthesis_sources: v.optional(
		v.pipe(
			v.array(v.pipe(v.number(), v.minValue(1))),
			v.description('Thought numbers being synthesized')
		)
	),
	merge_from_thoughts: v.optional(
		v.pipe(
			v.array(v.pipe(v.number(), v.minValue(1))),
			v.description('Thought numbers from other branches being merged (DAG)')
		)
	),
	merge_branch_ids: v.optional(
		v.pipe(
			v.array(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]+$/), v.maxLength(50))),
			v.description('Branch IDs being merged into current context')
		)
	),
	meta_observation: v.optional(
		v.pipe(v.string(), v.description('Metacognitive observation about reasoning process'))
	),
	reasoning_depth: v.optional(
		v.pipe(
			v.picklist(['shallow', 'moderate', 'deep']),
			v.description('Effort signal: how deep reasoning should go')
		)
	),
	session_id: v.pipe(
		v.string(),
		v.regex(
			/^[a-zA-Z0-9_-]+$/,
			'Session ID must contain only letters, numbers, hyphens, and underscores'
		),
		v.minLength(1),
		v.maxLength(100),
		v.notValue('__global__', "Session ID '__global__' is retired; use an explicit named session"),
		v.description(
			'Required session identifier for state isolation. Thought history, branches, and statistics are scoped to this explicit named session.'
		)
	),
	reset_state: v.optional(
		v.pipe(
			v.boolean(),
			v.description(
				'When true, clears all state for the target session before processing this thought. The thought is then processed as the first in a fresh session.'
			)
		)
	),
	tool_name: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Name of the tool being invoked (for tool_call thoughts)')
		)
	),
	tool_arguments: v.optional(
		v.pipe(
			v.record(v.string(), v.unknown()),
			v.description('Arguments passed to the tool (for tool_call thoughts)')
		)
	),
	tool_result: v.optional(
		v.pipe(
			v.unknown(),
			v.description('Result returned by the tool (for tool_observation thoughts)')
		)
	),
	continuation_token: v.optional(
		v.pipe(
			v.string(),
			v.minLength(1),
			v.description('Token for resuming long-running tool invocations')
		)
	),
	decomposition_children: v.optional(
		v.pipe(v.array(v.string()), v.description('Child thought IDs produced by decomposition'))
	),
	backtrack_target: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1),
			v.description(
				'Thought number to backtrack to. When the parent thought has thought_type=backtrack, this thought is logically retracted: it remains in history but is excluded from quality signals and reasoning stats.'
			)
		)
	),
	register_branch_id: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[a-zA-Z0-9_-]+$/,
				'register_branch_id must contain only letters, numbers, hyphens, and underscores'
			),
			v.minLength(1),
			v.maxLength(50),
			v.description(
				'Pre-declares a branch ID for this session before any thoughts reference it. Useful so that subsequent thoughts using merge_branch_ids can target a branch that has not yet received any thoughts.'
			)
		)
	),
});

/** Inferred output type of the sequential thinking schema (string IDs, no branded types). */
export type SchemaOutput = v.InferOutput<typeof SequentialThinkingSchema>;

/**
 * The sequential thinking tool definition for MCP registration.
 *
 * This object defines the tool that is registered with the MCP server.
 * The inputSchema is left empty as the schema is handled by tmcp
 * when registering the tool using the Valibot adapter.
 *
 * @example
 * ```typescript
 * import { SEQUENTIAL_THINKING_TOOL } from './schema.js';
 * import { McpServer } from 'tmcp';
 *
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 * server.tool({
 *   name: SEQUENTIAL_THINKING_TOOL.name,
 *   description: SEQUENTIAL_THINKING_TOOL.description,
 *   schema: SequentialThinkingSchema
 * }, handler);
 * ```
 */
export const SEQUENTIAL_THINKING_TOOL: Tool = {
	name: 'sequentialthinking_tools',
	description: TOOL_DESCRIPTION,
	inputSchema: {}, // Schema is handled by tmcp when registering the tool
};

/**
 * Valibot schema for validating JSON-RPC 2.0 request messages.
 *
 * Validates that a JSON-RPC request has:
 * - A jsonrpc version (must be "2.0")
 * - A method name (string)
 * - Optional params (object or array)
 * - Optional id (string, number, or null for notifications)
 *
 * @example
 * ```typescript
 * import { safeParse } from 'valibot';
 * import { JsonRpcRequestSchema } from './schema.js';
 *
 * const result = safeParse(JsonRpcRequestSchema, {
 *   jsonrpc: '2.0',
 *   method: 'tools/list',
 *   id: 1
 * });
 * ```
 */
export const JsonRpcRequestSchema = v.object({
	jsonrpc: v.pipe(
		v.string(),
		v.literal('2.0'),
		v.description('JSON-RPC protocol version (must be "2.0")')
	),
	method: v.pipe(v.string(), v.minLength(1), v.description('Method name to invoke')),
	params: v.optional(
		v.pipe(
			v.union([v.array(v.unknown()), v.record(v.string(), v.unknown())]),
			v.description('Method parameters (object or array)')
		)
	),
	id: v.optional(
		v.pipe(
			v.union([v.string(), v.number(), v.null()]),
			v.description('Request ID (omit for notifications)')
		)
	),
});

/**
 * Schema for {@link EdgeKind} — the semantic relationship between two thoughts.
 */
export const EdgeKindSchema = v.union([
	v.literal('sequence'),
	v.literal('branch'),
	v.literal('merge'),
	v.literal('verifies'),
	v.literal('critiques'),
	v.literal('derives_from'),
	v.literal('tool_invocation'),
	v.literal('revises'),
]) satisfies v.GenericSchema<EdgeKind>;

/**
 * Schema for {@link Edge} — a directed edge in the thought DAG.
 */
export const EdgeSchema = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.maxLength(30)),
	from: v.pipe(v.string(), v.minLength(1), v.maxLength(30)),
	to: v.pipe(v.string(), v.minLength(1), v.maxLength(30)),
	kind: EdgeKindSchema,
	sessionId: v.pipe(v.string(), v.minLength(1)),
	createdAt: v.number(),
	metadata: v.optional(v.record(v.string(), v.unknown())),
}) satisfies v.GenericSchema<
	Omit<Edge, 'id' | 'from' | 'to' | 'sessionId'> & {
		id: string;
		from: string;
		to: string;
		sessionId: string;
	}
>;
