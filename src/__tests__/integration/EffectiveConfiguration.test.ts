import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigFileOptions } from '../../config/ConfigLoader.js';
import { ConfigLoader } from '../../config/ConfigLoader.js';
import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import { asSessionId } from '../../contracts/ids.js';
import { PersistenceDrainError } from '../../core/PersistenceBufferErrors.js';
import { TreeOfThoughtStrategy } from '../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { ConfigurationError } from '../../errors.js';
import {
	createServer,
	initializeServer,
	type ToolAwareSequentialThinkingServer,
} from '../../lib.js';
import { SkillRegistry } from '../../registry/SkillRegistry.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { SEQUENTIAL_THINKING_TOOL } from '../../schema.js';
import { ServerConfig } from '../../ServerConfig.js';

const SuspendedResponseSchema = v.object({
	status: v.literal('suspended'),
	continuation_token: v.string(),
	expires_at: v.number(),
});

const temporaryDirectories = new Set<string>();
const liveServers = new Set<ToolAwareSequentialThinkingServer>();
const ENVIRONMENT_KEYS = [
	'TRACELATTICE_FEATURES_DAG_EDGES',
	'TRACELATTICE_FEATURES_REASONING_STRATEGY',
	'TRACELATTICE_FEATURES_CALIBRATION',
	'TRACELATTICE_FEATURES_COMPRESSION',
	'TRACELATTICE_FEATURES_TOOL_INTERLEAVE',
	'TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES',
	'TRACELATTICE_FEATURES_OUTCOME_RECORDING',
	'TRACELATTICE_TOOL_INTERLEAVE_TTL_MS',
	'TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS',
	'TRACELATTICE_MAX_HISTORY_SIZE',
	'TRACELATTICE_MAX_BRANCHES',
	'TRACELATTICE_MAX_BRANCH_SIZE',
	'TRACELATTICE_SKILL_DIRS',
	'TRACELATTICE_TOOL_DIRS',
] as const;
const originalEnvironment = new Map<string, string | undefined>();

async function writeConfig(contents: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'tracelattice-effective-config-'));
	temporaryDirectories.add(directory);
	const configPath = join(directory, 'config.json');
	await writeFile(configPath, contents, 'utf8');
	return configPath;
}

function loadConfig(configPath: string): ConfigFileOptions {
	const loaded = new ConfigLoader(configPath).load();
	if (loaded === null) {
		throw new TypeError('ConfigLoader returned null for an existing configuration file');
	}
	return loaded;
}

async function dispose(server: ToolAwareSequentialThinkingServer): Promise<void> {
	await server.dispose();
	liveServers.delete(server);
}

async function disposeAfterExpectedFailure(
	server: ToolAwareSequentialThinkingServer
): Promise<void> {
	try {
		await expect(server.dispose()).rejects.toBeInstanceOf(AggregateError);
	} finally {
		liveServers.delete(server);
	}
}

function persistenceBackend(server: ToolAwareSequentialThinkingServer): PersistenceBackend {
	const persistence = server.getContainer().resolve('Persistence');
	if (persistence === null) throw new TypeError('Expected persistence');
	return persistence;
}

function thoughtInput(sessionId: string, thoughtNumber: number, totalThoughts: number) {
	return {
		thought: `configured persistence thought ${thoughtNumber}`,
		thought_number: thoughtNumber,
		total_thoughts: totalThoughts,
		next_thought_needed: thoughtNumber < totalThoughts,
		session_id: sessionId,
	};
}

function skillDocument(name: string, description: string): string {
	return ['---', `name: ${name}`, `description: ${description}`, '---', '# Body'].join('\n');
}

function toolDocument(name: string, description: string): string {
	return [
		'---',
		`name: ${name}`,
		`description: ${description}`,
		'inputSchema:',
		'  type: object',
		'---',
		'# Body',
	].join('\n');
}

beforeEach(() => {
	originalEnvironment.clear();
	for (const key of ENVIRONMENT_KEYS) {
		originalEnvironment.set(key, process.env[key]);
	}
});

afterEach(async () => {
	for (const server of liveServers) {
		await server.dispose();
	}
	liveServers.clear();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const [key, value] of originalEnvironment) {
		expect(process.env[key]).toBe(value);
	}
	for (const directory of temporaryDirectories) {
		await rm(directory, { recursive: true, force: true });
	}
	temporaryDirectories.clear();
});

describe('effective runtime configuration', () => {
	it('applies false feature overrides and the selected strategy to running services', async () => {
		const rawFileConfig: ConfigFileOptions = {
			features: {
				dagEdges: true,
				reasoningStrategy: 'sequential',
				calibration: true,
				compression: true,
				toolInterleave: true,
				newThoughtTypes: true,
				outcomeRecording: true,
			},
		};
		vi.stubEnv('TRACELATTICE_FEATURES_DAG_EDGES', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_REASONING_STRATEGY', 'tot');
		vi.stubEnv('TRACELATTICE_FEATURES_CALIBRATION', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_COMPRESSION', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_TOOL_INTERLEAVE', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES', 'false');
		vi.stubEnv('TRACELATTICE_FEATURES_OUTCOME_RECORDING', 'false');

		const server = await createServer({
			fileConfig: rawFileConfig,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		await server.processThought({
			thought: 'first accepted thought',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: 'effective-flags',
		});
		await server.processThought({
			thought: 'second accepted thought',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: 'effective-flags',
		});

		expect(server.config.features).toEqual({
			dagEdges: false,
			reasoningStrategy: 'tot',
			calibration: false,
			compression: false,
			toolInterleave: false,
			newThoughtTypes: false,
			outcomeRecording: false,
		});
		expect(server.getContainer().resolve('reasoningStrategy')).toBeInstanceOf(
			TreeOfThoughtStrategy
		);
		expect(server.getContainer().has('suspensionStore')).toBe(false);
		expect(server.getContainer().resolve('EdgeStore').size(asSessionId('effective-flags'))).toBe(0);
	});

	it('starts a persistence drain only when the configured file threshold is reached', async () => {
		vi.stubEnv('TRACELATTICE_MAX_HISTORY_SIZE', '4321');
		const server = await createServer({
			fileConfig: {
				maxHistorySize: 123,
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 2,
				persistenceFlushInterval: 60_000,
				persistenceMaxRetries: 0,
				features: { toolInterleave: false },
			},
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		const persistence = persistenceBackend(server);
		const save = vi.spyOn(persistence, 'saveThoughtForSession');
		const sessionId = asSessionId('configured-threshold');

		expect(server.config.maxHistorySize).toBe(4321);
		expect(server.config.persistenceBufferSize).toBe(2);
		expect(server.config.persistenceFlushInterval).toBe(60_000);
		expect(server.config.persistenceMaxRetries).toBe(0);

		await server.processThought(thoughtInput(sessionId, 1, 2));
		expect(save).not.toHaveBeenCalled();
		expect(server.history.getWriteBufferLength()).toBe(1);

		await server.processThought(thoughtInput(sessionId, 2, 2));
		expect(save).toHaveBeenCalled();
		await server.history.drainSession(sessionId);
		expect(save).toHaveBeenCalledTimes(2);
		expect(server.history.getWriteBufferLength()).toBe(0);
	});

	it('flushes at the exact configured file timer boundary', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		const server = await createServer({
			fileConfig: {
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 100,
				persistenceFlushInterval: 250,
				persistenceMaxRetries: 0,
				features: { toolInterleave: false },
			},
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		const persistence = persistenceBackend(server);
		const save = vi.spyOn(persistence, 'saveThoughtForSession');

		expect(server.config.persistenceFlushInterval).toBe(250);
		await server.processThought(thoughtInput('configured-timer', 1, 1));

		await vi.advanceTimersByTimeAsync(249);
		expect(save).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(save).toHaveBeenCalledOnce();
		expect(server.history.getWriteBufferLength()).toBe(0);
	});

	it.each([
		{ maxRetries: 0, expectedAttempts: 1, elapsedRetryTime: 0 },
		{ maxRetries: 2, expectedAttempts: 3, elapsedRetryTime: 600 },
	])(
		'limits configured file retries to $maxRetries after the initial attempt',
		async ({ maxRetries, expectedAttempts, elapsedRetryTime }) => {
			vi.useFakeTimers({ shouldAdvanceTime: false });
			const server = await createServer({
				fileConfig: {
					persistence: { enabled: true, backend: 'memory' },
					persistenceBufferSize: 100,
					persistenceFlushInterval: 60_000,
					persistenceMaxRetries: maxRetries,
					features: { toolInterleave: false },
				},
				autoDiscover: false,
				loadFromPersistence: false,
			});
			liveServers.add(server);
			expect(server.config.persistenceMaxRetries).toBe(maxRetries);
			const persistence = persistenceBackend(server);
			const firstAttempt = Promise.withResolvers<void>();
			const failure = new Error(`controlled retry failure ${maxRetries}`);
			const save = vi.spyOn(persistence, 'saveThoughtForSession').mockImplementation(async () => {
				firstAttempt.resolve();
				throw failure;
			});
			const sessionId = asSessionId(`configured-retries-${maxRetries}`);
			await server.processThought(thoughtInput(sessionId, 1, 1));

			const stopOutcomePromise = server.stop().then(
				() => ({ status: 'fulfilled' as const }),
				(error: unknown) => ({ status: 'rejected' as const, error })
			);
			await firstAttempt.promise;
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(elapsedRetryTime);
			const stopOutcome = await stopOutcomePromise;

			expect(save).toHaveBeenCalledTimes(expectedAttempts);
			expect(stopOutcome.status).toBe('rejected');
			if (stopOutcome.status !== 'rejected') throw new TypeError('Expected server stop to reject');
			expect(stopOutcome.error).toBeInstanceOf(AggregateError);
			if (!(stopOutcome.error instanceof AggregateError)) {
				throw new TypeError('Expected aggregate stop failure');
			}
			expect(stopOutcome.error.errors).toHaveLength(1);
			const drainFailure = stopOutcome.error.errors[0];
			expect(drainFailure).toBeInstanceOf(PersistenceDrainError);
			expect(drainFailure).toMatchObject({
				code: 'PERSISTENCE_DRAIN',
				failures: [
					{
						kind: 'thought',
						sessionId,
						attempts: expectedAttempts,
						cause: failure,
					},
				],
			});
			await disposeAfterExpectedFailure(server);
		}
	);

	it('waits for a configured threshold write during shutdown and clears timers', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		const server = await createServer({
			fileConfig: {
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 1,
				persistenceFlushInterval: 500,
				persistenceMaxRetries: 0,
				features: { toolInterleave: false },
			},
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		expect(server.config.persistenceBufferSize).toBe(1);
		const persistence = persistenceBackend(server);
		const originalSave = persistence.saveThoughtForSession.bind(persistence);
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		vi.spyOn(persistence, 'saveThoughtForSession').mockImplementation(
			async (sessionId, thought) => {
				writeStarted.resolve();
				await releaseWrite.promise;
				await originalSave(sessionId, thought);
			}
		);
		const shutdownStarted = Promise.withResolvers<void>();
		const originalShutdown = server.history.shutdownWithinLifecycle.bind(server.history);
		vi.spyOn(server.history, 'shutdownWithinLifecycle').mockImplementation(() => {
			const shutdown = originalShutdown();
			shutdownStarted.resolve();
			return shutdown;
		});

		await server.processThought(thoughtInput('configured-shutdown', 1, 1));
		await writeStarted.promise;
		let settled = false;
		const stopping = server.stop().then(() => {
			settled = true;
		});
		await shutdownStarted.promise;

		try {
			expect(settled).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			releaseWrite.resolve();
			await stopping;
		}
		expect(settled).toBe(true);
		expect(
			await persistence.loadHistoryForSession(asSessionId('configured-shutdown'))
		).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('uses configured suspension TTL and sweep intervals in the running store', async () => {
		vi.useFakeTimers({ now: new Date('2026-09-09T00:00:00.000Z') });
		const rawFileConfig: ConfigFileOptions = {
			features: { toolInterleave: true },
			toolInterleaveTtlMs: 9000,
			toolInterleaveSweepMs: 8000,
		};
		vi.stubEnv('TRACELATTICE_TOOL_INTERLEAVE_TTL_MS', '1234');
		vi.stubEnv('TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS', '2468');
		const server = await createServer({
			fileConfig: rawFileConfig,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		const startedAt = Date.now();

		const result = await server.processThought({
			thought: 'suspend for configured expiry',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: 'effective-ttl',
			thought_type: 'tool_call',
			tool_name: 'sequentialthinking_tools',
			tool_arguments: {},
		});
		const response = v.parse(SuspendedResponseSchema, JSON.parse(result.content[0]?.text ?? '{}'));
		const store = server.getContainer().resolve('suspensionStore');

		expect(server.config.toolInterleaveTtlMs).toBe(1234);
		expect(server.config.toolInterleaveSweepMs).toBe(2468);
		expect(response.expires_at - startedAt).toBe(1234);
		vi.advanceTimersByTime(1234);
		const expired = await server.processThought({
			thought: 'result at exact expiry',
			thought_number: 2,
			total_thoughts: 2,
			next_thought_needed: false,
			session_id: 'effective-ttl',
			thought_type: 'tool_observation',
			continuation_token: response.continuation_token,
		});

		expect(JSON.parse(expired.content[0]?.text ?? '{}')).toMatchObject({
			code: 'SUSPENSION_EXPIRED',
			status: 'failed',
		});
		expect(server.history.getHistory('effective-ttl')).toHaveLength(1);
		expect(store.size('effective-ttl')).toBe(0);
	});

	it.each([
		['invalid reasoning strategy', JSON.stringify({ features: { reasoningStrategy: 'bogus' } })],
		['invalid suspension TTL', JSON.stringify({ toolInterleaveTtlMs: 0 })],
	])('rejects %s before starting runtime timers', async (_caseName, contents) => {
		vi.useFakeTimers();
		const loaded = loadConfig(await writeConfig(contents));

		await expect(
			createServer({ fileConfig: loaded, autoDiscover: false, loadFromPersistence: false })
		).rejects.toBeInstanceOf(ConfigurationError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('tears down runtime timers when initialization fails', async () => {
		vi.useFakeTimers();
		const stopSpy = vi.spyOn(InMemorySuspensionStore.prototype, 'stop');
		vi.spyOn(SkillRegistry.prototype, 'discoverAsync').mockRejectedValue(
			new Error('injected discovery failure')
		);

		await expect(createServer({ autoDiscover: true, loadFromPersistence: false })).rejects.toThrow(
			'injected discovery failure'
		);
		expect(stopSpy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('releases timers across repeated create and dispose cycles', async () => {
		vi.useFakeTimers();

		for (let cycle = 0; cycle < 3; cycle += 1) {
			const server = await createServer({ autoDiscover: false, loadFromPersistence: false });
			liveServers.add(server);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			await dispose(server);
			expect(vi.getTimerCount()).toBe(0);
		}
	});

	it('uses one loaded configuration snapshot during initialization', async () => {
		const loadSpy = vi
			.spyOn(ConfigLoader.prototype, 'load')
			.mockReturnValueOnce({
				maxHistorySize: 321,
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 2,
				persistenceFlushInterval: 60_000,
				persistenceMaxRetries: 0,
				features: { toolInterleave: false },
			})
			.mockReturnValueOnce({
				maxHistorySize: 654,
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 1,
				persistenceFlushInterval: 100,
				persistenceMaxRetries: 10,
			});

		const server = await initializeServer();
		liveServers.add(server);
		const persistence = persistenceBackend(server);
		const save = vi.spyOn(persistence, 'saveThoughtForSession');

		expect(loadSpy).toHaveBeenCalledOnce();
		expect(server.config.maxHistorySize).toBe(321);
		expect(server.config.persistenceBufferSize).toBe(2);
		expect(server.config.persistenceFlushInterval).toBe(60_000);
		expect(server.config.persistenceMaxRetries).toBe(0);
		await server.processThought(thoughtInput('one-config-snapshot', 1, 2));
		expect(save).not.toHaveBeenCalled();
		await server.processThought(thoughtInput('one-config-snapshot', 2, 2));
		expect(save).toHaveBeenCalled();
		await server.history.drainSession(asSessionId('one-config-snapshot'));
		expect(save).toHaveBeenCalledTimes(2);
	});

	it('applies environment overrides exactly once during initialization', async () => {
		const overlaySpy = vi.spyOn(ConfigLoader.prototype, 'applyEnvironmentOverrides');
		const loadSpy = vi.spyOn(ConfigLoader.prototype, 'load').mockImplementation(function (
			this: ConfigLoader
		) {
			return this.applyEnvironmentOverrides({
				maxHistorySize: 321,
				persistenceBufferSize: 3,
				persistenceFlushInterval: 700,
				persistenceMaxRetries: 1,
			});
		});

		const server = await initializeServer();
		liveServers.add(server);

		expect(loadSpy).toHaveBeenCalledOnce();
		expect(overlaySpy).toHaveBeenCalledOnce();
		expect(server.config.maxHistorySize).toBe(321);
		expect(server.config.persistenceBufferSize).toBe(3);
		expect(server.config.persistenceFlushInterval).toBe(700);
		expect(server.config.persistenceMaxRetries).toBe(1);
	});

	it('initializes both registries from one configured temporary root snapshot', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-initialize-roots-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(
				join(skillDir, 'initialized.md'),
				skillDocument('initialized-skill', 'ready'),
				'utf8'
			),
			writeFile(
				join(toolDir, 'initialized.tool.md'),
				toolDocument('initialized-tool', 'ready'),
				'utf8'
			),
		]);
		const loadSpy = vi.spyOn(ConfigLoader.prototype, 'load').mockReturnValue({
			skillDirs: [skillDir],
			toolDirs: [toolDir],
			features: { toolInterleave: false },
		});

		const server = await initializeServer();
		liveServers.add(server);

		expect(loadSpy).toHaveBeenCalledOnce();
		expect(server.skills.has('initialized-skill')).toBe(true);
		expect(server.tools.has('initialized-tool')).toBe(true);
	});

	it('discovers tools and skills from the same ordered configured roots at startup', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-root-order-'));
		temporaryDirectories.add(root);
		const firstSkills = join(root, 'first-skills');
		const secondSkills = join(root, 'second-skills');
		const firstTools = join(root, 'first-tools');
		const secondTools = join(root, 'second-tools');
		await Promise.all(
			[firstSkills, secondSkills, firstTools, secondTools].map((directory) =>
				mkdir(directory, { recursive: true })
			)
		);
		await Promise.all([
			writeFile(join(firstSkills, 'shared.md'), skillDocument('shared-skill', 'first'), 'utf8'),
			writeFile(join(secondSkills, 'shared.md'), skillDocument('shared-skill', 'second'), 'utf8'),
			writeFile(join(firstTools, 'shared.tool.md'), toolDocument('shared-tool', 'first'), 'utf8'),
			writeFile(join(secondTools, 'shared.tool.md'), toolDocument('shared-tool', 'second'), 'utf8'),
			writeFile(
				join(firstTools, 'builtin.tool.md'),
				toolDocument('sequentialthinking_tools', 'filesystem shadow'),
				'utf8'
			),
		]);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [firstSkills, secondSkills],
				toolDirs: [firstTools, secondTools],
				features: { toolInterleave: false },
			}),
			autoDiscover: true,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(server.skills.get('shared-skill')?.description).toBe('first');
		expect(server.tools.get('shared-tool')?.description).toBe('first');
		expect(server.tools.get('sequentialthinking_tools')).toBe(SEQUENTIAL_THINKING_TOOL);
	});

	it('applies environment discovery roots and explicit limits over file and default values', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-root-precedence-'));
		temporaryDirectories.add(root);
		const fileSkillDir = join(root, 'file-skills');
		const fileToolDir = join(root, 'file-tools');
		const environmentSkillDir = join(root, 'environment-skills');
		const environmentToolDir = join(root, 'environment-tools');
		const defaultSkillDir = join(root, '.claude', 'skills');
		const defaultToolDir = join(root, '.claude', 'tools');
		await Promise.all(
			[
				fileSkillDir,
				fileToolDir,
				environmentSkillDir,
				environmentToolDir,
				defaultSkillDir,
				defaultToolDir,
			].map((directory) => mkdir(directory, { recursive: true }))
		);
		await Promise.all([
			writeFile(join(fileSkillDir, 'file.md'), skillDocument('file-skill', 'file'), 'utf8'),
			writeFile(join(fileToolDir, 'file.tool.md'), toolDocument('file-tool', 'file'), 'utf8'),
			writeFile(
				join(environmentSkillDir, 'environment.md'),
				skillDocument('environment-skill', 'environment'),
				'utf8'
			),
			writeFile(
				join(environmentToolDir, 'environment.tool.md'),
				toolDocument('environment-tool', 'environment'),
				'utf8'
			),
			writeFile(
				join(defaultSkillDir, 'default.md'),
				skillDocument('default-skill', 'default'),
				'utf8'
			),
			writeFile(
				join(defaultToolDir, 'default.tool.md'),
				toolDocument('default-tool', 'default'),
				'utf8'
			),
		]);
		vi.stubEnv('TRACELATTICE_SKILL_DIRS', environmentSkillDir);
		vi.stubEnv('TRACELATTICE_TOOL_DIRS', environmentToolDir);
		const originalWorkingDirectory = process.cwd();
		process.chdir(root);

		try {
			const server = await createServer({
				fileConfig: {
					maxHistorySize: 101,
					maxBranches: 11,
					maxBranchSize: 12,
					skillDirs: [fileSkillDir],
					toolDirs: [fileToolDir],
					features: { toolInterleave: false },
				},
				maxHistorySize: 202,
				maxBranches: 22,
				maxBranchSize: 23,
				autoDiscover: true,
				loadFromPersistence: false,
			});
			liveServers.add(server);

			expect(server.config.skillDirs).toEqual([environmentSkillDir]);
			expect(server.config.toolDirs).toEqual([environmentToolDir]);
			expect(server.config.maxHistorySize).toBe(202);
			expect(server.config.maxBranches).toBe(22);
			expect(server.config.maxBranchSize).toBe(23);
			expect(server.skills.getNames()).toEqual(['environment-skill']);
			expect(server.tools.getNames().sort()).toEqual([
				'environment-tool',
				'sequentialthinking_tools',
			]);
		} finally {
			process.chdir(originalWorkingDirectory);
		}
	});

	it('keeps both startup scans disabled and skill discovery as the only server discovery method', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-manual-discovery-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(join(skillDir, 'manual.md'), skillDocument('manual-skill', 'manual'), 'utf8'),
			writeFile(join(toolDir, 'manual.tool.md'), toolDocument('manual-tool', 'manual'), 'utf8'),
		]);
		const skillDiscovery = vi.spyOn(SkillRegistry.prototype, 'discoverAsync');
		const toolDiscovery = vi.spyOn(ToolRegistry.prototype, 'discoverAsync');
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(skillDiscovery).not.toHaveBeenCalled();
		expect(toolDiscovery).not.toHaveBeenCalled();
		expect(server.skills.has('manual-skill')).toBe(false);
		expect(server.tools.has('manual-tool')).toBe(false);
		expect(
			Object.getOwnPropertyNames(Object.getPrototypeOf(server)).filter((name) =>
				name.startsWith('discover')
			)
		).toEqual(['discoverSkillsAsync']);

		await server.discoverSkillsAsync();
		expect(skillDiscovery).toHaveBeenCalledOnce();
		expect(toolDiscovery).not.toHaveBeenCalled();
		expect(server.skills.has('manual-skill')).toBe(true);
		expect(server.tools.has('manual-tool')).toBe(false);

		await server.tools.discoverAsync();
		expect(toolDiscovery).toHaveBeenCalledOnce();
		expect(server.tools.has('manual-tool')).toBe(true);
	});

	it('defers both registry scans when lazy discovery is enabled', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-lazy-roots-'));
		temporaryDirectories.add(root);
		const skillDir = join(root, 'skills');
		const toolDir = join(root, 'tools');
		await Promise.all([mkdir(skillDir), mkdir(toolDir)]);
		await Promise.all([
			writeFile(join(skillDir, 'lazy.md'), skillDocument('lazy-skill', 'lazy'), 'utf8'),
			writeFile(join(toolDir, 'lazy.tool.md'), toolDocument('lazy-tool', 'lazy'), 'utf8'),
		]);
		const server = await createServer({
			config: new ServerConfig({
				skillDirs: [skillDir],
				toolDirs: [toolDir],
				features: { toolInterleave: false },
			}),
			autoDiscover: true,
			lazyDiscovery: true,
			loadFromPersistence: false,
		});
		liveServers.add(server);

		expect(server.skills.has('lazy-skill')).toBe(false);
		expect(server.tools.has('lazy-tool')).toBe(false);

		await Promise.all([server.skills.discoverAsync(), server.tools.discoverAsync()]);
		expect(server.skills.has('lazy-skill')).toBe(true);
		expect(server.tools.has('lazy-tool')).toBe(true);
	});

	it('keeps an explicit ServerConfig instance ahead of file and top-level options', async () => {
		const config = new ServerConfig({
			maxHistorySize: 111,
			skillDirs: [],
			toolDirs: [],
			persistence: { enabled: true, backend: 'memory' },
			persistenceBufferSize: 2,
			persistenceFlushInterval: 60_000,
			persistenceMaxRetries: 0,
			features: { toolInterleave: false },
		});
		const server = await createServer({
			config,
			fileConfig: {
				maxHistorySize: 222,
				skillDirs: ['/file/skills'],
				toolDirs: ['/file/tools'],
				persistence: { enabled: true, backend: 'memory' },
				persistenceBufferSize: 1,
				persistenceFlushInterval: 100,
				persistenceMaxRetries: 10,
			},
			maxHistorySize: 333,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(server);
		const persistence = persistenceBackend(server);
		const save = vi.spyOn(persistence, 'saveThoughtForSession');

		expect(server.config).toBe(config);
		expect(server.config.maxHistorySize).toBe(111);
		expect(server.config.skillDirs).toEqual([]);
		expect(server.config.toolDirs).toEqual([]);
		expect(server.config.persistenceBufferSize).toBe(2);
		expect(server.config.persistenceFlushInterval).toBe(60_000);
		expect(server.config.persistenceMaxRetries).toBe(0);
		await server.processThought(thoughtInput('explicit-config-threshold', 1, 2));
		expect(save).not.toHaveBeenCalled();
		await server.processThought(thoughtInput('explicit-config-threshold', 2, 2));
		expect(save).toHaveBeenCalled();
		await server.history.drainSession(asSessionId('explicit-config-threshold'));
		expect(save).toHaveBeenCalledTimes(2);
	});

	it('restores a threshold-drained thought after a public file-backed restart', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-configured-file-restart-'));
		temporaryDirectories.add(dataDir);
		const fileConfig: ConfigFileOptions = {
			persistence: { enabled: true, backend: 'file', options: { dataDir } },
			persistenceBufferSize: 1,
			persistenceFlushInterval: 60_000,
			persistenceMaxRetries: 0,
			features: { toolInterleave: false },
		};
		const sessionId = asSessionId('configured-file-restart');
		const first = await createServer({
			fileConfig,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		liveServers.add(first);
		expect(first.config.persistenceBufferSize).toBe(1);

		await first.processThought(thoughtInput(sessionId, 1, 1));
		await first.stop();
		await dispose(first);

		const second = await createServer({
			fileConfig,
			autoDiscover: false,
			loadFromPersistence: true,
		});
		liveServers.add(second);

		expect(second.history.getHistory(sessionId)).toHaveLength(1);
		expect(second.history.getHistory(sessionId)[0]?.thought).toBe(
			'configured persistence thought 1'
		);
		expect(second.history.getWriteBufferLength()).toBe(0);
		await dispose(second);
	});
});
