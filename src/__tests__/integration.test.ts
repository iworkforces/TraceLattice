import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolAwareSequentialThinkingServer } from '../lib.js';
import { createServer } from '../lib.js';

import { asBranchId, asSessionId } from '../contracts/ids.js';

const INTEGRATION_SESSION = asSessionId('integration-session');

describe('ToolAwareSequentialThinkingServer Integration', () => {
	let server: ToolAwareSequentialThinkingServer;

	beforeEach(async () => {
		server = await createServer({ maxHistorySize: 10 });
	});

	it('should process complete thought sequence', async () => {
		const result = (await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'First thought',
			thought_number: 1,
			total_thoughts: 3,
			next_thought_needed: true,
			available_mcp_tools: ['test-tool'],
		})) as { content: Array<{ type: string; text: string }> };

		expect(result.content[0]!.type).toBe('text');
		const response = JSON.parse(result.content[0]!.text);
		expect(response.thought_number).toBe(1);
		expect(response.next_thought_needed).toBe(true);
	});

	it('should handle branching thoughts', async () => {
		await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'Original thought',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
		});

		await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'Branch thought',
			thought_number: 2,
			total_thoughts: 3,
			next_thought_needed: true,
			branch_from_thought: 1,
			branch_id: asBranchId('branch-a'),
		});

		const branches = server.history.getBranches(INTEGRATION_SESSION);
		expect(branches[asBranchId('branch-a')]).toHaveLength(1);
	});

	it('should handle thought revisions', async () => {
		await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'Original thought',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
		});

		const result = (await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'Revised thought',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			is_revision: true,
			revises_thought: 1,
		})) as { content: Array<{ type: string; text: string }> };

		const response = JSON.parse(result.content[0]!.text);
		expect(response.thought_number).toBe(2);
	});

	it('should track step recommendations', async () => {
		const result = (await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'I need to search the codebase',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			current_step: {
				step_description: 'Search for files',
				recommended_tools: [
					{
						tool_name: 'search-tool',
						confidence: 0.9,
						rationale: 'Best for searching',
						priority: 1,
					},
				],
				expected_outcome: 'List of matching files',
			},
		})) as { content: Array<{ type: string; text: string }> };

		const response = JSON.parse(result.content[0]!.text);
		expect(response.current_step).toBeDefined();
		expect(response.current_step?.step_description).toBe('Search for files');
	});

	it('should limit history size', async () => {
		const smallServer = await createServer({ maxHistorySize: 3 });

		// Add 5 thoughts
		for (let i = 1; i <= 5; i++) {
			await smallServer.processThought({
				session_id: INTEGRATION_SESSION,
				thought: `Thought ${i}`,
				thought_number: i,
				total_thoughts: 5,
				next_thought_needed: i < 5,
			});
		}

		// History should be trimmed to maxHistorySize
		expect(smallServer.history.getHistory(INTEGRATION_SESSION).length).toBeLessThanOrEqual(3);
	});

	it('should handle errors gracefully', async () => {
		const result = (await server.processThought({
			session_id: INTEGRATION_SESSION,
			thought: 'Test',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
		})) as { content: Array<{ type: string; text: string }> };

		// Should not throw, should return valid response
		expect(result).toBeDefined();
		expect(result.content).toBeDefined();
	});
});
