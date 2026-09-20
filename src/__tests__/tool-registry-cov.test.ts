import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { ToolRegistry } from '../registry/ToolRegistry.js';
import type { ToolRegistryOptions } from '../registry/ToolRegistry.js';
import { DiscoveryCache } from '../cache/DiscoveryCache.js';
import type { Tool } from '../types/tool.js';
import { InvalidToolError, DuplicateToolError, ToolNotFoundError } from '../errors.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------- Helpers ----------

function makeTool(name: string, description = '', inputSchema: Record<string, unknown> = {}): Tool {
	return { name, description, inputSchema };
}

function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
	return new ToolRegistry(options);
}

/**
 * Creates a temp directory with `.tool.md` files for discovery tests.
 * Returns the temp dir path. Caller must clean up.
 */
function createTempToolDir(files: { name: string; content: string }[]): string {
	const dir = mkdtempSync(join(tmpdir(), 'tool-registry-test-'));
	for (const f of files) {
		writeFileSync(join(dir, f.name), f.content, 'utf-8');
	}
	return dir;
}

function toolFrontmatter(opts: {
	name?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}): string {
	const lines: string[] = ['---'];
	if (opts.name !== undefined) lines.push(`name: ${opts.name}`);
	if (opts.description !== undefined) lines.push(`description: ${opts.description}`);
	if (opts.inputSchema !== undefined) {
		lines.push(`inputSchema:`);
		lines.push(`  type: object`);
		if (opts.inputSchema.properties) {
			lines.push(`  properties:`);
			for (const [key, val] of Object.entries(
				opts.inputSchema.properties as Record<string, { type: string }>
			)) {
				lines.push(`    ${key}:`);
				lines.push(`      type: ${val.type}`);
			}
		}
	}
	lines.push('---');
	lines.push('');
	lines.push('# Tool body');
	return lines.join('\n');
}

// ---------- Tests ----------

describe('ToolRegistry (coverage)', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup failures
			}
		}
	});

	// ==================== Constructor ====================
	describe('Constructor', () => {
		it('creates with default options', () => {
			const registry = createToolRegistry();
			expect(registry.size()).toBe(0);
			expect(registry.getAll()).toEqual([]);
		});

		it('creates with custom toolDirs', () => {
			const registry = createToolRegistry({ toolDirs: ['/custom/tools'] });
			expect(registry.size()).toBe(0);
		});

		it('creates with custom cache', () => {
			const cache = new DiscoveryCache<Tool>({ maxSize: 10, ttl: 1000 });
			const registry = createToolRegistry({ cache });
			expect(registry.size()).toBe(0);
			cache.dispose();
		});

		it('creates with custom logger', () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			const registry = createToolRegistry({ logger });
			registry.add(makeTool('logged-tool', 'test', { type: 'object' }));
			expect(logger.info).toHaveBeenCalled();
		});

		it('creates with lazyDiscovery flag', () => {
			const registry = createToolRegistry({ lazyDiscovery: true });
			expect(registry.size()).toBe(0);
		});
	});

	// ==================== _shouldSkipFile ====================
	describe('_shouldSkipFile (via discovery)', () => {
		it('never skips files — all .tool.md files are processed', async () => {
			const dir = createTempToolDir([
				{
					name: 'hidden.tool.md',
					content: toolFrontmatter({
						name: 'hidden-tool',
						description: 'Hidden',
						inputSchema: { type: 'object' },
					}),
				},
				{
					name: 'SKIP_ME.tool.md',
					content: toolFrontmatter({
						name: 'skip-tool',
						description: 'Skip',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(2);
			expect(registry.has('hidden-tool')).toBe(true);
			expect(registry.has('skip-tool')).toBe(true);
		});
	});

	// ==================== _parseFrontmatter ====================
	describe('_parseFrontmatter (via discovery)', () => {
		it('parses valid YAML with name, description, and inputSchema', async () => {
			const dir = createTempToolDir([
				{
					name: 'valid.tool.md',
					content: toolFrontmatter({
						name: 'my-tool',
						description: 'A valid tool',
						inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(1);

			const tool = registry.get('my-tool');
			expect(tool).toBeDefined();
			expect(tool!.name).toBe('my-tool');
			expect(tool!.description).toBe('A valid tool');
			expect(tool!.inputSchema).toBeDefined();
		});

		it('returns error for missing name field', async () => {
			const dir = createTempToolDir([
				{
					name: 'no-name.tool.md',
					content: [
						'---',
						'description: missing name',
						'inputSchema:',
						'  type: object',
						'---',
						'# Body',
					].join('\n'),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('returns error for missing inputSchema field', async () => {
			const dir = createTempToolDir([
				{
					name: 'no-schema.tool.md',
					content: [
						'---',
						'name: no-schema-tool',
						'description: has name but no schema',
						'---',
						'# Body',
					].join('\n'),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('returns error for no frontmatter at all', async () => {
			const dir = createTempToolDir([
				{
					name: 'plain.tool.md',
					content: '# Just a heading\nNo frontmatter here.',
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('handles name field that is not a string', async () => {
			const dir = createTempToolDir([
				{
					name: 'bad-name.tool.md',
					content: ['---', 'name: 42', 'inputSchema:', '  type: object', '---', '# Body'].join(
						'\n'
					),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			// name is not a string → "Missing required field: name"
			expect(count).toBe(0);
		});

		it('handles description that is not a string (defaults to empty)', async () => {
			const dir = createTempToolDir([
				{
					name: 'numeric-desc.tool.md',
					content: [
						'---',
						'name: numeric-desc-tool',
						'description: 123',
						'inputSchema:',
						'  type: object',
						'---',
						'# Body',
					].join('\n'),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(1);
			const tool = registry.get('numeric-desc-tool');
			// description is not string → defaults to ''
			expect(tool!.description).toBe('');
		});
	});

	// ==================== _buildItem ====================
	describe('_buildItem (via discovery)', () => {
		it('builds a valid tool from parsed frontmatter', async () => {
			const dir = createTempToolDir([
				{
					name: 'buildable.tool.md',
					content: toolFrontmatter({
						name: 'buildable',
						description: 'A buildable tool',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			await registry.discoverAsync();

			const tool = registry.get('buildable');
			expect(tool).toBeDefined();
			expect(tool!.name).toBe('buildable');
		});

		it('returns null for missing name → tool not added', async () => {
			const dir = createTempToolDir([
				{
					name: 'no-name-build.tool.md',
					content: ['---', 'description: no name', 'inputSchema:', '  type: object', '---'].join(
						'\n'
					),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('returns null for missing inputSchema → tool not added', async () => {
			const dir = createTempToolDir([
				{
					name: 'no-schema-build.tool.md',
					content: ['---', 'name: schema-less', '---'].join('\n'),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('defaults description to empty string when missing', async () => {
			const dir = createTempToolDir([
				{
					name: 'no-desc.tool.md',
					content: ['---', 'name: no-desc-tool', 'inputSchema:', '  type: object', '---'].join(
						'\n'
					),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			await registry.discoverAsync();

			const tool = registry.get('no-desc-tool');
			expect(tool).toBeDefined();
			expect(tool!.description).toBe('');
		});
	});

	// ==================== Error Factories ====================
	describe('Error factories', () => {
		it('_createInvalidError produces InvalidToolError', () => {
			const registry = createToolRegistry();
			expect(() => registry.add({ name: '', description: '', inputSchema: {} })).toThrow(
				InvalidToolError
			);
		});

		it('_createDuplicateError produces DuplicateToolError', () => {
			const registry = createToolRegistry();
			registry.add(makeTool('dup', 'test', { type: 'object' }));
			expect(() => registry.add(makeTool('dup', 'test2', { type: 'object' }))).toThrow(
				DuplicateToolError
			);
		});

		it('_createNotFoundError produces ToolNotFoundError on remove', () => {
			const registry = createToolRegistry();
			expect(() => registry.remove('ghost')).toThrow(ToolNotFoundError);
		});

		it('_createNotFoundError produces ToolNotFoundError on update', () => {
			const registry = createToolRegistry();
			expect(() => registry.update('ghost', { description: 'new' })).toThrow(ToolNotFoundError);
		});

		it('InvalidToolError has correct message', () => {
			const registry = createToolRegistry();
			try {
				registry.add({ name: '', description: '', inputSchema: {} });
			} catch (err) {
				expect(err).toBeInstanceOf(InvalidToolError);
				expect((err as Error).message).toContain('tool must have a valid name');
			}
		});

		it('DuplicateToolError has correct message', () => {
			const registry = createToolRegistry();
			registry.add(makeTool('dup-msg'));
			try {
				registry.add(makeTool('dup-msg'));
			} catch (err) {
				expect(err).toBeInstanceOf(DuplicateToolError);
				expect((err as Error).message).toContain("tool 'dup-msg' already exists");
			}
		});

		it('ToolNotFoundError has correct message', () => {
			const registry = createToolRegistry();
			try {
				registry.remove('missing-msg');
			} catch (err) {
				expect(err).toBeInstanceOf(ToolNotFoundError);
				expect((err as Error).message).toContain("Tool 'missing-msg' not found, cannot remove");
			}
		});
	});

	// ==================== get() with cache ====================
	describe('get() with cache lookup', () => {
		it('returns item from _items when no cache hit', () => {
			const cache = new DiscoveryCache<Tool>({ maxSize: 10, ttl: 60000 });
			const registry = createToolRegistry({ cache });

			const tool = makeTool('direct', 'Direct access', { type: 'object' });
			registry.add(tool);

			// Cache was invalidated by add, so get should fall through to _items
			const result = registry.get('direct');
			expect(result).toEqual(tool);
			cache.dispose();
		});

		it('returns cached tool when cache has entry', () => {
			const cache = new DiscoveryCache<Tool>({ maxSize: 10, ttl: 60000 });
			const registry = createToolRegistry({ cache });

			// Manually populate cache with tool:name key
			const cachedTool = makeTool('cached-one', 'From cache', { type: 'object' });
			cache.set('tool:cached-one', [cachedTool]);

			const result = registry.get('cached-one');
			expect(result).toEqual(cachedTool);
			cache.dispose();
		});

		it('falls through to _items when cache returns empty array', () => {
			const cache = new DiscoveryCache<Tool>({ maxSize: 10, ttl: 60000 });
			const registry = createToolRegistry({ cache });

			// Set empty array in cache
			cache.set('tool:empty-cache', []);

			// Add the tool to _items
			const tool = makeTool('empty-cache', 'Fallthrough', { type: 'object' });
			registry.add(tool);

			// Re-set cache with empty (add invalidated it)
			cache.set('tool:empty-cache', []);

			const result = registry.get('empty-cache');
			// Should fall through to _items since cached.length === 0
			expect(result).toEqual(tool);
			cache.dispose();
		});

		it('returns undefined when neither cache nor _items have the tool', () => {
			const cache = new DiscoveryCache<Tool>({ maxSize: 10, ttl: 60000 });
			const registry = createToolRegistry({ cache });

			const result = registry.get('nonexistent');
			expect(result).toBeUndefined();
			cache.dispose();
		});

		it('get works without cache (default cache path)', () => {
			const registry = createToolRegistry();
			const tool = makeTool('no-cache', 'No cache', { type: 'object' });
			registry.add(tool);

			const result = registry.get('no-cache');
			expect(result).toEqual(tool);
		});
	});

	describe('Canonical CRUD operations', () => {
		let registry: ToolRegistry;

		beforeEach(() => {
			registry = createToolRegistry();
		});

		it('adds tools', () => {
			const tool = makeTool('added', 'test', { type: 'object' });
			registry.add(tool);
			expect(registry.has('added')).toBe(true);
		});

		it('removes tools', () => {
			registry.add(makeTool('removed', 'test', { type: 'object' }));
			registry.remove('removed');
			expect(registry.has('removed')).toBe(false);
		});

		it('updates tools', () => {
			registry.add(makeTool('updated', 'old', { type: 'object' }));
			registry.update('updated', { description: 'new' });
			expect(registry.get('updated')?.description).toBe('new');
		});

		it('checks registered tools', () => {
			expect(registry.has('nope')).toBe(false);
			registry.add(makeTool('present', 'test', { type: 'object' }));
			expect(registry.has('present')).toBe(true);
		});

		it('gets tools including through the cache path', () => {
			registry.add(makeTool('retrieved', 'test', { type: 'object' }));
			const result = registry.get('retrieved');
			expect(result).toBeDefined();
			expect(result!.name).toBe('retrieved');
		});

		it('returns undefined for a non-existent tool', () => {
			expect(registry.get('ghost')).toBeUndefined();
		});

		it('replaces all tools', () => {
			registry.add(makeTool('old1'));
			registry.add(makeTool('old2'));

			registry.setAll([makeTool('new1', 'New 1'), makeTool('new2', 'New 2')]);

			expect(registry.has('old1')).toBe(false);
			expect(registry.has('old2')).toBe(false);
			expect(registry.has('new1')).toBe(true);
			expect(registry.has('new2')).toBe(true);
			expect(registry.size()).toBe(2);
		});

		it('clears the registry when replacing with an empty array', () => {
			registry.add(makeTool('existing'));
			registry.setAll([]);
			expect(registry.size()).toBe(0);
		});
	});

	// ==================== Discovery with real filesystem ====================
	describe('Discovery (real filesystem)', () => {
		it('discovers .tool.md files from temp directory', async () => {
			const dir = createTempToolDir([
				{
					name: 'tool-a.tool.md',
					content: toolFrontmatter({
						name: 'tool-a',
						description: 'Tool A',
						inputSchema: { type: 'object' },
					}),
				},
				{
					name: 'tool-b.tool.md',
					content: toolFrontmatter({
						name: 'tool-b',
						description: 'Tool B',
						inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(2);
			expect(registry.has('tool-a')).toBe(true);
			expect(registry.has('tool-b')).toBe(true);
		});

		it('skips non-.tool.md files', async () => {
			const dir = createTempToolDir([
				{
					name: 'readme.md',
					content: '# Not a tool',
				},
				{
					name: 'config.json',
					content: '{}',
				},
				{
					name: 'valid.tool.md',
					content: toolFrontmatter({
						name: 'only-tool',
						description: 'Only valid tool',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('only-tool')).toBe(true);
		});

		it('handles empty directory', async () => {
			const dir = createTempToolDir([]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(0);
		});

		it('handles non-existent directory', async () => {
			const registry = createToolRegistry({
				toolDirs: ['/nonexistent/path/that/does/not/exist'],
			});
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('deduplicates tools across multiple directories', async () => {
			const dir1 = createTempToolDir([
				{
					name: 'shared.tool.md',
					content: toolFrontmatter({
						name: 'shared-tool',
						description: 'From dir1',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			const dir2 = createTempToolDir([
				{
					name: 'shared.tool.md',
					content: toolFrontmatter({
						name: 'shared-tool',
						description: 'From dir2',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir1, dir2);

			const registry = createToolRegistry({ toolDirs: [dir1, dir2] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.size()).toBe(1);
			// First directory wins
			expect(registry.get('shared-tool')?.description).toBe('From dir1');
		});

		it('skips files with invalid frontmatter during discovery', async () => {
			const dir = createTempToolDir([
				{
					name: 'invalid.tool.md',
					content: '# No frontmatter at all',
				},
				{
					name: 'valid.tool.md',
					content: toolFrontmatter({
						name: 'valid-tool',
						description: 'Valid',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('valid-tool')).toBe(true);
		});

		it('idempotent — second discoverAsync returns cached count', async () => {
			const dir = createTempToolDir([
				{
					name: 'idem.tool.md',
					content: toolFrontmatter({
						name: 'idem-tool',
						description: 'Idempotent',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const first = await registry.discoverAsync();
			const second = await registry.discoverAsync();

			expect(first).toBe(1);
			expect(second).toBe(1);
		});

		it('concurrent discoverAsync shares same promise', async () => {
			const dir = createTempToolDir([
				{
					name: 'concurrent.tool.md',
					content: toolFrontmatter({
						name: 'concurrent-tool',
						description: 'Concurrent',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const [c1, c2] = await Promise.all([registry.discoverAsync(), registry.discoverAsync()]);

			expect(c1).toBe(c2);
		});

		it('skips subdirectories (only processes files)', async () => {
			const dir = createTempToolDir([
				{
					name: 'file.tool.md',
					content: toolFrontmatter({
						name: 'file-tool',
						description: 'File',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			// Create a subdirectory with .tool.md extension (unusual but possible)
			mkdirSync(join(dir, 'subdir.tool.md'));
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('file-tool')).toBe(true);
		});
	});

	// ==================== Integration: get with cache after discovery ====================
	describe('get with cache after discovery', () => {
		it('get returns tool discovered from filesystem', async () => {
			const dir = createTempToolDir([
				{
					name: 'discovered.tool.md',
					content: toolFrontmatter({
						name: 'discovered',
						description: 'Discovered tool',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const cache = new DiscoveryCache<Tool>({ maxSize: 50, ttl: 300000 });
			const registry = createToolRegistry({ toolDirs: [dir], cache });
			await registry.discoverAsync();

			const tool = registry.get('discovered');
			expect(tool).toBeDefined();
			expect(tool!.name).toBe('discovered');
			cache.dispose();
		});

		it('gets a tool after discovery', async () => {
			const dir = createTempToolDir([
				{
					name: 'alias-disc.tool.md',
					content: toolFrontmatter({
						name: 'alias-disc',
						description: 'Alias discovery',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			await registry.discoverAsync();

			const tool = registry.get('alias-disc');
			expect(tool).toBeDefined();
			expect(tool!.name).toBe('alias-disc');
		});
	});

	// ==================== fileExtensions and entityName ====================
	describe('Internal properties', () => {
		it('only discovers .tool.md files (not .skill.md or .md)', async () => {
			const dir = createTempToolDir([
				{
					name: 'tool.tool.md',
					content: toolFrontmatter({
						name: 'real-tool',
						description: 'Real',
						inputSchema: { type: 'object' },
					}),
				},
				{
					name: 'skill.skill.md',
					content: toolFrontmatter({
						name: 'not-a-tool',
						description: 'Skill file',
						inputSchema: { type: 'object' },
					}),
				},
				{
					name: 'plain.md',
					content: toolFrontmatter({
						name: 'also-not-tool',
						description: 'Plain md',
						inputSchema: { type: 'object' },
					}),
				},
			]);
			tempDirs.push(dir);

			const registry = createToolRegistry({ toolDirs: [dir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('real-tool')).toBe(true);
			expect(registry.has('not-a-tool')).toBe(false);
			expect(registry.has('also-not-tool')).toBe(false);
		});
	});

	// ==================== Uncovered Branch Coverage ====================
	describe('Uncovered Branch Coverage', () => {
		it('_parseFrontmatter catch branch — YAML parse error during property extraction', () => {
			const registry = createToolRegistry();
			// Access the protected method directly to test the catch branch
			// Create frontmatter YAML that parses but causes an error during extraction
			// Override _extractFrontmatter to return an object that throws on property access
			const throwingObj = new Proxy({} as Record<string, unknown>, {
				get(_target, prop) {
					if (prop === 'name') {
						throw new Error('Proxy trap error');
					}
					return undefined;
				},
			});
			(
				registry as unknown as { _extractFrontmatter: () => Record<string, unknown> }
			)._extractFrontmatter = () => throwingObj;

			const result = (
				registry as unknown as { _parseFrontmatter: (c: string) => { _error?: string } }
			)._parseFrontmatter('---\nname: test\n---');
			expect(result._error).toBe('YAML parse error');
		});

		it('_buildItem returns null when name is present but inputSchema is missing', () => {
			const registry = createToolRegistry();
			const result = (
				registry as unknown as { _buildItem: (p: Partial<Tool>) => Tool | null }
			)._buildItem({
				name: 'test-tool',
				description: 'test',
				// inputSchema deliberately omitted
			});
			expect(result).toBeNull();
		});
	});
});
