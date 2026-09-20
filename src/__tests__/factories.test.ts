import { describe, it, expect } from 'vitest';
import {
	createTestThought,
	createToolRecommendation,
	createSkillRecommendation,
	createStepRecommendation,
	createHypothesisThought,
	createVerificationThought,
	createCritiqueThought,
	createSynthesisThought,
	createMetaThought,
	MockHistoryManager,
	createMockFormatter,
} from './helpers/factories.js';

describe('factories', () => {
	describe('createMetaThought', () => {
		it('should create a thought with meta type defaults', () => {
			const thought = createMetaThought();
			expect(thought.thought_type).toBe('meta');
			expect(thought.meta_observation).toBe('Current reasoning path is converging well');
			expect(thought.reasoning_depth).toBe('shallow');
		});

		it('should allow overriding meta thought fields', () => {
			const thought = createMetaThought({
				meta_observation: 'Custom observation',
				reasoning_depth: 'deep',
				thought_number: 5,
			});
			expect(thought.meta_observation).toBe('Custom observation');
			expect(thought.reasoning_depth).toBe('deep');
			expect(thought.thought_number).toBe(5);
		});
	});

	describe('MockHistoryManager.getResetCallCount', () => {
		it('should return 0 when reset has not been called', () => {
			const manager = new MockHistoryManager();
			expect(manager.getResetCallCount()).toBe(0);
		});

		it('should track reset call count', async () => {
			const manager = new MockHistoryManager();
			await manager.resetAll();
			expect(manager.getResetCallCount()).toBe(1);
			await manager.resetAll();
			expect(manager.getResetCallCount()).toBe(2);
		});

		it('should track reset call count for specific sessions', async () => {
			const manager = new MockHistoryManager();
			await manager.resetSession('session-1');
			await manager.resetSession('session-2');
			expect(manager.getResetCallCount()).toBe(2);
		});
	});

	describe('createMockFormatter', () => {
		it('should return an object with formatThought method', () => {
			const formatter = createMockFormatter();
			expect(formatter.formatThought).toBeTypeOf('function');
		});

		it('should format a thought as JSON with key fields', () => {
			const formatter = createMockFormatter();
			const thought = createTestThought({
				thought_number: 3,
				total_thoughts: 5,
				next_thought_needed: true,
				thought: 'Testing formatter',
			});
			const result = formatter.formatThought(thought);
			const parsed = JSON.parse(result) as Record<string, unknown>;

			expect(parsed.thought_number).toBe(3);
			expect(parsed.total_thoughts).toBe(5);
			expect(parsed.next_thought_needed).toBe(true);
			expect(parsed.thought).toBe('Testing formatter');
		});

		it('should produce valid JSON output', () => {
			const formatter = createMockFormatter();
			const thought = createTestThought();
			const result = formatter.formatThought(thought);
			expect(() => JSON.parse(result)).not.toThrow();
		});
	});

	describe('factory consistency checks', () => {
		it('createTestThought returns valid defaults', () => {
			const thought = createTestThought();
			expect(thought.thought).toBe('Test thought');
			expect(thought.thought_number).toBe(1);
			expect(thought.total_thoughts).toBe(1);
			expect(thought.next_thought_needed).toBe(false);
			expect(thought.session_id).toBe('test-session');
		});

		it('createToolRecommendation returns valid defaults', () => {
			const rec = createToolRecommendation();
			expect(rec.tool_name).toBe('test-tool');
			expect(rec.confidence).toBe(0.8);
		});

		it('createSkillRecommendation returns valid defaults', () => {
			const rec = createSkillRecommendation();
			expect(rec.skill_name).toBe('test-skill');
			expect(rec.confidence).toBe(0.7);
		});

		it('createStepRecommendation returns valid defaults', () => {
			const step = createStepRecommendation();
			expect(step.step_description).toBe('Test step description');
			expect(step.recommended_tools).toHaveLength(1);
			expect(step.expected_outcome).toBe('Test expected outcome');
		});

		it('createHypothesisThought returns hypothesis type', () => {
			const thought = createHypothesisThought();
			expect(thought.thought_type).toBe('hypothesis');
			expect(thought.hypothesis_id).toBe('hyp-1');
		});

		it('createVerificationThought returns verification type', () => {
			const thought = createVerificationThought();
			expect(thought.thought_type).toBe('verification');
			expect(thought.verification_target).toBe(1);
		});

		it('createCritiqueThought returns critique type', () => {
			const thought = createCritiqueThought();
			expect(thought.thought_type).toBe('critique');
			expect(thought.meta_observation).toBe('Previous reasoning overlooked edge cases');
		});

		it('createSynthesisThought returns synthesis type', () => {
			const thought = createSynthesisThought();
			expect(thought.thought_type).toBe('synthesis');
			expect(thought.synthesis_sources).toEqual([1, 2, 3]);
			expect(thought.merge_from_thoughts).toEqual([1, 3]);
			expect(thought.merge_branch_ids).toEqual(['branch-a']);
		});
	});

	describe('MockHistoryManager', () => {
		it('should start with empty history', () => {
			const manager = new MockHistoryManager();
			expect(manager.getHistory('test-session')).toEqual([]);
			expect(manager.getHistoryLength('test-session')).toBe(0);
		});

		it('should add and retrieve thoughts', () => {
			const manager = new MockHistoryManager();
			const thought = createTestThought({ thought_number: 1 });
			manager.addThought(thought);

			expect(manager.getHistory('test-session')).toHaveLength(1);
			expect(manager.getHistoryLength('test-session')).toBe(1);
			expect(manager.getHistory('test-session')[0]!.thought_number).toBe(1);
		});

		it('should return empty branches by default', () => {
			const manager = new MockHistoryManager();
			expect(manager.getBranches('test-session')).toEqual({});
			expect(manager.getBranchIds('test-session')).toEqual([]);
		});

		it('should return undefined for MCP tools when none set', () => {
			const manager = new MockHistoryManager();
			expect(manager.getAvailableMcpTools('test-session')).toBeUndefined();
		});

		it('should return undefined for skills when none set', () => {
			const manager = new MockHistoryManager();
			expect(manager.getAvailableSkills('test-session')).toBeUndefined();
		});

		it('should track MCP tools from added thoughts', () => {
			const manager = new MockHistoryManager();
			const thought = createTestThought({
				available_mcp_tools: ['tool-a', 'tool-b'],
			});
			manager.addThought(thought);

			expect(manager.getAvailableMcpTools('test-session')).toEqual(['tool-a', 'tool-b']);
		});

		it('should track skills from added thoughts', () => {
			const manager = new MockHistoryManager();
			const thought = createTestThought({
				available_skills: ['skill-x', 'skill-y'],
			});
			manager.addThought(thought);

			expect(manager.getAvailableSkills('test-session')).toEqual(['skill-x', 'skill-y']);
		});

		it('should isolate sessions by session_id', () => {
			const manager = new MockHistoryManager();
			manager.addThought(createTestThought({ session_id: 'a', thought_number: 1 }));
			manager.addThought(createTestThought({ session_id: 'b', thought_number: 2 }));

			expect(manager.getHistory('a')).toHaveLength(1);
			expect(manager.getHistory('b')).toHaveLength(1);
			expect(manager.getHistoryLength('a')).toBe(1);
			expect(manager.getHistoryLength('b')).toBe(1);
		});

		it('should return branches and branchIds for specific session', () => {
			const manager = new MockHistoryManager();
			// Access session to create it
			manager.addThought(createTestThought({ session_id: 'sess-1' }));
			expect(manager.getBranches('sess-1')).toEqual({});
			expect(manager.getBranchIds('sess-1')).toEqual([]);
		});

		it('should return tools and skills for specific session', () => {
			const manager = new MockHistoryManager();
			manager.addThought(
				createTestThought({
					session_id: 'sess-2',
					available_mcp_tools: ['t1'],
					available_skills: ['s1'],
				})
			);

			expect(manager.getAvailableMcpTools('sess-2')).toEqual(['t1']);
			expect(manager.getAvailableSkills('sess-2')).toEqual(['s1']);
		});

		it('should not set mcpTools when thought has no available_mcp_tools', () => {
			const manager = new MockHistoryManager();
			manager.addThought(
				createTestThought({
					thought: 'No tools',
					available_mcp_tools: undefined,
					available_skills: undefined,
				})
			);
			expect(manager.getAvailableMcpTools('test-session')).toBeUndefined();
			expect(manager.getAvailableSkills('test-session')).toBeUndefined();
		});
	});
});
