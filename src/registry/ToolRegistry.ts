/**
 * Tool registry for managing MCP tool CRUD operations.
 *
 * This module provides the `ToolRegistry` class which manages the registration,
 * retrieval, update, and removal of MCP tools. It supports optional caching
 * for improved performance, filesystem discovery, and integrates with the logging system.
 *
 * @module registry
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { DuplicateToolError, InvalidToolError, ToolNotFoundError } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { Tool } from '../types/tool.js';
import { BaseRegistry } from './BaseRegistry.js';

/**
 * Configuration options for creating a `ToolRegistry` instance.
 *
 * @example
 * ```typescript
 * const options: ToolRegistryOptions = {
 *   logger: new StructuredLogger({ context: 'ToolRegistry' }),
 *   cache: new DiscoveryCache({ ttl: 300000, maxSize: 100 }),
 *   toolDirs: ['./custom-tools', '~/.claude/tools'],
 *   lazyDiscovery: true
 * };
 * ```
 */
export interface ToolRegistryOptions {
	/** Optional logger for diagnostics. */
	logger?: Logger;

	/** Optional cache for tool lookups. */
	cache?: DiscoveryCache<Tool>;

	/**
	 * Directory paths to search for tools.
	 * @default ['.claude/tools', '~/.claude/tools']
	 */
	toolDirs?: string[];

	/**
	 * Enable lazy discovery (discover on first access instead of startup).
	 * @default false
	 */
	lazyDiscovery?: boolean;
}

/**
 * Registry for managing MCP tool operations.
 *
 * Extends `BaseRegistry<Tool>` with tool-specific frontmatter parsing.
 */
export class ToolRegistry extends BaseRegistry<Tool> {
	protected override readonly _fileExtensions = ['.tool.md'];
	protected override readonly _entityName = 'tool';

	constructor(options: ToolRegistryOptions = {}) {
		super({
			logger: options.logger,
			cache: options.cache,
			searchDirs: options.toolDirs ?? ['.claude/tools', join(homedir(), '.claude/tools')],
			lazyDiscovery: options.lazyDiscovery,
		});
	}

	// --- Error factories ---

	protected override _createInvalidError(reason: string): Error {
		return new InvalidToolError(reason);
	}

	protected override _createDuplicateError(name: string): Error {
		return new DuplicateToolError(name);
	}

	protected override _createNotFoundError(name: string, action: string): Error {
		return new ToolNotFoundError(name, action);
	}

	// --- Discovery ---

	protected override _shouldSkipFile(_fileName: string): boolean {
		return false;
	}

	protected override _parseFrontmatter(content: string): Partial<Tool> & { _error?: string } {
		const frontmatter = this._extractFrontmatter(content);
		if (!frontmatter) {
			return { _error: 'No YAML frontmatter found' };
		}

		try {
			const result: Partial<Tool> = {
				name: typeof frontmatter.name === 'string' ? frontmatter.name : undefined,
				description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
				inputSchema: frontmatter.inputSchema as Tool['inputSchema'],
			};

			if (!result.name) {
				return { _error: 'Missing required field: name' };
			}
			if (!result.inputSchema) {
				return { _error: 'Missing required field: inputSchema' };
			}

			return result;
		} catch {
			return { _error: 'YAML parse error' };
		}
	}

	protected override _buildItem(parsed: Partial<Tool>): Tool | null {
		if (!parsed.name || !parsed.inputSchema) {
			return null;
		}
		return {
			name: parsed.name,
			description: parsed.description || '',
			inputSchema: parsed.inputSchema,
		};
	}

	// --- Tool-specific get with cache lookup ---

	public override get(name: string): Tool | undefined {
		if (this._cache) {
			const cached = this._cache.get(`tool:${name}`);
			if (cached && cached.length > 0) {
				return cached[0];
			}
		}
		return this._items.get(name);
	}
}
