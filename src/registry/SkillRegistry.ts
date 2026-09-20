/**
 * Skill registry for managing and discovering Claude Code skills.
 *
 * This module provides the `SkillRegistry` class which manages skill registration,
 * discovery from filesystem directories, and CRUD operations. Skills are higher-level
 * workflows that coordinate multiple tools and operations.
 *
 * @module registry
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { DuplicateSkillError, InvalidSkillError, SkillNotFoundError } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { Skill } from '../types/skill.js';
import { BaseRegistry } from './BaseRegistry.js';

/**
 * Configuration options for creating a `SkillRegistry` instance.
 *
 * @example
 * ```typescript
 * const options: SkillRegistryOptions = {
 *   logger: new StructuredLogger({ context: 'SkillRegistry' }),
 *   cache: new DiscoveryCache({ ttl: 300000, maxSize: 100 }),
 *   skillDirs: ['./custom-skills', '~/.claude/skills'],
 *   lazyDiscovery: true
 * };
 * ```
 */
export interface SkillRegistryOptions {
	/** Optional logger for diagnostics. */
	logger?: Logger;

	/** Optional cache for skill lookups. */
	cache?: DiscoveryCache<Skill>;

	/**
	 * Directory paths to search for skills.
	 * @default ['.claude/skills', '~/.claude/skills', '.agents/skills', '~/.agents/skills']
	 */
	skillDirs?: string[];

	/**
	 * Enable lazy discovery (discover on first access instead of startup).
	 * @default false
	 */
	lazyDiscovery?: boolean;
}

/**
 * Registry for managing Claude Code skill operations.
 *
 * Extends `BaseRegistry<Skill>` with skill-specific frontmatter parsing.
 */
export class SkillRegistry extends BaseRegistry<Skill> {
	protected override readonly _fileExtensions = ['.md', '.yml', '.yaml'];
	protected override readonly _entityName = 'skill';

	constructor(options: SkillRegistryOptions = {}) {
		super({
			logger: options.logger,
			cache: options.cache,
			searchDirs: options.skillDirs ?? [
				'.claude/skills',
				join(homedir(), '.claude/skills'),
				'.agents/skills',
				join(homedir(), '.agents/skills'),
			],
			lazyDiscovery: options.lazyDiscovery,
		});
	}

	// --- Error factories ---

	protected override _createInvalidError(reason: string): Error {
		return new InvalidSkillError(reason);
	}

	protected override _createDuplicateError(name: string): Error {
		return new DuplicateSkillError(name);
	}

	protected override _createNotFoundError(name: string, action: string): Error {
		return new SkillNotFoundError(name, action);
	}

	// --- Discovery ---

	protected override _shouldSkipFile(fileName: string): boolean {
		return fileName === '.DS_Store';
	}

	protected override _parseFrontmatter(content: string): Partial<Skill> & { _error?: string } {
		const frontmatter = this._extractFrontmatter(content);
		if (!frontmatter) {
			return {};
		}

		try {
			const result: Partial<Skill> = {
				name: typeof frontmatter.name === 'string' ? frontmatter.name : undefined,
				description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
				user_invocable: frontmatter['user-invocable'] === true,
				allowed_tools: Array.isArray(frontmatter['allowed-tools'])
					? frontmatter['allowed-tools'].map(String)
					: undefined,
			};

			if (!result.name) {
				return { _error: 'Missing required field: name' };
			}

			return result;
		} catch (error) {
			this.log('Error parsing YAML frontmatter:', {
				error: error instanceof Error ? error.message : String(error),
			});
			return { _error: 'YAML parse error' };
		}
	}

	protected override _buildItem(parsed: Partial<Skill>): Skill | null {
		if (!parsed.name) {
			return null;
		}
		return {
			name: parsed.name,
			description: parsed.description || '',
			user_invocable: parsed.user_invocable ?? false,
			allowed_tools: parsed.allowed_tools,
		};
	}
}
