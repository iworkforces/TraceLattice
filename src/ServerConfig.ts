/**
 * Server configuration management with validation.
 *
 * This module provides the `ServerConfig` class which handles all server configuration
 * with built-in validation and sensible defaults. Configuration values are validated
 * on construction and warnings are emitted for out-of-range values.
 *
 * @module ServerConfig
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError } from './errors.js';
import type { PersistenceConfig } from './contracts/PersistenceBackend.js';

/**
 * Configuration options for creating a `ServerConfig` instance.
 *
 * All properties are optional with sensible defaults applied during validation.
 *
 * @example
 * ```typescript
 * const options: ServerConfigOptions = {
 *   maxHistorySize: 500,
 *   maxBranches: 25,
 *   skillDirs: ['./custom-skills'],
 *   toolDirs: ['./custom-tools'],
 *   persistence: { enabled: true, backend: 'sqlite' }
 * };
 * ```
 */

import type { FeatureFlags } from './contracts/features.js';
export interface ServerConfigOptions {
	/**
	 * Maximum number of thoughts to keep in history.
	 * @default 1000
	 */
	maxHistorySize?: number;

	/**
	 * Maximum number of branches to maintain.
	 * @default 50
	 */
	maxBranches?: number;

	/**
	 * Maximum size of each branch.
	 * @default 100
	 */
	maxBranchSize?: number;

	/**
	 * Directory paths to search for skills.
	 * @default ['.claude/skills', '~/.claude/skills', '.agents/skills', '~/.agents/skills']
	 */
	skillDirs?: string[];

	/**
	 * Directory paths to search for tools.
	 * @default ['.claude/tools', '~/.claude/tools']
	 */
	toolDirs?: string[];

	/**
	 * Discovery cache configuration.
	 */
	discoveryCache?: {
		/**
		 * Time-to-live for cache entries in milliseconds.
		 * @default 300000 (5 minutes)
		 */
		ttl?: number;
		/**
		 * Maximum number of entries in the cache.
		 * @default 100
		 */
		maxSize?: number;
	};

	/**
	 * Persistence configuration for storing history and state.
	 */
	persistence?: PersistenceConfig;

	/**
	 * Maximum number of thoughts to buffer before flushing to persistence.
	 * @default 100
	 */
	persistenceBufferSize?: number;

	/**
	 * Interval in milliseconds between periodic persistence flushes.
	 * @default 1000
	 */
	persistenceFlushInterval?: number;

	/**
	 * Maximum number of retries for failed persistence flushes.
	 * @default 3
	 */
	persistenceMaxRetries?: number;

	/**
	 * Feature flag overrides. Missing fields are filled with defaults (all ON,
	 * reasoningStrategy='sequential').
	 */
	features?: Partial<FeatureFlags>;

	/**
	 * TTL in milliseconds for suspended tool-interleave entries in SuspensionStore.
	 * @default 60000
	 */
	toolInterleaveTtlMs?: number;

	/**
	 * Sweep interval in milliseconds for SuspensionStore expiration cleanup.
	 * @default 60000
	 */
	toolInterleaveSweepMs?: number;

	/**
	 * Maximum sessions per owner. Prevents one user from consuming all session slots.
	 * @default 50
	 */
	maxSessionsPerOwner?: number;
}

/**
 * Server configuration with validation and defaults.
 *
 * This class manages all server configuration including history limits,
 * branch limits, discovery directories, cache settings, and persistence.
 * All values are validated on construction with appropriate defaults applied.
 *
 * @remarks
 * - Values outside recommended ranges trigger warnings but are still applied
 * - Environment variables override file-based configuration
 * - The `toJSON()` method provides a plain object representation
 *
 * @example
 * ```typescript
 * // Using defaults
 * const config1 = new ServerConfig();
 * console.log(config1.maxHistorySize); // 10000
 *
 * // With custom options
 * const config2 = new ServerConfig({
 *   maxHistorySize: 500,
 *   persistence: { enabled: true, backend: 'file', options: { dataDir: './data' } }
 * });
 *
 * // Export as plain object
 * const json = config2.toJSON();
 * ```
 */
export class ServerConfig {
	/** Maximum number of thoughts to keep in history. */
	public maxHistorySize: number;

	/** Maximum number of branches to maintain. */
	public maxBranches: number;

	/** Maximum size of each branch. */
	public maxBranchSize: number;

	/** Directory paths to search for skills. */
	public skillDirs: string[];

	/** Directory paths to search for tools. */
	public toolDirs: string[];

	/** Discovery cache configuration. */
	public discoveryCache: { ttl: number; maxSize: number };

	/** Persistence configuration. */
	public persistence: PersistenceConfig;

	/** Maximum number of thoughts to buffer before flushing to persistence. */
	public persistenceBufferSize: number;

	/** Interval in milliseconds between periodic persistence flushes. */
	public persistenceFlushInterval: number;

	/** Maximum number of retries for failed persistence flushes. */
	public persistenceMaxRetries: number;

	/** Feature flag toggles. */
	public features: FeatureFlags;

	/** TTL in milliseconds for suspended tool-interleave entries. */
	public toolInterleaveTtlMs: number;

	/** Sweep interval in milliseconds for SuspensionStore expiration cleanup. */
	public toolInterleaveSweepMs: number;

	/** Maximum sessions per owner (LRU per-owner bucket). */
	public maxSessionsPerOwner: number;

	/**
	 * Creates a new ServerConfig instance with validation.
	 *
	 * All values are validated and defaults are applied for undefined options.
	 * Warnings are emitted to console for values outside recommended ranges.
	 *
	 * @param options - Optional configuration overrides
	 *
	 * @example
	 * ```typescript
	 * const config = new ServerConfig({
	 *   maxHistorySize: 500,
	 *   skillDirs: ['./my-skills']
	 * });
	 * ```
	 */
	constructor(options: ServerConfigOptions = {}) {
		this.maxHistorySize = this.validateMaxHistorySize(options.maxHistorySize);
		this.maxBranches = this.validateMaxBranches(options.maxBranches);
		this.maxBranchSize = this.validateMaxBranchSize(options.maxBranchSize);
		this.skillDirs = this.validateSkillDirs(options.skillDirs);
		this.toolDirs = this.validateToolDirs(options.toolDirs);
		this.discoveryCache = this.validateDiscoveryCache(options.discoveryCache);
		this.persistence = this.validatePersistence(options.persistence);
		this.persistenceBufferSize = this.validatePersistenceBufferSize(options.persistenceBufferSize);
		this.persistenceFlushInterval = this.validatePersistenceFlushInterval(
			options.persistenceFlushInterval
		);
		this.persistenceMaxRetries = this.validatePersistenceMaxRetries(options.persistenceMaxRetries);
		this.features = this.validateFeatures(options.features);
		this.toolInterleaveTtlMs = this.validatePositiveMs(
			options.toolInterleaveTtlMs,
			60000,
			'toolInterleaveTtlMs'
		);
		this.toolInterleaveSweepMs = this.validatePositiveMs(
			options.toolInterleaveSweepMs,
			60000,
			'toolInterleaveSweepMs'
		);
		this.maxSessionsPerOwner = this.validateMaxSessionsPerOwner(options.maxSessionsPerOwner);
	}

	/**
	 * Validates the max history size value.
	 * @param value - The value to validate
	 * @returns The validated value or default (1000)
	 * @private
	 */
	private validateMaxHistorySize(value?: number): number {
		const defaultValue = 10000;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`maxHistorySize must be a finite number, got ${value}`);
		}
		if (value < 1) {
			throw new ConfigurationError(`maxHistorySize must be at least 1, got ${value}`);
		}
		if (value > 10000) {
			throw new ConfigurationError(`maxHistorySize must not exceed 10000, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates the max branches value.
	 * @param value - The value to validate
	 * @returns The validated value or default (50)
	 * @private
	 */
	private validateMaxBranches(value?: number): number {
		const defaultValue = 50;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`maxBranches must be a finite number, got ${value}`);
		}
		if (value < 0) {
			throw new ConfigurationError(`maxBranches must be non-negative, got ${value}`);
		}
		if (value > 1000) {
			throw new ConfigurationError(`maxBranches must not exceed 1000, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates the max branch size value.
	 * @param value - The value to validate
	 * @returns The validated value or default (100)
	 * @private
	 */
	private validateMaxBranchSize(value?: number): number {
		const defaultValue = 100;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`maxBranchSize must be a finite number, got ${value}`);
		}
		if (value < 1) {
			throw new ConfigurationError(`maxBranchSize must be at least 1, got ${value}`);
		}
		if (value > 1000) {
			throw new ConfigurationError(`maxBranchSize must not exceed 1000, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates the skill directories value.
	 * @param value - The value to validate
	 * @returns The validated value or default ['.claude/skills', '~/.claude/skills', '.agents/skills', '~/.agents/skills']
	 * @private
	 */
	private validateSkillDirs(value?: string[]): string[] {
		const defaultValue = [
			'.claude/skills',
			join(homedir(), '.claude/skills'),
			'.agents/skills',
			join(homedir(), '.agents/skills'),
		];
		return value === undefined ? defaultValue : [...value];
	}

	private validateToolDirs(value?: string[]): string[] {
		const defaultValue = ['.claude/tools', join(homedir(), '.claude/tools')];
		return value === undefined ? defaultValue : [...value];
	}

	/**
	 * Validates the discovery cache configuration.
	 * @param value - The value to validate
	 * @returns The validated value with defaults applied
	 * @private
	 */
	private validateDiscoveryCache(value?: { ttl?: number; maxSize?: number }): {
		ttl: number;
		maxSize: number;
	} {
		return {
			ttl: value?.ttl ?? 300000,
			maxSize: value?.maxSize ?? 100,
		};
	}

	/**
	 * Validates the persistence configuration.
	 * @param value - The value to validate
	 * @returns The validated value with defaults applied
	 * @private
	 */
	private validatePersistence(value?: PersistenceConfig): PersistenceConfig {
		if (!value) {
			// Default to in-memory (no actual persistence, just consistency)
			return {
				enabled: false,
				backend: 'memory',
			};
		}

		// Validate backend type
		const validBackends = ['file', 'sqlite', 'memory'];
		const backend = value.backend ?? 'memory';
		if (!validBackends.includes(backend)) {
			throw new ConfigurationError(
				`persistence.backend must be one of ${validBackends.join(', ')}, got ${backend}`
			);
		}

		return {
			enabled: value.enabled ?? false,
			backend,
			options: value.options ?? {},
		};
	}

	/**
	 * Validates the persistence buffer size value.
	 * @param value - The value to validate
	 * @returns The validated value or default (100)
	 * @private
	 */
	private validatePersistenceBufferSize(value?: number): number {
		const defaultValue = 100;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`persistenceBufferSize must be a finite number, got ${value}`);
		}
		if (value < 1) {
			throw new ConfigurationError(`persistenceBufferSize must be at least 1, got ${value}`);
		}
		if (value > 10000) {
			throw new ConfigurationError(`persistenceBufferSize must not exceed 10000, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates the persistence flush interval value.
	 * @param value - The value to validate
	 * @returns The validated value or default (1000)
	 * @private
	 */
	private validatePersistenceFlushInterval(value?: number): number {
		const defaultValue = 1000;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(
				`persistenceFlushInterval must be a finite number, got ${value}`
			);
		}
		if (value < 100) {
			throw new ConfigurationError(`persistenceFlushInterval must be at least 100, got ${value}`);
		}
		if (value > 60000) {
			throw new ConfigurationError(`persistenceFlushInterval must not exceed 60000, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates the persistence max retries value.
	 * @param value - The value to validate
	 * @returns The validated value or default (3)
	 * @private
	 */
	private validatePersistenceMaxRetries(value?: number): number {
		const defaultValue = 3;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`persistenceMaxRetries must be a finite number, got ${value}`);
		}
		if (value < 0) {
			throw new ConfigurationError(`persistenceMaxRetries must be non-negative, got ${value}`);
		}
		if (value > 10) {
			throw new ConfigurationError(`persistenceMaxRetries must not exceed 10, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates feature flags and fills defaults for missing fields.
	 * @param value - Partial feature flag overrides
	 * @returns Fully populated FeatureFlags with defaults applied
	 * @private
	 */
	private validateFeatures(value?: Partial<FeatureFlags>): FeatureFlags {
		const reasoningStrategy = value?.reasoningStrategy ?? 'sequential';
		if (reasoningStrategy !== 'sequential' && reasoningStrategy !== 'tot') {
			throw new ConfigurationError(
				`features.reasoningStrategy must be one of sequential, tot, got ${reasoningStrategy}`
			);
		}
		return {
			dagEdges: value?.dagEdges ?? true,
			reasoningStrategy,
			calibration: value?.calibration ?? true,
			compression: value?.compression ?? true,
			toolInterleave: value?.toolInterleave ?? true,
			newThoughtTypes: value?.newThoughtTypes ?? true,
			outcomeRecording: value?.outcomeRecording ?? true,
		};
	}

	/**
	 * Validates a positive millisecond value with a default fallback.
	 * @param value - The value to validate
	 * @param defaultValue - Default applied if value is undefined/null
	 * @param fieldName - Field name for error messages
	 * @returns The validated millisecond value
	 * @private
	 */
	private validatePositiveMs(
		value: number | undefined,
		defaultValue: number,
		fieldName: string
	): number {
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`${fieldName} must be a finite number, got ${value}`);
		}
		if (value < 1) {
			throw new ConfigurationError(`${fieldName} must be at least 1, got ${value}`);
		}
		return value;
	}

	/**
	 * Validates the max sessions per owner value.
	 * @param value - The value to validate
	 * @returns The validated value or default (50)
	 * @private
	 */
	private validateMaxSessionsPerOwner(value?: number): number {
		const defaultValue = 50;
		if (value === undefined || value === null) return defaultValue;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new ConfigurationError(`maxSessionsPerOwner must be a finite number, got ${value}`);
		}
		if (value < 1) {
			throw new ConfigurationError(`maxSessionsPerOwner must be at least 1, got ${value}`);
		}
		if (value > 10000) {
			throw new ConfigurationError(`maxSessionsPerOwner must not exceed 10000, got ${value}`);
		}
		return value;
	}

	/**
	 * Converts the configuration to a plain object.
	 *
	 * Useful for serialization, logging, or when a plain object representation
	 * is preferred over the ServerConfig instance.
	 *
	 * @returns A plain object representation of the configuration
	 *
	 * @example
	 * ```typescript
	 * const config = new ServerConfig({ maxHistorySize: 500 });
	 * const json = config.toJSON();
	 * console.log(JSON.stringify(json, null, 2));
	 * ```
	 */
	public toJSON(): ServerConfigOptions {
		return {
			maxHistorySize: this.maxHistorySize,
			maxBranches: this.maxBranches,
			maxBranchSize: this.maxBranchSize,
			skillDirs: this.skillDirs,
			toolDirs: this.toolDirs,
			discoveryCache: this.discoveryCache,
			persistence: this.persistence,
			persistenceBufferSize: this.persistenceBufferSize,
			persistenceFlushInterval: this.persistenceFlushInterval,
			persistenceMaxRetries: this.persistenceMaxRetries,
			features: this.features,
			toolInterleaveTtlMs: this.toolInterleaveTtlMs,
			toolInterleaveSweepMs: this.toolInterleaveSweepMs,
			maxSessionsPerOwner: this.maxSessionsPerOwner,
		};
	}
}
