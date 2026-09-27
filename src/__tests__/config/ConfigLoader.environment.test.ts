import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../config/ConfigLoader.js';
import { ServerConfig } from '../../ServerConfig.js';

const LEGACY_ENVIRONMENT_KEYS = [
	'MAX_HISTORY_SIZE',
	'MAX_BRANCHES',
	'MAX_BRANCH_SIZE',
	'LOG_LEVEL',
	'PRETTY_LOG',
	'SKILL_DIRS',
	'TOOL_DIRS',
	'DISCOVERY_CACHE_TTL',
	'DISCOVERY_CACHE_MAX_SIZE',
	'SESSION_MAX_PER_OWNER',
] as const;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('ConfigLoader environment contract', () => {
	it('applies the namespaced server environment settings', () => {
		// Given
		vi.stubEnv('TRACELATTICE_MAX_HISTORY_SIZE', '501');
		vi.stubEnv('TRACELATTICE_MAX_BRANCHES', '26');
		vi.stubEnv('TRACELATTICE_MAX_BRANCH_SIZE', '201');
		vi.stubEnv('TRACELATTICE_LOG_LEVEL', 'debug');
		vi.stubEnv('TRACELATTICE_PRETTY_LOG', 'false');
		vi.stubEnv('TRACELATTICE_SKILL_DIRS', '/skills/a:/skills/b');
		vi.stubEnv('TRACELATTICE_TOOL_DIRS', '/tools/a:/tools/b');
		vi.stubEnv('TRACELATTICE_DISCOVERY_CACHE_TTL', '61');
		vi.stubEnv('TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE', '202');
		vi.stubEnv('TRACELATTICE_SESSION_MAX_PER_OWNER', '27');

		// When
		const config = new ConfigLoader().applyEnvironmentOverrides({});

		// Then
		expect(config).toMatchObject({
			maxHistorySize: 501,
			maxBranches: 26,
			maxBranchSize: 201,
			logLevel: 'debug',
			prettyLog: false,
			skillDirs: ['/skills/a', '/skills/b'],
			toolDirs: ['/tools/a', '/tools/b'],
			discoveryCache: { ttl: 61_000, maxSize: 202 },
			maxSessionsPerOwner: 27,
		});
	});

	it('ignores every unprefixed legacy environment setting', () => {
		// Given
		for (const key of LEGACY_ENVIRONMENT_KEYS) vi.stubEnv(key, '1');
		const fileConfig = {
			maxHistorySize: 700,
			maxBranches: 30,
			maxBranchSize: 300,
			logLevel: 'warn' as const,
			prettyLog: true,
			skillDirs: ['/file/skills'],
			toolDirs: ['/file/tools'],
			discoveryCache: { ttl: 70_000, maxSize: 300 },
			maxSessionsPerOwner: 40,
		};

		// When
		const config = new ConfigLoader().applyEnvironmentOverrides(fileConfig);

		// Then
		expect(config).toEqual(fileConfig);
	});

	it('keeps file-only persistence settings when unsupported namespaced aliases are set', () => {
		const fileConfig = {
			persistenceBufferSize: 7,
			persistenceFlushInterval: 750,
			persistenceMaxRetries: 2,
		};
		vi.stubEnv('TRACELATTICE_PERSISTENCE_BUFFER_SIZE', '9');
		vi.stubEnv('TRACELATTICE_PERSISTENCE_FLUSH_INTERVAL', '900');
		vi.stubEnv('TRACELATTICE_PERSISTENCE_MAX_RETRIES', '4');

		const loaded = new ConfigLoader().applyEnvironmentOverrides(fileConfig);
		const effective = new ServerConfig(new ConfigLoader().toServerConfigOptions(loaded));

		expect(loaded).toEqual(fileConfig);
		expect(effective.persistenceBufferSize).toBe(7);
		expect(effective.persistenceFlushInterval).toBe(750);
		expect(effective.persistenceMaxRetries).toBe(2);
	});

	it('converts only discovery TTL seconds while interleave TTL stays in milliseconds', () => {
		vi.stubEnv('TRACELATTICE_DISCOVERY_CACHE_TTL', '19');
		vi.stubEnv('TRACELATTICE_TOOL_INTERLEAVE_TTL_MS', '23000');
		vi.stubEnv('TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS', '47000');

		const loaded = new ConfigLoader().applyEnvironmentOverrides({});
		const effective = new ServerConfig(new ConfigLoader().toServerConfigOptions(loaded));

		expect(effective.discoveryCache.ttl).toBe(19_000);
		expect(effective.toolInterleaveTtlMs).toBe(23_000);
		expect(effective.toolInterleaveSweepMs).toBe(47_000);
	});

	it('ignores pretty logging values other than literal false even for a file setting', () => {
		vi.stubEnv('TRACELATTICE_PRETTY_LOG', 'true');

		expect(new ConfigLoader().applyEnvironmentOverrides({ prettyLog: false }).prettyLog).toBe(
			false
		);
		vi.stubEnv('TRACELATTICE_PRETTY_LOG', 'false');
		expect(new ConfigLoader().applyEnvironmentOverrides({ prettyLog: true }).prettyLog).toBe(
			false
		);
	});
});
