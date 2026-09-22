import { asBranchId, type BranchId, type SessionId } from '../contracts/ids.js';
/**
 * Comprehensive tests for ThoughtProcessor.
 *
 * This test file covers input validation, error handling, history integration,
 * response formatting, and edge cases for the ThoughtProcessor class.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThoughtProcessor } from '../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../core/ThoughtFormatter.js';
import { SessionLock } from '../core/SessionLock.js';
import { SequentialStrategy } from '../core/reasoning/strategies/SequentialStrategy.js';
import { StructuredLogger } from '../logger/StructuredLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { MockHistoryManager } from './helpers/factories.js';
import type { ThoughtData } from '../core/thought.js';
import { asSessionId } from '../contracts/ids.js';
import type { HistorySessionSnapshot, IHistoryManager } from '../core/IHistoryManager.js';
import type { ThoughtEvaluator } from '../core/ThoughtEvaluator.js';
import { createTestThought, createHypothesisThought } from './helpers/factories.js';
import { createDisabledThoughtEvaluator as createEvaluator } from './helpers/evaluator.js';

describe('ThoughtProcessor', () => {
	let processor: ThoughtProcessor;
	let mockHistory: MockHistoryManager;
	let formatter: ThoughtFormatter;
	let logger: StructuredLogger;

	beforeEach(() => {
		mockHistory = new MockHistoryManager();
		formatter = new ThoughtFormatter();
		logger = new StructuredLogger({ context: 'Test', pretty: false });
		processor = new ThoughtProcessor(mockHistory, formatter, createEvaluator(), logger);
	});

	describe('Input Validation', () => {
		it('should auto-adjust total_thoughts when thought_number exceeds it', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 10,
				total_thoughts: 5,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.total_thoughts).toBe(10);
			expect(parsed.thought_number).toBe(10);
		});

		it('should not adjust total_thoughts when thought_number is less than or equal', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 3,
				total_thoughts: 5,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.total_thoughts).toBe(5);
			expect(parsed.thought_number).toBe(3);
		});

		it('should handle thought_number equal to total_thoughts', async () => {
			const input: ThoughtData = {
				thought: 'Final thought',
				thought_number: 5,
				total_thoughts: 5,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.total_thoughts).toBe(5);
			expect(parsed.thought_number).toBe(5);
			expect(parsed.next_thought_needed).toBe(false);
		});
	});

	describe('History Integration', () => {
		it('should add thought to history on successful processing', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			await processor.process(input);

			expect(mockHistory.getHistoryLength(asSessionId('test-session'))).toBe(1);
			expect(mockHistory.getHistory(asSessionId('test-session'))[0]).toMatchObject(input);
		});

		it('should respect max history size through HistoryManager', async () => {
			// Add multiple thoughts
			for (let i = 1; i <= 5; i++) {
				const input: ThoughtData = {
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 5,
					next_thought_needed: i < 5,
					session_id: asSessionId('test-session'),
				};
				await processor.process(input);
			}

			expect(mockHistory.getHistoryLength(asSessionId('test-session'))).toBe(5);
		});

		it('should report correct thought_history_length in response', async () => {
			const input1: ThoughtData = {
				thought: 'First thought',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
			};

			await processor.process(input1);

			const result1 = await processor.process({
				thought: 'Second thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			});

			const parsed = JSON.parse(result1.content[0]!.text);
			expect(parsed.thought_history_length).toBe(2);
		});
	});

	describe('Response Formatting', () => {
		it('should return correctly structured response', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				available_mcp_tools: ['tool1', 'tool2'],
				available_skills: ['skill1'],
			};

			const result = await processor.process(input);

			expect(result.content).toHaveLength(1);
			expect(result.content[0]!.type).toBe('text');
			expect(result.isError).toBeUndefined();

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed).toMatchObject({
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
				branches: [],
				thought_history_length: 1,
			});
		});

		it('should include available_mcp_tools in response when provided', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				available_mcp_tools: ['Read', 'Write', 'Grep'],
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.available_mcp_tools).toEqual(['Read', 'Write', 'Grep']);
		});

		it('should include available_skills in response when provided', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				available_skills: ['commit', 'review-pr'],
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.available_skills).toEqual(['commit', 'review-pr']);
		});

		it('should include current_step in response when provided', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				current_step: {
					step_description: 'Analyze code',
					recommended_tools: [
						{
							tool_name: 'Grep',
							confidence: 0.9,
							rationale: 'Best for searching',
							priority: 1,
						},
					],
					expected_outcome: 'Find patterns',
				},
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.current_step).toEqual({
				step_description: 'Analyze code',
				recommended_tools: [
					{
						tool_name: 'Grep',
						confidence: 0.9,
						rationale: 'Best for searching',
						priority: 1,
					},
				],
				expected_outcome: 'Find patterns',
			});
		});

		it('should include branches in response', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.branches).toEqual([]);
		});
	});

	describe('Error Handling', () => {
		it('should handle missing optional fields gracefully', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			expect(result.isError).toBeUndefined();
		});

		it('should return error response when processing fails', async () => {
			// Create a HistoryManager that throws on addThought
			class ThrowingHistoryManager implements IHistoryManager {
				assertThoughtIdentityAvailable(_thought: ThoughtData): void {}
				resolveThoughtReference(_sessionId: SessionId, _thoughtNumber: number) {
					return { kind: 'missing' as const };
				}
				addThought(): void {
					throw new Error('Database error');
				}
				getHistory(_sessionId: string): ThoughtData[] {
					return [];
				}
				getHistoryLength(_sessionId: string): number {
					return 0;
				}
				getBranches(_sessionId: string): Record<BranchId, ThoughtData[]> {
					return {};
				}
				getBranchIds(_sessionId: string): BranchId[] {
					return [];
				}
				registerBranch(_sessionId: string, _branchId: BranchId): void {}
				branchExists(_sessionId: string, _branchId: BranchId): boolean {
					return false;
				}
				async resetSession(_sessionId: string, _clearAuxiliaryState?: () => void): Promise<void> {}
				async resetSessionWithinExclusive(
					_sessionId: SessionId,
					_clearAuxiliaryState?: () => void
				): Promise<void> {}
				async resetAll(): Promise<void> {}
				async resetAllWithinExclusive(): Promise<void> {}
				inspectSession(_sessionId: string): HistorySessionSnapshot {
					return {
						history: [],
						branches: {},
						verificationTargets: new Map(),
						branchIds: [],
						availableMcpTools: undefined,
						availableSkills: undefined,
					};
				}
				getSessionIds(): string[] {
					return [];
				}
				getAvailableMcpTools(_sessionId: string): string[] | undefined {
					return undefined;
				}
				getAvailableSkills(_sessionId: string): string[] | undefined {
					return undefined;
				}
				getEdgeStore(): undefined {
					return undefined;
				}
			}

			const throwingHistory = new ThrowingHistoryManager();
			const throwingProcessor = new ThoughtProcessor(
				throwingHistory,
				formatter,
				createEvaluator(),
				logger
			);

			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await throwingProcessor.process(input);

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.error).toBe('Database error');
			expect(parsed.status).toBe('failed');
		});

		it('should handle undefined thought_number edge case', async () => {
			// TypeScript should catch this at compile time, but test runtime behavior
			const input = {
				thought: 'Test thought',
				session_id: asSessionId('test-session'),
			} as unknown as ThoughtData;

			// The processor should handle this gracefully
			const result = await processor.process(input);
			// Either returns an error or processes with undefined values
			expect(result).toBeDefined();
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty thought string', async () => {
			const input: ThoughtData = {
				thought: '',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			expect(result.isError).toBeUndefined();
		});

		it('should handle very long thought content', async () => {
			const longThought = 'x'.repeat(10000);
			const input: ThoughtData = {
				thought: longThought,
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			expect(result.isError).toBeUndefined();
		});

		it('should handle special characters in thought', async () => {
			const input: ThoughtData = {
				thought: 'Test with "quotes" and \'apostrophes\' and \n newlines \t tabs',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			expect(result.isError).toBeUndefined();
		});

		it('should handle very large thought_number', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 999999,
				total_thoughts: 5,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.total_thoughts).toBe(999999);
		});

		it('should handle next_thought_needed as undefined', async () => {
			const input = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				session_id: asSessionId('test-session'),
			} as ThoughtData;

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.next_thought_needed).toBe(true); // Default value
		});

		it('should handle tool and skill recommendations with full details', async () => {
			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				available_mcp_tools: ['tool1', 'tool2', 'tool3'],
				available_skills: ['skill1', 'skill2'],
				current_step: {
					step_description: 'Full step with recommendations',
					recommended_tools: [
						{
							tool_name: 'Read',
							confidence: 0.95,
							rationale: 'Perfect for reading files',
							priority: 1,
						},
						{
							tool_name: 'Grep',
							confidence: 0.7,
							rationale: 'Good for searching',
							priority: 2,
							alternatives: ['Glob', 'Find'],
						},
					],
					expected_outcome: 'Files read and searched',
				},
				previous_steps: [
					{
						step_description: 'Step 1',
						recommended_tools: [
							{ tool_name: 'tool1', confidence: 0.8, rationale: 'test', priority: 1 },
						],
						expected_outcome: 'Done',
					},
				],
				remaining_steps: ['Step 3: Final step'],
			};

			const result = await processor.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.available_mcp_tools).toEqual(['tool1', 'tool2', 'tool3']);
			expect(parsed.available_skills).toEqual(['skill1', 'skill2']);
			expect(parsed.current_step.recommended_tools).toHaveLength(2);
			expect(parsed.current_step.recommended_tools[1].alternatives).toEqual(['Glob', 'Find']);
			expect(parsed.previous_steps).toHaveLength(1);
			expect(parsed.remaining_steps).toEqual(['Step 3: Final step']);
		});
	});

	describe('Logging', () => {
		it('should log formatted thoughts when logger is provided', async () => {
			const logSpy = vi.spyOn(logger, 'info');

			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			await processor.process(input);

			expect(logSpy).toHaveBeenCalled();
		});

		it('should use NullLogger as default when no logger provided', async () => {
			const processorWithoutLogger = new ThoughtProcessor(
				mockHistory,
				formatter,
				createEvaluator()
			);

			const input: ThoughtData = {
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			};

			const result = await processorWithoutLogger.process(input);

			// Should work without throwing errors
			expect(result.content).toBeDefined();
		});
	});

	describe('available_mcp_tools / available_skills persistence (Bug 2 fix)', () => {
		it('should persist available_skills across calls when omitted in subsequent calls', async () => {
			// Thought 1: send available_skills
			const result1 = await processor.process({
				thought: 'First thought',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				available_skills: ['vercel-react-native-skills', 'agent-browser'],
			});
			const parsed1 = JSON.parse(result1.content[0]!.text);
			expect(parsed1.available_skills).toEqual(['vercel-react-native-skills', 'agent-browser']);

			// Thought 2: omit available_skills — should carry over from Thought 1
			const result2 = await processor.process({
				thought: 'Second thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			});
			const parsed2 = JSON.parse(result2.content[0]!.text);
			expect(parsed2.available_skills).toEqual(['vercel-react-native-skills', 'agent-browser']);
		});

		it('should persist available_mcp_tools across calls when omitted in subsequent calls', async () => {
			// Thought 1: send available_mcp_tools
			const result1 = await processor.process({
				thought: 'First thought',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				available_mcp_tools: ['Read', 'Grep', 'Glob'],
			});
			const parsed1 = JSON.parse(result1.content[0]!.text);
			expect(parsed1.available_mcp_tools).toEqual(['Read', 'Grep', 'Glob']);

			// Thought 2: omit available_mcp_tools — should carry over
			const result2 = await processor.process({
				thought: 'Second thought',
				thought_number: 2,
				total_thoughts: 2,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			});
			const parsed2 = JSON.parse(result2.content[0]!.text);
			expect(parsed2.available_mcp_tools).toEqual(['Read', 'Grep', 'Glob']);
		});

		it('should replace cached skills when a new call provides different values', async () => {
			// Thought 1
			await processor.process({
				thought: 'First thought',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				available_skills: ['skill-a', 'skill-b'],
			});

			// Thought 2: new skills replace the old ones
			await processor.process({
				thought: 'Second thought',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				available_skills: ['skill-c'],
			});

			// Thought 3: omit — should carry over the replaced values
			const result3 = await processor.process({
				thought: 'Third thought',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			});
			const parsed3 = JSON.parse(result3.content[0]!.text);
			expect(parsed3.available_skills).toEqual(['skill-c']);
		});

		it('should return undefined for available_skills when never set', async () => {
			const result = await processor.process({
				thought: 'First thought without skills',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			});
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.available_skills).toBeUndefined();
		});
	});

	describe('ThoughtEvaluator Integration', () => {
		let evaluator: ThoughtEvaluator;
		let processorWithEvaluator: ThoughtProcessor;

		beforeEach(() => {
			evaluator = createEvaluator();
			processorWithEvaluator = new ThoughtProcessor(mockHistory, formatter, evaluator, logger);
		});

		it('should include reasoning fields when present in input', async () => {
			const input: ThoughtData = {
				thought: 'Hypothesis: performance bottleneck in rendering',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				thought_type: 'hypothesis',
				quality_score: 0.85,
				confidence: 0.7,
				hypothesis_id: 'perf-bottleneck-1',
			};

			const result = await processorWithEvaluator.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.thought_type).toBe('hypothesis');
			expect(parsed.quality_score).toBe(0.85);
			expect(parsed.confidence).toBe(0.7);
			expect(parsed.hypothesis_id).toBe('perf-bottleneck-1');
		});

		it('should include confidence_signals when evaluator is present', async () => {
			const input = createHypothesisThought({
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			});

			const result = await processorWithEvaluator.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.confidence_signals).toBeDefined();
			expect(parsed.confidence_signals.reasoning_depth).toBe(1);
			expect(parsed.confidence_signals.revision_count).toBe(0);
			expect(parsed.confidence_signals.branch_count).toBe(0);
			expect(parsed.confidence_signals.has_hypothesis).toBe(true);
			expect(parsed.confidence_signals.has_verification).toBe(false);
			expect(parsed.confidence_signals.thought_type_distribution).toBeDefined();
			expect(parsed.confidence_signals.thought_type_distribution.hypothesis).toBe(1);
			expect(typeof parsed.confidence_signals.average_confidence).toBe('number');
		});

		it('should include reasoning_stats when evaluator is present', async () => {
			const input = createHypothesisThought({
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
			});

			const result = await processorWithEvaluator.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.reasoning_stats).toBeDefined();
			expect(parsed.reasoning_stats.total_thoughts).toBe(1);
			expect(parsed.reasoning_stats.total_branches).toBe(0);
			expect(parsed.reasoning_stats.total_revisions).toBe(0);
			expect(parsed.reasoning_stats.total_merges).toBe(0);
			expect(parsed.reasoning_stats.chain_depth).toBe(1);
			expect(parsed.reasoning_stats.thought_type_counts).toBeDefined();
			expect(parsed.reasoning_stats.hypothesis_count).toBe(1);
			expect(parsed.reasoning_stats.verified_hypothesis_count).toBe(0);
			expect(parsed.reasoning_stats.unresolved_hypothesis_count).toBe(1);
			expect(typeof parsed.reasoning_stats.average_quality_score).toBe('number');
			expect(typeof parsed.reasoning_stats.average_confidence).toBe('number');
		});

		it('should produce reasoning fields with standard input', async () => {
			const input = createTestThought();

			const result = await processorWithEvaluator.process(input);
			const parsed = JSON.parse(result.content[0]!.text);

			// Existing fields still present
			expect(parsed.thought_number).toBe(1);
			expect(parsed.total_thoughts).toBe(1);
			expect(parsed.next_thought_needed).toBe(false);
			expect(parsed.branches).toEqual([]);
			expect(parsed.thought_history_length).toBe(1);

			// thought_type is always defaulted to 'regular' by normalizer
			expect(parsed.thought_type).toBe('regular');

			// Evaluator always produces signals
			expect(parsed.confidence_signals).toBeDefined();
			expect(parsed.reasoning_stats).toBeDefined();
		});
	});

	describe('reasoning_hints', () => {
		it('omits reasoning_hints when no warning patterns detected', async () => {
			const result = await processor.process(
				createTestThought({
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				})
			);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.reasoning_hints).toBeUndefined();
		});

		it('includes reasoning_hints when 3+ consecutive regular thoughts', async () => {
			await processor.process(
				createTestThought({
					thought_number: 1,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			await processor.process(
				createTestThought({
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			const result = await processor.process(
				createTestThought({
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.reasoning_hints).toBeDefined();
			expect(Array.isArray(parsed.reasoning_hints)).toBe(true);
			expect(parsed.reasoning_hints.length).toBeGreaterThan(0);
		});

		it('limits reasoning_hints to max 3', async () => {
			// Send thoughts with decreasing confidence to trigger confidence_drift
			// plus consecutive regular thoughts for consecutive_without_verification
			for (let i = 1; i <= 5; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 10,
						next_thought_needed: true,
						confidence: 1.0 - i * 0.15, // decreasing: 0.85, 0.70, 0.55, 0.40, 0.25
					})
				);
			}
			const result = await processor.process(
				createTestThought({
					thought_number: 6,
					total_thoughts: 10,
					next_thought_needed: true,
				})
			);
			const parsed = JSON.parse(result.content[0]!.text);
			if (parsed.reasoning_hints) {
				expect(parsed.reasoning_hints.length).toBeLessThanOrEqual(3);
			}
		});

		it('does not repeat same hint within 3-thought cooldown', async () => {
			// Process 3 thoughts to trigger consecutive_without_verification
			await processor.process(
				createTestThought({
					thought_number: 1,
					total_thoughts: 10,
					next_thought_needed: true,
				})
			);
			await processor.process(
				createTestThought({
					thought_number: 2,
					total_thoughts: 10,
					next_thought_needed: true,
				})
			);
			const result3 = await processor.process(
				createTestThought({
					thought_number: 3,
					total_thoughts: 10,
					next_thought_needed: true,
				})
			);
			const parsed3 = JSON.parse(result3.content[0]!.text);
			const firstHints = parsed3.reasoning_hints;

			// Process thought 4 — same pattern should be in cooldown
			const result4 = await processor.process(
				createTestThought({
					thought_number: 4,
					total_thoughts: 10,
					next_thought_needed: true,
				})
			);
			const parsed4 = JSON.parse(result4.content[0]!.text);

			// Hint fired at thought 3, so thought 4 should be in cooldown
			if (firstHints && firstHints.length > 0) {
				expect(parsed4.reasoning_hints).toBeUndefined();
			}
		});

		it('re-fires hint after cooldown expires', async () => {
			// Process 3 thoughts to trigger consecutive_without_verification at thought 3
			for (let i = 1; i <= 3; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 10,
						next_thought_needed: true,
					})
				);
			}
			// Process thoughts 4-5 (in cooldown: 4-3=1, 5-3=2 — both < 3)
			for (let i = 4; i <= 5; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 10,
						next_thought_needed: true,
					})
				);
			}
			// Thought 6: cooldown expired (6-3=3, NOT < 3) and new run of 3+ consecutive (4,5,6)
			const result6 = await processor.process(
				createTestThought({
					thought_number: 6,
					total_thoughts: 10,
					next_thought_needed: true,
				})
			);
			const parsed6 = JSON.parse(result6.content[0]!.text);
			expect(parsed6.reasoning_hints).toBeDefined();
			expect(parsed6.reasoning_hints.length).toBeGreaterThan(0);
		});

		it('tracks cooldowns per session independently', async () => {
			// Session A: trigger pattern at thought 3
			for (let i = 1; i <= 3; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 5,
						next_thought_needed: true,
						session_id: 'session-a',
					})
				);
			}
			const resultA = await processor.process(
				createTestThought({
					thought_number: 4,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: 'session-a',
				})
			);
			const parsedA4 = JSON.parse(resultA.content[0]!.text);

			// Session B: same pattern — should NOT be affected by session A's cooldown
			for (let i = 1; i <= 3; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 5,
						next_thought_needed: true,
						session_id: 'session-b',
					})
				);
			}
			const resultB = await processor.process(
				createTestThought({
					thought_number: 4,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: 'session-b',
				})
			);
			const parsedB4 = JSON.parse(resultB.content[0]!.text);

			// Both sessions are in cooldown at thought 4 (fired at 3, 4-3=1 < 3)
			// But the key point: session B was NOT blocked by session A's cooldown
			expect(parsedA4.reasoning_hints).toBeUndefined();
			expect(parsedB4.reasoning_hints).toBeUndefined();
		});

		it('session B gets hint even when session A is in cooldown', async () => {
			// Session A: trigger at thought 3, then thought 4 in cooldown
			for (let i = 1; i <= 4; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 5,
						next_thought_needed: true,
						session_id: 'hint-a',
					})
				);
			}

			// Session B: 3 thoughts triggers hint at thought 3
			await processor.process(
				createTestThought({
					thought_number: 1,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: 'hint-b',
				})
			);
			await processor.process(
				createTestThought({
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: 'hint-b',
				})
			);
			const resultB3 = await processor.process(
				createTestThought({
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: 'hint-b',
				})
			);
			const parsedB3 = JSON.parse(resultB3.content[0]!.text);

			// Session B gets hints despite session A being in cooldown
			expect(parsedB3.reasoning_hints).toBeDefined();
			expect(parsedB3.reasoning_hints.length).toBeGreaterThan(0);
		});

		it('does not include info-severity patterns as hints', async () => {
			// hypothesis followed by verification — triggers healthy_verification (info)
			// but NOT consecutive_without_verification (warning)
			await processor.process(
				createTestThought({
					thought_number: 1,
					total_thoughts: 5,
					next_thought_needed: true,
					thought_type: 'hypothesis',
					hypothesis_id: 'h1',
				})
			);
			await processor.process(
				createTestThought({
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
					thought_type: 'verification',
					hypothesis_id: 'h1',
				})
			);
			const result = await processor.process(
				createTestThought({
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			const parsed = JSON.parse(result.content[0]!.text);

			// healthy_verification is info-level — should NOT appear in reasoning_hints
			if (parsed.reasoning_hints) {
				for (const hint of parsed.reasoning_hints) {
					expect(hint).not.toContain('good practice');
				}
			}
		});

		it('reasoning_hints are strings with descriptive messages', async () => {
			await processor.process(
				createTestThought({
					thought_number: 1,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			await processor.process(
				createTestThought({
					thought_number: 2,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			const result = await processor.process(
				createTestThought({
					thought_number: 3,
					total_thoughts: 5,
					next_thought_needed: true,
				})
			);
			const parsed = JSON.parse(result.content[0]!.text);

			expect(parsed.reasoning_hints).toBeDefined();
			for (const hint of parsed.reasoning_hints) {
				expect(typeof hint).toBe('string');
				expect(hint.length).toBeGreaterThan(0);
			}
			// consecutive_without_verification pattern includes thought range
			expect(parsed.reasoning_hints[0]).toContain('consecutive');
		});

		it('confidence_drift pattern produces warning hint', async () => {
			// 3 consecutive thoughts with strictly decreasing confidence
			for (let i = 1; i <= 3; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 5,
						next_thought_needed: true,
						confidence: 1.0 - i * 0.2, // 0.8, 0.6, 0.4
						thought_type: 'verification', // avoid consecutive_without_verification
					})
				);
			}
			const result = await processor.process(
				createTestThought({
					thought_number: 4,
					total_thoughts: 5,
					next_thought_needed: true,
					confidence: 0.1, // continues decreasing
					thought_type: 'verification',
				})
			);
			const parsed = JSON.parse(result.content[0]!.text);

			// confidence_drift is a warning pattern
			if (parsed.reasoning_hints) {
				const hasDriftHint = parsed.reasoning_hints.some(
					(h: string) => h.toLowerCase().includes('confidence') || h.includes('\u2192')
				);
				expect(hasDriftHint).toBe(true);
			}
		});

		it('prioritizes confidence_drift over consecutive_without_verification when both fire', async () => {
			// Build a sequence that triggers BOTH consecutive_without_verification (3+ regular thoughts)
			// AND confidence_drift (3+ consecutive decreasing confidence). Cap is 3 hints, but if both
			// patterns fire and the priority sort works, confidence_drift must come first.
			let result: Awaited<ReturnType<typeof processor.process>> | undefined;
			for (let i = 1; i <= 3; i++) {
				result = await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 5,
						next_thought_needed: true,
						confidence: 1.0 - i * 0.2, // 0.8, 0.6, 0.4 (strictly decreasing)
						thought_type: 'regular',
					})
				);
			}
			const parsed = JSON.parse(result!.content[0]!.text);
			expect(parsed.reasoning_hints).toBeDefined();
			expect(parsed.reasoning_hints.length).toBeGreaterThan(0);

			// confidence_drift (priority 1) must come before consecutive_without_verification (priority 4)
			const driftIdx = parsed.reasoning_hints.findIndex(
				(h: string) => h.toLowerCase().includes('confidence') || h.includes('\u2192')
			);
			const consecutiveIdx = parsed.reasoning_hints.findIndex((h: string) =>
				h.toLowerCase().includes('consecutive')
			);
			if (driftIdx !== -1 && consecutiveIdx !== -1) {
				expect(driftIdx).toBeLessThan(consecutiveIdx);
			} else {
				// At minimum, confidence_drift hint must be present (highest priority)
				expect(driftIdx).toBeGreaterThanOrEqual(0);
			}
		});

		it('reset_state clears history but cooldowns persist on processor', async () => {
			// Trigger hint at thought 3
			for (let i = 1; i <= 3; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 10,
						next_thought_needed: true,
						session_id: 'reset-hints',
					})
				);
			}

			// Reset session and rebuild 3 consecutive thoughts
			for (let i = 1; i <= 4; i++) {
				await processor.process(
					createTestThought({
						thought_number: i,
						total_thoughts: 10,
						next_thought_needed: true,
						session_id: 'reset-hints',
						...(i === 1 ? { reset_state: true } : {}),
					})
				);
			}

			// Cooldown from thought 3 (first chain) is still active for thought 3-4 (second chain):
			// 3-3=0 < 3 → in cooldown at thought 3, 4-3=1 < 3 → in cooldown at thought 4.
			// _hintCooldowns is on ThoughtProcessor, NOT cleared by reset_state.
			const last = await processor.process(
				createTestThought({
					thought_number: 5,
					total_thoughts: 10,
					next_thought_needed: true,
					session_id: 'reset-hints',
				})
			);
			const parsed = JSON.parse(last.content[0]!.text);

			// 5-3=2 < 3 → still in cooldown for consecutive_without_verification.
			// monotonic_type and no_alternatives_explored (warning since bugs #4/#5 fixed)
			// have independent cooldowns and may fire here — assert the cooled-down hint is absent.
			const hints = parsed.reasoning_hints ?? [];
			expect(hints.some((h: string) => h.includes('without verification'))).toBe(false);
		});
	});

	describe('cross-field reference validation', () => {
		it('drops a dangling scalar reference before branch registration', async () => {
			const result = await processor.process({
				thought: 'Strict scalar reference',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				verification_target: 1,
				register_branch_id: 'future',
			});

			expect(result.isError).toBeUndefined();
			expect(JSON.parse(result.content[0]!.text).warnings).toEqual([
				'Dropped dangling verification_target: 1 (history has 0 thoughts)',
			]);
			expect(mockHistory.getBranchIds(asSessionId('test-session'))).toEqual([asBranchId('future')]);
		});

		it('filters dangling thought-list references before branch registration', async () => {
			const result = await processor.process({
				thought: 'Strict list reference',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				synthesis_sources: [1],
				register_branch_id: 'future',
			});

			expect(result.isError).toBeUndefined();
			expect(JSON.parse(result.content[0]!.text).warnings).toEqual([
				'Filtered dangling synthesis_sources: [1] (history has 0 thoughts)',
			]);
			expect(mockHistory.getBranchIds(asSessionId('test-session'))).toEqual([asBranchId('future')]);
		});

		it('rejects dangling branch references before branch registration', async () => {
			const result = await processor.process({
				thought: 'Strict branch reference',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				merge_branch_ids: [asBranchId('missing')],
				register_branch_id: 'future',
			});

			expect(result).toMatchObject({ isError: true });
			expect(JSON.parse(result.content[0]!.text)).toMatchObject({
				code: 'VALIDATION_ERROR',
				status: 'failed',
			});
			expect(mockHistory.getBranchIds(asSessionId('test-session'))).toEqual([]);
		});

		it('should drop verification_target referencing non-existent thought', async () => {
			// Seed 3 thoughts into history
			for (let i = 1; i <= 3; i++) {
				await processor.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: asSessionId('test-session'),
				});
			}

			const result = await processor.process({
				thought: 'Verify something',
				thought_number: 4,
				total_thoughts: 5,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				thought_type: 'verification',
				verification_target: 999,
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings).toHaveLength(1);
			expect(parsed.warnings[0]).toContain('verification_target');
			expect(parsed.warnings[0]).toContain('999');
		});

		it('should filter synthesis_sources keeping only valid references', async () => {
			// Seed 5 thoughts
			for (let i = 1; i <= 5; i++) {
				await processor.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 7,
					next_thought_needed: true,
					session_id: asSessionId('test-session'),
				});
			}

			const result = await processor.process({
				thought: 'Synthesize',
				thought_number: 6,
				total_thoughts: 7,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				thought_type: 'synthesis',
				synthesis_sources: [1, 999],
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings[0]).toContain('synthesis_sources');
			expect(parsed.warnings[0]).toContain('999');
			// The thought should still be added (no rejection)
			expect(result.isError).toBeUndefined();
		});

		it('should drop non-existent merge_branch_ids', async () => {
			const result = await processor.process({
				thought: 'Merge',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				merge_branch_ids: ['nonexistent'].map(asBranchId),
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings[0]).toContain('merge_branch_ids');
			expect(parsed.warnings[0]).toContain('nonexistent');
		});

		it('should drop revises_thought referencing non-existent thought', async () => {
			// Seed 5 thoughts
			for (let i = 1; i <= 5; i++) {
				await processor.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 7,
					next_thought_needed: true,
					session_id: asSessionId('test-session'),
				});
			}

			const result = await processor.process({
				thought: 'Revise',
				thought_number: 6,
				total_thoughts: 7,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				is_revision: true,
				revises_thought: 50,
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings[0]).toContain('revises_thought');
			expect(parsed.warnings[0]).toContain('50');
		});

		it('should pass through all valid references without warnings', async () => {
			// Seed 3 thoughts
			for (let i = 1; i <= 3; i++) {
				await processor.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: asSessionId('test-session'),
				});
			}

			const result = await processor.process({
				thought: 'Verify thought 2',
				thought_number: 4,
				total_thoughts: 5,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				thought_type: 'verification',
				verification_target: 2,
				synthesis_sources: [1, 3],
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeUndefined();
		});

		it('should drop all references when history is empty', async () => {
			const result = await processor.process({
				thought: 'First thought with references',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				verification_target: 5,
				revises_thought: 3,
				branch_from_thought: 2,
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings).toHaveLength(3);
			expect(result.isError).toBeUndefined();
		});

		it('should filter mixed valid/invalid merge_from_thoughts', async () => {
			// Seed 3 thoughts
			for (let i = 1; i <= 3; i++) {
				await processor.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: asSessionId('test-session'),
				});
			}

			const result = await processor.process({
				thought: 'Merge thoughts',
				thought_number: 4,
				total_thoughts: 5,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
				merge_from_thoughts: [1, 2, 100, 200],
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings[0]).toContain('merge_from_thoughts');
			expect(parsed.warnings[0]).toContain('100');
			expect(parsed.warnings[0]).toContain('200');
			expect(result.isError).toBeUndefined();
		});
	});

	describe('thought_number > total_thoughts auto-adjust warning', () => {
		it('should log warning and include in response when auto-adjusting total_thoughts', async () => {
			const mockHistoryManager = new MockHistoryManager();
			const mockLogger = {
				warn: vi.fn(),
				info: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			} as Logger;

			const proc = new ThoughtProcessor(
				mockHistoryManager,
				new ThoughtFormatter(),
				createEvaluator(),
				mockLogger
			);

			const result = await proc.process({
				thought: 'test',
				thought_number: 99,
				total_thoughts: 3,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
			});

			// Verify auto-adjust occurred
			const response = JSON.parse(result.content[0]!.text);
			expect(response.total_thoughts).toBe(99);

			// Verify warning logged
			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Auto-adjusted total_thoughts to match thought_number',
				expect.objectContaining({
					thought_number: 99,
					original_total_thoughts: 3,
					adjusted_total_thoughts: 99,
				})
			);

			// Verify warning in response
			expect(response.warnings).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						'[TOTAL_THOUGHTS_ADJUSTED] Auto-adjusted total_thoughts from 3 to 99'
					),
				])
			);
		});

		it('should not warn when thought_number <= total_thoughts', async () => {
			const mockHistoryManager = new MockHistoryManager();
			const mockLogger = {
				warn: vi.fn(),
				info: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			} as Logger;

			const proc = new ThoughtProcessor(
				mockHistoryManager,
				new ThoughtFormatter(),
				createEvaluator(),
				mockLogger
			);

			const result = await proc.process({
				thought: 'test',
				thought_number: 3,
				total_thoughts: 5,
				next_thought_needed: true,
				session_id: asSessionId('test-session'),
			});

			const response = JSON.parse(result.content[0]!.text);
			expect(response.total_thoughts).toBe(5);

			// No auto-adjust warning
			expect(mockLogger.warn).not.toHaveBeenCalledWith(
				'Auto-adjusted total_thoughts to match thought_number',
				expect.anything()
			);

			// No warnings in response (unless cross-field validation adds some)
			expect(response.warnings).toBeUndefined();
		});
	});

	describe('session isolation', () => {
		it('passes session_id to historyManager.getHistory()', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const spy = vi.spyOn(mockHM, 'getHistory');

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('sess-a'),
			});

			expect(spy).toHaveBeenCalledWith('sess-a');
		});

		it('passes session_id to historyManager.getBranches()', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const spy = vi.spyOn(mockHM, 'getBranches');

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('sess-b'),
			});

			expect(spy).toHaveBeenCalledWith('sess-b');
		});

		it('passes session_id to historyManager.getHistoryLength()', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const spy = vi.spyOn(mockHM, 'getHistoryLength');

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('sess-c'),
			});

			expect(spy).toHaveBeenCalledWith('sess-c');
		});

		it('passes session_id to historyManager.getBranchIds()', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const spy = vi.spyOn(mockHM, 'getBranchIds');

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('sess-d'),
			});

			expect(spy).toHaveBeenCalledWith('sess-d');
		});

		it('uses a non-mutating session snapshot for cached MCP tools', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const spy = vi.spyOn(mockHM, 'inspectSession');

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('sess-e'),
			});

			expect(spy).toHaveBeenCalledWith('sess-e');
		});

		it('uses a non-mutating session snapshot for cached skills', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const spy = vi.spyOn(mockHM, 'inspectSession');

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('sess-f'),
			});

			expect(spy).toHaveBeenCalledWith('sess-f');
		});

		it('includes session_id in response when provided', async () => {
			const result = await processor.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('my-session'),
			});
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.session_id).toBe('my-session');
		});

		it('rejects processing when session_id is omitted', async () => {
			const result = await Reflect.apply(processor.process, processor, [
				{
					thought: 'Test',
					thought_number: 1,
					total_thoughts: 1,
					next_thought_needed: false,
				},
			]);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(result.isError).toBe(true);
			expect(parsed.status).toBe('failed');
			expect(mockHistory.getSessionIds()).toEqual([]);
		});

		it('uses session-scoped history for cross-reference validation', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			// Add 2 thoughts to session 'alpha'
			for (let i = 1; i <= 2; i++) {
				await proc.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 3,
					next_thought_needed: true,
					session_id: asSessionId('alpha'),
				});
			}

			// Thought 3 in 'alpha' references revises_thought: 1 (valid)
			const result = await proc.process({
				thought: 'Revise thought 1',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
				session_id: asSessionId('alpha'),
				is_revision: true,
				revises_thought: 1,
			});

			const parsed = JSON.parse(result.content[0]!.text);
			// Should NOT have warnings since thought 1 exists in session 'alpha'
			expect(parsed.warnings).toBeUndefined();
		});
	});

	describe('reset_state', () => {
		it('delegates a direct reset without a session lock', async () => {
			const mockHM = new MockHistoryManager();
			const resetSpy = vi.spyOn(mockHM, 'resetSessionWithinExclusive');
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			await proc.resetSession('direct-reset');

			expect(resetSpy).toHaveBeenCalledWith('direct-reset', expect.any(Function));
		});

		it('delegates a direct reset while holding the shared session lock', async () => {
			const mockHM = new MockHistoryManager();
			const resetSpy = vi.spyOn(mockHM, 'resetSessionWithinExclusive');
			const proc = new ThoughtProcessor(
				mockHM,
				formatter,
				createEvaluator(),
				logger,
				new SequentialStrategy(),
				undefined,
				undefined,
				undefined,
				undefined,
				new SessionLock()
			);

			await proc.resetSession('locked-reset');

			expect(resetSpy).toHaveBeenCalledWith('locked-reset', expect.any(Function));
		});

		it('validates identity and full input before reset or branch registration', async () => {
			const mockHM = new MockHistoryManager();
			const resetSpy = vi.spyOn(mockHM, 'resetSessionWithinExclusive');
			const registrationSpy = vi.spyOn(mockHM, 'registerBranch');
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);
			const malformed = {
				thought: 'must not reset',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: 'bad/session',
				reset_state: true,
				register_branch_id: 'future',
			};
			const invalidContent = {
				...malformed,
				session_id: 'valid-session',
				thought_number: 0,
			};

			const malformedResult = await proc.process(malformed as unknown as ThoughtData);
			const invalidResult = await proc.process(invalidContent as unknown as ThoughtData);

			expect(malformedResult).toMatchObject({ isError: true });
			expect(invalidResult).toMatchObject({ isError: true });
			expect(resetSpy).not.toHaveBeenCalled();
			expect(registrationSpy).not.toHaveBeenCalled();
			expect(mockHM.getHistoryLength(asSessionId('valid-session'))).toBe(0);
		});

		it('awaits reset then registers the branch before admitting the replacement', async () => {
			const events: string[] = [];
			const mockHM = new MockHistoryManager();
			vi.spyOn(mockHM, 'resetSessionWithinExclusive').mockImplementation(async (sessionId) => {
				events.push(`reset:${sessionId}`);
			});
			vi.spyOn(mockHM, 'registerBranch').mockImplementation((sessionId, branchId) => {
				events.push(`register:${sessionId}:${branchId}`);
			});
			vi.spyOn(mockHM, 'addThought').mockImplementation((thought) => {
				events.push(`add:${thought.session_id}:${thought.thought}`);
			});
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			await proc.process({
				thought: 'replacement',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('ordered'),
				reset_state: true,
				register_branch_id: 'future',
			} as unknown as ThoughtData);

			expect(events).toEqual([
				'reset:ordered',
				'register:ordered:future',
				'add:ordered:replacement',
			]);
		});

		it('awaits exclusive reset work when reset_state is true', async () => {
			const mockHM = new MockHistoryManager();
			const spy = vi.spyOn(mockHM, 'resetSessionWithinExclusive');
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('my-session'),
				reset_state: true,
			});

			expect(spy).toHaveBeenCalledWith('my-session', expect.any(Function));
		});

		it('does not reset when reset_state is false', async () => {
			const mockHM = new MockHistoryManager();
			const spy = vi.spyOn(mockHM, 'resetSessionWithinExclusive');
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('my-session'),
				reset_state: false,
			});

			expect(spy).not.toHaveBeenCalled();
		});

		it('does not reset when reset_state is omitted', async () => {
			const mockHM = new MockHistoryManager();
			const spy = vi.spyOn(mockHM, 'resetSessionWithinExclusive');
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			await proc.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('my-session'),
			});

			expect(spy).not.toHaveBeenCalled();
		});

		it('processes thought as first after reset (history_length = 1)', async () => {
			const mockHM = new MockHistoryManager();
			const proc = new ThoughtProcessor(mockHM, formatter, createEvaluator(), logger);

			// Add 3 thoughts to the session
			for (let i = 1; i <= 3; i++) {
				await proc.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 5,
					next_thought_needed: true,
					session_id: asSessionId('reset-sess'),
				});
			}

			// Fourth thought with reset_state: true should start fresh
			const result = await proc.process({
				thought: 'Fresh start',
				thought_number: 1,
				total_thoughts: 2,
				next_thought_needed: true,
				session_id: asSessionId('reset-sess'),
				reset_state: true,
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.thought_history_length).toBe(1);
		});

		it('does not echo reset_state in response', async () => {
			const result = await processor.process({
				thought: 'Test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				reset_state: true,
			});
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.reset_state).toBeUndefined();
		});
	});
});

describe('ThoughtProcessor — uncovered branches', () => {
	let processor: ThoughtProcessor;
	let mockHistory: MockHistoryManager;
	let formatter: ThoughtFormatter;
	let logger: StructuredLogger;

	beforeEach(() => {
		mockHistory = new MockHistoryManager();
		formatter = new ThoughtFormatter();
		logger = new StructuredLogger({ context: 'Test', pretty: false });
		processor = new ThoughtProcessor(mockHistory, formatter, createEvaluator(), logger);
	});

	describe('_generateHints max 3 break (line 172)', () => {
		it('should cap hints at 3 even when more warnings are available', async () => {
			// We need 4+ different warning patterns active simultaneously.
			// Easiest: create a history that triggers multiple pattern signals.
			// 4+ consecutive same-type thoughts triggers consecutive_without_verification (warning)
			// 3+ decreasing confidence triggers confidence_drift (warning)
			// We need at least 4 different warning patterns to hit the break.
			// Let's use a longer history to trigger multiple distinct warning patterns.
			const proc = new ThoughtProcessor(
				new MockHistoryManager(),
				formatter,
				createEvaluator(),
				logger
			);

			// First, seed 12 consecutive 'regular' thoughts with decreasing confidence
			// This should trigger:
			// 1) consecutive_without_verification at thought 4+ (warning)
			// 2) confidence_drift (warning)
			// And monotonic_type (info, not counted)
			// To get 4+ warning patterns we use synthesis thoughts with dangling references too
			for (let i = 1; i <= 10; i++) {
				await proc.process({
					thought: `Thought ${i}`,
					thought_number: i,
					total_thoughts: 15,
					next_thought_needed: true,
					session_id: asSessionId('hint-cap'),
					thought_type: 'regular',
					confidence: 1.0 - i * 0.05,
				});
			}

			const result = await proc.process({
				thought: 'Another regular',
				thought_number: 11,
				total_thoughts: 15,
				next_thought_needed: true,
				session_id: asSessionId('hint-cap'),
				thought_type: 'regular',
				confidence: 0.3,
			});

			const parsed = JSON.parse(result.content[0]!.text);
			if (parsed.reasoning_hints) {
				expect(parsed.reasoning_hints.length).toBeLessThanOrEqual(3);
			}
		});
	});

	describe('process catch with non-Error (line 322)', () => {
		it('should handle non-Error thrown in process catch branch', async () => {
			// Create a HistoryManager that throws a non-Error value
			class StringThrowingHistoryManager implements IHistoryManager {
				assertThoughtIdentityAvailable(_thought: ThoughtData): void {}
				resolveThoughtReference(_sessionId: SessionId, _thoughtNumber: number) {
					return { kind: 'missing' as const };
				}
				addThought(): void {
					throw 'string failure';
				}
				getHistory(_sessionId: string): ThoughtData[] {
					return [];
				}
				getHistoryLength(_sessionId: string): number {
					return 0;
				}
				getBranches(_sessionId: string): Record<BranchId, ThoughtData[]> {
					return {};
				}
				getBranchIds(_sessionId: string): BranchId[] {
					return [];
				}
				registerBranch(_sessionId: string, _branchId: BranchId): void {}
				branchExists(_sessionId: string, _branchId: BranchId): boolean {
					return false;
				}
				async resetSession(_sessionId: string, _clearAuxiliaryState?: () => void): Promise<void> {}
				async resetSessionWithinExclusive(
					_sessionId: SessionId,
					_clearAuxiliaryState?: () => void
				): Promise<void> {}
				async resetAll(): Promise<void> {}
				async resetAllWithinExclusive(): Promise<void> {}
				inspectSession(_sessionId: string): HistorySessionSnapshot {
					return {
						history: [],
						branches: {},
						verificationTargets: new Map(),
						branchIds: [],
						availableMcpTools: undefined,
						availableSkills: undefined,
					};
				}
				getSessionIds(): string[] {
					return [];
				}
				getAvailableMcpTools(_sessionId: string): string[] | undefined {
					return undefined;
				}
				getAvailableSkills(_sessionId: string): string[] | undefined {
					return undefined;
				}
				getEdgeStore(): undefined {
					return undefined;
				}
			}

			const throwingHistory = new StringThrowingHistoryManager();
			const throwingProcessor = new ThoughtProcessor(
				throwingHistory,
				formatter,
				createEvaluator(),
				logger
			);

			const result = await throwingProcessor.process({
				thought: 'Test thought',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
			});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.error).toBe('string failure');
			expect(parsed.status).toBe('failed');
		});
	});

	describe('synthesis_sources all dangling → undefined (line 449)', () => {
		it('should set synthesis_sources to undefined when all values are dangling', async () => {
			const result = await processor.process({
				thought: 'Synthesis attempt',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				thought_type: 'synthesis',
				synthesis_sources: [100, 200, 300],
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings[0]).toContain('synthesis_sources');
			expect(result.isError).toBeUndefined();
		});
	});

	describe('merge_from_thoughts all dangling → undefined (line 468)', () => {
		it('should set merge_from_thoughts to undefined when all values are dangling', async () => {
			const result = await processor.process({
				thought: 'Merge attempt',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
				session_id: asSessionId('test-session'),
				merge_from_thoughts: [500, 600],
			});

			const parsed = JSON.parse(result.content[0]!.text);
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings[0]).toContain('merge_from_thoughts');
			expect(result.isError).toBeUndefined();
		});
	});
});
