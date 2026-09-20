import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolAwareSequentialThinkingServer } from '../lib.js';
import { createServer } from '../lib.js';
import type { Tool } from '../types/tool.js';
import type { Skill } from '../types/skill.js';
import type { ThoughtData } from '../core/thought.js';
import { asSessionId } from '../contracts/ids.js';

const CRUD_SESSION = asSessionId('crud-session');

describe('CRUD Operations', () => {
	let server: ToolAwareSequentialThinkingServer;

	beforeEach(async () => {
		server = await createServer({ maxHistorySize: 10 });
	});

	describe('Tool CRUD', () => {
		const mockTool: Tool = {
			name: 'test-tool',
			description: 'A test tool',
			inputSchema: {},
		};

		it('should add a tool', () => {
			server.tools.add(mockTool);
			expect(server.tools.has('test-tool')).toBe(true);
			expect(server.tools.get('test-tool')).toEqual(mockTool);
		});

		it('should not add duplicate tool', () => {
			server.tools.add(mockTool);
			expect(() => server.tools.add(mockTool)).toThrow("tool 'test-tool' already exists");
			const tools = server.tools.getAll();
			const testTools = tools.filter((t: Tool) => t.name === 'test-tool');
			expect(testTools.length).toBe(1);
		});

		it('should remove a tool', () => {
			server.tools.add(mockTool);
			server.tools.remove('test-tool');
			expect(server.tools.has('test-tool')).toBe(false);
		});

		it('should throw when removing non-existent tool', () => {
			expect(() => server.tools.remove('non-existent')).toThrow(
				"Tool 'non-existent' not found, cannot remove"
			);
		});

		it('should update a tool', () => {
			server.tools.add(mockTool);
			server.tools.update('test-tool', { description: 'Updated description' });
			expect(server.tools.get('test-tool')?.description).toBe('Updated description');
		});

		it('should throw when updating non-existent tool', () => {
			expect(() => server.tools.update('non-existent', { description: 'New' })).toThrow(
				"Tool 'non-existent' not found, cannot update"
			);
		});

		it('should clear all tools', () => {
			server.tools.add(mockTool);
			server.tools.add({ name: 'another-tool', description: 'Another', inputSchema: {} });
			server.tools.clear();
			expect(server.tools.getAll().length).toBe(0);
		});
	});

	describe('Skill CRUD', () => {
		const mockSkill: Skill = {
			name: 'test-skill',
			description: 'A test skill',
			user_invocable: true,
		};

		it('should add a skill', () => {
			server.skills.add(mockSkill);
			expect(server.skills.has('test-skill')).toBe(true);
			expect(server.skills.get('test-skill')).toEqual(mockSkill);
		});

		it('should not add duplicate skill', () => {
			server.skills.add(mockSkill);
			expect(() => server.skills.add(mockSkill)).toThrow("skill 'test-skill' already exists");
			const skills = server.skills.getAll();
			const testSkills = skills.filter((s: Skill) => s.name === 'test-skill');
			expect(testSkills.length).toBe(1);
		});

		it('should remove a skill', () => {
			server.skills.add(mockSkill);
			server.skills.remove('test-skill');
			expect(server.skills.has('test-skill')).toBe(false);
		});

		it('should throw when removing non-existent skill', () => {
			expect(() => server.skills.remove('non-existent')).toThrow(
				"Skill 'non-existent' not found, cannot remove"
			);
		});

		it('should update a skill', () => {
			server.skills.add(mockSkill);
			server.skills.update('test-skill', { description: 'Updated description' });
			expect(server.skills.get('test-skill')?.description).toBe('Updated description');
		});

		it('should throw when updating non-existent skill', () => {
			expect(() => server.skills.update('non-existent', { description: 'New' })).toThrow(
				"Skill 'non-existent' not found, cannot update"
			);
		});

		it('should clear all skills', () => {
			server.skills.add(mockSkill);
			server.skills.add({
				name: 'another-skill',
				description: 'Another',
				user_invocable: false,
			});
			server.skills.clear();
			expect(server.skills.getAll().length).toBe(0);
		});
	});

	describe('History Management', () => {
		it('should clear history', async () => {
			// Add a thought to history
			await server.processThought({
				session_id: CRUD_SESSION,
				thought: 'test',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			} satisfies ThoughtData);

			// Verify history is not empty
			expect(server.history.getHistory(CRUD_SESSION).length).toBeGreaterThan(0);

			// Clear history
			await server.resetAll();

			// Verify history is empty
			expect(server.history.getHistory(CRUD_SESSION)).toHaveLength(0);
		});
	});
});
