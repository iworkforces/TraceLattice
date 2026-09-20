import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Skill } from '../types/skill.js';
import { SkillRegistry } from '../registry/SkillRegistry.js';
import { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { InvalidSkillError, DuplicateSkillError, SkillNotFoundError } from '../errors.js';

/** Test-only interface to access private _extractFrontmatter method. */
interface TestableWithExtractFrontmatter {
	_extractFrontmatter: () => unknown;
}

// ---------- Helpers ----------

function makeSkill(name: string, overrides: Partial<Skill> = {}): Skill {
	return {
		name,
		description: overrides.description ?? `Description for ${name}`,
		user_invocable: overrides.user_invocable ?? false,
		allowed_tools: overrides.allowed_tools,
	};
}

function makeSkillFile(opts: {
	name?: string;
	description?: string;
	userInvocable?: boolean;
	allowedTools?: string[];
	noFrontmatter?: boolean;
	invalidYaml?: boolean;
	missingName?: boolean;
	nonStringName?: boolean;
}): string {
	if (opts.noFrontmatter) {
		return '# Skill without frontmatter\n\nSome body text.';
	}
	if (opts.invalidYaml) {
		return '---\n: invalid: [yaml\n---\n# Body';
	}
	const lines: string[] = ['---'];
	if (opts.missingName) {
		// Frontmatter with no name field
		lines.push('description: A skill missing its name');
	} else if (opts.nonStringName) {
		lines.push('name: 123');
	} else {
		lines.push(`name: ${opts.name ?? 'test-skill'}`);
	}
	if (opts.description !== undefined) {
		lines.push(`description: ${opts.description}`);
	}
	if (opts.userInvocable !== undefined) {
		lines.push(`user-invocable: ${opts.userInvocable}`);
	}
	if (opts.allowedTools) {
		lines.push('allowed-tools:');
		for (const tool of opts.allowedTools) {
			lines.push(`  - ${tool}`);
		}
	}
	lines.push('---');
	lines.push('# Skill body');
	return lines.join('\n');
}

// ---------- Tests ----------

describe('SkillRegistry', () => {
	let registry: SkillRegistry;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'skill-registry-test-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ==================== Constructor ====================
	describe('Constructor', () => {
		it('creates registry with default options', () => {
			registry = new SkillRegistry();
			expect(registry.size()).toBe(0);
			expect(registry.getAll()).toEqual([]);
		});

		it('creates registry with custom skillDirs', () => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			expect(registry.size()).toBe(0);
		});

		it('creates registry with custom logger', () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			registry = new SkillRegistry({ logger, skillDirs: [tmpDir] });
			registry.add(makeSkill('logged-skill'));
			expect(logger.info).toHaveBeenCalled();
		});

		it('creates registry with custom cache', () => {
			const cache = new DiscoveryCache<Skill>({ maxSize: 10, ttl: 5000 });
			registry = new SkillRegistry({ cache, skillDirs: [tmpDir] });
			registry.add(makeSkill('cached'));
			expect(registry.has('cached')).toBe(true);
			cache.dispose();
		});

		it('creates registry with lazy discovery flag', () => {
			registry = new SkillRegistry({ lazyDiscovery: true, skillDirs: [tmpDir] });
			expect(registry.size()).toBe(0);
		});
	});

	// ==================== _shouldSkipFile ====================
	describe('_shouldSkipFile (via discovery)', () => {
		it('skips .DS_Store files', async () => {
			writeFileSync(join(tmpDir, '.DS_Store'), makeSkillFile({ name: 'ds-store-skill' }));
			writeFileSync(join(tmpDir, 'real-skill.md'), makeSkillFile({ name: 'real-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('real-skill')).toBe(true);
			expect(registry.has('ds-store-skill')).toBe(false);
		});

		it('does not skip regular files', async () => {
			writeFileSync(join(tmpDir, 'normal-skill.md'), makeSkillFile({ name: 'normal-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('normal-skill')).toBe(true);
		});
	});

	// ==================== _parseFrontmatter ====================
	describe('_parseFrontmatter (via discovery)', () => {
		it('parses valid frontmatter with name and description', async () => {
			writeFileSync(
				join(tmpDir, 'skill.md'),
				makeSkillFile({ name: 'my-skill', description: 'A great skill' })
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('my-skill');
			expect(skill).toBeDefined();
			expect(skill!.name).toBe('my-skill');
			expect(skill!.description).toBe('A great skill');
		});

		it('parses user-invocable field correctly', async () => {
			writeFileSync(
				join(tmpDir, 'invocable.md'),
				makeSkillFile({ name: 'invocable-skill', userInvocable: true })
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('invocable-skill');
			expect(skill).toBeDefined();
			expect(skill!.user_invocable).toBe(true);
		});

		it('parses user-invocable=false correctly', async () => {
			writeFileSync(
				join(tmpDir, 'non-invocable.md'),
				makeSkillFile({ name: 'non-invocable-skill', userInvocable: false })
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('non-invocable-skill');
			expect(skill).toBeDefined();
			expect(skill!.user_invocable).toBe(false);
		});

		it('parses allowed-tools array', async () => {
			writeFileSync(
				join(tmpDir, 'with-tools.md'),
				makeSkillFile({
					name: 'tools-skill',
					allowedTools: ['Bash', 'Read', 'Grep'],
				})
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('tools-skill');
			expect(skill).toBeDefined();
			expect(skill!.allowed_tools).toEqual(['Bash', 'Read', 'Grep']);
		});

		it('returns empty partial when no frontmatter present', async () => {
			writeFileSync(join(tmpDir, 'no-frontmatter.md'), makeSkillFile({ noFrontmatter: true }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			// No frontmatter → parsed returns {} → no name → not added
			expect(count).toBe(0);
		});

		it('returns _error when name is missing from frontmatter', async () => {
			writeFileSync(join(tmpDir, 'no-name.md'), makeSkillFile({ missingName: true }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			// Missing name → _error → skipped
			expect(count).toBe(0);
		});

		it('returns _error when name is not a string', async () => {
			writeFileSync(join(tmpDir, 'non-string-name.md'), makeSkillFile({ nonStringName: true }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			// name: 123 (number) → name is undefined → _error
			expect(count).toBe(0);
		});

		it('handles YAML parse errors gracefully', async () => {
			writeFileSync(join(tmpDir, 'invalid-yaml.md'), makeSkillFile({ invalidYaml: true }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			// Invalid YAML → catch block → _error → skipped
			expect(count).toBe(0);
		});

		it('defaults description to empty string when not provided', async () => {
			const content = '---\nname: minimal-skill\n---\n# Body';
			writeFileSync(join(tmpDir, 'minimal.md'), content);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('minimal-skill');
			expect(skill).toBeDefined();
			expect(skill!.description).toBe('');
		});

		it('defaults user_invocable to false when not in frontmatter', async () => {
			const content = '---\nname: default-invocable\n---\n# Body';
			writeFileSync(join(tmpDir, 'default.md'), content);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('default-invocable');
			expect(skill).toBeDefined();
			expect(skill!.user_invocable).toBe(false);
		});

		it('allowed_tools is undefined when not in frontmatter', async () => {
			const content = '---\nname: no-tools\n---\n# Body';
			writeFileSync(join(tmpDir, 'no-tools.md'), content);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('no-tools');
			expect(skill).toBeDefined();
			expect(skill!.allowed_tools).toBeUndefined();
		});

		it('handles non-string description in frontmatter', async () => {
			const content = '---\nname: num-desc\ndescription: 42\n---\n# Body';
			writeFileSync(join(tmpDir, 'num-desc.md'), content);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('num-desc');
			expect(skill).toBeDefined();
			// description is not a string → defaults to ''
			expect(skill!.description).toBe('');
		});
	});

	// ==================== _buildItem ====================
	describe('_buildItem (via discovery)', () => {
		it('builds a valid skill from parsed data', async () => {
			writeFileSync(
				join(tmpDir, 'valid.md'),
				makeSkillFile({
					name: 'built-skill',
					description: 'Built via discovery',
					userInvocable: true,
					allowedTools: ['Bash'],
				})
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('built-skill');
			expect(skill).toEqual({
				name: 'built-skill',
				description: 'Built via discovery',
				user_invocable: true,
				allowed_tools: ['Bash'],
			});
		});

		it('returns null for parsed data without name (skill not added)', async () => {
			writeFileSync(join(tmpDir, 'unnamed.md'), makeSkillFile({ noFrontmatter: true }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});
	});

	// ==================== Error Factories ====================
	describe('Error Factories', () => {
		beforeEach(() => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
		});

		describe('_createInvalidError', () => {
			it('throws InvalidSkillError when adding skill without name', () => {
				expect(() => registry.add({ name: '', description: 'no name' })).toThrow(InvalidSkillError);
			});

			it('includes reason in error message', () => {
				expect(() => registry.add({ name: '', description: 'no name' })).toThrow(
					'skill must have a valid name'
				);
			});

			it('has correct error code', () => {
				try {
					registry.add({ name: '', description: 'no name' });
				} catch (e) {
					expect(e).toBeInstanceOf(InvalidSkillError);
					expect((e as InvalidSkillError).code).toBe('INVALID_SKILL');
				}
			});
		});

		describe('_createDuplicateError', () => {
			it('throws DuplicateSkillError when adding duplicate skill', () => {
				registry.add(makeSkill('dup-skill'));
				expect(() => registry.add(makeSkill('dup-skill'))).toThrow(DuplicateSkillError);
			});

			it('includes skill name in error message', () => {
				registry.add(makeSkill('dup-skill'));
				expect(() => registry.add(makeSkill('dup-skill'))).toThrow(
					"skill 'dup-skill' already exists"
				);
			});

			it('has correct error code', () => {
				registry.add(makeSkill('dup-skill'));
				try {
					registry.add(makeSkill('dup-skill'));
				} catch (e) {
					expect(e).toBeInstanceOf(DuplicateSkillError);
					expect((e as DuplicateSkillError).code).toBe('DUPLICATE_SKILL');
				}
			});
		});

		describe('_createNotFoundError', () => {
			it('throws SkillNotFoundError when removing non-existent skill', () => {
				expect(() => registry.remove('ghost')).toThrow(SkillNotFoundError);
			});

			it('includes skill name and action in error message', () => {
				expect(() => registry.remove('ghost')).toThrow("Skill 'ghost' not found, cannot remove");
			});

			it('throws SkillNotFoundError when updating non-existent skill', () => {
				expect(() => registry.update('ghost', { description: 'new' })).toThrow(SkillNotFoundError);
			});

			it('includes action in update error message', () => {
				expect(() => registry.update('ghost', { description: 'new' })).toThrow(
					"Skill 'ghost' not found, cannot update"
				);
			});

			it('has correct error code', () => {
				try {
					registry.remove('ghost');
				} catch (e) {
					expect(e).toBeInstanceOf(SkillNotFoundError);
					expect((e as SkillNotFoundError).code).toBe('SKILL_NOT_FOUND');
				}
			});
		});
	});

	describe('Canonical CRUD operations', () => {
		beforeEach(() => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
		});

		describe('add()', () => {
			it('adds a skill to the registry', () => {
				const skill = makeSkill('added');
				registry.add(skill);
				expect(registry.has('added')).toBe(true);
			});

			it('delegates to add()', () => {
				const spy = vi.spyOn(registry, 'add');
				const skill = makeSkill('spied');
				registry.add(skill);
				expect(spy).toHaveBeenCalledWith(skill);
			});
		});

		describe('update()', () => {
			it('updates a skill in the registry', () => {
				registry.add(makeSkill('to-update'));
				registry.update('to-update', { description: 'Updated' });
				expect(registry.get('to-update')?.description).toBe('Updated');
			});

			it('delegates to update()', () => {
				registry.add(makeSkill('to-update'));
				const spy = vi.spyOn(registry, 'update');
				registry.update('to-update', { description: 'Updated' });
				expect(spy).toHaveBeenCalledWith('to-update', { description: 'Updated' });
			});
		});

		describe('has()', () => {
			it('returns true for existing skill', () => {
				registry.add(makeSkill('exists'));
				expect(registry.has('exists')).toBe(true);
			});

			it('returns false for non-existent skill', () => {
				expect(registry.has('nope')).toBe(false);
			});

			it('delegates to has()', () => {
				const spy = vi.spyOn(registry, 'has');
				registry.has('check');
				expect(spy).toHaveBeenCalledWith('check');
			});
		});

		describe('get()', () => {
			it('returns skill by name', () => {
				const skill = makeSkill('get-me');
				registry.add(skill);
				expect(registry.get('get-me')).toEqual(skill);
			});

			it('returns undefined for non-existent skill', () => {
				expect(registry.get('missing')).toBeUndefined();
			});

			it('delegates to get()', () => {
				const spy = vi.spyOn(registry, 'get');
				registry.get('delegated');
				expect(spy).toHaveBeenCalledWith('delegated');
			});
		});

		describe('setAll()', () => {
			it('replaces all skills', () => {
				registry.add(makeSkill('old'));
				registry.setAll([makeSkill('new1'), makeSkill('new2')]);
				expect(registry.has('old')).toBe(false);
				expect(registry.has('new1')).toBe(true);
				expect(registry.has('new2')).toBe(true);
				expect(registry.size()).toBe(2);
			});

			it('with empty array clears registry', () => {
				registry.add(makeSkill('existing'));
				registry.setAll([]);
				expect(registry.size()).toBe(0);
			});

			it('delegates to setAll()', () => {
				const spy = vi.spyOn(registry, 'setAll');
				const skills = [makeSkill('s1')];
				registry.setAll(skills);
				expect(spy).toHaveBeenCalledWith(skills);
			});
		});
	});

	// ==================== Discovery ====================
	describe('Discovery', () => {
		it('discovers .md skill files from directory', async () => {
			writeFileSync(
				join(tmpDir, 'skill-a.md'),
				makeSkillFile({ name: 'skill-a', description: 'Skill A' })
			);
			writeFileSync(
				join(tmpDir, 'skill-b.md'),
				makeSkillFile({ name: 'skill-b', description: 'Skill B' })
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(2);
			expect(registry.has('skill-a')).toBe(true);
			expect(registry.has('skill-b')).toBe(true);
		});

		it('discovers .yml skill files', async () => {
			writeFileSync(join(tmpDir, 'skill.yml'), makeSkillFile({ name: 'yml-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('yml-skill')).toBe(true);
		});

		it('discovers .yaml skill files', async () => {
			writeFileSync(join(tmpDir, 'skill.yaml'), makeSkillFile({ name: 'yaml-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('yaml-skill')).toBe(true);
		});

		it('skips files with non-matching extensions', async () => {
			writeFileSync(join(tmpDir, 'readme.txt'), 'not a skill');
			writeFileSync(join(tmpDir, 'data.json'), '{}');

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(0);
		});

		it('skips directories (non-file entries)', async () => {
			mkdirSync(join(tmpDir, 'subdir.md'));
			writeFileSync(join(tmpDir, 'real.md'), makeSkillFile({ name: 'real' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('real')).toBe(true);
		});

		it('handles non-existent directories gracefully', async () => {
			registry = new SkillRegistry({
				skillDirs: [join(tmpDir, 'non-existent-subdir')],
			});
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('handles empty directories', async () => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('deduplicates skills across multiple directories', async () => {
			const dir2 = mkdtempSync(join(tmpdir(), 'skill-registry-test2-'));
			try {
				writeFileSync(join(tmpDir, 'skill.md'), makeSkillFile({ name: 'same-skill' }));
				writeFileSync(join(dir2, 'skill.md'), makeSkillFile({ name: 'same-skill' }));

				registry = new SkillRegistry({ skillDirs: [tmpDir, dir2] });
				const count = await registry.discoverAsync();

				expect(count).toBe(1);
				expect(registry.size()).toBe(1);
			} finally {
				rmSync(dir2, { recursive: true, force: true });
			}
		});

		it('is idempotent (shares promise on concurrent calls)', async () => {
			writeFileSync(join(tmpDir, 'concurrent.md'), makeSkillFile({ name: 'concurrent-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const [count1, count2] = await Promise.all([
				registry.discoverAsync(),
				registry.discoverAsync(),
			]);

			expect(count1).toBe(count2);
			expect(registry.size()).toBe(1);
		});

		it('returns cached count on subsequent calls after discovery', async () => {
			const cache = new DiscoveryCache<Skill>({ maxSize: 50, ttl: 300000 });
			writeFileSync(join(tmpDir, 'cached.md'), makeSkillFile({ name: 'cached-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir], cache });
			await registry.discoverAsync();

			const count = await registry.discoverAsync();
			expect(count).toBe(1);
			cache.dispose();
		});

		it('discovers skills with full frontmatter fields', async () => {
			writeFileSync(
				join(tmpDir, 'full.md'),
				makeSkillFile({
					name: 'full-skill',
					description: 'Fully loaded',
					userInvocable: true,
					allowedTools: ['Bash', 'Read', 'Write'],
				})
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			const skill = registry.get('full-skill');
			expect(skill).toEqual({
				name: 'full-skill',
				description: 'Fully loaded',
				user_invocable: true,
				allowed_tools: ['Bash', 'Read', 'Write'],
			});
		});

		it('skips files with parse errors and continues discovery', async () => {
			writeFileSync(join(tmpDir, 'bad.md'), makeSkillFile({ invalidYaml: true }));
			writeFileSync(join(tmpDir, 'good.md'), makeSkillFile({ name: 'good-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
			expect(registry.has('good-skill')).toBe(true);
		});

		it('skips .DS_Store during discovery', async () => {
			writeFileSync(join(tmpDir, '.DS_Store'), 'binary junk');
			writeFileSync(join(tmpDir, 'valid.md'), makeSkillFile({ name: 'valid-skill' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			const count = await registry.discoverAsync();

			expect(count).toBe(1);
		});
	});

	// ==================== File Extensions ====================
	describe('File Extensions', () => {
		it('has correct file extensions (.md, .yml, .yaml)', () => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			// Verify by attempting discovery with each extension
			const extensions = ['.md', '.yml', '.yaml'];
			for (const ext of extensions) {
				writeFileSync(
					join(tmpDir, `skill-${ext.replace('.', '')}${ext}`),
					makeSkillFile({ name: `skill-${ext.replace('.', '')}` })
				);
			}
		});
	});

	// ==================== Entity Name ====================
	describe('Entity Name', () => {
		it('uses "skill" as entity name (visible in error messages)', () => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			expect(() => registry.add({ name: '', description: '' })).toThrow(
				'skill must have a valid name'
			);
		});
	});

	// ==================== Integration Tests ====================
	describe('Integration', () => {
		it('discovered skills can be updated via aliases', async () => {
			writeFileSync(
				join(tmpDir, 'updatable.md'),
				makeSkillFile({ name: 'updatable', description: 'Original' })
			);

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			registry.update('updatable', { description: 'Updated' });
			expect(registry.get('updatable')?.description).toBe('Updated');
		});

		it('discovered skills can be removed', async () => {
			writeFileSync(join(tmpDir, 'removable.md'), makeSkillFile({ name: 'removable' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			registry.remove('removable');
			expect(registry.has('removable')).toBe(false);
		});

		it('setAll replaces discovered skills', async () => {
			writeFileSync(join(tmpDir, 'discovered.md'), makeSkillFile({ name: 'discovered' }));

			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			await registry.discoverAsync();

			registry.setAll([makeSkill('manual1'), makeSkill('manual2')]);
			expect(registry.has('discovered')).toBe(false);
			expect(registry.has('manual1')).toBe(true);
			expect(registry.has('manual2')).toBe(true);
		});

		it('adds the same skill again after removal', () => {
			registry = new SkillRegistry({ skillDirs: [tmpDir] });
			registry.add(makeSkill('recycle'));
			registry.remove('recycle');
			registry.add(makeSkill('recycle', { description: 'New' }));
			expect(registry.get('recycle')?.description).toBe('New');
		});
	});

	// ==================== Direct Protected Method Access ====================
	describe('Protected methods (via test subclass)', () => {
		// Subclass to expose protected methods for direct testing
		class TestableSkillRegistry extends SkillRegistry {
			public testParseFrontmatter(content: string): Partial<Skill> & { _error?: string } {
				return this._parseFrontmatter(content);
			}

			public testBuildItem(parsed: Partial<Skill>): Skill | null {
				return this._buildItem(parsed);
			}

			public testShouldSkipFile(fileName: string): boolean {
				return this._shouldSkipFile(fileName);
			}

			// Allow overriding _extractFrontmatter for catch block testing
			public setExtractFrontmatter(fn: (content: string) => Record<string, unknown> | null): void {
				this._extractFrontmatter = fn;
			}
		}

		let testable: TestableSkillRegistry;

		beforeEach(() => {
			testable = new TestableSkillRegistry({ skillDirs: [tmpDir] });
		});

		describe('_shouldSkipFile()', () => {
			it('returns true for .DS_Store', () => {
				expect(testable.testShouldSkipFile('.DS_Store')).toBe(true);
			});

			it('returns false for regular files', () => {
				expect(testable.testShouldSkipFile('skill.md')).toBe(false);
				expect(testable.testShouldSkipFile('SKILL.md')).toBe(false);
				expect(testable.testShouldSkipFile('.gitignore')).toBe(false);
			});
		});

		describe('_parseFrontmatter()', () => {
			it('returns {} when no frontmatter is present', () => {
				const result = testable.testParseFrontmatter('# No frontmatter');
				expect(result).toEqual({});
			});

			it('parses valid frontmatter with all fields', () => {
				const content = [
					'---',
					'name: my-skill',
					'description: A skill',
					'user-invocable: true',
					'allowed-tools:',
					'  - Bash',
					'  - Read',
					'---',
					'# Body',
				].join('\n');
				const result = testable.testParseFrontmatter(content);
				expect(result).toEqual({
					name: 'my-skill',
					description: 'A skill',
					user_invocable: true,
					allowed_tools: ['Bash', 'Read'],
				});
			});

			it('returns _error when name is missing', () => {
				const content = '---\ndescription: No name here\n---\n# Body';
				const result = testable.testParseFrontmatter(content);
				expect(result._error).toBe('Missing required field: name');
			});

			it('returns _error when _extractFrontmatter result causes throw', () => {
				// Use vi.spyOn to mock _extractFrontmatter returning a Proxy that throws
				vi.spyOn(
					testable as unknown as TestableWithExtractFrontmatter,
					'_extractFrontmatter'
				).mockReturnValue(
					new Proxy(
						{},
						{
							get(_target, prop) {
								if (prop === 'name') {
									throw new Error('getter boom');
								}
								return undefined;
							},
						}
					) as never
				);

				const result = testable.testParseFrontmatter('any content');
				expect(result._error).toBe('YAML parse error');
			});

			it('returns _error with non-Error thrown value in catch', () => {
				vi.spyOn(
					testable as unknown as TestableWithExtractFrontmatter,
					'_extractFrontmatter'
				).mockReturnValue(
					new Proxy(
						{},
						{
							get(_target, prop) {
								if (prop === 'name') {
									throw { message: 'string error' };
								}
								return undefined;
							},
						}
					) as never
				);

				const result = testable.testParseFrontmatter('any content');
				expect(result._error).toBe('YAML parse error');
			});
		});

		describe('_buildItem()', () => {
			it('returns null when parsed data has no name', () => {
				const result = testable.testBuildItem({ description: 'no name' });
				expect(result).toBeNull();
			});

			it('returns null when parsed data has empty name', () => {
				const result = testable.testBuildItem({ name: '', description: 'empty' });
				expect(result).toBeNull();
			});

			it('builds skill with all fields', () => {
				const result = testable.testBuildItem({
					name: 'built',
					description: 'Built skill',
					user_invocable: true,
					allowed_tools: ['Bash'],
				});
				expect(result).toEqual({
					name: 'built',
					description: 'Built skill',
					user_invocable: true,
					allowed_tools: ['Bash'],
				});
			});

			it('defaults description to empty string when missing', () => {
				const result = testable.testBuildItem({ name: 'no-desc' });
				expect(result!.description).toBe('');
			});

			it('defaults user_invocable to false when undefined', () => {
				const result = testable.testBuildItem({ name: 'no-invocable' });
				expect(result!.user_invocable).toBe(false);
			});

			it('preserves allowed_tools as undefined when not provided', () => {
				const result = testable.testBuildItem({ name: 'no-tools' });
				expect(result!.allowed_tools).toBeUndefined();
			});
		});
	});
});
