/**
 * Tests for InputNormalizer.
 *
 * This test file covers recommendation defaults, identity handling, and
 * reasoning-field normalization for the documented input contract.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeInput as normalizeRawInput,
	normalizeReasoningFields,
	sanitizeRecursive,
} from '../core/InputNormalizer.js';
import type { ThoughtData } from '../core/thought.js';
import { ValidationError } from '../errors.js';
import { asSessionId } from '../contracts/ids.js';

const TEST_SESSION_ID = 'input-normalizer-test';

function normalizeInput(input: unknown): ThoughtData {
	if (typeof input !== 'object' || input === null) {
		return normalizeRawInput(input);
	}
	return normalizeRawInput({ session_id: TEST_SESSION_ID, ...input });
}

/**
 * Helper for creating tool recommendations.
 */
function createToolRecommendation(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		tool_name: 'test-tool',
		confidence: 0.9,
		rationale: 'Test rationale',
		priority: 1,
		...overrides,
	};
}

describe('InputNormalizer', () => {
	describe('session identity boundary', () => {
		it('rejects an omitted session id', () => {
			const input = {
				thought: 'named thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			};

			expect(() => normalizeRawInput(input)).toThrowError(
				"Validation failed for 'session_id': is required"
			);
		});

		it('rejects the retired global session id at the identifier boundary', () => {
			expect(() => asSessionId('__global__')).toThrowError(
				"Validation failed for 'session_id': reserved value '__global__' is retired; use an explicit named session"
			);
		});

		it.each(['', 'bad session!', 'a/b', 'x'.repeat(101)])(
			'rejects malformed explicit session id %j without mutating caller input',
			(sessionId) => {
				const input = {
					thought: 'reset safely',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: sessionId,
					reset_state: true,
					register_branch_id: 'future-branch',
					tool_arguments: { nested: { values: ['one', 'two'] } },
				};
				const before = structuredClone(input);

				expect(() => normalizeInput(input)).toThrowError(ValidationError);
				expect(input).toEqual(before);
			}
		);

		it('preserves named identity and deep caller input while returning a fresh normalized copy', () => {
			const input = {
				thought: 'global thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'copy-test',
				register_branch_id: 'future-branch',
				current_step: {
					step_description: 'inspect',
					recommended_tools: [{ tool_name: 'Read', confidence: 1, rationale: 'read' }],
					expected_outcome: 'known',
				},
			};
			const before = structuredClone(input);

			const normalized = normalizeInput(input);

			expect(normalized.session_id).toBe('copy-test');
			expect(normalized).not.toBe(input);
			expect(normalized.current_step).not.toBe(input.current_step);
			expect(input).toEqual(before);
		});
	});

	describe('current_step normalization', () => {
		it('does not promote the unsupported recommended_tool alias', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				current_step: {
					step_description: 'Test step',
					recommended_tool: [createToolRecommendation()],
					expected_outcome: 'Test outcome',
				},
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step?.recommended_tools).toBeUndefined();
			const step = normalized.current_step as Record<string, unknown> | undefined;
			expect(step?.recommended_tool).toEqual([createToolRecommendation()]);
		});

		it('should preserve recommended_tools when already plural', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				current_step: {
					step_description: 'Test step',
					recommended_tools: [createToolRecommendation()],
					expected_outcome: 'Test outcome',
				},
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step).toBeDefined();
			expect(normalized.current_step?.recommended_tools).toBeDefined();
			expect(normalized.current_step?.recommended_tools).toHaveLength(1);
		});

		it('does not promote the unsupported recommended_skill alias', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				current_step: {
					step_description: 'Test step',
					recommended_tools: [createToolRecommendation()],
					recommended_skill: [
						{
							skill_name: 'test-skill',
							confidence: 0.9,
							rationale: 'Test rationale',
							priority: 1,
						},
					],
					expected_outcome: 'Test outcome',
				},
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step?.recommended_skills).toBeUndefined();
			const step = normalized.current_step as Record<string, unknown> | undefined;
			expect(step?.recommended_skill).toEqual([
				{
					skill_name: 'test-skill',
					confidence: 0.9,
					rationale: 'Test rationale',
					priority: 1,
				},
			]);
		});

		it('should preserve recommended_skills when already plural', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				current_step: {
					step_description: 'Test step',
					recommended_tools: [createToolRecommendation()],
					recommended_skills: [
						{
							skill_name: 'test-skill',
							confidence: 0.9,
							rationale: 'Test rationale',
							priority: 1,
						},
					],
					expected_outcome: 'Test outcome',
				},
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step).toBeDefined();
			expect(normalized.current_step?.recommended_skills).toBeDefined();
			expect(normalized.current_step?.recommended_skills).toHaveLength(1);
		});

		it('should handle missing current_step', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step).toBeUndefined();
		});
	});

	describe('previous_steps normalization', () => {
		it('does not promote unsupported singular aliases in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Step 1',
						recommended_tool: [createToolRecommendation({ tool_name: 'tool1' })],
						expected_outcome: 'Outcome 1',
					},
					{
						step_description: 'Step 2',
						recommended_tool: [createToolRecommendation({ tool_name: 'tool2' })],
						expected_outcome: 'Outcome 2',
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps).toHaveLength(2);
			expect(normalized.previous_steps?.[0]?.recommended_tools).toBeUndefined();
			expect(normalized.previous_steps?.[1]?.recommended_tools).toBeUndefined();
		});

		it('normalizes only documented plural recommendations in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Step 1',
						recommended_tool: [createToolRecommendation({ tool_name: 'tool1' })],
						expected_outcome: 'Outcome 1',
					},
					{
						step_description: 'Step 2',
						recommended_tools: [createToolRecommendation({ tool_name: 'tool2' })],
						expected_outcome: 'Outcome 2',
					},
					{
						step_description: 'Step 3',
						recommended_tool: [createToolRecommendation({ tool_name: 'tool3' })],
						expected_outcome: 'Outcome 3',
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps).toBeDefined();
			expect(normalized.previous_steps).toHaveLength(3);
			expect(normalized.previous_steps?.[0]?.recommended_tools).toBeUndefined();
			expect(normalized.previous_steps?.[1]?.recommended_tools).toBeDefined();
			expect(normalized.previous_steps?.[2]?.recommended_tools).toBeUndefined();
		});

		it('should handle empty previous_steps array', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				previous_steps: [],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps).toBeDefined();
			expect(normalized.previous_steps).toHaveLength(0);
		});

		it('should handle missing previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps).toBeUndefined();
		});

		it('should fill in default confidence (0.5) for missing tool confidence in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Previous step',
						recommended_tools: [
							{
								tool_name: 'Grep',
								rationale: 'Search code',
								// Missing: confidence, priority
							},
						],
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.confidence).toBe(0.5);
		});

		it('should fill in default priority (999) for missing tool priority in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Previous step',
						recommended_tools: [
							{
								tool_name: 'Read',
								rationale: 'Read file',
								// Missing: priority
							},
						],
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.priority).toBe(999);
		});

		it('should fill in default rationale (empty string) for missing tool rationale in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Previous step',
						recommended_tools: [
							{
								tool_name: 'Task',
								// Missing: rationale
							},
						],
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.rationale).toBe('');
		});

		it('should fill in default expected_outcome (empty string) for missing in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Previous step',
						recommended_tools: [
							{
								tool_name: 'Grep',
								rationale: 'Search code',
							},
						],
						// Missing: expected_outcome
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps?.[0]?.expected_outcome).toBe('');
		});

		it('should preserve existing confidence and priority when present in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Previous step',
						recommended_tools: [
							{
								tool_name: 'Grep',
								rationale: 'Search code',
								confidence: 0.8,
								priority: 2,
							},
						],
						expected_outcome: 'Files found',
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.confidence).toBe(0.8);
			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.priority).toBe(2);
			expect(normalized.previous_steps?.[0]?.expected_outcome).toBe('Files found');
		});

		it('should handle mixed complete and partial tool recommendations in previous_steps', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				previous_steps: [
					{
						step_description: 'Step 1 - partial',
						recommended_tools: [
							{
								tool_name: 'Read',
								rationale: 'Read file',
							},
						],
					},
					{
						step_description: 'Step 2 - complete',
						recommended_tools: [
							{
								tool_name: 'Grep',
								rationale: 'Search code',
								confidence: 0.9,
								priority: 1,
							},
						],
						expected_outcome: 'Found matches',
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			// Step 1 should have defaults filled in
			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.confidence).toBe(0.5);
			expect(normalized.previous_steps?.[0]?.recommended_tools?.[0]?.priority).toBe(999);
			expect(normalized.previous_steps?.[0]?.expected_outcome).toBe('');

			// Step 2 should preserve original values
			expect(normalized.previous_steps?.[1]?.recommended_tools?.[0]?.confidence).toBe(0.9);
			expect(normalized.previous_steps?.[1]?.recommended_tools?.[0]?.priority).toBe(1);
			expect(normalized.previous_steps?.[1]?.expected_outcome).toBe('Found matches');
		});
	});

	describe('edge cases', () => {
		it('should handle null input', () => {
			const normalized = normalizeInput(null) as ThoughtData;
			expect(normalized).toBeNull();
		});

		it('should handle non-object input', () => {
			const normalized = normalizeInput('string') as ThoughtData;
			expect(normalized).toBe('string');
		});

		it('normalizes documented plural fields in current_step and previous_steps together', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				current_step: {
					step_description: 'Current step',
					recommended_tools: [createToolRecommendation({ tool_name: 'current-tool' })],
					expected_outcome: 'Current outcome',
				},
				previous_steps: [
					{
						step_description: 'Previous step',
						recommended_tools: [createToolRecommendation({ tool_name: 'prev-tool' })],
						expected_outcome: 'Previous outcome',
					},
				],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step?.recommended_tools).toBeDefined();
			expect(normalized.previous_steps?.[0]?.recommended_tools).toBeDefined();
		});

		it('should not modify other fields', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				available_mcp_tools: ['tool1', 'tool2'],
				available_skills: ['skill1'],
				remaining_steps: ['Step 3', 'Step 4'],
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.thought).toBe('Test thought');
			expect(normalized.thought_number).toBe(1);
			expect(normalized.total_thoughts).toBe(1);
			expect(normalized.next_thought_needed).toBe(false);
			expect(normalized.available_mcp_tools).toEqual(['tool1', 'tool2']);
			expect(normalized.available_skills).toEqual(['skill1']);
			expect(normalized.remaining_steps).toEqual(['Step 3', 'Step 4']);
		});
	});
});

describe('skill normalization (Bug 1 fix)', () => {
	it('should fill in default confidence (0.5) for missing skill confidence', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test' }],
				recommended_skills: [{ skill_name: 'ast-grep' }],
				expected_outcome: 'Test outcome',
			},
		} as unknown;

		const normalized = normalizeInput(input) as ThoughtData;
		expect(normalized.current_step?.recommended_skills?.[0]?.confidence).toBe(0.5);
	});

	it('should fill in default rationale (empty string) for missing skill rationale', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test' }],
				recommended_skills: [{ skill_name: 'ast-grep', confidence: 0.8 }],
				expected_outcome: 'Test outcome',
			},
		} as unknown;

		const normalized = normalizeInput(input) as ThoughtData;
		expect(normalized.current_step?.recommended_skills?.[0]?.rationale).toBe('');
	});

	it('should fill in default priority (999) for missing skill priority', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test' }],
				recommended_skills: [{ skill_name: 'ast-grep' }],
				expected_outcome: 'Test outcome',
			},
		} as unknown;

		const normalized = normalizeInput(input) as ThoughtData;
		expect(normalized.current_step?.recommended_skills?.[0]?.priority).toBe(999);
	});

	it('should preserve existing skill confidence and rationale when present', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test' }],
				recommended_skills: [{ skill_name: 'ast-grep', confidence: 0.85, rationale: 'AST search' }],
				expected_outcome: 'Test outcome',
			},
		} as unknown;

		const normalized = normalizeInput(input) as ThoughtData;
		expect(normalized.current_step?.recommended_skills?.[0]?.confidence).toBe(0.85);
		expect(normalized.current_step?.recommended_skills?.[0]?.rationale).toBe('AST search');
	});

	it('should normalize skills in previous_steps with defaults', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			previous_steps: [
				{
					step_description: 'Previous step',
					recommended_tools: [{ tool_name: 'Grep', rationale: 'Search code' }],
					recommended_skills: [{ skill_name: 'commit' }],
				},
			],
		} as unknown;

		const normalized = normalizeInput(input) as ThoughtData;
		expect(normalized.previous_steps?.[0]?.recommended_skills?.[0]?.confidence).toBe(0.5);
		expect(normalized.previous_steps?.[0]?.recommended_skills?.[0]?.rationale).toBe('');
		expect(normalized.previous_steps?.[0]?.recommended_skills?.[0]?.priority).toBe(999);
	});
});

describe('reasoning fields normalization', () => {
	function createMinimalInput(overrides: Record<string, unknown> = {}): unknown {
		return {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			...overrides,
		};
	}

	describe('thought_type', () => {
		it('should default thought_type to regular when missing', () => {
			const normalized = normalizeInput(createMinimalInput()) as ThoughtData;
			expect(normalized.thought_type).toBe('regular');
		});

		it('should preserve thought_type when provided', () => {
			const normalized = normalizeInput(
				createMinimalInput({ thought_type: 'hypothesis' })
			) as ThoughtData;
			expect(normalized.thought_type).toBe('hypothesis');
		});
	});

	describe('quality_score', () => {
		it('should clamp quality_score above 1 to 1', () => {
			const normalized = normalizeInput(createMinimalInput({ quality_score: 1.5 })) as ThoughtData;
			expect(normalized.quality_score).toBe(1);
		});

		it('should clamp quality_score below 0 to 0', () => {
			const normalized = normalizeInput(createMinimalInput({ quality_score: -0.3 })) as ThoughtData;
			expect(normalized.quality_score).toBe(0);
		});

		it('should leave quality_score within range unchanged', () => {
			const normalized = normalizeInput(createMinimalInput({ quality_score: 0.75 })) as ThoughtData;
			expect(normalized.quality_score).toBe(0.75);
		});
	});

	describe('confidence', () => {
		it('should clamp confidence above 1 to 1', () => {
			const normalized = normalizeInput(createMinimalInput({ confidence: 2.0 })) as ThoughtData;
			expect(normalized.confidence).toBe(1);
		});

		it('should clamp confidence below 0 to 0', () => {
			const normalized = normalizeInput(createMinimalInput({ confidence: -1 })) as ThoughtData;
			expect(normalized.confidence).toBe(0);
		});

		it('should leave confidence within range unchanged', () => {
			const normalized = normalizeInput(createMinimalInput({ confidence: 0.9 })) as ThoughtData;
			expect(normalized.confidence).toBe(0.9);
		});
	});

	describe('verification_result', () => {
		it('preserves numeric zero without treating it as absent', () => {
			const normalized = normalizeInput(createMinimalInput({ verification_result: 0 }));

			expect(normalized.verification_result).toBe(0);
		});

		it.each(['0', '1', true, false])('does not coerce boundary value %j', (actual) => {
			const normalized = normalizeInput(createMinimalInput({ verification_result: actual }));

			expect(normalized.verification_result).toBe(actual);
		});
	});

	describe('hypothesis_id', () => {
		it('should pass through valid hypothesis_id', () => {
			const normalized = normalizeInput(
				createMinimalInput({ hypothesis_id: 'perf-bottleneck-1' })
			) as ThoughtData;
			expect(normalized.hypothesis_id).toBe('perf-bottleneck-1');
		});

		it('should throw ValidationError for invalid hypothesis_id', () => {
			expect(() =>
				normalizeInput(createMinimalInput({ hypothesis_id: '../etc/passwd' }))
			).toThrow();
		});
	});

	describe('synthesis_sources', () => {
		it('should filter out non-positive values from synthesis_sources', () => {
			const normalized = normalizeInput(
				createMinimalInput({ synthesis_sources: [1, -2, 0, 3, 4.5, 'bad'] })
			) as ThoughtData;
			expect(normalized.synthesis_sources).toEqual([1, 3]);
		});

		it('should keep valid positive integers in synthesis_sources', () => {
			const normalized = normalizeInput(
				createMinimalInput({ synthesis_sources: [2, 5, 7] })
			) as ThoughtData;
			expect(normalized.synthesis_sources).toEqual([2, 5, 7]);
		});
	});

	describe('merge_from_thoughts', () => {
		it('should filter out non-positive values from merge_from_thoughts', () => {
			const normalized = normalizeInput(
				createMinimalInput({ merge_from_thoughts: [4, -1, 0, 8, 3.14] })
			) as ThoughtData;
			expect(normalized.merge_from_thoughts).toEqual([4, 8]);
		});

		it('should keep valid positive integers in merge_from_thoughts', () => {
			const normalized = normalizeInput(
				createMinimalInput({ merge_from_thoughts: [1, 2, 3] })
			) as ThoughtData;
			expect(normalized.merge_from_thoughts).toEqual([1, 2, 3]);
		});
	});

	describe('merge_branch_ids', () => {
		it('should sanitize valid merge_branch_ids entries', () => {
			const normalized = normalizeInput(
				createMinimalInput({ merge_branch_ids: ['explore-a', 'explore_b'] })
			) as ThoughtData;
			expect(normalized.merge_branch_ids).toEqual(['explore-a', 'explore_b']);
		});

		it('should throw for invalid merge_branch_ids entries', () => {
			expect(() =>
				normalizeInput(createMinimalInput({ merge_branch_ids: ['valid', '../bad'] }))
			).toThrow();
		});
	});

	describe('reasoning_depth', () => {
		it('should default reasoning_depth to moderate for hypothesis type', () => {
			const normalized = normalizeInput(
				createMinimalInput({ thought_type: 'hypothesis' })
			) as ThoughtData;
			expect(normalized.reasoning_depth).toBe('moderate');
		});

		it('should default reasoning_depth to moderate for verification type', () => {
			const normalized = normalizeInput(
				createMinimalInput({ thought_type: 'verification' })
			) as ThoughtData;
			expect(normalized.reasoning_depth).toBe('moderate');
		});

		it('should NOT default reasoning_depth for regular type', () => {
			const normalized = normalizeInput(
				createMinimalInput({ thought_type: 'regular' })
			) as ThoughtData;
			expect(normalized.reasoning_depth).toBeUndefined();
		});

		it('should preserve reasoning_depth when already provided', () => {
			const normalized = normalizeInput(
				createMinimalInput({ thought_type: 'hypothesis', reasoning_depth: 'deep' })
			) as ThoughtData;
			expect(normalized.reasoning_depth).toBe('deep');
		});
	});

	describe('current contract', () => {
		it('normalizes documented recommendation and reasoning fields together', () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				branch_id: 'my-branch',
				thought_type: 'synthesis',
				quality_score: 0.85,
				confidence: 0.9,
				synthesis_sources: [1, 2],
				current_step: {
					step_description: 'Test step',
					recommended_tools: [createToolRecommendation()],
					expected_outcome: 'Test outcome',
				},
			} as unknown;

			const normalized = normalizeInput(input) as ThoughtData;

			expect(normalized.current_step?.recommended_tools).toBeDefined();
			expect(normalized.branch_id).toBe('my-branch');
			expect(normalized.thought_type).toBe('synthesis');
			expect(normalized.quality_score).toBe(0.85);
			expect(normalized.confidence).toBe(0.9);
			expect(normalized.synthesis_sources).toEqual([1, 2]);
		});
	});

	describe('normalizeReasoningFields direct usage', () => {
		it('should mutate the input object in place', () => {
			const input: Record<string, unknown> = {};
			normalizeReasoningFields(input);
			expect(input.thought_type).toBe('regular');
		});
	});
});

describe('sanitizeRecursive', () => {
	it('should sanitize a string with dangerous HTML tags', () => {
		expect(sanitizeRecursive('<script>x</script>')).toBe('x');
	});

	it('should pass through numbers unchanged', () => {
		expect(sanitizeRecursive(42)).toBe(42);
	});

	it('should pass through null unchanged', () => {
		expect(sanitizeRecursive(null)).toBeNull();
	});

	it('should sanitize strings inside arrays', () => {
		expect(sanitizeRecursive(['a\x00b', 'c'])).toEqual(['ab', 'c']);
	});

	it('should sanitize deeply nested object strings', () => {
		expect(sanitizeRecursive({ a: { b: '<iframe>x' } })).toEqual({ a: { b: 'x' } });
	});

	it('should pass through booleans unchanged', () => {
		expect(sanitizeRecursive(true)).toBe(true);
	});

	it('should pass through undefined unchanged', () => {
		expect(sanitizeRecursive(undefined)).toBeUndefined();
	});

	it('should return Date objects as-is (non-plain object)', () => {
		const date = new Date('2024-01-01');
		expect(sanitizeRecursive(date)).toBe(date);
	});

	it('should return RegExp objects as-is (non-plain object)', () => {
		const regex = /test/gi;
		expect(sanitizeRecursive(regex)).toBe(regex);
	});

	it('should handle objects with null prototype', () => {
		const obj = Object.create(null) as Record<string, unknown>;
		obj.key = '<script>x</script>';
		const result = sanitizeRecursive(obj) as Record<string, unknown>;
		expect(result.key).toBe('x');
	});

	it('should handle mixed nested structures with non-plain objects', () => {
		const date = new Date();
		const input = { a: '<script>x</script>', b: date, c: { d: 42 } };
		const result = sanitizeRecursive(input) as Record<string, unknown>;
		expect(result.a).toBe('x');
		expect(result.b).toBe(date);
		expect(result.c).toEqual({ d: 42 });
	});

	it('should handle arrays containing null and undefined', () => {
		expect(sanitizeRecursive([null, undefined, 'a'])).toEqual([null, undefined, 'a']);
	});
});

describe('suggested_inputs sanitization', () => {
	function createInputWithSuggestedInputs(suggestedInputs: Record<string, unknown>): unknown {
		return {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [createToolRecommendation({ suggested_inputs: suggestedInputs })],
				expected_outcome: 'Test outcome',
			},
		};
	}

	it('should pass through non-HTML strings unchanged', () => {
		const normalized = normalizeInput(
			createInputWithSuggestedInputs({ command: 'cat /etc/passwd' })
		) as ThoughtData;
		const tool = normalized.current_step?.recommended_tools?.[0];
		expect(tool?.suggested_inputs).toEqual({ command: 'cat /etc/passwd' });
	});

	it('should strip dangerous HTML tags from string values', () => {
		const normalized = normalizeInput(
			createInputWithSuggestedInputs({ cmd: '<script>alert(1)</script>' })
		) as ThoughtData;
		const tool = normalized.current_step?.recommended_tools?.[0];
		expect(tool?.suggested_inputs).toEqual({ cmd: 'alert(1)' });
	});

	it('should drop nested object values (flat-primitives only)', () => {
		const normalized = normalizeInput(
			createInputWithSuggestedInputs({ nested: { deep: 'a\x00b' }, kept: 'ok' })
		) as ThoughtData;
		const tool = normalized.current_step?.recommended_tools?.[0];
		expect(tool?.suggested_inputs).toEqual({ kept: 'ok' });
	});

	it('should drop array values (flat-primitives only)', () => {
		const normalized = normalizeInput(
			createInputWithSuggestedInputs({ arr: ['<iframe>x'], kept: 'ok' })
		) as ThoughtData;
		const tool = normalized.current_step?.recommended_tools?.[0];
		expect(tool?.suggested_inputs).toEqual({ kept: 'ok' });
	});

	it('should leave safe strings unchanged', () => {
		const normalized = normalizeInput(
			createInputWithSuggestedInputs({ safe: 'normal text' })
		) as ThoughtData;
		const tool = normalized.current_step?.recommended_tools?.[0];
		expect(tool?.suggested_inputs).toEqual({ safe: 'normal text' });
	});

	it('should leave non-string values unchanged', () => {
		const normalized = normalizeInput(
			createInputWithSuggestedInputs({ num: 42, bool: true })
		) as ThoughtData;
		const tool = normalized.current_step?.recommended_tools?.[0];
		expect(tool?.suggested_inputs).toEqual({ num: 42, bool: true });
	});
});

describe('session_id sanitization', () => {
	const baseInput = {
		thought: 'Test thought',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
	};

	it('passes through valid session_id unchanged', () => {
		const result = normalizeInput({ ...baseInput, session_id: 'analysis-task-42' }) as ThoughtData;
		expect(result.session_id).toBe('analysis-task-42');
	});

	it('rejects control characters in explicit session_id', () => {
		expect(() => normalizeInput({ ...baseInput, session_id: 'session\x00name' })).toThrowError(
			ValidationError
		);
	});

	it('rejects session_id with invalid characters', () => {
		expect(() => normalizeInput({ ...baseInput, session_id: 'bad session!' })).toThrowError(
			ValidationError
		);
	});

	it('rejects session_id exceeding 100 characters', () => {
		expect(() => normalizeInput({ ...baseInput, session_id: 'a'.repeat(101) })).toThrowError(
			ValidationError
		);
	});

	it('rejects session_id containing path traversal sequences', () => {
		expect(() => normalizeInput({ ...baseInput, session_id: '../etc/passwd' })).toThrowError(
			ValidationError
		);
	});

	it('rejects the retired global session_id', () => {
		expect(() => normalizeRawInput({ ...baseInput, session_id: '__global__' })).toThrowError(
			"Validation failed for 'session_id': reserved value '__global__' is retired; use an explicit named session"
		);
	});
});
