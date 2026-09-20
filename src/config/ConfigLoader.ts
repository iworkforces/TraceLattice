/**
 * Configuration file loading with environment variable override support.
 *
 * This module provides the `ConfigLoader` class which handles loading configuration
 * from YAML and JSON files in standard locations, with automatic environment variable
 * overrides for all settings.
 *
 * @module config
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as v from 'valibot';
import type { PersistenceConfig } from '../contracts/PersistenceBackend.js';
import { ConfigurationError, getErrorMessage } from '../errors.js';
import type { FeatureFlags } from '../contracts/features.js';
import type { ServerConfigOptions } from '../ServerConfig.js';

/**
 * Lenient runtime schema for config files. Only validates top-level shape;
 * unknown extra fields are preserved by Valibot's default object behavior
 * being strict is avoided by using `v.looseObject`. All fields are optional.
 */
const ConfigFileOptionsSchema = v.looseObject({
	maxHistorySize: v.optional(v.number()),
	maxBranches: v.optional(v.number()),
	maxBranchSize: v.optional(v.number()),
	logLevel: v.optional(v.picklist(['debug', 'info', 'warn', 'error'])),
	prettyLog: v.optional(v.boolean()),
	skillDirs: v.optional(v.array(v.string())),
	toolDirs: v.optional(v.array(v.string())),
	discoveryCache: v.optional(
		v.looseObject({
			ttl: v.optional(v.number()),
			maxSize: v.optional(v.number()),
		})
	),
	persistence: v.optional(v.looseObject({})),
	persistenceBufferSize: v.optional(v.number()),
	persistenceFlushInterval: v.optional(v.number()),
	persistenceMaxRetries: v.optional(v.number()),
	features: v.optional(v.looseObject({})),
	toolInterleaveTtlMs: v.optional(v.number()),
	toolInterleaveSweepMs: v.optional(v.number()),
	maxSessionsPerOwner: v.optional(v.number()),
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Configuration options loaded from config files.
 *
 * These options represent the structure of configuration files (JSON or YAML)
 * that can be loaded from standard locations. All values can be overridden
 * by environment variables.
 *
 * @example
 * ```yaml
 * # .claude/config.yaml
 * maxHistorySize: 500
 * maxBranches: 25
 * logLevel: debug
 * prettyLog: true
 * skillDirs:
 *   - ./custom-skills
 * toolDirs:
 *   - ./custom-tools
 * discoveryCache:
 *   ttl: 600000
 *   maxSize: 200
 * persistence:
 *   enabled: true
 *   backend: sqlite
 *   options:
 *     dbPath: ./data/history.db
 * ```
 */
export interface ConfigFileOptions {
	/**
	 * Maximum number of thoughts to keep in history.
	 * Can be overridden by `TRACELATTICE_MAX_HISTORY_SIZE` environment variable.
	 */
	readonly maxHistorySize?: number;

	/**
	 * Maximum number of branches to maintain.
	 * Can be overridden by `TRACELATTICE_MAX_BRANCHES` environment variable.
	 */
	readonly maxBranches?: number;

	/**
	 * Maximum size of each branch.
	 * Can be overridden by `TRACELATTICE_MAX_BRANCH_SIZE` environment variable.
	 */
	readonly maxBranchSize?: number;

	/**
	 * Logging level for the application.
	 * Can be overridden by `TRACELATTICE_LOG_LEVEL` environment variable.
	 */
	readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';

	/**
	 * Whether to enable pretty (formatted) logging output.
	 * Can be overridden by `TRACELATTICE_PRETTY_LOG` environment variable (set to "false" to disable).
	 */
	readonly prettyLog?: boolean;

	/**
	 * Directory paths to search for skills.
	 * Can be overridden by `TRACELATTICE_SKILL_DIRS` environment variable (colon-separated).
	 */
	readonly skillDirs?: string[];

	/**
	 * Directory paths to search for tools.
	 * Can be overridden by `TRACELATTICE_TOOL_DIRS` environment variable (colon-separated).
	 */
	readonly toolDirs?: string[];

	/**
	 * Discovery cache configuration.
	 * Can be overridden by `TRACELATTICE_DISCOVERY_CACHE_TTL` and
	 * `TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE` environment variables.
	 */
	readonly discoveryCache?: {
		/**
		 * Time-to-live for cache entries in milliseconds.
		 * Environment variable `TRACELATTICE_DISCOVERY_CACHE_TTL` accepts seconds.
		 */
		readonly ttl?: number;
		/**
		 * Maximum number of entries in the cache.
		 */
		readonly maxSize?: number;
	};

	/**
	 * Persistence configuration for storing history and state.
	 */
	readonly persistence?: PersistenceConfig;

	readonly persistenceBufferSize?: number;

	readonly persistenceFlushInterval?: number;

	readonly persistenceMaxRetries?: number;

	/**
	 * Feature flag overrides. Each field can be set independently.
	 * Can be overridden by `TRACELATTICE_FEATURES_*` environment variables.
	 */
	readonly features?: Partial<FeatureFlags>;

	/**
	 * TTL in milliseconds for suspended tool-interleave entries.
	 * Can be overridden by `TRACELATTICE_TOOL_INTERLEAVE_TTL_MS` environment variable.
	 */
	readonly toolInterleaveTtlMs?: number;

	/**
	 * Sweep interval in milliseconds for SuspensionStore expiration cleanup.
	 * Can be overridden by `TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS` environment variable.
	 */
	readonly toolInterleaveSweepMs?: number;

	/**
	 * Maximum sessions per owner. Per-owner LRU bucket prevents one user from
	 * consuming all session slots.
	 * Can be overridden by `TRACELATTICE_SESSION_MAX_PER_OWNER` environment variable.
	 */
	readonly maxSessionsPerOwner?: number;
}

/**
 * Loads configuration from files with environment variable overrides.
 *
 * This class searches for configuration files in standard locations and applies
 * environment variable overrides. Files are searched in priority order, with the
 * first match being used. Environment variables always take precedence over file values.
 *
 * @remarks
 * **Config File Search Order (priority):**
 * 1. Custom path (if provided to constructor)
 * 2. `.claude/config.json` (project-local)
 * 3. `.claude/config.yaml` (project-local)
 * 4. `.claude/config.yml` (project-local)
 * 5. `~/.claude/config.json` (user-global)
 * 6. `~/.claude/config.yaml` (user-global)
 * 7. `~/.claude/config.yml` (user-global)
 *
 * **Environment Variable Overrides:**
 * | Variable | Type | Description |
 * |----------|------|-------------|
 * | `TRACELATTICE_MAX_HISTORY_SIZE` | number | Max thoughts in history |
 * | `TRACELATTICE_MAX_BRANCHES` | number | Max number of branches |
 * | `TRACELATTICE_MAX_BRANCH_SIZE` | number | Max size of each branch |
 * | `TRACELATTICE_LOG_LEVEL` | string | Logging level (debug/info/warn/error) |
 * | `TRACELATTICE_PRETTY_LOG` | string | "false" to disable pretty logging |
 * | `TRACELATTICE_SKILL_DIRS` | string | Colon-separated directory paths |
 * | `TRACELATTICE_TOOL_DIRS` | string | Colon-separated directory paths |
 * | `TRACELATTICE_DISCOVERY_CACHE_TTL` | number | TTL in seconds (converted to ms) |
 * | `TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE` | number | Max cache entries |
 *
 * @example
 * ```typescript
 * // Use default search paths
 * const loader1 = new ConfigLoader();
 * const config1 = loader1.load();
 *
 * // Use custom config path
 * const loader2 = new ConfigLoader('./my-config.yaml');
 * const config2 = loader2.load();
 *
 * // Convert to ServerConfig options
 * const serverOptions = loader2.toServerConfigOptions(config2);
 * ```
 */
export class ConfigLoader {
	/** Array of config file paths to search, in priority order. */
	private _configPaths: string[];

	/**
	 * Creates a new ConfigLoader instance.
	 *
	 * @param customPath - Optional custom config file path. If provided, only this path will be checked.
	 *
	 * @example
	 * ```typescript
	 * // Use default search paths
	 * const loader1 = new ConfigLoader();
	 *
	 * // Use a specific config file
	 * const loader2 = new ConfigLoader('./custom-config.json');
	 * ```
	 */
	constructor(customPath?: string) {
		const configuredPath = customPath ?? process.env.TRACELATTICE_CONFIG;
		this._configPaths = configuredPath
			? [configuredPath]
			: [
					'.claude/config.json',
					'.claude/config.yaml',
					'.claude/config.yml',
					join(homedir(), '.claude/config.json'),
					join(homedir(), '.claude/config.yaml'),
					join(homedir(), '.claude/config.yml'),
				];
	}

	/**
	 * Loads configuration from files and applies environment overrides.
	 *
	 * Searches for config files in the configured paths (in priority order),
	 * parses the first match, and applies environment variable overrides.
	 * Returns null if no config file is found and no environment overrides are set.
	 *
	 * @returns The loaded configuration with environment overrides applied, or null if no config found
	 *
	 * @example
	 * ```typescript
	 * const loader = new ConfigLoader();
	 * const config = loader.load();
	 *
	 * if (config) {
	 *   console.log('Max history size:', config.maxHistorySize);
	 *   console.log('Log level:', config.logLevel);
	 * }
	 * ```
	 */
	load(): ConfigFileOptions | null {
		let config: ConfigFileOptions | null = null;

		for (const configPath of this._configPaths) {
			if (existsSync(configPath)) {
				try {
					config = this.parseConfig(configPath);
					break;
				} catch (error) {
					console.error(`Failed to load config from ${configPath}:`, getErrorMessage(error));
				}
			}
		}

		return this.applyEnvironmentOverrides(config || {});
	}

	/**
	 * Applies environment variable overrides to the configuration.
	 *
	 * Environment variables take precedence over file-based configuration.
	 * Supported environment variables:
	 * - `TRACELATTICE_MAX_HISTORY_SIZE`, `TRACELATTICE_MAX_BRANCHES`,
	 *   `TRACELATTICE_MAX_BRANCH_SIZE` (numbers)
	 * - `TRACELATTICE_LOG_LEVEL` (debug/info/warn/error)
	 * - `TRACELATTICE_PRETTY_LOG` ("false" to disable)
	 * - `TRACELATTICE_SKILL_DIRS` (colon-separated paths)
	 * - `TRACELATTICE_TOOL_DIRS` (colon-separated paths)
	 * - `TRACELATTICE_DISCOVERY_CACHE_TTL` (in seconds, converted to ms)
	 * - `TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE` (number)
	 *
	 * @param config - The configuration to apply overrides to
	 * @returns A new configuration object with environment overrides applied
	 */
	public applyEnvironmentOverrides(config: ConfigFileOptions): ConfigFileOptions {
		const result = this.cloneConfig(config);

		if (process.env.TRACELATTICE_MAX_HISTORY_SIZE !== undefined) {
			result.maxHistorySize = this.parseEnvironmentInteger(
				'TRACELATTICE_MAX_HISTORY_SIZE',
				process.env.TRACELATTICE_MAX_HISTORY_SIZE
			);
		}
		if (process.env.TRACELATTICE_MAX_BRANCHES !== undefined) {
			result.maxBranches = this.parseEnvironmentInteger(
				'TRACELATTICE_MAX_BRANCHES',
				process.env.TRACELATTICE_MAX_BRANCHES
			);
		}
		if (process.env.TRACELATTICE_MAX_BRANCH_SIZE !== undefined) {
			result.maxBranchSize = this.parseEnvironmentInteger(
				'TRACELATTICE_MAX_BRANCH_SIZE',
				process.env.TRACELATTICE_MAX_BRANCH_SIZE
			);
		}
		if (
			process.env.TRACELATTICE_LOG_LEVEL &&
			['debug', 'info', 'warn', 'error'].includes(process.env.TRACELATTICE_LOG_LEVEL)
		) {
			result.logLevel = process.env.TRACELATTICE_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error';
		}
		if (process.env.TRACELATTICE_PRETTY_LOG === 'false') {
			result.prettyLog = false;
		}
		if (process.env.TRACELATTICE_SKILL_DIRS !== undefined) {
			result.skillDirs =
				process.env.TRACELATTICE_SKILL_DIRS === ''
					? []
					: process.env.TRACELATTICE_SKILL_DIRS.split(':');
		}
		if (process.env.TRACELATTICE_TOOL_DIRS !== undefined) {
			result.toolDirs =
				process.env.TRACELATTICE_TOOL_DIRS === ''
					? []
					: process.env.TRACELATTICE_TOOL_DIRS.split(':');
		}
		if (process.env.TRACELATTICE_DISCOVERY_CACHE_TTL !== undefined) {
			const seconds = this.parseEnvironmentInteger(
				'TRACELATTICE_DISCOVERY_CACHE_TTL',
				process.env.TRACELATTICE_DISCOVERY_CACHE_TTL
			);
			const ttl = seconds * 1000;
			if (!Number.isSafeInteger(ttl)) {
				throw new ConfigurationError(
					'TRACELATTICE_DISCOVERY_CACHE_TTL exceeds the safe integer range'
				);
			}
			result.discoveryCache = { ...result.discoveryCache, ttl };
		}
		if (process.env.TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE !== undefined) {
			const maxSize = this.parseEnvironmentInteger(
				'TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE',
				process.env.TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE
			);
			result.discoveryCache = { ...result.discoveryCache, maxSize };
		}
		if (process.env.TRACELATTICE_TOOL_INTERLEAVE_TTL_MS !== undefined) {
			result.toolInterleaveTtlMs = this.parseEnvironmentInteger(
				'TRACELATTICE_TOOL_INTERLEAVE_TTL_MS',
				process.env.TRACELATTICE_TOOL_INTERLEAVE_TTL_MS
			);
		}
		if (process.env.TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS !== undefined) {
			result.toolInterleaveSweepMs = this.parseEnvironmentInteger(
				'TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS',
				process.env.TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS
			);
		}
		if (process.env.TRACELATTICE_SESSION_MAX_PER_OWNER !== undefined) {
			result.maxSessionsPerOwner = this.parseEnvironmentInteger(
				'TRACELATTICE_SESSION_MAX_PER_OWNER',
				process.env.TRACELATTICE_SESSION_MAX_PER_OWNER
			);
		}

		this.applyFeatureFlagOverrides(result);

		return result;
	}

	private cloneConfig(config: ConfigFileOptions): Mutable<ConfigFileOptions> {
		return {
			...config,
			...(config.skillDirs === undefined ? {} : { skillDirs: [...config.skillDirs] }),
			...(config.toolDirs === undefined ? {} : { toolDirs: [...config.toolDirs] }),
			...(config.discoveryCache === undefined
				? {}
				: { discoveryCache: { ...config.discoveryCache } }),
			...(config.persistence === undefined
				? {}
				: {
						persistence: {
							...config.persistence,
							...(config.persistence.options === undefined
								? {}
								: { options: { ...config.persistence.options } }),
						},
					}),
			...(config.features === undefined ? {} : { features: { ...config.features } }),
		};
	}

	/**
	 * Applies TRACELATTICE_FEATURES_* environment variable overrides for feature flags.
	 * Booleans accept 'true'/'false'/'1'/'0' (case-insensitive).
	 * Invalid reasoningStrategy values are rejected.
	 *
	 * @param result - Configuration object to mutate with feature flag overrides
	 * @private
	 */
	private applyFeatureFlagOverrides(result: Mutable<ConfigFileOptions>): void {
		const boolMap: Record<string, Exclude<keyof FeatureFlags, 'reasoningStrategy'>> = {
			TRACELATTICE_FEATURES_DAG_EDGES: 'dagEdges',
			TRACELATTICE_FEATURES_CALIBRATION: 'calibration',
			TRACELATTICE_FEATURES_COMPRESSION: 'compression',
			TRACELATTICE_FEATURES_TOOL_INTERLEAVE: 'toolInterleave',
			TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES: 'newThoughtTypes',
			TRACELATTICE_FEATURES_OUTCOME_RECORDING: 'outcomeRecording',
		};
		for (const [envVar, key] of Object.entries(boolMap)) {
			const raw = process.env[envVar];
			if (raw === undefined) continue;
			const parsed = this.parseBoolean(raw);
			if (parsed === undefined) {
				console.warn(
					`Invalid boolean value for ${envVar}: "${raw}" (expected true/false/1/0). Ignoring.`
				);
				continue;
			}
			const features: { -readonly [K in keyof FeatureFlags]?: FeatureFlags[K] } =
				result.features ?? {};
			features[key] = parsed;
			result.features = features;
		}

		const strategyRaw = process.env.TRACELATTICE_FEATURES_REASONING_STRATEGY;
		if (strategyRaw !== undefined) {
			if (strategyRaw !== 'sequential' && strategyRaw !== 'tot') {
				throw new ConfigurationError(
					`TRACELATTICE_FEATURES_REASONING_STRATEGY must be one of sequential, tot, got ${strategyRaw}`
				);
			}
			const features: { -readonly [K in keyof FeatureFlags]?: FeatureFlags[K] } =
				result.features ?? {};
			features.reasoningStrategy = strategyRaw;
			result.features = features;
		}
	}

	private parseEnvironmentInteger(environmentName: string, raw: string): number {
		if (!/^(0|[1-9]\d*)$/.test(raw)) {
			throw new ConfigurationError(`${environmentName} must be an integer, got ${raw}`);
		}
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed)) {
			throw new ConfigurationError(`${environmentName} must be a safe integer, got ${raw}`);
		}
		return parsed;
	}

	/**
	 * Parses a boolean from an environment variable string.
	 * Accepts 'true'/'false'/'1'/'0' case-insensitively.
	 *
	 * @param raw - Raw environment variable string
	 * @returns Parsed boolean, or undefined if the value is invalid
	 * @private
	 */
	private parseBoolean(raw: string): boolean | undefined {
		const v = raw.trim().toLowerCase();
		if (v === 'true' || v === '1') return true;
		if (v === 'false' || v === '0') return false;
		return undefined;
	}

	/**
	 * Parses a configuration file (JSON or YAML).
	 *
	 * Detects the file type by extension and uses the appropriate parser.
	 * Supports `.json`, `.yaml`, and `.yml` file extensions.
	 *
	 * @param filePath - Path to the configuration file to parse
	 * @returns The parsed configuration object
	 * @throws {Error} If the file cannot be parsed
	 * @private
	 */
	private parseConfig(filePath: string): ConfigFileOptions {
		const content = readFileSync(filePath, 'utf-8');
		const ext = filePath.split('.').pop()?.toLowerCase();

		const raw: unknown = ext === 'yaml' || ext === 'yml' ? parseYaml(content) : JSON.parse(content);

		return v.parse(ConfigFileOptionsSchema, raw) as ConfigFileOptions;
	}

	/**
	 * Converts file-based configuration to ServerConfig options.
	 *
	 * This is a convenience method for extracting the ServerConfig-relevant
	 * options from a file-based configuration.
	 *
	 * @param config - The configuration to convert
	 * @returns An object with ServerConfig-compatible options
	 *
	 * @example
	 * ```typescript
	 * const loader = new ConfigLoader();
	 * const config = loader.load();
	 * if (config) {
	 *   const serverOpts = loader.toServerConfigOptions(config);
	 *   const serverConfig = new ServerConfig(serverOpts);
	 * }
	 * ```
	 */
	toServerConfigOptions(config: ConfigFileOptions): ServerConfigOptions {
		return {
			maxHistorySize: config.maxHistorySize,
			maxBranches: config.maxBranches,
			maxBranchSize: config.maxBranchSize,
			skillDirs: config.skillDirs,
			toolDirs: config.toolDirs,
			discoveryCache: config.discoveryCache,
			persistence: config.persistence,
			persistenceBufferSize: config.persistenceBufferSize,
			persistenceFlushInterval: config.persistenceFlushInterval,
			persistenceMaxRetries: config.persistenceMaxRetries,
			features: config.features,
			toolInterleaveTtlMs: config.toolInterleaveTtlMs,
			toolInterleaveSweepMs: config.toolInterleaveSweepMs,
			maxSessionsPerOwner: config.maxSessionsPerOwner,
		};
	}
}
