import { describe, it, expect, beforeEach } from 'vitest';
import { ThoughtFormatter } from '../core/ThoughtFormatter.js';
import type { ThoughtData } from '../core/thought.js';
import type { StepRecommendation } from '../core/step.js';

import { asBranchId, asSessionId } from '../contracts/ids.js';

const FORMATTER_SESSION = asSessionId('formatter-session');

describe('ThoughtFormatter', () => {
	let formatter: ThoughtFormatter;

	beforeEach(() => {
		formatter = new ThoughtFormatter();
	});

	describe('formatThought', () => {
		describe('basic thoughts', () => {
			it('should format a basic thought with number and total', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'I need to analyze the data structure',
					thought_number: 1,
					total_thoughts: 3,
					next_thought_needed: true,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('Thought');
				expect(output).toContain('1/3');
				expect(output).toContain('I need to analyze the data structure');
			});

			it('should format thought with correct numbering', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Continuing analysis',
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('2/5');
				expect(output).toContain('Continuing analysis');
			});

			it('should format the last thought', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Final conclusion',
					thought_number: 3,
					total_thoughts: 3,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('3/3');
				expect(output).toContain('Final conclusion');
			});

			it('should include thought icon for regular thoughts', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Regular thought',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('💭');
				expect(output).toContain('Thought');
			});
		});

		describe('revision thoughts', () => {
			it('should format a revision thought with revision icon', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'I need to revise my earlier analysis',
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					is_revision: true,
					revises_thought: 1,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🔄');
				expect(output).toContain('Revision');
				expect(output).toContain('3/5');
				expect(output).toContain('revise #1');
				expect(output).toContain('I need to revise my earlier analysis');
			});

			it('should show which thought is being revised', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Correcting previous assessment',
					thought_number: 4,
					total_thoughts: 6,
					next_thought_needed: true,
					is_revision: true,
					revises_thought: 2,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('revise #2');
			});
		});

		describe('branch thoughts', () => {
			it('should format a branch thought with branch icon', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Exploring an alternative approach',
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					branch_from_thought: 2,
					branch_id: asBranchId('alternative-1'),
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🌿');
				expect(output).toContain('Branch');
				expect(output).toContain('from #2');
				expect(output).toContain('Exploring an alternative approach');
			});

			it('should show branch origin thought number', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Another branch',
					thought_number: 5,
					total_thoughts: 10,
					next_thought_needed: true,
					branch_from_thought: 3,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('from #3');
			});
		});

		describe('with step recommendations', () => {
			it('should include recommendation when current_step is present', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'I need to search the codebase',
					thought_number: 1,
					total_thoughts: 3,
					next_thought_needed: true,
					current_step: {
						step_description: 'Search for files',
						recommended_tools: [
							{
								tool_name: 'Grep',
								confidence: 0.9,
								rationale: 'Best for searching code patterns',
								priority: 1,
							},
						],
						expected_outcome: 'List of matching files',
					},
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('I need to search the codebase');
				expect(output).toContain('Grep');
				expect(output).toContain('List of matching files');
			});

			it('should format thought without recommendation when no current_step', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Just thinking',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				// Should only have one line (the thought), no recommendation line
				const lines = output.split('\n');
				expect(lines).toHaveLength(1);
			});

			it('should add recommendation on a new line', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Analyzing code',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
					current_step: {
						step_description: 'Read files',
						recommended_tools: [
							{
								tool_name: 'Read',
								confidence: 0.95,
								rationale: 'Direct file reading',
								priority: 1,
							},
						],
						expected_outcome: 'File contents',
					},
				};

				const output = formatter.formatThought(data);
				const lines = output.split('\n');
				expect(lines).toHaveLength(2);
				expect(lines[0]).toContain('Analyzing code');
				expect(lines[1]).toContain('Read');
			});
		});

		describe('edge cases', () => {
			it('should handle empty thought string', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: '',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('1/1');
				// Should not throw
				expect(typeof output).toBe('string');
			});

			it('should handle very long thought content', () => {
				const longContent = 'A'.repeat(10000);
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: longContent,
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain(longContent);
			});

			it('should handle special characters in thought', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Test with <html> & "quotes" and \'single quotes\' and `backticks`',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('<html>');
				expect(output).toContain('&');
				expect(output).toContain('"quotes"');
			});

			it('should handle unicode characters in thought', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: '考えてみましょう 🤔 → análisis',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('考えてみましょう');
				expect(output).toContain('🤔');
			});

			it('should handle newlines in thought content', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Line 1\nLine 2\nLine 3',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('Line 1\nLine 2\nLine 3');
			});

			it('should handle thought_number larger than total_thoughts', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Extra thought beyond estimate',
					thought_number: 7,
					total_thoughts: 5,
					next_thought_needed: true,
					needs_more_thoughts: true,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('7/5');
			});

			it('should prioritize revision over branch when both are set', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Both revision and branch flags',
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					is_revision: true,
					revises_thought: 1,
					branch_from_thought: 2,
				};

				const output = formatter.formatThought(data);
				// is_revision is checked first in the code
				expect(output).toContain('🔄');
				expect(output).toContain('Revision');
			});
		});

		describe('thought type icons', () => {
			it('should show hypothesis icon and label for thought_type hypothesis', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'The performance issue is likely in the DB layer',
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
					thought_type: 'hypothesis',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🔬');
				expect(output).toContain('Hypothesis');
			});

			it('should show verification icon and label for thought_type verification', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Testing the DB hypothesis against evidence',
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					thought_type: 'verification',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('✅');
				expect(output).toContain('Verification');
			});

			it('should show critique icon and label for thought_type critique', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'My reasoning has a logical gap',
					thought_number: 4,
					total_thoughts: 6,
					next_thought_needed: true,
					thought_type: 'critique',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🔍');
				expect(output).toContain('Critique');
			});

			it('should show synthesis icon and label for thought_type synthesis', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Combining findings from both branches',
					thought_number: 5,
					total_thoughts: 6,
					next_thought_needed: true,
					thought_type: 'synthesis',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🧬');
				expect(output).toContain('Synthesis');
			});

			it('should show meta icon and label for thought_type meta', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'I notice I am over-exploring branches',
					thought_number: 6,
					total_thoughts: 8,
					next_thought_needed: true,
					thought_type: 'meta',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🧠');
				expect(output).toContain('Meta');
			});

			it('should show default thought icon for thought_type regular', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'A regular analytical step',
					thought_number: 1,
					total_thoughts: 3,
					next_thought_needed: true,
					thought_type: 'regular',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('💭');
				expect(output).toContain('Thought');
			});

			it('should show default thought icon when thought_type is undefined', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'No thought type specified',
					thought_number: 1,
					total_thoughts: 2,
					next_thought_needed: true,
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('💭');
			});

			it('should prioritize is_revision over thought_type', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Revision wins over hypothesis',
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					is_revision: true,
					revises_thought: 1,
					thought_type: 'hypothesis',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('🔄');
				expect(output).toContain('Revision');
				expect(output).not.toContain('🔬');
				expect(output).not.toContain('Hypothesis');
			});
		});

		describe('meta observation', () => {
			it('should include meta_observation text when present', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Analyzing the code structure',
					thought_number: 2,
					total_thoughts: 4,
					next_thought_needed: true,
					meta_observation: 'I am spending too much time on edge cases',
				};

				const output = formatter.formatThought(data);
				expect(output).toContain('I am spending too much time on edge cases');
				expect(output).toContain('📝');
			});

			it('should not add meta_observation line when not present', () => {
				const data: ThoughtData = {
					session_id: FORMATTER_SESSION,
					thought: 'Simple thought',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				};

				const output = formatter.formatThought(data);
				const lines = output.split('\n');
				expect(lines).toHaveLength(1);
				expect(output).not.toContain('📝');
			});
		});
	});

	describe('formatRecommendation', () => {
		describe('with tools', () => {
			it('should format a single tool recommendation', () => {
				const step: StepRecommendation = {
					step_description: 'Search the codebase',
					recommended_tools: [
						{
							tool_name: 'Grep',
							confidence: 0.9,
							rationale: 'Best for code search',
							priority: 1,
						},
					],
					expected_outcome: 'Search results',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('Tools: Grep');
				expect(output).toContain('Search results');
			});

			it('should format multiple tool recommendations', () => {
				const step: StepRecommendation = {
					step_description: 'Complex operation',
					recommended_tools: [
						{
							tool_name: 'Read',
							confidence: 0.9,
							rationale: 'Read files',
							priority: 1,
						},
						{
							tool_name: 'Grep',
							confidence: 0.8,
							rationale: 'Search code',
							priority: 2,
						},
						{
							tool_name: 'Bash',
							confidence: 0.7,
							rationale: 'Run commands',
							priority: 3,
						},
					],
					expected_outcome: 'Complete understanding',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('Tools: Read, Grep, Bash');
			});

			it('should handle empty recommended_tools array', () => {
				const step: StepRecommendation = {
					step_description: 'No tools needed',
					recommended_tools: [],
					expected_outcome: 'Pure reasoning',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).not.toContain('Tools:');
			});
		});

		describe('with skills', () => {
			it('should format skill recommendations', () => {
				const step: StepRecommendation = {
					step_description: 'Commit changes',
					recommended_tools: [],
					recommended_skills: [
						{
							skill_name: 'commit',
							confidence: 0.95,
							rationale: 'Handles git workflow',
							priority: 1,
						},
					],
					expected_outcome: 'Changes committed',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('Skills: commit');
			});

			it('should format multiple skill recommendations', () => {
				const step: StepRecommendation = {
					step_description: 'Review and commit',
					recommended_tools: [],
					recommended_skills: [
						{
							skill_name: 'review-pr',
							confidence: 0.9,
							rationale: 'Code review',
							priority: 1,
						},
						{
							skill_name: 'commit',
							confidence: 0.85,
							rationale: 'Commit changes',
							priority: 2,
						},
					],
					expected_outcome: 'Code reviewed and committed',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('Skills: review-pr, commit');
			});

			it('should handle empty recommended_skills array', () => {
				const step: StepRecommendation = {
					step_description: 'No skills needed',
					recommended_tools: [],
					recommended_skills: [],
					expected_outcome: 'Done',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).not.toContain('Skills:');
			});

			it('should handle undefined recommended_skills', () => {
				const step: StepRecommendation = {
					step_description: 'No skills defined',
					recommended_tools: [],
					expected_outcome: 'Done',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).not.toContain('Skills:');
			});
		});

		describe('with tools and skills combined', () => {
			it('should format both tools and skills', () => {
				const step: StepRecommendation = {
					step_description: 'Full workflow',
					recommended_tools: [
						{
							tool_name: 'Read',
							confidence: 0.9,
							rationale: 'Read files',
							priority: 1,
						},
					],
					recommended_skills: [
						{
							skill_name: 'commit',
							confidence: 0.85,
							rationale: 'Commit workflow',
							priority: 1,
						},
					],
					expected_outcome: 'Files read and committed',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('Tools: Read');
				expect(output).toContain('Skills: commit');
				expect(output).toContain('Files read and committed');
				// Parts are joined with ' | '
				expect(output).toContain(' | ');
			});
		});

		describe('expected outcome', () => {
			it('should include expected outcome with arrow prefix', () => {
				const step: StepRecommendation = {
					step_description: 'Test step',
					recommended_tools: [],
					expected_outcome: 'Expected result here',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('→ Expected result here');
			});

			it('should handle empty expected outcome', () => {
				const step: StepRecommendation = {
					step_description: 'Test step',
					recommended_tools: [
						{
							tool_name: 'Read',
							confidence: 0.9,
							rationale: 'Read',
							priority: 1,
						},
					],
					expected_outcome: '',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).not.toContain('→');
			});
		});

		describe('pipe separator', () => {
			it('should join parts with pipe separator', () => {
				const step: StepRecommendation = {
					step_description: 'Multi-part recommendation',
					recommended_tools: [
						{
							tool_name: 'Grep',
							confidence: 0.9,
							rationale: 'Search',
							priority: 1,
						},
					],
					recommended_skills: [
						{
							skill_name: 'commit',
							confidence: 0.8,
							rationale: 'Commit',
							priority: 1,
						},
					],
					expected_outcome: 'All done',
				};

				const output = formatter.formatRecommendation(step);
				// Should have 3 parts separated by ' | '
				const pipeCount = (output.match(/ \| /g) || []).length;
				expect(pipeCount).toBe(2);
			});

			it('should not have separator with single part', () => {
				const step: StepRecommendation = {
					step_description: 'Simple step',
					recommended_tools: [],
					expected_outcome: 'Just an outcome',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).not.toContain(' | ');
			});
		});

		describe('edge cases', () => {
			it('should return empty string when no tools, skills, or outcome', () => {
				const step: StepRecommendation = {
					step_description: 'Empty step',
					recommended_tools: [],
					expected_outcome: '',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toBe('');
			});

			it('should handle tool names with special characters', () => {
				const step: StepRecommendation = {
					step_description: 'MCP tools',
					recommended_tools: [
						{
							tool_name: 'mcp__tavily-mcp__tavily-search',
							confidence: 0.9,
							rationale: 'Web search',
							priority: 1,
						},
					],
					expected_outcome: 'Search results',
				};

				const output = formatter.formatRecommendation(step);
				expect(output).toContain('mcp__tavily-mcp__tavily-search');
			});
		});
	});
});
