import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Tool } from '../types/tool.js';
import { ToolRegistry } from '../registry/ToolRegistry.js';
import { ConfigLoader } from '../config/ConfigLoader.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('Tool Registration', () => {
	it('should add tool successfully', () => {
		const toolRegistry = new ToolRegistry();
		const tool: Tool = { name: 'test-tool', description: 'Test tool', inputSchema: {} };
		toolRegistry.add(tool);
		expect(toolRegistry.has('test-tool')).toBe(true);
	});

	it('should throw error for duplicate tool', () => {
		const toolRegistry = new ToolRegistry();
		const tool = { name: 'test-tool', description: 'Test tool', inputSchema: {} };
		toolRegistry.add(tool);
		expect(() => toolRegistry.add(tool)).toThrow("tool 'test-tool' already exists");
	});

	it('should remove tool successfully', () => {
		const toolRegistry = new ToolRegistry();
		const tool = { name: 'test-tool', description: 'Test tool', inputSchema: {} };
		toolRegistry.add(tool);
		toolRegistry.remove('test-tool');
		expect(toolRegistry.has('test-tool')).toBe(false);
	});

	it('should throw error for removing non-existent tool', () => {
		const toolRegistry = new ToolRegistry();
		expect(() => toolRegistry.remove('non-existent')).toThrow(
			"Tool 'non-existent' not found, cannot remove"
		);
	});

	it('should update tool successfully', () => {
		const toolRegistry = new ToolRegistry();
		const tool = { name: 'test-tool', description: 'Test tool', inputSchema: {} };
		toolRegistry.add(tool);
		toolRegistry.update('test-tool', { description: 'Updated test tool' });
		const updated = toolRegistry.get('test-tool');
		expect(updated?.description).toBe('Updated test tool');
	});

	it('should get all tools', () => {
		const toolRegistry = new ToolRegistry();
		const tool1 = { name: 'tool1', description: 'Tool 1', inputSchema: {} };
		const tool2 = { name: 'tool2', description: 'Tool 2', inputSchema: {} };
		toolRegistry.add(tool1);
		toolRegistry.add(tool2);
		const tools = toolRegistry.getAll();
		expect(tools).toHaveLength(2);
	});

	it('should get tool by name', () => {
		const toolRegistry = new ToolRegistry();
		const tool = { name: 'my-tool', description: 'My tool', inputSchema: {} };
		toolRegistry.add(tool);
		const retrieved = toolRegistry.get('my-tool');
		expect(retrieved).toEqual(tool);
	});

	it('should clear all tools', () => {
		const toolRegistry = new ToolRegistry();
		const tool1 = { name: 'tool1', description: 'Tool 1', inputSchema: {} };
		toolRegistry.add(tool1);
		toolRegistry.clear();
		expect(toolRegistry.size()).toBe(0);
	});
});

describe('Environment Variable Overrides', () => {
	it('should override maxHistorySize from env variable', async () => {
		vi.stubEnv('TRACELATTICE_MAX_HISTORY_SIZE', '500');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		expect(config?.maxHistorySize).toBe(500);
	});

	it('should override logLevel from env variable', async () => {
		vi.stubEnv('TRACELATTICE_LOG_LEVEL', 'debug');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		expect(config?.logLevel).toBe('debug');
	});

	it('should override prettyLog from env variable', async () => {
		vi.stubEnv('TRACELATTICE_PRETTY_LOG', 'false');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		expect(config?.prettyLog).toBe(false);
	});

	it('should override skillDirs from env variable', async () => {
		vi.stubEnv('TRACELATTICE_SKILL_DIRS', '/custom/skills:/fallback/skills');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		expect(config?.skillDirs).toEqual(['/custom/skills', '/fallback/skills']);
	});

	it('should parse colon-separated paths correctly', async () => {
		vi.stubEnv('TRACELATTICE_SKILL_DIRS', 'path1:path2:path3');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		expect(config?.skillDirs).toEqual(['path1', 'path2', 'path3']);
	});

	it('should not override if env variable is not set', async () => {
		vi.stubEnv('TRACELATTICE_MAX_HISTORY_SIZE', undefined);

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		expect(config?.maxHistorySize).not.toBeDefined();
	});
});

describe('Discovery Cache Configuration', () => {
	it('should override cache TTL from env variable', async () => {
		// DISCOVERY_CACHE_TTL is in seconds, converted to milliseconds by ConfigLoader
		vi.stubEnv('TRACELATTICE_DISCOVERY_CACHE_TTL', '60');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		const ttl = config?.discoveryCache?.ttl;
		expect(ttl).toBe(60000); // 60 seconds * 1000 = 60000 milliseconds
	});

	it('should override cache maxSize from env variable', async () => {
		vi.stubEnv('TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE', '50');

		const configLoader = new ConfigLoader();
		const config = configLoader.load();

		const maxSize = config?.discoveryCache?.maxSize;
		expect(maxSize).toBe(50);
	});
});
