import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ServerConfig } from '../ServerConfig.js';
import { ConfigurationError } from '../errors.js';

describe('ServerConfig', () => {
	describe('defaults', () => {
		it('should apply all defaults when no options provided', () => {
			const config = new ServerConfig();
			expect(config.maxHistorySize).toBe(10000);
			expect(config.maxBranches).toBe(50);
			expect(config.maxBranchSize).toBe(100);
			expect(config.persistenceBufferSize).toBe(100);
			expect(config.persistenceFlushInterval).toBe(1000);
			expect(config.persistenceMaxRetries).toBe(3);
			expect(config.discoveryCache).toEqual({ ttl: 300000, maxSize: 100 });
			expect(config.persistence).toEqual({ enabled: false, backend: 'memory' });
			expect(config.skillDirs).toHaveLength(4);
			expect(config.toolDirs).toHaveLength(2);
			expect(config.features).toEqual({
				dagEdges: true,
				reasoningStrategy: 'sequential',
				calibration: true,
				compression: true,
				toolInterleave: true,
				newThoughtTypes: true,
				outcomeRecording: true,
			});
			expect(config.toolInterleaveTtlMs).toBe(60000);
			expect(config.toolInterleaveSweepMs).toBe(60000);
		});
	});

	describe('maxHistorySize validation', () => {
		it('should accept valid values within range', () => {
			const c1 = new ServerConfig({ maxHistorySize: 1 });
			expect(c1.maxHistorySize).toBe(1);

			const c2 = new ServerConfig({ maxHistorySize: 10000 });
			expect(c2.maxHistorySize).toBe(10000);
		});

		it('should default to 10000 when undefined', () => {
			const config = new ServerConfig({ maxHistorySize: undefined });
			expect(config.maxHistorySize).toBe(10000);
		});

		it('should default to 10000 when null', () => {
			const config = new ServerConfig({ maxHistorySize: null as unknown as number });
			expect(config.maxHistorySize).toBe(10000);
		});

		it('should throw for 0', () => {
			expect(() => new ServerConfig({ maxHistorySize: 0 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxHistorySize: 0 })).toThrow('must be at least 1');
		});

		it('should throw for negative values', () => {
			expect(() => new ServerConfig({ maxHistorySize: -1 })).toThrow(ConfigurationError);
		});

		it('should throw for values exceeding 10000', () => {
			expect(() => new ServerConfig({ maxHistorySize: 10001 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxHistorySize: 10001 })).toThrow('must not exceed 10000');
		});

		it('should throw for NaN', () => {
			expect(() => new ServerConfig({ maxHistorySize: NaN })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxHistorySize: NaN })).toThrow('must be a finite number');
		});

		it('should throw for Infinity', () => {
			expect(() => new ServerConfig({ maxHistorySize: Infinity })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxHistorySize: Infinity })).toThrow(
				'must be a finite number'
			);
		});
	});

	describe('maxBranches validation', () => {
		it('should accept valid values including 0', () => {
			const c0 = new ServerConfig({ maxBranches: 0 });
			expect(c0.maxBranches).toBe(0);

			const c1 = new ServerConfig({ maxBranches: 1000 });
			expect(c1.maxBranches).toBe(1000);
		});

		it('should default to 50 when undefined', () => {
			expect(new ServerConfig().maxBranches).toBe(50);
		});

		it('should throw for negative values', () => {
			expect(() => new ServerConfig({ maxBranches: -1 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxBranches: -1 })).toThrow('non-negative');
		});

		it('should throw for values exceeding 1000', () => {
			expect(() => new ServerConfig({ maxBranches: 1001 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxBranches: 1001 })).toThrow('must not exceed 1000');
		});

		it('should throw for NaN', () => {
			expect(() => new ServerConfig({ maxBranches: NaN })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxBranches: NaN })).toThrow('must be a finite number');
		});

		it('should throw for Infinity', () => {
			expect(() => new ServerConfig({ maxBranches: Infinity })).toThrow(ConfigurationError);
		});
	});

	describe('maxBranchSize validation', () => {
		it('should accept valid values within range', () => {
			const c1 = new ServerConfig({ maxBranchSize: 1 });
			expect(c1.maxBranchSize).toBe(1);

			const c2 = new ServerConfig({ maxBranchSize: 1000 });
			expect(c2.maxBranchSize).toBe(1000);
		});

		it('should default to 100 when undefined', () => {
			expect(new ServerConfig().maxBranchSize).toBe(100);
		});

		it('should throw for 0', () => {
			expect(() => new ServerConfig({ maxBranchSize: 0 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ maxBranchSize: 0 })).toThrow('must be at least 1');
		});

		it('should throw for values exceeding 1000', () => {
			expect(() => new ServerConfig({ maxBranchSize: 1001 })).toThrow(ConfigurationError);
		});

		it('should throw for NaN', () => {
			expect(() => new ServerConfig({ maxBranchSize: NaN })).toThrow(ConfigurationError);
		});
	});

	describe('persistenceBufferSize validation', () => {
		it('should accept valid values within range', () => {
			expect(new ServerConfig({ persistenceBufferSize: 1 }).persistenceBufferSize).toBe(1);
			expect(new ServerConfig({ persistenceBufferSize: 10000 }).persistenceBufferSize).toBe(10000);
		});

		it('should default to 100 when undefined', () => {
			expect(new ServerConfig().persistenceBufferSize).toBe(100);
		});

		it('should throw for 0', () => {
			expect(() => new ServerConfig({ persistenceBufferSize: 0 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ persistenceBufferSize: 0 })).toThrow('must be at least 1');
		});

		it('should throw for values exceeding 10000', () => {
			expect(() => new ServerConfig({ persistenceBufferSize: 10001 })).toThrow(ConfigurationError);
		});

		it('should throw for NaN', () => {
			expect(() => new ServerConfig({ persistenceBufferSize: NaN })).toThrow(ConfigurationError);
		});
	});

	describe('persistenceFlushInterval validation', () => {
		it('should accept valid values within range', () => {
			expect(new ServerConfig({ persistenceFlushInterval: 100 }).persistenceFlushInterval).toBe(
				100
			);
			expect(new ServerConfig({ persistenceFlushInterval: 60000 }).persistenceFlushInterval).toBe(
				60000
			);
		});

		it('should default to 1000 when undefined', () => {
			expect(new ServerConfig().persistenceFlushInterval).toBe(1000);
		});

		it('should throw for values below 100', () => {
			expect(() => new ServerConfig({ persistenceFlushInterval: 99 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ persistenceFlushInterval: 99 })).toThrow(
				'must be at least 100'
			);
		});

		it('should throw for values exceeding 60000', () => {
			expect(() => new ServerConfig({ persistenceFlushInterval: 60001 })).toThrow(
				ConfigurationError
			);
			expect(() => new ServerConfig({ persistenceFlushInterval: 60001 })).toThrow(
				'must not exceed 60000'
			);
		});

		it('should throw for NaN', () => {
			expect(() => new ServerConfig({ persistenceFlushInterval: NaN })).toThrow(ConfigurationError);
		});
	});

	describe('persistenceMaxRetries validation', () => {
		it('should accept valid values including 0', () => {
			expect(new ServerConfig({ persistenceMaxRetries: 0 }).persistenceMaxRetries).toBe(0);
			expect(new ServerConfig({ persistenceMaxRetries: 10 }).persistenceMaxRetries).toBe(10);
		});

		it('should default to 3 when undefined', () => {
			expect(new ServerConfig().persistenceMaxRetries).toBe(3);
		});

		it('should throw for negative values', () => {
			expect(() => new ServerConfig({ persistenceMaxRetries: -1 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ persistenceMaxRetries: -1 })).toThrow('non-negative');
		});

		it('should throw for values exceeding 10', () => {
			expect(() => new ServerConfig({ persistenceMaxRetries: 11 })).toThrow(ConfigurationError);
			expect(() => new ServerConfig({ persistenceMaxRetries: 11 })).toThrow('must not exceed 10');
		});

		it('should throw for NaN', () => {
			expect(() => new ServerConfig({ persistenceMaxRetries: NaN })).toThrow(ConfigurationError);
		});
	});

	describe('persistenceMaxPendingThoughtsPerSession validation', () => {
		it('should default to 10000 when undefined', () => {
			expect(new ServerConfig().persistenceMaxPendingThoughtsPerSession).toBe(10000);
		});

		it('should accept values at both bounds', () => {
			expect(
				new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 1 })
					.persistenceMaxPendingThoughtsPerSession
			).toBe(1);
			expect(
				new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 10000 })
					.persistenceMaxPendingThoughtsPerSession
			).toBe(10000);
		});

		it('should throw for values below 1', () => {
			expect(() => new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 0 })).toThrow(
				ConfigurationError
			);
			expect(() => new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 0 })).toThrow(
				'persistenceMaxPendingThoughtsPerSession must be at least 1, got 0'
			);
			expect(() => new ServerConfig({ persistenceMaxPendingThoughtsPerSession: -5 })).toThrow(
				'must be at least 1'
			);
		});

		it('should throw for values exceeding 10000', () => {
			expect(() => new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 10001 })).toThrow(
				ConfigurationError
			);
			expect(() => new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 10001 })).toThrow(
				'persistenceMaxPendingThoughtsPerSession must not exceed 10000, got 10001'
			);
		});

		it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
			'should throw for non-finite value %s',
			(value) => {
				expect(() => new ServerConfig({ persistenceMaxPendingThoughtsPerSession: value })).toThrow(
					'persistenceMaxPendingThoughtsPerSession must be a finite number'
				);
			}
		);

		it('should throw for a non-number value', () => {
			const options = JSON.parse('{"persistenceMaxPendingThoughtsPerSession":"25"}');
			expect(() => new ServerConfig(options)).toThrow(ConfigurationError);
		});

		it('should be reported by toJSON', () => {
			const config = new ServerConfig({ persistenceMaxPendingThoughtsPerSession: 25 });
			expect(config.toJSON().persistenceMaxPendingThoughtsPerSession).toBe(25);
			expect(new ServerConfig().toJSON().persistenceMaxPendingThoughtsPerSession).toBe(10000);
		});
	});

	describe('skillDirs', () => {
		it('should use provided skillDirs', () => {
			const config = new ServerConfig({ skillDirs: ['/a', '/b'] });
			expect(config.skillDirs).toEqual(['/a', '/b']);
		});

		it('should use default skillDirs when undefined', () => {
			const config = new ServerConfig();
			expect(config.skillDirs).toEqual([
				'.claude/skills',
				join(homedir(), '.claude/skills'),
				'.agents/skills',
				join(homedir(), '.agents/skills'),
			]);
		});

		it('should preserve explicit empty skillDirs', () => {
			const config = new ServerConfig({ skillDirs: [] });
			expect(config.skillDirs).toEqual([]);
		});
	});

	describe('toolDirs', () => {
		it('should use provided toolDirs', () => {
			const config = new ServerConfig({ toolDirs: ['/a', '/b'] });
			expect(config.toolDirs).toEqual(['/a', '/b']);
		});

		it('should use default toolDirs when undefined', () => {
			const config = new ServerConfig();
			expect(config.toolDirs).toHaveLength(2);
			expect(config.toolDirs[0]).toBe('.claude/tools');
		});

		it('should preserve explicit empty toolDirs', () => {
			const config = new ServerConfig({ toolDirs: [] });
			expect(config.toolDirs).toEqual([]);
		});
	});

	describe('discoveryCache', () => {
		it('should use defaults when undefined', () => {
			const config = new ServerConfig();
			expect(config.discoveryCache).toEqual({ ttl: 300000, maxSize: 100 });
		});

		it('should merge partial options with defaults', () => {
			const config = new ServerConfig({ discoveryCache: { ttl: 60000 } });
			expect(config.discoveryCache).toEqual({ ttl: 60000, maxSize: 100 });
		});

		it('should accept full options', () => {
			const config = new ServerConfig({ discoveryCache: { ttl: 1000, maxSize: 50 } });
			expect(config.discoveryCache).toEqual({ ttl: 1000, maxSize: 50 });
		});
	});

	describe('persistence', () => {
		it('should default to disabled memory backend', () => {
			const config = new ServerConfig();
			expect(config.persistence.enabled).toBe(false);
			expect(config.persistence.backend).toBe('memory');
		});

		it('should accept file backend', () => {
			const config = new ServerConfig({
				persistence: { enabled: true, backend: 'file', options: { dataDir: './data' } },
			});
			expect(config.persistence.enabled).toBe(true);
			expect(config.persistence.backend).toBe('file');
			expect(config.persistence.options).toEqual({ dataDir: './data' });
		});

		it('should accept sqlite backend', () => {
			const config = new ServerConfig({
				persistence: { enabled: true, backend: 'sqlite', options: { dbPath: './db.sqlite' } },
			});
			expect(config.persistence.backend).toBe('sqlite');
		});

		it('should accept memory backend', () => {
			const config = new ServerConfig({ persistence: { backend: 'memory' } });
			expect(config.persistence.backend).toBe('memory');
		});

		it('should throw for invalid backend type', () => {
			expect(
				() =>
					new ServerConfig({
						persistence: { enabled: true, backend: 'redis' as 'file' | 'sqlite' | 'memory' },
					})
			).toThrow(ConfigurationError);
			expect(
				() =>
					new ServerConfig({
						persistence: { enabled: true, backend: 'redis' as 'file' | 'sqlite' | 'memory' },
					})
			).toThrow('file, sqlite, memory');
		});

		it('should default options to empty object', () => {
			const config = new ServerConfig({ persistence: { enabled: true, backend: 'file' } });
			expect(config.persistence.options).toEqual({});
		});

		it('should default backend to memory when not specified', () => {
			const config = new ServerConfig({ persistence: { enabled: true } });
			expect(config.persistence.backend).toBe('memory');
		});
	});

	describe('toJSON', () => {
		it('should return plain object with all fields', () => {
			const config = new ServerConfig({
				maxHistorySize: 500,
				maxBranches: 25,
				maxBranchSize: 200,
				skillDirs: [],
				toolDirs: [],
			});
			const json = config.toJSON();
			expect(json.maxHistorySize).toBe(500);
			expect(json.maxBranches).toBe(25);
			expect(json.maxBranchSize).toBe(200);
			expect(json.skillDirs).toEqual([]);
			expect(json.toolDirs).toEqual([]);
			expect(json.discoveryCache).toBeDefined();
			expect(json.persistence).toBeDefined();
			expect(json.persistenceBufferSize).toBeDefined();
			expect(json.persistenceFlushInterval).toBeDefined();
			expect(json.persistenceMaxRetries).toBeDefined();
		});
	});

	describe('full config', () => {
		it('should accept all fields simultaneously', () => {
			const config = new ServerConfig({
				maxHistorySize: 500,
				maxBranches: 25,
				maxBranchSize: 200,
				skillDirs: ['/a'],
				toolDirs: ['/b'],
				discoveryCache: { ttl: 1000, maxSize: 50 },
				persistence: { enabled: true, backend: 'file', options: { dataDir: './data' } },
				persistenceBufferSize: 50,
				persistenceFlushInterval: 500,
				persistenceMaxRetries: 5,
			});

			expect(config.maxHistorySize).toBe(500);
			expect(config.maxBranches).toBe(25);
			expect(config.maxBranchSize).toBe(200);
			expect(config.skillDirs).toEqual(['/a']);
			expect(config.toolDirs).toEqual(['/b']);
			expect(config.discoveryCache).toEqual({ ttl: 1000, maxSize: 50 });
			expect(config.persistence.enabled).toBe(true);
			expect(config.persistence.backend).toBe('file');
			expect(config.persistenceBufferSize).toBe(50);
			expect(config.persistenceFlushInterval).toBe(500);
			expect(config.persistenceMaxRetries).toBe(5);
		});
	});
});
