import { describe, it, expect } from 'vitest';
import {
	JsonRpcRequestSchema,
	SequentialThinkingSchema,
	SEQUENTIAL_THINKING_TOOL,
	ToolRecommendationSchema,
	StepRecommendationSchema,
	PartialToolRecommendationSchema,
	PartialStepRecommendationSchema,
	SkillRecommendationSchema,
} from '../schema.js';
import { safeParse } from 'valibot';

const TEST_SESSION_ID = 'schema-test';

function parseThought(input: Record<string, unknown>) {
	return safeParse(SequentialThinkingSchema, { session_id: TEST_SESSION_ID, ...input });
}

describe('JsonRpcRequestSchema envelope contract', () => {
	it.each([
		['string', 'request-42'],
		['number', 42],
		['null', null],
		['omitted', undefined],
	])('accepts a valid %s request ID', (_kind, id) => {
		const request = {
			jsonrpc: '2.0',
			method: 'tools/list',
			...(id === undefined ? {} : { id }),
		};

		const result = safeParse(JsonRpcRequestSchema, request);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.id).toBe(id);
		}
	});

	it.each([
		['missing jsonrpc', { id: 1, method: 'tools/list' }],
		['wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'tools/list' }],
		['missing method', { jsonrpc: '2.0', id: 1 }],
		['empty method', { jsonrpc: '2.0', id: 1, method: '' }],
		['boolean ID', { jsonrpc: '2.0', id: true, method: 'tools/list' }],
		['object ID', { jsonrpc: '2.0', id: { value: 1 }, method: 'tools/list' }],
		['scalar params', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: 'invalid' }],
	])('rejects an envelope with %s', (_case, request) => {
		const result = safeParse(JsonRpcRequestSchema, request);

		expect(result.success).toBe(false);
	});

	it('drops unknown envelope fields while retaining known fields', () => {
		const result = safeParse(JsonRpcRequestSchema, {
			jsonrpc: '2.0',
			id: 'known-fields',
			method: 'tools/list',
			params: {},
			unknownEnvelopeField: 'not-protocol-data',
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output).toEqual({
				jsonrpc: '2.0',
				id: 'known-fields',
				method: 'tools/list',
				params: {},
			});
		}
	});

	it('preserves object params including nested objects and arrays', () => {
		const params = {
			name: 'echo',
			arguments: {
				value: 'expected',
				nested: { enabled: true, values: [1, 'two', null] },
			},
		};

		const result = safeParse(JsonRpcRequestSchema, {
			jsonrpc: '2.0',
			id: 'nested-request',
			method: 'tools/call',
			params,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.params).toEqual(params);
		}
	});

	it('preserves positional array params including nested JSON values', () => {
		const params = ['echo', { nested: [1, true, null] }];

		const result = safeParse(JsonRpcRequestSchema, {
			jsonrpc: '2.0',
			id: 'positional-request',
			method: 'tools/call',
			params,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.params).toEqual(params);
		}
	});
});

describe('SequentialThinkingSchema', () => {
	const validInput = {
		available_mcp_tools: ['mcp-omnisearch', 'mcp-turso-cloud'],
		available_skills: ['commit', 'review-pr'],
		thought: 'This is a test thought',
		thought_number: 1,
		total_thoughts: 5,
		next_thought_needed: true,
		current_step: {
			step_description: 'Test step',
			recommended_tools: [
				{
					tool_name: 'mcp-omnisearch',
					confidence: 0.9,
					rationale: 'Test rationale',
					priority: 1,
				},
			],
			expected_outcome: 'Expected result',
		},
	};

	it('should validate valid input', () => {
		const result = parseThought(validInput);
		expect(result.success).toBe(true);
	});

	it('should require thought field', () => {
		const result = parseThought({
			thought_number: 1,
			total_thoughts: 5,
		});
		expect(result.success).toBe(false);
	});

	it('should require thought_number >= 1', () => {
		const result = parseThought({
			thought: 'test',
			thought_number: 0,
			total_thoughts: 5,
		});
		expect(result.success).toBe(false);
	});

	it('should require total_thoughts >= 1', () => {
		const result = parseThought({
			thought: 'test',
			thought_number: 1,
			total_thoughts: 0,
		});
		expect(result.success).toBe(false);
	});

	it('should validate confidence range 0-1', () => {
		const invalidTool = { ...validInput };
		if (invalidTool.current_step && invalidTool.current_step.recommended_tools) {
			invalidTool.current_step.recommended_tools[0]!.confidence = 1.5;
		}
		const result = parseThought(invalidTool);
		expect(result.success).toBe(false);
	});

	it('should accept optional fields', () => {
		const minimalInput = {
			thought: 'Minimal thought',
			thought_number: 1,
			total_thoughts: 1,
		};
		const result = parseThought(minimalInput);
		expect(result.success).toBe(true);
	});

	it('should validate skill recommendations', () => {
		const withSkills = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 5,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [
					{
						tool_name: 'mcp-omnisearch',
						confidence: 0.9,
						rationale: 'Test rationale',
						priority: 1,
					},
				],
				recommended_skills: [
					{
						skill_name: 'commit',
						confidence: 0.95,
						rationale: 'Handles git commits',
						priority: 1,
					},
				],
				expected_outcome: 'Expected result',
			},
		};
		const result = parseThought(withSkills);
		expect(result.success).toBe(true);
	});

	it('should validate revision fields', () => {
		const withRevision = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 5,
			is_revision: true,
			revises_thought: 1,
		};
		const result = parseThought(withRevision);
		expect(result.success).toBe(true);
	});

	it('should validate branching fields', () => {
		const withBranch = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 5,
			branch_from_thought: 1,
			branch_id: 'test-branch',
		};
		const result = parseThought(withBranch);
		expect(result.success).toBe(true);
	});

	it.each([0, 1] as const)('accepts verification_result %i as an exact outcome label', (actual) => {
		const result = parseThought({
			thought: 'Result-bearing verification',
			thought_number: 2,
			total_thoughts: 2,
			thought_type: 'verification',
			verification_target: 1,
			verification_result: actual,
		});

		expect(result.success).toBe(true);
		if (result.success) expect(result.output.verification_result).toBe(actual);
	});

	it.each([2, -1, 0.5, '1', true, false, null])(
		'rejects non-binary verification_result %j',
		(actual) => {
			const result = parseThought({
				thought: 'Invalid result-bearing verification',
				thought_number: 2,
				total_thoughts: 2,
				thought_type: 'verification',
				verification_target: 1,
				verification_result: actual,
			});

			expect(result.success).toBe(false);
		}
	);

	it('publishes verification_result on the MCP tool description', () => {
		expect(SEQUENTIAL_THINKING_TOOL.description).toContain('verification_result');
	});
});

describe('PartialToolRecommendationSchema', () => {
	it('should validate minimal valid input (only required fields)', () => {
		const minimal = {
			tool_name: 'Read',
			rationale: 'Read the file',
		};
		const result = safeParse(PartialToolRecommendationSchema, minimal);
		expect(result.success).toBe(true);
	});

	it('should accept optional confidence field', () => {
		const withConfidence = {
			tool_name: 'Grep',
			rationale: 'Search code',
			confidence: 0.8,
		};
		const result = safeParse(PartialToolRecommendationSchema, withConfidence);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.confidence).toBe(0.8);
		}
	});

	it('should accept optional priority field', () => {
		const withPriority = {
			tool_name: 'Write',
			rationale: 'Write to file',
			priority: 5,
		};
		const result = safeParse(PartialToolRecommendationSchema, withPriority);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.priority).toBe(5);
		}
	});

	it('should accept all optional fields', () => {
		const complete = {
			tool_name: 'Edit',
			rationale: 'Edit file',
			confidence: 0.9,
			priority: 1,
			suggested_inputs: { filePath: '/path/to/file' },
			alternatives: ['Write'],
		};
		const result = safeParse(PartialToolRecommendationSchema, complete);
		expect(result.success).toBe(true);
	});

	it('should validate confidence range 0-1 when provided', () => {
		const invalidConfidence = {
			tool_name: 'Read',
			rationale: 'Read file',
			confidence: 1.5,
		};
		const result = safeParse(PartialToolRecommendationSchema, invalidConfidence);
		expect(result.success).toBe(false);
	});

	it('should require tool_name', () => {
		const missingToolName = {
			rationale: 'Some rationale',
		};
		const result = safeParse(PartialToolRecommendationSchema, missingToolName);
		expect(result.success).toBe(false);
	});

	it('should accept tool with only tool_name (rationale optional)', () => {
		const minimalTool = {
			tool_name: 'Read',
		};
		const result = safeParse(PartialToolRecommendationSchema, minimalTool);
		expect(result.success).toBe(true);
		// Note: rationale will be undefined here, defaults are filled by InputNormalizer
	});
});

describe('PartialStepRecommendationSchema', () => {
	it('should validate minimal valid input (only required fields)', () => {
		const minimal = {
			step_description: 'Read the file',
			recommended_tools: [
				{
					tool_name: 'Read',
					rationale: 'Read the file',
				},
			],
		};
		const result = safeParse(PartialStepRecommendationSchema, minimal);
		expect(result.success).toBe(true);
	});

	it('should accept optional expected_outcome field', () => {
		const withOutcome = {
			step_description: 'Search code',
			recommended_tools: [
				{
					tool_name: 'Grep',
					rationale: 'Search for pattern',
				},
			],
			expected_outcome: 'List of matching files',
		};
		const result = safeParse(PartialStepRecommendationSchema, withOutcome);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.expected_outcome).toBe('List of matching files');
		}
	});

	it('should accept optional recommended_skills field', () => {
		const withSkills = {
			step_description: 'Commit changes',
			recommended_tools: [
				{
					tool_name: 'Bash',
					rationale: 'Run git commands',
				},
			],
			recommended_skills: [
				{
					skill_name: 'commit',
					confidence: 0.95,
					rationale: 'Handles git commit workflow',
					priority: 1,
				},
			],
		};
		const result = safeParse(PartialStepRecommendationSchema, withSkills);
		expect(result.success).toBe(true);
	});

	it('should accept optional next_step_conditions field', () => {
		const withConditions = {
			step_description: 'Analyze data',
			recommended_tools: [
				{
					tool_name: 'Read',
					rationale: 'Read data file',
				},
			],
			next_step_conditions: ['Data loaded successfully', 'No errors encountered'],
		};
		const result = safeParse(PartialStepRecommendationSchema, withConditions);
		expect(result.success).toBe(true);
	});

	it('should accept partial tool recommendations (missing confidence/priority)', () => {
		const partialTools = {
			step_description: 'Multi-step process',
			recommended_tools: [
				{
					tool_name: 'Read',
					rationale: 'Read file',
				},
				{
					tool_name: 'Grep',
					rationale: 'Search code',
					confidence: 0.8,
				},
				{
					tool_name: 'Write',
					rationale: 'Write output',
					priority: 1,
				},
			],
		};
		const result = safeParse(PartialStepRecommendationSchema, partialTools);
		expect(result.success).toBe(true);
	});

	it('should require step_description', () => {
		const missingDescription = {
			recommended_tools: [
				{
					tool_name: 'Read',
					rationale: 'Read file',
				},
			],
		};
		const result = safeParse(PartialStepRecommendationSchema, missingDescription);
		expect(result.success).toBe(false);
	});

	it('should require recommended_tools array', () => {
		const missingTools = {
			step_description: 'Do something',
		};
		const result = safeParse(PartialStepRecommendationSchema, missingTools);
		expect(result.success).toBe(false);
	});
});

describe('SequentialThinkingSchema with lenient previous_steps', () => {
	it('should accept partial previous_steps (missing confidence/priority/expected_outcome)', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 2,
			total_thoughts: 3,
			next_thought_needed: true,
			current_step: {
				step_description: 'Current step',
				recommended_tools: [
					{
						tool_name: 'Read',
						confidence: 0.9,
						rationale: 'Read file',
						priority: 1,
					},
				],
				expected_outcome: 'File read successfully',
			},
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
					// Missing: expected_outcome
				},
			],
		};
		const result = parseThought(input);
		expect(result.success).toBe(true);
	});

	it('should accept current_step with missing priority (uses default 999)', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 2,
			current_step: {
				step_description: 'Current step',
				recommended_tools: [
					{
						tool_name: 'Read',
						confidence: 0.9,
						rationale: 'Read file',
						// priority is optional, InputNormalizer fills in default 999
					},
				],
				expected_outcome: 'File read successfully',
			},
		};
		const result = parseThought(input);
		expect(result.success).toBe(true);
		// Verify priority was not in input (optional field)
		expect((result.output as Record<string, unknown>).current_step).toBeDefined();
	});

	it('should validate confidence range in previous_steps when provided', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 2,
			total_thoughts: 2,
			previous_steps: [
				{
					step_description: 'Previous step',
					recommended_tools: [
						{
							tool_name: 'Grep',
							rationale: 'Search code',
							confidence: 1.5, // Invalid - should fail
						},
					],
				},
			],
		};
		const result = parseThought(input);
		expect(result.success).toBe(false);
	});
});

describe('SkillRecommendationSchema - optional fields (Bug 1 fix)', () => {
	it('should accept skill with only skill_name (confidence/rationale optional)', () => {
		const minimal = { skill_name: 'ast-grep' };
		const result = safeParse(SkillRecommendationSchema, minimal);
		expect(result.success).toBe(true);
	});

	it('should accept skill with only skill_name and confidence', () => {
		const minimal = { skill_name: 'ast-grep', confidence: 0.8 };
		const result = safeParse(SkillRecommendationSchema, minimal);
		expect(result.success).toBe(true);
	});

	it('should accept skill with only skill_name and rationale', () => {
		const minimal = { skill_name: 'ast-grep', rationale: 'Need AST search' };
		const result = safeParse(SkillRecommendationSchema, minimal);
		expect(result.success).toBe(true);
	});

	it('should accept full skill recommendation', () => {
		const full = {
			skill_name: 'commit',
			confidence: 0.95,
			rationale: 'Handles git commits',
			priority: 1,
		};
		const result = safeParse(SkillRecommendationSchema, full);
		expect(result.success).toBe(true);
	});

	it('should reject confidence outside 0-1 range', () => {
		const invalid = { skill_name: 'ast-grep', confidence: 1.5 };
		const result = safeParse(SkillRecommendationSchema, invalid);
		expect(result.success).toBe(false);
	});

	it('should require skill_name', () => {
		const missing = { confidence: 0.5, rationale: 'test' };
		const result = safeParse(SkillRecommendationSchema, missing);
		expect(result.success).toBe(false);
	});

	it('should accept minimal skill in current_step via SequentialThinkingSchema', () => {
		const input = {
			thought: 'Test thought',
			thought_number: 1,
			total_thoughts: 1,
			current_step: {
				step_description: 'Test step',
				recommended_tools: [{ tool_name: 'Read', confidence: 0.9, rationale: 'test' }],
				recommended_skills: [{ skill_name: 'ast-grep' }],
				expected_outcome: 'Done',
			},
		};
		const result = parseThought(input);
		expect(result.success).toBe(true);
	});
});

describe('Schema accepts raw strings (sanitization moved to InputNormalizer)', () => {
	describe('SequentialThinkingSchema', () => {
		it('should accept strings with script tags (no schema-level sanitization)', () => {
			const result = parseThought({
				thought: '<script>alert(1)</script>hello',
				thought_number: 1,
				total_thoughts: 1,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.thought).toBe('<script>alert(1)</script>hello');
			}
		});

		it('should preserve TypeScript generics in thought field', () => {
			const result = parseThought({
				thought: 'Array<string> and Map<string, number>',
				thought_number: 1,
				total_thoughts: 1,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.thought).toBe('Array<string> and Map<string, number>');
			}
		});

		it('should accept strings with null bytes (no schema-level sanitization)', () => {
			const result = parseThought({
				thought: 'hello\x00world',
				thought_number: 1,
				total_thoughts: 1,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.thought).toBe('hello\x00world');
			}
		});

		it('should accept remaining_steps with HTML tags (no schema-level sanitization)', () => {
			const result = parseThought({
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				remaining_steps: ['<iframe>evil</iframe>step1', 'normal step'],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.remaining_steps).toEqual([
					'<iframe>evil</iframe>step1',
					'normal step',
				]);
			}
		});

		it('should accept meta_observation with HTML tags (no schema-level sanitization)', () => {
			const result = parseThought({
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				meta_observation: '<img onerror=alert(1) src=x>observation',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.meta_observation).toBe('<img onerror=alert(1) src=x>observation');
			}
		});
	});

	describe('StepRecommendationSchema', () => {
		it('should accept step fields with HTML tags (no schema-level sanitization)', () => {
			const result = safeParse(StepRecommendationSchema, {
				step_description: '<script>evil</script>step',
				recommended_tools: [],
				expected_outcome: '<iframe>bad</iframe>result',
				next_step_conditions: ['<style>.x{}</style>cond'],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.step_description).toBe('<script>evil</script>step');
				expect(result.output.expected_outcome).toBe('<iframe>bad</iframe>result');
				expect(result.output.next_step_conditions).toEqual(['<style>.x{}</style>cond']);
			}
		});
	});

	describe('ToolRecommendationSchema', () => {
		it('should accept rationale with HTML tags (no schema-level sanitization)', () => {
			const result = safeParse(ToolRecommendationSchema, {
				tool_name: '<script>evil</script>',
				confidence: 0.8,
				rationale: '<script>evil</script>reason',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.tool_name).toBe('<script>evil</script>');
				expect(result.output.rationale).toBe('<script>evil</script>reason');
			}
		});
	});
});

describe('session_id and reset_state schema validation', () => {
	const baseInput = {
		thought: 'Test thought',
		thought_number: 1,
		total_thoughts: 1,
		session_id: 'schema-session',
	};

	it('should accept valid session_id', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			session_id: 'analysis-task-42',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.session_id).toBe('analysis-task-42');
		}
	});

	it('should reject session_id with special characters', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			session_id: 'bad session!',
		});
		expect(result.success).toBe(false);
	});

	it('should reject empty session_id', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			session_id: '',
		});
		expect(result.success).toBe(false);
	});

	it('should reject session_id exceeding 100 characters', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			session_id: 'a'.repeat(101),
		});
		expect(result.success).toBe(false);
	});

	it('rejects the retired global session_id with a clear issue', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			session_id: '__global__',
		});

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues.some(({ message }) => message.includes('retired'))).toBe(true);
		}
	});

	it('should accept reset_state true', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			reset_state: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.reset_state).toBe(true);
		}
	});

	it('should accept reset_state false', () => {
		const result = safeParse(SequentialThinkingSchema, {
			...baseInput,
			reset_state: false,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output.reset_state).toBe(false);
		}
	});

	it('requires an explicit session_id', () => {
		const result = safeParse(SequentialThinkingSchema, {
			thought: baseInput.thought,
			thought_number: baseInput.thought_number,
			total_thoughts: baseInput.total_thoughts,
		});

		expect(result.success).toBe(false);
	});
});
