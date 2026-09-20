import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseRegistry } from '../registry/BaseRegistry.js';
import type { BaseRegistryOptions } from '../registry/BaseRegistry.js';
import { InvalidToolError, DuplicateToolError, ToolNotFoundError } from '../errors.js';
import { DiscoveryCache } from '../cache/DiscoveryCache.js';
import { SkillRegistry } from '../registry/SkillRegistry.js';
import { ToolRegistry } from '../registry/ToolRegistry.js';

// ---------- Module-level mocks (hoisted by vitest) ----------
vi.mock('node:fs/promises', () => ({
	readdir: vi.fn(),
	readFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
}));

// Import the mocked modules so we can configure them per-test
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);
const mockExistsSync = vi.mocked(existsSync);

// ---------- Test item type ----------
interface TestItem {
	name: string;
	value: number;
}

// ---------- Concrete subclass for testing ----------
class TestRegistry extends BaseRegistry<TestItem> {
	protected readonly _fileExtensions = ['.test.md'];
	protected readonly _entityName = 'test';

	protected _createInvalidError(reason: string): Error {
		return new InvalidToolError(reason);
	}

	protected _createDuplicateError(name: string): Error {
		return new DuplicateToolError(name);
	}

	protected _createNotFoundError(name: string, action: string): Error {
		return new ToolNotFoundError(name, action);
	}

	protected _parseFrontmatter(_content: string): Partial<TestItem> & { _error?: string } {
		return {};
	}

	protected _shouldSkipFile(_fileName: string): boolean {
		return false;
	}

	protected _buildItem(parsed: Partial<TestItem>): TestItem | null {
		if (!parsed.name) return null;
		return { name: parsed.name, value: parsed.value ?? 0 };
	}

	// Expose internal state for testing
	get discovered(): boolean {
		return this._discovered;
	}

	// Allow overriding _parseFrontmatter in tests
	setParseFrontmatter(fn: (content: string) => Partial<TestItem> & { _error?: string }): void {
		this._parseFrontmatter = fn;
	}

	setShouldSkipFile(fn: (fileName: string) => boolean): void {
		this._shouldSkipFile = fn;
	}
}

// ---------- Helpers ----------
function createRegistry(options: Partial<BaseRegistryOptions> = {}): TestRegistry {
	return new TestRegistry({ searchDirs: [], ...options });
}

function makeItem(name: string, value = 0): TestItem {
	return { name, value };
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	const result = Promise.withResolvers<T>();
	return { promise: result.promise, resolve: result.resolve };
}

// ---------- Tests ----------

describe('BaseRegistry', () => {
	let registry: TestRegistry;

	beforeEach(() => {
		registry = createRegistry();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ==================== CRUD Operations ====================
	describe('CRUD Operations', () => {
		describe('add()', () => {
			it('adds item to registry', () => {
				const item = makeItem('alpha', 1);
				registry.add(item);
				expect(registry.has('alpha')).toBe(true);
				expect(registry.get('alpha')).toEqual(item);
			});

			it('throws DuplicateToolError for duplicate names', () => {
				registry.add(makeItem('dup'));
				expect(() => registry.add(makeItem('dup'))).toThrow(DuplicateToolError);
				expect(() => registry.add(makeItem('dup'))).toThrow("tool 'dup' already exists");
			});

			it('throws InvalidToolError if item has no name', () => {
				expect(() => registry.add({ name: '', value: 0 })).toThrow(InvalidToolError);
			});
		});

		describe('get()', () => {
			it('returns item by name', () => {
				const item = makeItem('found', 42);
				registry.add(item);
				expect(registry.get('found')).toEqual(item);
			});

			it('returns undefined for non-existent item', () => {
				expect(registry.get('ghost')).toBeUndefined();
			});
		});

		describe('getAll()', () => {
			it('returns all items', () => {
				registry.add(makeItem('a', 1));
				registry.add(makeItem('b', 2));
				const all = registry.getAll();
				expect(all).toHaveLength(2);
				expect(all.map((i) => i.name).sort()).toEqual(['a', 'b']);
			});

			it('returns empty array when registry is empty', () => {
				expect(registry.getAll()).toEqual([]);
			});

			it('returns a caller-owned array when results are cached', () => {
				// Given
				registry.add(makeItem('stable', 1));
				const firstRead = registry.getAll();

				// When
				firstRead.length = 0;

				// Then
				expect(registry.getAll()).toEqual([makeItem('stable', 1)]);
			});
		});

		describe('has()', () => {
			it('returns true for existing item', () => {
				registry.add(makeItem('exists'));
				expect(registry.has('exists')).toBe(true);
			});

			it('returns false for non-existent item', () => {
				expect(registry.has('nope')).toBe(false);
			});
		});

		describe('remove()', () => {
			it('removes item', () => {
				registry.add(makeItem('rm'));
				registry.remove('rm');
				expect(registry.has('rm')).toBe(false);
			});

			it('throws ToolNotFoundError for non-existent item', () => {
				expect(() => registry.remove('missing')).toThrow(ToolNotFoundError);
				expect(() => registry.remove('missing')).toThrow("Tool 'missing' not found, cannot remove");
			});
		});

		describe('update()', () => {
			it('updates existing item', () => {
				registry.add(makeItem('upd', 10));
				registry.update('upd', { value: 99 });
				expect(registry.get('upd')?.value).toBe(99);
			});

			it('preserves unchanged fields', () => {
				registry.add(makeItem('upd2', 5));
				registry.update('upd2', { value: 50 });
				expect(registry.get('upd2')?.name).toBe('upd2');
			});

			it('throws ToolNotFoundError for non-existent item', () => {
				expect(() => registry.update('missing', { value: 1 })).toThrow(ToolNotFoundError);
				expect(() => registry.update('missing', { value: 1 })).toThrow(
					"Tool 'missing' not found, cannot update"
				);
			});
		});

		describe('clear()', () => {
			it('removes all items', () => {
				registry.add(makeItem('x'));
				registry.add(makeItem('y'));
				registry.clear();
				expect(registry.size()).toBe(0);
				expect(registry.getAll()).toEqual([]);
			});
		});

		describe('size()', () => {
			it('returns correct count', () => {
				expect(registry.size()).toBe(0);
				registry.add(makeItem('one'));
				expect(registry.size()).toBe(1);
				registry.add(makeItem('two'));
				expect(registry.size()).toBe(2);
				registry.remove('one');
				expect(registry.size()).toBe(1);
			});
		});

		describe('getNames()', () => {
			it('returns array of names', () => {
				registry.add(makeItem('first'));
				registry.add(makeItem('second'));
				expect(registry.getNames().sort()).toEqual(['first', 'second']);
			});

			it('returns empty array when empty', () => {
				expect(registry.getNames()).toEqual([]);
			});
		});
	});

	// ==================== Bulk Operations ====================
	describe('Bulk Operations', () => {
		describe('setAll()', () => {
			it('replaces all items', () => {
				registry.add(makeItem('old1'));
				registry.add(makeItem('old2'));

				registry.setAll([makeItem('new1', 10), makeItem('new2', 20)]);

				expect(registry.has('old1')).toBe(false);
				expect(registry.has('old2')).toBe(false);
				expect(registry.has('new1')).toBe(true);
				expect(registry.has('new2')).toBe(true);
				expect(registry.size()).toBe(2);
			});

			it('with empty array clears registry', () => {
				registry.add(makeItem('existing'));
				registry.setAll([]);
				expect(registry.size()).toBe(0);
			});

			it('handles duplicate items in input gracefully (logs error, skips duplicate)', () => {
				registry.setAll([makeItem('dup', 1), makeItem('dup', 2)]);
				expect(registry.size()).toBe(1);
				expect(registry.get('dup')?.value).toBe(1);
			});
		});
	});

	// ==================== Cache Integration ====================
	describe('Cache Integration', () => {
		let cache: DiscoveryCache<TestItem>;

		beforeEach(() => {
			cache = new DiscoveryCache<TestItem>({ maxSize: 50, ttl: 300000 });
			registry = createRegistry({ cache });
		});

		afterEach(() => {
			cache.dispose();
		});

		it('add() invalidates cache', () => {
			const spy = vi.spyOn(cache, 'invalidate');
			registry.add(makeItem('cached'));
			expect(spy).toHaveBeenCalledWith('all');
		});

		it('remove() invalidates cache', () => {
			registry.add(makeItem('to-rm'));
			const spy = vi.spyOn(cache, 'invalidate');
			registry.remove('to-rm');
			expect(spy).toHaveBeenCalledWith('all');
			expect(spy).toHaveBeenCalledWith('to-rm');
		});

		it('update() invalidates cache', () => {
			registry.add(makeItem('to-upd'));
			const spy = vi.spyOn(cache, 'invalidate');
			registry.update('to-upd', { value: 99 });
			expect(spy).toHaveBeenCalledWith('all');
			expect(spy).toHaveBeenCalledWith('to-upd');
		});

		it('clear() clears cache', () => {
			const spy = vi.spyOn(cache, 'clear');
			registry.add(makeItem('c'));
			registry.clear();
			expect(spy).toHaveBeenCalled();
		});

		it('getAll() caches the result', () => {
			registry.add(makeItem('x'));
			const first = registry.getAll();
			const spy = vi.spyOn(cache, 'get');
			const second = registry.getAll();
			expect(spy).toHaveBeenCalledWith('all');
			expect(first).toEqual(second);
		});

		it('getAll() returns cached value when available', () => {
			const cachedItems = [makeItem('cached-a', 1), makeItem('cached-b', 2)];
			cache.set('all', cachedItems);
			const result = registry.getAll();
			expect(result).toEqual(cachedItems);
		});
	});

	// ==================== Discovery ====================
	describe('Discovery', () => {
		beforeEach(() => {
			mockReaddir.mockReset();
			mockReadFile.mockReset();
			mockExistsSync.mockReset();
		});

		it('scans directories and discovers items', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter((content: string) => {
				if (content.includes('itemA')) return { name: 'itemA', value: 10 };
				if (content.includes('itemB')) return { name: 'itemB', value: 20 };
				return {};
			});

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([
				{ name: 'a.test.md', isFile: () => true },
				{ name: 'b.test.md', isFile: () => true },
			] as never);
			mockReadFile.mockImplementation((path: unknown) => {
				const p = String(path);
				if (p.includes('a.test.md')) return Promise.resolve('itemA content') as never;
				if (p.includes('b.test.md')) return Promise.resolve('itemB content') as never;
				return Promise.resolve('') as never;
			});

			const count = await registry.discoverAsync();
			expect(count).toBe(2);
			expect(registry.has('itemA')).toBe(true);
			expect(registry.has('itemB')).toBe(true);
		});

		it('is idempotent (shares promise on concurrent calls)', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'item', value: 1 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'x.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const [count1, count2] = await Promise.all([
				registry.discoverAsync(),
				registry.discoverAsync(),
			]);

			expect(count1).toBe(count2);
			expect(mockReaddir).toHaveBeenCalledTimes(1);
		});

		it('returns cached count on subsequent calls after discovery', async () => {
			const cache = new DiscoveryCache<TestItem>({ maxSize: 50, ttl: 300000 });
			registry = createRegistry({ searchDirs: ['/test/dir'], cache });
			registry.setParseFrontmatter(() => ({ name: 'cached-item', value: 1 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'x.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			await registry.discoverAsync();

			const count = await registry.discoverAsync();
			expect(count).toBe(1);
			expect(mockReaddir).toHaveBeenCalledTimes(1);
			cache.dispose();
		});

		it('publishes a refreshed snapshot only after the scan completes', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter((content) => ({
				name: 'item',
				value: content === 'updated' ? 2 : 1,
			}));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'x.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValueOnce('initial' as never);
			await registry.discoverAsync();
			let releaseRead: ((content: string) => void) | undefined;
			let markReadStarted: (() => void) | undefined;
			const readStarted = new Promise<void>((resolve) => {
				markReadStarted = resolve;
			});
			mockReadFile.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						markReadStarted?.();
						releaseRead = resolve;
					}) as never
			);

			// When
			const refreshing = registry.refreshAsync();
			await readStarted;
			const duringRefresh = registry.getAll();
			releaseRead?.('updated');
			await refreshing;

			// Then
			expect(duringRefresh).toEqual([makeItem('item', 1)]);
			expect(registry.getAll()).toEqual([makeItem('item', 2)]);
		});

		it('coalesces refresh requests that arrive during an active scan', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'item', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'x.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValueOnce('initial' as never);
			await registry.discoverAsync();
			let releaseRead: (() => void) | undefined;
			let markReadStarted: (() => void) | undefined;
			const readStarted = new Promise<void>((resolve) => {
				markReadStarted = resolve;
			});
			mockReadFile
				.mockImplementationOnce(
					() =>
						new Promise<string>((resolve) => {
							markReadStarted?.();
							releaseRead = () => resolve('updated');
						}) as never
				)
				.mockResolvedValue('updated' as never);

			// When
			const first = registry.refreshAsync();
			await readStarted;
			const second = registry.refreshAsync();
			const third = registry.refreshAsync();
			releaseRead?.();
			await Promise.all([first, second, third]);

			// Then
			expect(mockReaddir).toHaveBeenCalledTimes(3);
			expect(registry.size()).toBe(1);
		});

		it('overlays a manual add made while its filesystem read is pending', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'shared', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'shared.test.md', isFile: () => true }] as never);
			const readStarted = deferred<void>();
			const pendingRead = deferred<string>();
			mockReadFile.mockImplementationOnce(() => {
				readStarted.resolve();
				return pendingRead.promise as never;
			});
			const discovery = registry.discoverAsync();
			await readStarted.promise;

			// When
			registry.add(makeItem('shared', 7));
			pendingRead.resolve('filesystem');
			const count = await discovery;

			// Then
			expect(count).toBe(0);
			expect(registry.get('shared')).toEqual(makeItem('shared', 7));
			expect(registry.getAll()).toEqual([makeItem('shared', 7)]);
		});

		it('overlays a stable-name manual update made while a read is pending', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.add(makeItem('manual', 1));
			registry.setParseFrontmatter(() => ({ name: 'filesystem', value: 3 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			const readStarted = deferred<void>();
			const pendingRead = deferred<string>();
			mockReadFile.mockImplementationOnce(() => {
				readStarted.resolve();
				return pendingRead.promise as never;
			});
			const discovery = registry.discoverAsync();
			await readStarted.promise;

			// When
			registry.update('manual', { name: 'renamed', value: 2 });
			pendingRead.resolve('filesystem');
			await discovery;

			// Then
			expect(registry.get('manual')).toEqual(makeItem('manual', 2));
			expect(registry.has('renamed')).toBe(false);
			expect(registry.getNames()).toEqual(['manual', 'filesystem']);
		});

		it('reveals a retained filesystem candidate when its manual shadow is removed', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.add(makeItem('shared', 7));
			registry.setParseFrontmatter(() => ({ name: 'shared', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'shared.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('filesystem' as never);
			expect(await registry.discoverAsync()).toBe(0);

			// When
			registry.remove('shared');

			// Then
			expect(registry.get('shared')).toEqual(makeItem('shared', 1));
			expect(registry.getAll()).toEqual([makeItem('shared', 1)]);
			expect(await registry.discoverAsync()).toBe(1);
			expect(mockReaddir).toHaveBeenCalledOnce();
		});

		it('supersedes an update to a discovered item on the next refresh', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter((content) => ({
				name: 'filesystem',
				value: content === 'fresh' ? 2 : 1,
			}));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValueOnce('initial' as never).mockResolvedValueOnce('fresh' as never);
			await registry.discoverAsync();
			registry.update('filesystem', { name: 'renamed', value: 99 });

			// When
			await registry.refreshAsync();

			// Then
			expect(registry.get('filesystem')).toEqual(makeItem('filesystem', 2));
			expect(registry.has('renamed')).toBe(false);
		});

		it('rediscovers a removed filesystem item without retaining a tombstone', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'filesystem', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);
			await registry.discoverAsync();
			registry.remove('filesystem');

			// When
			const count = await registry.refreshAsync();

			// Then
			expect(count).toBe(1);
			expect(registry.get('filesystem')).toEqual(makeItem('filesystem', 1));
		});

		it('clear invalidates an active pass and its queued pre-clear refresh', async () => {
			// Given
			const cache = new DiscoveryCache<TestItem>({ maxSize: 50, ttl: 300000 });
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			registry = createRegistry({ searchDirs: ['/test/dir'], cache, logger });
			registry.setParseFrontmatter(() => ({ name: 'stale', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			const readStarted = deferred<void>();
			const pendingRead = deferred<string>();
			mockReadFile.mockImplementation(() => {
				readStarted.resolve();
				return pendingRead.promise as never;
			});
			const discovery = registry.discoverAsync();
			await readStarted.promise;
			const queuedRefresh = registry.refreshAsync();

			// When
			registry.clear();
			const cacheSet = vi.spyOn(cache, 'set');
			pendingRead.resolve('stale');
			await Promise.all([discovery, queuedRefresh]);

			// Then
			expect(mockReaddir).toHaveBeenCalledOnce();
			expect(registry.getAll()).toEqual([]);
			expect(cacheSet).toHaveBeenCalledOnce();
			expect(cacheSet).toHaveBeenCalledWith('all', []);
			expect(
				logger.info.mock.calls.some(([message]) => String(message).startsWith('Discovery complete'))
			).toBe(false);
			cache.dispose();
		});

		it('setAll invalidates an active pass and its queued pre-replacement refresh', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'stale', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			const readStarted = deferred<void>();
			const pendingRead = deferred<string>();
			mockReadFile.mockImplementation(() => {
				readStarted.resolve();
				return pendingRead.promise as never;
			});
			const discovery = registry.discoverAsync();
			await readStarted.promise;
			const queuedRefresh = registry.refreshAsync();

			// When
			registry.setAll([makeItem('replacement', 9)]);
			pendingRead.resolve('stale');
			await Promise.all([discovery, queuedRefresh]);

			// Then
			expect(mockReaddir).toHaveBeenCalledOnce();
			expect(registry.getAll()).toEqual([makeItem('replacement', 9)]);
		});

		it('runs one fresh pass when refresh is requested after replacement', async () => {
			// Given
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter((content) => ({
				name: content === 'fresh' ? 'fresh' : 'stale',
				value: 1,
			}));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			const readStarted = deferred<void>();
			const pendingRead = deferred<string>();
			mockReadFile
				.mockImplementationOnce(() => {
					readStarted.resolve();
					return pendingRead.promise as never;
				})
				.mockResolvedValueOnce('fresh' as never);
			const staleDiscovery = registry.discoverAsync();
			await readStarted.promise;
			registry.setAll([makeItem('replacement', 9)]);

			// When
			const refreshed = registry.refreshAsync();
			pendingRead.resolve('stale');
			const [, count] = await Promise.all([staleDiscovery, refreshed]);

			// Then
			expect(count).toBe(1);
			expect(mockReaddir).toHaveBeenCalledTimes(2);
			expect(registry.getAll()).toEqual([makeItem('replacement', 9), makeItem('fresh', 1)]);
		});

		it('publishes one cache-backed snapshot with a visible filesystem count', async () => {
			// Given
			const cache = new DiscoveryCache<TestItem>({ maxSize: 50, ttl: 300000 });
			registry = createRegistry({ searchDirs: ['/test/dir'], cache });
			registry.add(makeItem('shared', 7));
			expect(registry.getAll()).toEqual([makeItem('shared', 7)]);
			registry.setParseFrontmatter((content) => ({
				name: content,
				value: content === 'shared' ? 1 : 2,
			}));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([
				{ name: 'shared.test.md', isFile: () => true },
				{ name: 'visible.test.md', isFile: () => true },
			] as never);
			mockReadFile.mockImplementation(
				(path) => Promise.resolve(String(path).includes('shared') ? 'shared' : 'visible') as never
			);

			// When
			const count = await registry.discoverAsync();

			// Then
			const expected = [makeItem('shared', 7), makeItem('visible', 2)];
			expect(count).toBe(1);
			expect(registry.get('shared')).toEqual(expected[0]);
			expect(registry.get('visible')).toEqual(expected[1]);
			expect(registry.getAll()).toEqual(expected);
			expect(cache.get('all')).toEqual(expected);
			expect(registry.getNames()).toEqual(['shared', 'visible']);
			expect(registry.has('shared')).toBe(true);
			expect(registry.has('visible')).toBe(true);
			expect(registry.size()).toBe(2);
			cache.dispose();
		});

		it('handles empty directories', async () => {
			registry = createRegistry({ searchDirs: ['/empty/dir'] });

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([] as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it.each([
			['SkillRegistry', () => new SkillRegistry({ skillDirs: [] })],
			['ToolRegistry', () => new ToolRegistry({ toolDirs: [] })],
		])('%s preserves explicit empty roots without filesystem access', async (_name, create) => {
			const concreteRegistry = create();

			const count = await concreteRegistry.discoverAsync();

			expect(count).toBe(0);
			expect(mockExistsSync).not.toHaveBeenCalled();
			expect(mockReaddir).not.toHaveBeenCalled();
			expect(mockReadFile).not.toHaveBeenCalled();
		});

		it('uses the four ordered default roots for SkillRegistry discovery', async () => {
			// Given
			const skillRegistry = new SkillRegistry();
			mockExistsSync.mockReturnValue(false);

			// When
			await skillRegistry.discoverAsync();

			// Then
			expect(mockExistsSync.mock.calls.map(([directory]) => directory)).toEqual([
				'.claude/skills',
				join(homedir(), '.claude/skills'),
				'.agents/skills',
				join(homedir(), '.agents/skills'),
			]);
		});

		it('handles non-existent directories', async () => {
			registry = createRegistry({ searchDirs: ['/no/such/dir'] });
			mockExistsSync.mockReturnValue(false);

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
			expect(mockReaddir).not.toHaveBeenCalled();
		});

		it('handles unreadable files gracefully', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'bad.test.md', isFile: () => true }] as never);
			mockReadFile.mockRejectedValue(new Error('Permission denied'));

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('skips files that do not match extensions', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'should-not-add', value: 0 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([
				{ name: 'readme.txt', isFile: () => true },
				{ name: 'data.json', isFile: () => true },
			] as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
			expect(mockReadFile).not.toHaveBeenCalled();
		});

		it('skips files that _shouldSkipFile returns true for', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setShouldSkipFile((name: string) => name.startsWith('skip-'));
			registry.setParseFrontmatter(() => ({ name: 'item', value: 0 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([
				{ name: 'skip-this.test.md', isFile: () => true },
				{ name: 'keep.test.md', isFile: () => true },
			] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(1);
		});

		it('skips items with _error in parsed frontmatter', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ _error: 'bad format' }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'bad.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('skips items without name in parsed data', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ value: 42 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'noname.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('does not add duplicates during discovery', async () => {
			registry = createRegistry({ searchDirs: ['/dir1', '/dir2'] });
			registry.setParseFrontmatter(() => ({ name: 'same', value: 1 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'item.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(1);
			expect(registry.size()).toBe(1);
		});

		it('uses ordered root precedence when discovered names overlap', async () => {
			registry = createRegistry({ searchDirs: ['/first', '/second'] });
			registry.setParseFrontmatter((content) => ({
				name: 'shared',
				value: content === 'first' ? 1 : 2,
			}));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'shared.test.md', isFile: () => true }] as never);
			mockReadFile.mockImplementation(
				(path) => Promise.resolve(String(path).startsWith('/first') ? 'first' : 'second') as never
			);

			await registry.discoverAsync();

			expect(registry.get('shared')).toEqual(makeItem('shared', 1));
		});

		it('keeps manually registered items ahead of discovered names', async () => {
			registry = createRegistry({ searchDirs: ['/root'] });
			registry.add(makeItem('shared', 7));
			registry.setParseFrontmatter(() => ({ name: 'shared', value: 1 }));
			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'shared.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('discovered' as never);

			await registry.discoverAsync();

			expect(registry.get('shared')).toEqual(makeItem('shared', 7));
		});

		it('skips directories (non-file entries)', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'item', value: 0 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([
				{ name: 'subdir.test.md', isFile: () => false },
				{ name: 'file.test.md', isFile: () => true },
			] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(1);
		});

		it('handles readdir failure gracefully', async () => {
			registry = createRegistry({ searchDirs: ['/fail/dir'] });

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockRejectedValue(new Error('EACCES'));

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('handles _buildItem returning null', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });
			registry.setParseFrontmatter(() => ({ name: 'null-item', value: 0 }));
			// Override _buildItem to simulate rejection
			registry['_buildItem'] = () => null;

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'x.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});
	});

	// ==================== Constructor ====================
	describe('Constructor', () => {
		it('works with no options (uses defaults)', () => {
			const reg = new TestRegistry({});
			expect(reg.size()).toBe(0);
			expect(reg.getAll()).toEqual([]);
		});

		it('accepts a custom logger', () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				setLevel: vi.fn(),
				getLevel: vi.fn(),
			};
			const reg = createRegistry({ logger });
			reg.add(makeItem('logged'));
			expect(logger.info).toHaveBeenCalled();
		});

		it('accepts lazy discovery flag (no immediate effect, stored internally)', () => {
			const reg = createRegistry({ lazyDiscovery: true });
			expect(reg.size()).toBe(0);
		});

		it('accepts searchDirs option', () => {
			const reg = createRegistry({ searchDirs: ['/a', '/b'] });
			expect(reg.size()).toBe(0);
		});
	});

	// ==================== _extractFrontmatter utility ====================
	describe('_extractFrontmatter()', () => {
		class FrontmatterTestRegistry extends TestRegistry {
			public extractFrontmatter(content: string): Record<string, unknown> | null {
				return this._extractFrontmatter(content);
			}
		}

		let fmReg: FrontmatterTestRegistry;

		beforeEach(() => {
			fmReg = new FrontmatterTestRegistry({});
		});

		it('parses valid YAML frontmatter', () => {
			const content = '---\nname: test\nvalue: 42\n---\n# Body';
			const result = fmReg.extractFrontmatter(content);
			expect(result).toEqual({ name: 'test', value: 42 });
		});

		it('returns null when no frontmatter present', () => {
			const content = '# Just a heading\nSome body text';
			expect(fmReg.extractFrontmatter(content)).toBeNull();
		});

		it('returns null for content without closing delimiters', () => {
			const content = '---\nname: test\nno closing';
			expect(fmReg.extractFrontmatter(content)).toBeNull();
		});
	});

	// ==================== Edge cases ====================
	describe('Edge Cases', () => {
		it('add then remove then add same name works', () => {
			registry.add(makeItem('recycle', 1));
			registry.remove('recycle');
			registry.add(makeItem('recycle', 2));
			expect(registry.get('recycle')?.value).toBe(2);
		});

		it('update preserves name even if update tries to change it', () => {
			registry.add(makeItem('original', 1));
			registry.update('original', { name: 'changed', value: 99 } as Partial<TestItem>);
			expect(registry.has('original')).toBe(true);
			expect(registry.get('original')?.value).toBe(99);
		});

		it('getAll returns fresh array (not internal reference)', () => {
			registry.add(makeItem('a'));
			const all1 = registry.getAll();
			registry.add(makeItem('b'));
			const all2 = registry.getAll();
			expect(all1).toHaveLength(1);
			expect(all2).toHaveLength(2);
		});
	});

	// ==================== Uncovered Branch Coverage ====================
	describe('Uncovered Branch Coverage', () => {
		beforeEach(() => {
			mockReaddir.mockReset();
			mockReadFile.mockReset();
			mockExistsSync.mockReset();
		});

		it('discoverAsync retains the visible filesystem count when the cache is invalidated', async () => {
			const cache = new DiscoveryCache<TestItem>({ maxSize: 50, ttl: 300000 });
			registry = createRegistry({ searchDirs: ['/test/dir'], cache });
			registry.setParseFrontmatter(() => ({ name: 'item', value: 1 }));

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'x.test.md', isFile: () => true }] as never);
			mockReadFile.mockResolvedValue('content' as never);

			await registry.discoverAsync();

			// Invalidate cache so 'all' returns null, triggering ?? 0 branch
			cache.invalidate('all');

			const count = await registry.discoverAsync();
			expect(count).toBe(1);
			cache.dispose();
		});

		it('handles non-Error thrown during file read', async () => {
			registry = createRegistry({ searchDirs: ['/test/dir'] });

			mockExistsSync.mockReturnValue(true);
			mockReaddir.mockResolvedValue([{ name: 'bad.test.md', isFile: () => true }] as never);
			// Throw a string (not an Error) to hit String(readError) branch
			mockReadFile.mockRejectedValue('string error');

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('handles non-Error thrown during readdir', async () => {
			registry = createRegistry({ searchDirs: ['/fail/dir'] });

			mockExistsSync.mockReturnValue(true);
			// Throw a string (not an Error) to hit String(error) branch in directory scan
			mockReaddir.mockRejectedValue('directory error string');

			const count = await registry.discoverAsync();
			expect(count).toBe(0);
		});

		it('setAll handles non-Error thrown during add', async () => {
			// Create a registry where add throws a non-Error value
			const origAdd = registry.add.bind(registry);
			let callCount = 0;
			registry.add = (item: TestItem) => {
				callCount++;
				if (callCount === 2) {
					throw 'non-error string';
				}
				origAdd(item);
			};

			registry.setAll([makeItem('good', 1), makeItem('bad', 2), makeItem('also-good', 3)]);
			// First item added, second throws non-Error (logged via String()), third added
			expect(registry.has('good')).toBe(true);
			expect(registry.has('bad')).toBe(false);
		});
	});
});
