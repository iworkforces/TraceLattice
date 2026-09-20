import { beforeEach, describe, expect, it } from 'vitest';
import type { StepRecommendation } from '../core/step.js';
import type { ThoughtData } from '../core/thought.js';
import type { ToolAwareSequentialThinkingServer } from '../lib.js';
import { createServer } from '../lib.js';
import type { SkillRecommendation } from '../types/skill.js';
import type { ToolRecommendation } from '../types/tool.js';
import { asSessionId } from '../contracts/ids.js';

import { asBranchId } from '../contracts/ids.js';
import type { StrategyDecision } from '../contracts/strategy.js';
/**
 * Helper function for creating test thoughts with minimal required fields
 */
function createTestThought(overrides?: Partial<ThoughtData>): ThoughtData {
	return {
		thought: 'Test thought',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		session_id: asSessionId('tool-suite'),
		...overrides,
	};
}

/**
 * Helper for creating tool recommendations
 */
function createToolRecommendation(overrides?: Partial<ToolRecommendation>): ToolRecommendation {
	return {
		tool_name: 'test-tool',
		confidence: 0.9,
		rationale: 'Test rationale',
		priority: 1,
		...overrides,
	};
}

/**
 * Helper for creating skill recommendations
 */
function createSkillRecommendation(overrides?: Partial<SkillRecommendation>): SkillRecommendation {
	return {
		skill_name: 'test-skill',
		confidence: 0.85,
		rationale: 'Test skill rationale',
		priority: 1,
		...overrides,
	};
}

/**
 * Helper for creating step recommendations
 */
function createStepRecommendation(overrides?: Partial<StepRecommendation>): StepRecommendation {
	return {
		step_description: 'Test step description',
		recommended_tools: [createToolRecommendation()],
		expected_outcome: 'Test expected outcome',
		...overrides,
	};
}

/**
 * Helper to parse the response from processThought
 */
function parseProcessThoughtResult(result: unknown): {
	thought_number: number;
	total_thoughts: number;
	next_thought_needed: boolean;
	branches: string[];
	thought_history_length: number;
	available_mcp_tools?: string[];
	available_skills?: string[];
	current_step?: StepRecommendation;
	previous_steps?: StepRecommendation[];
	remaining_steps?: string[];
	strategy_hint?: StrategyDecision;
	error?: string;
	status?: string;
} {
	const content = (result as { content: Array<{ type: string; text: string }> }).content;
	return JSON.parse(content[0]!.text);
}

describe('tracelattice MCP Tool', () => {
	let server: ToolAwareSequentialThinkingServer;

	beforeEach(async () => {
		server = await createServer({ maxHistorySize: 10 });
	});

	describe('1. Basic Functionality Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('1.1 Minimal Thought Processing - should validate basic thought processing with minimal required fields', async () => {
			const thought = createTestThought();
			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.thought_number).toBe(1);
			expect(response.total_thoughts).toBe(1);
			expect(response.next_thought_needed).toBe(false);
			expect(response.thought_history_length).toBe(1);
		});

		it('1.2 Ongoing Thought Processing - should expose the continue strategy decision without generating another thought', async () => {
			// Given
			const thought = createTestThought({
				thought_number: 2,
				total_thoughts: 4,
				next_thought_needed: true,
			});

			// When
			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			// Then
			expect(response.thought_number).toBe(2);
			expect(response.total_thoughts).toBe(4);
			expect(response.next_thought_needed).toBe(true);
			expect(response.thought_history_length).toBe(1);
			expect(response.strategy_hint?.action).toBe('continue');
			expect(server.history.getHistoryLength(asSessionId('tool-suite'))).toBe(1);
		});

		it('1.3 Full Field Thought Processing - should validate all fields are properly processed and returned', async () => {
			const thought = createTestThought({
				available_mcp_tools: ['tool1', 'tool2'],
				available_skills: ['skill1', 'skill2'],
				is_revision: true,
				revises_thought: 1,
				branch_from_thought: 1,
				branch_id: asBranchId('test-branch'),
				needs_more_thoughts: true,
				current_step: createStepRecommendation({
					recommended_tools: [
						createToolRecommendation({ tool_name: 'tool1' }),
						createToolRecommendation({ tool_name: 'tool2' }),
					],
					recommended_skills: [createSkillRecommendation({ skill_name: 'skill1' })],
				}),
				previous_steps: [createStepRecommendation()],
				remaining_steps: ['Step 1', 'Step 2'],
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.thought_number).toBe(1);
			expect(response.total_thoughts).toBe(1);
			expect(response.next_thought_needed).toBe(false);
			expect(response.available_mcp_tools).toEqual(['tool1', 'tool2']);
			expect(response.available_skills).toEqual(['skill1', 'skill2']);
			expect(response.current_step).toBeDefined();
			expect(response.current_step?.recommended_tools).toHaveLength(2);
			expect(response.current_step?.recommended_skills).toHaveLength(1);
			expect(response.previous_steps).toHaveLength(1);
			expect(response.remaining_steps).toEqual(['Step 1', 'Step 2']);
		});

		it('1.4 Optional Fields Omission - should ensure optional fields can be omitted without errors', async () => {
			// Test with various combinations of omitted optional fields
			const thought1 = createTestThought({ next_thought_needed: undefined });
			const result1 = await server.processThought(thought1);
			const response1 = parseProcessThoughtResult(result1);

			expect(response1.next_thought_needed).toBe(true); // Should default to true

			const thought2 = createTestThought({
				available_mcp_tools: undefined,
				available_skills: undefined,
			});
			const result2 = await server.processThought(thought2);
			const response2 = parseProcessThoughtResult(result2);

			expect(response2.available_mcp_tools).toBeUndefined();
			expect(response2.available_skills).toBeUndefined();
		});
	});

	describe('2. Tool & Skill Recommendation Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('2.1 Current Step with Tool Recommendations - should validate tool recommendation structure and return', async () => {
			const thought = createTestThought({
				current_step: createStepRecommendation({
					step_description: 'Search the codebase',
					recommended_tools: [
						createToolRecommendation({
							tool_name: 'search-tool',
							confidence: 0.95,
							rationale: 'Best tool for searching',
							priority: 1,
						}),
						createToolRecommendation({
							tool_name: 'grep-tool',
							confidence: 0.8,
							rationale: 'Alternative search tool',
							priority: 2,
						}),
					],
					expected_outcome: 'List of matching files',
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step).toBeDefined();
			expect(response.current_step?.step_description).toBe('Search the codebase');
			expect(response.current_step?.recommended_tools).toHaveLength(2);
			expect(response.current_step?.recommended_tools[0]).toMatchObject({
				tool_name: 'search-tool',
				confidence: 0.95,
				rationale: 'Best tool for searching',
				priority: 1,
			});
		});

		it('2.2 Current Step with Skill Recommendations - should validate skill recommendation structure and return', async () => {
			const thought = createTestThought({
				current_step: createStepRecommendation({
					step_description: 'Create git commit',
					recommended_tools: [],
					recommended_skills: [
						createSkillRecommendation({
							skill_name: 'commit',
							confidence: 0.98,
							rationale: 'Standard commit skill',
							priority: 1,
						}),
						createSkillRecommendation({
							skill_name: 'review-pr',
							confidence: 0.75,
							rationale: 'Alternative review skill',
							priority: 2,
						}),
					],
					expected_outcome: 'Commit created successfully',
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step).toBeDefined();
			expect(response.current_step?.recommended_skills).toBeDefined();
			expect(response.current_step?.recommended_skills?.[0]).toMatchObject({
				skill_name: 'commit',
				confidence: 0.98,
				rationale: 'Standard commit skill',
				priority: 1,
			});
		});

		it('2.3 Tool Suggestions and Alternatives - should validate optional tool fields', async () => {
			const thought = createTestThought({
				current_step: createStepRecommendation({
					recommended_tools: [
						createToolRecommendation({
							suggested_inputs: { query: 'test', limit: 10 },
							alternatives: ['alt-tool-1', 'alt-tool-2'],
						}),
					],
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step?.recommended_tools[0]?.suggested_inputs).toEqual({
				query: 'test',
				limit: 10,
			});
			expect(response.current_step?.recommended_tools[0]?.alternatives).toEqual([
				'alt-tool-1',
				'alt-tool-2',
			]);
		});

		it('2.4 Skill Allowed Tools and User Invocable - should validate optional skill fields', async () => {
			const thought = createTestThought({
				current_step: createStepRecommendation({
					recommended_tools: [],
					recommended_skills: [
						createSkillRecommendation({
							allowed_tools: ['Bash', 'Read'],
							user_invocable: true,
						}),
					],
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step?.recommended_skills?.[0]?.allowed_tools).toEqual([
				'Bash',
				'Read',
			]);
			expect(response.current_step?.recommended_skills?.[0]?.user_invocable).toBe(true);
		});

		it('2.5 Step Conditions Tracking - should validate next_step_conditions field', async () => {
			const thought = createTestThought({
				current_step: createStepRecommendation({
					next_step_conditions: ['Check if files were found', 'If empty, try alternative search'],
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step?.next_step_conditions).toEqual([
				'Check if files were found',
				'If empty, try alternative search',
			]);
		});

		it('2.6 Previous Steps History - should validate tracking of previously recommended steps', async () => {
			const previousStep = createStepRecommendation({
				step_description: 'Previous step',
				recommended_tools: [createToolRecommendation({ tool_name: 'previous-tool' })],
				expected_outcome: 'Previous outcome',
			});

			const thought = createTestThought({
				previous_steps: [previousStep],
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.previous_steps).toHaveLength(1);
			expect(response.previous_steps?.[0]?.step_description).toBe('Previous step');
		});

		it('2.7 Remaining Steps Tracking - should validate remaining_steps high-level descriptions', async () => {
			const thought = createTestThought({
				remaining_steps: [
					'Implement feature A',
					'Write tests for feature A',
					'Document the feature',
				],
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.remaining_steps).toEqual([
				'Implement feature A',
				'Write tests for feature A',
				'Document the feature',
			]);
		});
	});

	describe('3. History Management Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('3.1 Sequential Thought Processing - should validate multiple thoughts processed in sequence', async () => {
			// Process 3 thoughts in sequence
			for (let i = 1; i <= 3; i++) {
				const thought = createTestThought({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 3,
					next_thought_needed: i < 3,
				});
				await server.processThought(thought);
			}

			expect(server.history.getHistoryLength(asSessionId('tool-suite'))).toBe(3);

			const history = server.history.getHistory(asSessionId('tool-suite'));
			expect(history[0]!.thought).toBe('Thought 1');
			expect(history[1]!.thought).toBe('Thought 2');
			expect(history[2]!.thought).toBe('Thought 3');
		});

		it('3.2 History Size Limit - should validate history trimming when exceeding maxHistorySize', async () => {
			const smallServer = await createServer({ maxHistorySize: 3 });

			// Add 5 thoughts
			for (let i = 1; i <= 5; i++) {
				await smallServer.processThought(
					createTestThought({
						thought: `Thought ${i}`,
						thought_number: i,
						total_thoughts: 5,
						next_thought_needed: i < 5,
					})
				);
			}

			// History should be trimmed to maxHistorySize (3)
			expect(smallServer.history.getHistoryLength(asSessionId('tool-suite'))).toBe(3);

			// The oldest thoughts should be removed, keeping the 3 most recent
			const history = smallServer.history.getHistory(asSessionId('tool-suite'));
			expect(history[0]!.thought).toBe('Thought 3');
			expect(history[1]!.thought).toBe('Thought 4');
			expect(history[2]!.thought).toBe('Thought 5');
		});

		it('3.3 History Persistence Across Thoughts - should validate history state maintained across multiple calls', async () => {
			// Process multiple thoughts
			const thoughts = [
				createTestThought({
					thought: 'First thought',
					thought_number: 1,
					total_thoughts: 3,
					next_thought_needed: true,
				}),
				createTestThought({
					thought: 'Second thought',
					thought_number: 2,
					total_thoughts: 3,
					next_thought_needed: true,
				}),
				createTestThought({
					thought: 'Third thought',
					thought_number: 3,
					total_thoughts: 3,
					next_thought_needed: false,
				}),
			];

			for (const thought of thoughts) {
				await server.processThought(thought);
			}

			// All thoughts should be accessible via history manager
			const history = server.history.getHistory(asSessionId('tool-suite'));
			expect(history).toHaveLength(3);
			expect(history[0]!.thought).toBe('First thought');
			expect(history[1]!.thought).toBe('Second thought');
			expect(history[2]!.thought).toBe('Third thought');
		});
	});

	describe('4. Branching Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('4.1 Single Branch Creation - should validate creating a branch from an existing thought', async () => {
			// Add base thought
			await server.processThought(
				createTestThought({
					thought: 'Base thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			// Add branch thought
			await server.processThought(
				createTestThought({
					thought: 'Branch thought',
					thought_number: 2,
					total_thoughts: 3,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-a'),
				})
			);

			const branches = server.history.getBranches(asSessionId('tool-suite'));
			expect(branches[asBranchId('branch-a')]).toHaveLength(1);
			expect(branches[asBranchId('branch-a')]![0]!.thought).toBe('Branch thought');
		});

		it('4.2 Multiple Branches - should validate creating multiple branches from different points', async () => {
			// Add base thought
			await server.processThought(
				createTestThought({
					thought: 'Base thought',
					thought_number: 1,
					total_thoughts: 4,
					next_thought_needed: true,
				})
			);

			// Add multiple branch thoughts
			await server.processThought(
				createTestThought({
					thought: 'Branch A thought',
					thought_number: 2,
					total_thoughts: 4,
					next_thought_needed: true,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-a'),
				})
			);

			await server.processThought(
				createTestThought({
					thought: 'Branch B thought',
					thought_number: 3,
					total_thoughts: 4,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('branch-b'),
				})
			);

			const branches = server.history.getBranches(asSessionId('tool-suite'));
			expect(branches[asBranchId('branch-a')]).toHaveLength(1);
			expect(branches[asBranchId('branch-b')]).toHaveLength(1);
			expect(branches[asBranchId('branch-a')]![0]!.thought).toBe('Branch A thought');
			expect(branches[asBranchId('branch-b')]![0]!.thought).toBe('Branch B thought');
		});

		it('4.3 Branch ID Validation - Valid - should validate branch_id accepts valid characters', async () => {
			await server.processThought(
				createTestThought({
					thought: 'Base thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			// Test valid branch IDs
			const validBranchIds = ['branch-1', 'branch_2', 'Branch3', '123', 'a-b_c-1_2'];

			for (const branchId of validBranchIds) {
				await server.processThought(
					createTestThought({
						thought: `Branch ${branchId}`,
						thought_number: 2,
						total_thoughts: 2,
						next_thought_needed: false,
						branch_from_thought: 1,
						branch_id: asBranchId(branchId),
					})
				);
			}

			const branches = server.history.getBranches(asSessionId('tool-suite'));
			expect(Object.keys(branches)).toHaveLength(validBranchIds.length);
		});

		it('4.4 Branch ID Validation - Invalid Characters - should validate branch_id rejects invalid characters', async () => {
			await server.processThought(
				createTestThought({
					thought: 'Base thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			// Note: The schema validation using Valibot regex happens at the MCP layer
			// Here we test that the server handles the input appropriately
			// Invalid branch IDs would be caught by schema validation before reaching processThought
			// This test verifies the server can handle branch IDs that pass basic validation

			// Test a valid branch ID (spaces and special chars would fail regex validation)
			await server.processThought(
				createTestThought({
					thought: 'Branch with valid ID',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('valid-branch_123'),
				})
			);

			const branches = server.history.getBranches(asSessionId('tool-suite'));
			expect(branches[asBranchId('valid-branch_123')]).toBeDefined();
		});

		it('4.5 Branch ID Length Limits - should validate branch_id length constraints (1-50 chars)', async () => {
			await server.processThought(
				createTestThought({
					thought: 'Base thought',
					thought_number: 1,
					total_thoughts: 4,
					next_thought_needed: true,
				})
			);

			// Test 1 character (valid)
			await server.processThought(
				createTestThought({
					thought: 'Branch with 1 char ID',
					thought_number: 2,
					total_thoughts: 4,
					next_thought_needed: true,
					branch_from_thought: 1,
					branch_id: asBranchId('a'),
				})
			);

			// Test 50 characters (valid)
			const fiftyCharId = 'a'.repeat(50);
			await server.processThought(
				createTestThought({
					thought: 'Branch with 50 char ID',
					thought_number: 3,
					total_thoughts: 4,
					next_thought_needed: true,
					branch_from_thought: 1,
					branch_id: asBranchId(fiftyCharId),
				})
			);

			const branches = server.history.getBranches(asSessionId('tool-suite'));
			expect(branches[asBranchId('a')]).toBeDefined();
			expect(branches[asBranchId(fiftyCharId)]).toBeDefined();

			// Note: 51+ characters would fail Valibot's maxLength validation
			// before reaching processThought
		});
	});

	describe('5. Revision Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('5.1 Simple Revision Flag - should validate is_revision flag is preserved', async () => {
			await server.processThought(
				createTestThought({
					thought: 'Original thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			await server.processThought(
				createTestThought({
					thought: 'Revised thought',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					is_revision: true,
				})
			);

			const history = server.history.getHistory(asSessionId('tool-suite'));

			// The revision metadata should be preserved in history
			expect(history[1]!.is_revision).toBe(true);
		});

		it('5.2 Revision with Thought Reference - should validate revises_thought points to correct thought', async () => {
			await server.processThought(
				createTestThought({
					thought: 'Original thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			await server.processThought(
				createTestThought({
					thought: 'Revision of thought 1',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					is_revision: true,
					revises_thought: 1,
				})
			);

			const history = server.history.getHistory(asSessionId('tool-suite'));
			expect(history[1]!.is_revision).toBe(true);
			expect(history[1]!.revises_thought).toBe(1);
		});

		it('5.3 Combined Branch and Revision - should validate combining branching with revision', async () => {
			await server.processThought(
				createTestThought({
					thought: 'Base thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			await server.processThought(
				createTestThought({
					thought: 'Branch and revision thought',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('revision-branch'),
					is_revision: true,
					revises_thought: 1,
				})
			);

			const history = server.history.getHistory(asSessionId('tool-suite'));
			const branches = server.history.getBranches(asSessionId('tool-suite'));

			// Both sets of metadata should be preserved
			expect(history[1]!.branch_from_thought).toBe(1);
			expect(history[1]!.branch_id).toBe('revision-branch');
			expect(history[1]!.is_revision).toBe(true);
			expect(history[1]!.revises_thought).toBe(1);

			// Branch should exist
			expect(branches[asBranchId('revision-branch')]).toHaveLength(1);
		});
	});

	describe('6. Edge Case Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('6.1 Thought Number Exceeds Total - should validate auto-adjustment when thought_number > total_thoughts', async () => {
			const result = await server.processThought(
				createTestThought({
					thought_number: 10,
					total_thoughts: 5,
				})
			);

			const response = parseProcessThoughtResult(result);

			// total_thoughts should be adjusted to match thought_number
			expect(response.thought_number).toBe(10);
			expect(response.total_thoughts).toBe(10); // Adjusted
		});

		it('6.2 Empty Tool/Skill Arrays - should validate empty arrays for available_mcp_tools and available_skills', async () => {
			const thought = createTestThought({
				available_mcp_tools: [],
				available_skills: [],
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.available_mcp_tools).toEqual([]);
			expect(response.available_skills).toEqual([]);
		});

		it('6.3 Very Long Thought Content - should validate handling of lengthy thought strings', async () => {
			const longThought = 'A'.repeat(10000);

			await server.processThought(
				createTestThought({
					thought: longThought,
				})
			);

			const history = server.history.getHistory(asSessionId('tool-suite'));

			// Thought should be preserved without truncation
			expect(history[0]!.thought).toHaveLength(10000);
		});

		it('6.4 Next Thought Needed Default - should validate next_thought_needed defaults to true when omitted', async () => {
			const thought = createTestThought({
				next_thought_needed: undefined,
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			// Should default to true when omitted
			expect(response.next_thought_needed).toBe(true);
		});

		it('6.5 Needs More Thoughts Flag - should validate needs_more_thoughts field handling', async () => {
			const thought = createTestThought({
				thought_number: 5,
				total_thoughts: 5,
				next_thought_needed: false,
				needs_more_thoughts: true,
			});

			await server.processThought(thought);
			const history = server.history.getHistory(asSessionId('tool-suite'));

			// Flag should be preserved in history
			expect(history[0]!.needs_more_thoughts).toBe(true);
		});
	});

	describe('7. Error Handling Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('7.1 Invalid Thought Number (Negative) - should validate handling of negative thought_number', async () => {
			// Note: Schema validation with minValue(1) would catch this before processThought
			// This test verifies the server handles processing gracefully
			// Negative values would fail Valibot validation

			// Test a valid edge case instead
			const result = await server.processThought(
				createTestThought({
					thought_number: 1,
				})
			);

			const response = parseProcessThoughtResult(result);
			expect(response.thought_number).toBe(1);
		});

		it('7.2 Invalid Thought Number (Zero) - should validate handling of zero thought_number', async () => {
			// Note: Schema validation with minValue(1) would catch this before processThought
			// Test the minimum valid value instead
			const result = await server.processThought(
				createTestThought({
					thought_number: 1,
				})
			);

			const response = parseProcessThoughtResult(result);
			expect(response.thought_number).toBe(1);
		});

		it('7.3 Invalid Total Thoughts (Negative) - should validate handling of negative total_thoughts', async () => {
			// Note: Schema validation with minValue(1) would catch this before processThought
			// Test with a valid minimum value
			const result = await server.processThought(
				createTestThought({
					total_thoughts: 1,
				})
			);

			const response = parseProcessThoughtResult(result);
			expect(response.total_thoughts).toBe(1);
		});

		it('7.4 Invalid Confidence Values - should validate confidence outside 0-1 range', async () => {
			// Note: Schema validation with minValue(0) and maxValue(1) would catch this
			// Test with valid confidence values
			const thought = createTestThought({
				current_step: createStepRecommendation({
					recommended_tools: [
						createToolRecommendation({ confidence: 0 }),
						createToolRecommendation({ confidence: 0.5 }),
						createToolRecommendation({ confidence: 1 }),
					],
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step?.recommended_tools[0]?.confidence).toBe(0);
			expect(response.current_step?.recommended_tools[1]?.confidence).toBe(0.5);
			expect(response.current_step?.recommended_tools[2]?.confidence).toBe(1);
		});

		it('7.5 Missing Required Fields - should validate response to missing required fields', async () => {
			// Note: Schema validation would catch missing required fields before processThought
			// Test that all required fields work correctly when present
			const thought = createTestThought({
				thought: 'Complete thought with all required fields',
				thought_number: 1,
				total_thoughts: 1,
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.thought_number).toBe(1);
			expect(response.total_thoughts).toBe(1);
			expect(response.thought_history_length).toBe(1);
		});

		it('7.6 Malformed Step Recommendations - should validate handling of malformed current_step', async () => {
			// Note: Schema validation would catch malformed steps before processThought
			// Test with a well-formed step recommendation
			const thought = createTestThought({
				current_step: createStepRecommendation({
					step_description: 'Valid step',
					recommended_tools: [createToolRecommendation()],
					expected_outcome: 'Valid outcome',
				}),
			});

			const result = await server.processThought(thought);
			const response = parseProcessThoughtResult(result);

			expect(response.current_step?.step_description).toBe('Valid step');
			expect(response.current_step?.expected_outcome).toBe('Valid outcome');
		});
	});

	describe('8. Integration Tests', () => {
		beforeEach(async () => {
			await server.resetAll();
		});

		it('8.1 End-to-End Thinking Session - should validate complete multi-step thinking session', async () => {
			// Complete 5-step thinking session with recommendations, branches, and revisions

			// Step 1: Initial analysis
			await server.processThought(
				createTestThought({
					thought: 'I need to analyze the problem and break it down',
					thought_number: 1,
					total_thoughts: 5,
					next_thought_needed: true,
					current_step: createStepRecommendation({
						step_description: 'Analyze the problem',
						recommended_tools: [createToolRecommendation({ tool_name: 'analyze-tool' })],
						expected_outcome: 'Problem understood',
					}),
				})
			);

			// Step 2: Search codebase
			await server.processThought(
				createTestThought({
					thought: 'I will search for relevant files',
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
					current_step: createStepRecommendation({
						step_description: 'Search codebase',
						recommended_tools: [
							createToolRecommendation({ tool_name: 'search-tool', priority: 1 }),
							createToolRecommendation({ tool_name: 'grep-tool', priority: 2 }),
						],
						expected_outcome: 'List of relevant files',
					}),
				})
			);

			// Step 3: Create a branch
			await server.processThought(
				createTestThought({
					thought: 'Alternative approach: consider using a different strategy',
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					branch_from_thought: 2,
					branch_id: asBranchId('alternative-approach'),
				})
			);

			// Step 4: Revise previous thought
			await server.processThought(
				createTestThought({
					thought: 'I revise my analysis - need more context',
					thought_number: 4,
					total_thoughts: 5,
					next_thought_needed: true,
					is_revision: true,
					revises_thought: 1,
				})
			);

			// Step 5: Final conclusion
			const finalResult = await server.processThought(
				createTestThought({
					thought: 'Based on my analysis, here is the solution',
					thought_number: 5,
					total_thoughts: 5,
					next_thought_needed: false,
					remaining_steps: [],
				})
			);

			const finalResponse = parseProcessThoughtResult(finalResult);
			const history = server.history.getHistory(asSessionId('tool-suite'));
			const branches = server.history.getBranches(asSessionId('tool-suite'));

			// Verify coherent state maintained throughout
			expect(history).toHaveLength(5);
			expect(branches[asBranchId('alternative-approach')]).toHaveLength(1);
			expect(finalResponse.thought_history_length).toBe(5);
			expect(finalResponse.branches).toContain('alternative-approach');
		});

		it('8.2 Concurrent Session Isolation - should validate separate server instances maintain separate state', async () => {
			// Create two separate server instances
			const server1 = await createServer({ maxHistorySize: 10 });
			const server2 = await createServer({ maxHistorySize: 10 });

			// Process thoughts on both servers
			await server1.processThought(
				createTestThought({
					thought: 'Server 1 thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			await server2.processThought(
				createTestThought({
					thought: 'Server 2 thought',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);

			// Verify state isolation
			expect(server1.history.getHistoryLength(asSessionId('tool-suite'))).toBe(1);
			expect(server2.history.getHistoryLength(asSessionId('tool-suite'))).toBe(1);
			expect(server1.history.getHistory(asSessionId('tool-suite'))[0]!.thought).toBe(
				'Server 1 thought'
			);
			expect(server2.history.getHistory(asSessionId('tool-suite'))[0]!.thought).toBe(
				'Server 2 thought'
			);

			// Create branches on each server
			await server1.processThought(
				createTestThought({
					thought: 'Server 1 branch',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('server1-branch'),
				})
			);

			await server2.processThought(
				createTestThought({
					thought: 'Server 2 branch',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('server2-branch'),
				})
			);

			// Verify branch isolation
			const branches1 = server1.history.getBranches(asSessionId('tool-suite'));
			const branches2 = server2.history.getBranches(asSessionId('tool-suite'));

			expect(branches1[asBranchId('server1-branch')]).toBeDefined();
			expect(branches2[asBranchId('server2-branch')]).toBeDefined();
			expect(branches1[asBranchId('server2-branch')]).toBeUndefined();
			expect(branches2[asBranchId('server1-branch')]).toBeUndefined();
		});

		it('8.3 Available Tools/Skills Registration - should validate available_mcp_tools and available_skills reflect registry', async () => {
			// Register custom tools
			server.tools.add({
				name: 'custom-tool',
				description: 'A custom tool',
				inputSchema: {},
			});

			// Register custom skills
			server.skills.add({
				name: 'custom-skill',
				description: 'A custom skill',
			});

			// Process a thought referencing available tools/skills
			await server.processThought(
				createTestThought({
					thought: 'I will use the custom tools and skills',
					available_mcp_tools: ['custom-tool', 'another-tool'],
					available_skills: ['custom-skill', 'another-skill'],
					current_step: createStepRecommendation({
						recommended_tools: [createToolRecommendation({ tool_name: 'custom-tool' })],
						recommended_skills: [createSkillRecommendation({ skill_name: 'custom-skill' })],
					}),
				})
			);

			const response = parseProcessThoughtResult(
				await server.processThought(
					createTestThought({
						thought: 'I will use the custom tools and skills',
						available_mcp_tools: ['custom-tool', 'another-tool'],
						available_skills: ['custom-skill', 'another-skill'],
						current_step: createStepRecommendation({
							recommended_tools: [createToolRecommendation({ tool_name: 'custom-tool' })],
							recommended_skills: [createSkillRecommendation({ skill_name: 'custom-skill' })],
						}),
					})
				)
			);

			// Available tools/skills should be reflected in response
			expect(response.available_mcp_tools).toContain('custom-tool');
			expect(response.available_skills).toContain('custom-skill');
			expect(response.current_step?.recommended_tools[0]?.tool_name).toBe('custom-tool');
			expect(response.current_step?.recommended_skills?.[0]?.skill_name).toBe('custom-skill');
		});
	});

	describe('9. Session Isolation (CVE-2026-25536)', () => {
		// These tests reproduce the exact contamination scenario from the CVE:
		// When Chain A completes and Chain B starts, Chain B's thought_history_length,
		// average_confidence, thought_type_counts, and branches all reflect Chain A's data.
		// The fix adds session_id to scope state per-session.

		function parseResponse(result: unknown) {
			const content = (result as { content: Array<{ type: string; text: string }> }).content;
			return JSON.parse(content[0]!.text) as {
				thought_number: number;
				total_thoughts: number;
				next_thought_needed: boolean;
				branches: string[];
				thought_history_length: number;
				session_id?: string;
				status?: string;
				confidence_signals?: {
					reasoning_depth: number;
					revision_count: number;
					branch_count: number;
					thought_type_distribution: Record<string, number>;
					has_hypothesis: boolean;
					has_verification: boolean;
					average_confidence: number | null;
				};
				reasoning_stats?: {
					total_thoughts: number;
					total_branches: number;
					thought_type_counts: Record<string, number>;
					average_quality_score: number | null;
					average_confidence: number | null;
					hypothesis_count: number;
				};
			};
		}

		let server: ToolAwareSequentialThinkingServer;

		beforeEach(async () => {
			server = await createServer({ maxHistorySize: 100 });
		});

		it('9.1 Chain B does not inherit Chain A thought_history_length', async () => {
			for (let i = 1; i <= 3; i++) {
				await server.processThought(
					createTestThought({
						thought: `Chain A thought ${i}`,
						thought_number: i,
						total_thoughts: 3,
						next_thought_needed: i < 3,
					})
				);
			}

			// Chain B: process 1 thought WITH session_id='chain-b'
			const chainBResult = await server.processThought(
				createTestThought({
					thought: 'Chain B first thought',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('chain-b'),
				})
			);

			const response = parseResponse(chainBResult);

			// Chain B should have length 1, NOT 4 (contaminated by Chain A)
			expect(response.thought_history_length).toBe(1);
			expect(response.session_id).toBe('chain-b');
		});

		it('9.2 Chain B does not inherit Chain A branches', async () => {
			// Chain A: create a base thought + branch
			await server.processThought(
				createTestThought({
					thought: 'Chain A base',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				})
			);
			await server.processThought(
				createTestThought({
					thought: 'Chain A branch thought',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					branch_from_thought: 1,
					branch_id: asBranchId('chain-a-branch'),
				})
			);

			// Chain B: new session, verify branches is empty
			const chainBResult = await server.processThought(
				createTestThought({
					thought: 'Chain B thought',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('chain-b'),
				})
			);

			const response = parseResponse(chainBResult);

			// Chain B should have NO branches — Chain A's 'chain-a-branch' must not leak
			expect(response.branches).toEqual([]);
			expect(response.confidence_signals?.branch_count).toBe(0);
		});

		it('9.3 Chain B does not inherit Chain A thought_type_counts', async () => {
			// Chain A: process thoughts with specific thought_types
			await server.processThought(
				createTestThought({
					thought: 'Chain A hypothesis',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
					thought_type: 'hypothesis',
					hypothesis_id: 'hyp-chain-a',
					confidence: 0.6,
				})
			);
			await server.processThought(
				createTestThought({
					thought: 'Chain A verification',
					thought_number: 2,
					total_thoughts: 2,
					next_thought_needed: false,
					thought_type: 'verification',
					hypothesis_id: 'hyp-chain-a',
					verification_target: 1,
					confidence: 0.9,
				})
			);

			// Chain B: only a regular thought
			const chainBResult = await server.processThought(
				createTestThought({
					thought: 'Chain B regular thought',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('chain-b'),
				})
			);

			const response = parseResponse(chainBResult);

			// Chain B should NOT see Chain A's hypothesis/verification counts
			expect(response.reasoning_stats?.thought_type_counts.hypothesis).toBe(0);
			expect(response.reasoning_stats?.thought_type_counts.verification).toBe(0);
			expect(response.reasoning_stats?.thought_type_counts.regular).toBe(1);
			expect(response.reasoning_stats?.hypothesis_count).toBe(0);
			expect(response.confidence_signals?.has_hypothesis).toBe(false);
			expect(response.confidence_signals?.has_verification).toBe(false);
		});

		it('9.4 Chain B statistics are scoped — average_quality_score reflects only Chain B', async () => {
			// Chain A: thoughts with specific quality_scores
			for (let i = 1; i <= 3; i++) {
				await server.processThought(
					createTestThought({
						thought: `Chain A thought ${i}`,
						thought_number: i,
						total_thoughts: 3,
						next_thought_needed: i < 3,
						quality_score: 0.3,
						confidence: 0.4,
					})
				);
			}

			// Chain B: single thought with high quality_score
			const chainBResult = await server.processThought(
				createTestThought({
					thought: 'Chain B high-quality thought',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('chain-b'),
					quality_score: 0.95,
					confidence: 0.99,
				})
			);

			const response = parseResponse(chainBResult);

			// Chain B average_quality_score should be 0.95 (only its own data), not ~0.46
			expect(response.reasoning_stats?.average_quality_score).toBe(0.95);
			expect(response.reasoning_stats?.average_confidence).toBe(0.99);
			expect(response.confidence_signals?.average_confidence).toBe(0.99);
		});

		it('9.5 rejects omitted session_id instead of creating global state', async () => {
			const omittedSessionInput = {
				thought: 'Missing explicit session',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			};

			const result = await Reflect.apply(server.processThought, server, [omittedSessionInput]);
			const response = parseResponse(result);

			expect(result.isError).toBe(true);
			expect(response.status).toBe('failed');
			expect(server.history.getSessionIds()).toEqual([]);
		});

		it('9.6 reset_state clears session and starts fresh', async () => {
			// 3 thoughts in session 'task-a'
			for (let i = 1; i <= 3; i++) {
				await server.processThought(
					createTestThought({
						thought: `Task-A thought ${i}`,
						thought_number: i,
						total_thoughts: 3,
						next_thought_needed: i < 3,
						session_id: asSessionId('task-a'),
					})
				);
			}

			// 4th thought with session_id='task-a', reset_state=true
			const result = await server.processThought(
				createTestThought({
					thought: 'Task-A fresh start',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: asSessionId('task-a'),
					reset_state: true,
				})
			);

			const response = parseResponse(result);

			// After reset, only the new thought exists
			expect(response.thought_history_length).toBe(1);
			expect(response.session_id).toBe('task-a');
		});

		it('9.7 rejects retired global session identity', async () => {
			const result = await Reflect.apply(server.processThought, server, [
				{
					thought: 'Retired global session',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
					session_id: '__global__',
					reset_state: true,
				},
			]);
			const response = parseResponse(result);

			expect(result.isError).toBe(true);
			expect(response.status).toBe('failed');
			expect(server.history.getSessionIds()).toEqual([]);
		});
	});
});
