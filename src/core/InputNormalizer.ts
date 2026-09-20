/**
 * Input normalization for the documented sequential-thinking contract.
 *
 * This module fills in sensible defaults for missing fields in `previous_steps`,
 * which LLMs naturally provide as partial/skeletal data (historical context).
 *
 * @module processor
 */

import { ValidationError } from '../errors.js';
import {
	sanitizeString,
	sanitizeRationale,
	sanitizeStepField,
	sanitizeSuggestedInputs,
} from '../sanitize.js';
import type { ThoughtData } from './thought.js';
import { SESSION_ID_PATTERN, MAX_SESSION_ID_LENGTH } from './ids.js';
import { asBranchId, asSessionId, generateThoughtId, type BranchId } from '../contracts/ids.js';

/**
 * Default values for missing partial recommendation fields.
 *
 * Shared between tool and skill recommendations (identical defaults).
 */
const DEFAULT_RECOMMENDATION_CONFIDENCE = 0.5;
const DEFAULT_RECOMMENDATION_PRIORITY = 999;
const DEFAULT_RECOMMENDATION_RATIONALE = '';
const DEFAULT_STEP_OUTCOME = '';

/**
 * Recursively sanitizes all string values within an unknown structure.
 * Walks into plain objects and arrays to reach deeply nested strings.
 * Non-plain objects (Date, RegExp, etc.) are returned as-is.
 *
 * @param value - The value to sanitize recursively
 * @returns The sanitized value with all nested strings cleaned
 *
 * @example
 * ```typescript
 * sanitizeRecursive('<script>x</script>'); // 'x'
 * sanitizeRecursive({ a: { b: '<iframe>y' } }); // { a: { b: 'y' } }
 * sanitizeRecursive(['a\x00b', 42]); // ['ab', 42]
 * ```
 */
export function sanitizeRecursive(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === 'string') {
		return sanitizeString(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeRecursive(item));
	}
	if (typeof value === 'object') {
		// Only recurse into plain objects — skip Date, RegExp, Map, Set, etc.
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			return value;
		}
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			result[key] = sanitizeRecursive(val);
		}
		return result;
	}
	return value;
}

/**
 * Valid branch ID pattern: alphanumeric, hyphens, underscores only.
 * Prevents path traversal attacks by rejecting special characters like / . \ etc.
 */
const BRANCH_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Sanitizes and validates a branch ID to prevent path traversal attacks.
 *
 * @param branchId - The branch ID to sanitize
 * @returns The sanitized branch ID
 * @throws ValidationError if the branch ID contains invalid characters
 *
 * @example
 * ```typescript
 * sanitizeBranchId('my-branch_01'); // 'my-branch_01'
 * sanitizeBranchId('../etc/passwd'); // throws ValidationError
 * ```
 */
export function sanitizeBranchId(branchId: string): BranchId {
	// Validate format
	if (!BRANCH_ID_PATTERN.test(branchId)) {
		throw new ValidationError(
			'branch_id',
			'Invalid format - must be 1-64 alphanumeric characters, hyphens, or underscores only'
		);
	}
	return asBranchId(branchId);
}

/**
 * Sanitizes and validates a session ID.
 *
 * @param sessionId - The session ID to sanitize
 * @returns The sanitized session ID, or undefined if invalid after sanitization
 *
 * @example
 * ```typescript
 * sanitizeSessionId('analysis-task-42'); // 'analysis-task-42'
 * sanitizeSessionId('bad session!'); // undefined (stripped)
 * ```
 */
export function sanitizeSessionId(sessionId: string): string | undefined {
	// First sanitize control characters
	const cleaned = sanitizeString(sessionId);
	// Validate format after sanitization
	if (cleaned.length > MAX_SESSION_ID_LENGTH || !SESSION_ID_PATTERN.test(cleaned)) {
		return undefined;
	}
	return cleaned;
}

/**
 * Normalizes a recommendation object (tool or skill) with default values.
 *
 * Fills in sensible defaults for missing optional fields:
 * - `confidence`: 0.5
 * - `priority`: 999
 * - `rationale`: empty string
 *
 * @param rec - The recommendation object to normalize
 * @returns The normalized recommendation with defaults filled in
 *
 * @example
 * ```typescript
 * const input = { tool_name: 'Read', rationale: 'Read the file' };
 * const normalized = normalizeRecommendation(input);
 * // { tool_name: 'Read', rationale: 'Read the file', confidence: 0.5, priority: 999 }
 * ```
 */
function normalizeRecommendation(rec: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = { ...rec };

	// Fill in default confidence if missing
	if (!('confidence' in normalized) || normalized.confidence === undefined) {
		normalized.confidence = DEFAULT_RECOMMENDATION_CONFIDENCE;
	}

	// Fill in default priority if missing
	if (!('priority' in normalized) || normalized.priority === undefined) {
		normalized.priority = DEFAULT_RECOMMENDATION_PRIORITY;
	}

	// Fill in default rationale if missing
	// Fill in default rationale if missing, otherwise sanitize urgency phrases + cap length
	if (!('rationale' in normalized) || normalized.rationale === undefined) {
		normalized.rationale = DEFAULT_RECOMMENDATION_RATIONALE;
	} else if (typeof normalized.rationale === 'string') {
		normalized.rationale = sanitizeRationale(normalized.rationale);
	}
	// Sanitize suggested_inputs: enforce flat primitives, key cap, value-length cap
	if (
		normalized.suggested_inputs &&
		typeof normalized.suggested_inputs === 'object' &&
		!Array.isArray(normalized.suggested_inputs)
	) {
		normalized.suggested_inputs = sanitizeSuggestedInputs(
			normalized.suggested_inputs as Record<string, unknown>
		);
	}

	return normalized;
}
/**
 * Normalizes step recommendation objects.
 *
 * Normalizes tool and skill recommendations within the step to fill in defaults.
 *
 * @param step - The step recommendation to normalize
 * @param lenient - Whether to use lenient mode (fill in defaults for missing fields)
 * @returns The normalized step recommendation
 *
 * @example
 * ```typescript
 * // Strict mode (for current_step)
 * const input = {
 *   step_description: 'Analyze data',
 *   recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test', priority: 1 }],
 *   expected_outcome: 'Data analyzed'
 * };
 * const normalized = normalizeStepRecommendation(input, false);
 *
 * // Lenient mode (for previous_steps)
 * const partialInput = {
 *   step_description: 'Read file',
 *   recommended_tools: [{ tool_name: 'Read', rationale: 'Read file' }]
 * };
 * const normalized = normalizeStepRecommendation(partialInput, true);
 * // confidence: 0.5, priority: 999, expected_outcome: '' filled in
 * ```
 */
function normalizeStepRecommendation(
	step: Record<string, unknown>,
	lenient: boolean
): Record<string, unknown> {
	const normalized: Record<string, unknown> = { ...step };

	// Normalize recommended_tools array if present
	if (Array.isArray(normalized.recommended_tools)) {
		normalized.recommended_tools = normalized.recommended_tools.map((tool) =>
			typeof tool === 'object' && tool !== null
				? normalizeRecommendation(tool as Record<string, unknown>)
				: tool
		);
	}

	// Normalize recommended_skills array if present
	if (Array.isArray(normalized.recommended_skills)) {
		normalized.recommended_skills = normalized.recommended_skills.map((skill) =>
			typeof skill === 'object' && skill !== null
				? normalizeRecommendation(skill as Record<string, unknown>)
				: skill
		);
	}
	// Sanitize step-level string fields for prompt injection prevention
	if (typeof normalized.step_description === 'string') {
		normalized.step_description = sanitizeStepField(normalized.step_description);
	}
	if (typeof normalized.expected_outcome === 'string') {
		normalized.expected_outcome = sanitizeStepField(normalized.expected_outcome);
	}
	if (Array.isArray(normalized.next_step_conditions)) {
		normalized.next_step_conditions = normalized.next_step_conditions.map((cond: unknown) =>
			typeof cond === 'string' ? sanitizeStepField(cond) : cond
		);
	}
	// In lenient mode, fill in default expected_outcome if missing
	if (lenient && !('expected_outcome' in normalized)) {
		normalized.expected_outcome = DEFAULT_STEP_OUTCOME;
	}

	return normalized;
}

/**
 * Normalizes reasoning-specific fields on a thought input object.
 * Always applies reasoning normalization — reasoning is the default pipeline.
 * Applies the following normalization rules:
 * - Defaults `thought_type` to `'regular'` if not provided
 * - Clamps `quality_score` to [0, 1] range
 * - Clamps `confidence` to [0, 1] range
 * - Sanitizes `hypothesis_id` using `sanitizeBranchId` pattern
 * - Filters `synthesis_sources` to positive integers only
 * - Filters `merge_from_thoughts` to positive integers only
 * - Sanitizes each entry in `merge_branch_ids`
 * - Defaults `reasoning_depth` to `'moderate'` for hypothesis/verification types
 *
 * @param input - The mutable normalized input object to apply reasoning defaults to
 *
 * @example
 * ```typescript
 * const input: Record<string, unknown> = { thought_type: 'hypothesis', quality_score: 1.5 };
 * normalizeReasoningFields(input);
 * // input.quality_score === 1, input.reasoning_depth === 'moderate'
 * ```
 */
export function normalizeReasoningFields(input: Record<string, unknown>): void {
	// Always apply reasoning field normalization — reasoning is the default pipeline
	// Default thought_type to 'regular'

	if (!('thought_type' in input) || input.thought_type === undefined) {
		input.thought_type = 'regular';
	}

	// Clamp quality_score to [0, 1]
	if (typeof input.quality_score === 'number') {
		input.quality_score = Math.max(0, Math.min(1, input.quality_score));
	}

	// Clamp confidence to [0, 1]
	if (typeof input.confidence === 'number') {
		input.confidence = Math.max(0, Math.min(1, input.confidence));
	}

	// Sanitize hypothesis_id (same rules as branch_id)
	if (typeof input.hypothesis_id === 'string') {
		input.hypothesis_id = sanitizeBranchId(input.hypothesis_id);
	}

	// Filter synthesis_sources to positive integers only
	if (Array.isArray(input.synthesis_sources)) {
		input.synthesis_sources = input.synthesis_sources.filter(
			(v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0
		);
	}

	// Filter merge_from_thoughts to positive integers only
	if (Array.isArray(input.merge_from_thoughts)) {
		input.merge_from_thoughts = input.merge_from_thoughts.filter(
			(v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0
		);
	}

	// Sanitize merge_branch_ids entries
	if (Array.isArray(input.merge_branch_ids)) {
		input.merge_branch_ids = input.merge_branch_ids.map((id: unknown) => {
			if (typeof id === 'string') {
				return sanitizeBranchId(id);
			}
			return id;
		});
	}

	// Default reasoning_depth to 'moderate' for hypothesis/verification types
	if (
		(input.thought_type === 'hypothesis' || input.thought_type === 'verification') &&
		!('reasoning_depth' in input)
	) {
		input.reasoning_depth = 'moderate';
	}
}

/**
 * Normalizes thought input data before schema validation.
 *
 * The normalization is applied BEFORE schema validation, allowing the
 * strict Valibot schema to remain the contract authority.
 *
 * @param input - The raw thought input data to normalize
 * @returns Normalized thought data with correct field names
 *
 * @remarks
 * **Normalization Rules:**
 * - Applied to `current_step` if present (strict mode)
 * - Applied to all items in `previous_steps` if present (lenient mode with defaults)
 *
 * LLMs naturally provide complete data for `current_step`
 * but only partial/skeletal data for `previous_steps` (historical context).
 * The lenient mode for `previous_steps` fills in sensible defaults:
 * - `confidence`: 0.5 for missing tool recommendation confidence
 * - `priority`: 999 for missing tool recommendation priority
 * - `rationale`: empty string for missing tool recommendation rationale
 * - `expected_outcome`: empty string for missing step expected outcome
 *
 * @example
 * ```typescript
 * const input = {
 *   thought: 'I need to analyze the data',
 *   thought_number: 1,
 *   total_thoughts: 3,
 *   session_id: 'data-analysis',
 *   next_thought_needed: true,
 *   current_step: {
 *     step_description: 'Read the data file',
 *     recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test', priority: 1 }],
 *     expected_outcome: 'Data loaded'
 *   },
 *   previous_steps: [{
 *     step_description: 'Previous step',
 *     recommended_tools: [{ tool_name: 'Grep', rationale: 'Search code' }]
 *   }]
 * };
 *
 * const normalized = normalizeInput(input);
 * // previous_steps[0]: confidence=0.5, priority=999, expected_outcome='' filled in
 * ```
 */
export function normalizeInput(input: unknown): ThoughtData {
	if (typeof input !== 'object' || input === null) {
		return input as ThoughtData;
	}

	const normalized = { ...input } as Record<string, unknown>;

	if (normalized.session_id === undefined) {
		throw new ValidationError('session_id', 'is required');
	}
	if (typeof normalized.session_id !== 'string') {
		throw new ValidationError('session_id', 'must be a non-empty string');
	}
	normalized.session_id = asSessionId(normalized.session_id);

	// Normalize current_step if present (strict mode - no defaults)
	if (normalized.current_step && typeof normalized.current_step === 'object') {
		normalized.current_step = normalizeStepRecommendation(
			normalized.current_step as Record<string, unknown>,
			false // strict mode
		);
	}

	// Normalize all items in previous_steps if present (lenient mode - with defaults)
	if (Array.isArray(normalized.previous_steps) && normalized.previous_steps.length > 0) {
		normalized.previous_steps = normalized.previous_steps.map((step) =>
			typeof step === 'object' && step !== null
				? normalizeStepRecommendation(step as Record<string, unknown>, true) // lenient mode
				: step
		);
	}

	// Sanitize branch_id to prevent path traversal attacks
	if (typeof normalized.branch_id === 'string') {
		normalized.branch_id = sanitizeBranchId(normalized.branch_id);
	}

	if (typeof normalized.register_branch_id === 'string') {
		normalized.register_branch_id = sanitizeBranchId(normalized.register_branch_id);
	}

	// Auto-generate id if not provided (for DAG node identity)
	if (!normalized.id || typeof normalized.id !== 'string') {
		normalized.id = generateThoughtId();
	}

	// Normalize reasoning fields
	normalizeReasoningFields(normalized);

	// Sanitize meta_observation for prompt injection prevention
	if (typeof normalized.meta_observation === 'string') {
		normalized.meta_observation = sanitizeStepField(normalized.meta_observation);
	}

	// Sanitize all free-text string fields recursively (dangerous HTML tags + null bytes)
	// This was moved from schema transforms because v.transform() cannot be converted to JSON Schema
	const sanitized = sanitizeRecursive(normalized);

	return sanitized as ThoughtData;
}
