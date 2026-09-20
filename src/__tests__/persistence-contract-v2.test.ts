import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asBranchId, asSessionId } from '../contracts/ids.js';
import { FilePersistence } from '../persistence/FilePersistence.js';
import { nodeFileWriterOperations } from '../persistence/FileWriter.js';
import { MemoryPersistence } from '../persistence/MemoryPersistence.js';
import { parseFileSnapshotV2 } from '../persistence/FileSnapshotV2.js';
import { parseThoughtData } from '../persistence/PersistenceCodec.js';
import { createTestThought } from './helpers/factories.js';

const SNAPSHOT_SOURCE_PATH = '/data/snapshot.json';
const TEST_SESSION_ID = asSessionId('test-session');
const EMPTY_FILE_V2_SNAPSHOT = {
	version: 2,
	thoughts: [],
	branches: [],
	edges: [],
	summaries: [],
} as const;
const MINIMAL_PERSISTED_THOUGHT = {
	thought: 'Persisted minimal thought',
	thought_number: 1,
	total_thoughts: 1,
	session_id: 'session-minimal',
} as const;

function persistedThought(id: string, sessionId: string) {
	return {
		...MINIMAL_PERSISTED_THOUGHT,
		id,
		session_id: sessionId,
	};
}

describe('mandatory session-scoped persistence contract', () => {
	it('exposes only scoped storage operations on built-in backends', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-guard-'));
		const file = await FilePersistence.create({ dataDir });
		try {
			for (const backend of [new MemoryPersistence(), file]) {
				expect(typeof backend.saveThoughtForSession).toBe('function');
				expect(typeof backend.clearAll).toBe('function');
				expect('saveThought' in backend).toBe(false);
				expect('loadHistory' in backend).toBe(false);
				expect('saveBranch' in backend).toBe(false);
				expect('deleteBranch' in backend).toBe(false);
				expect('loadBranch' in backend).toBe(false);
				expect('listBranches' in backend).toBe(false);
				expect('listEdgeSessions' in backend).toBe(false);
			}
		} finally {
			await file.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

describe('File v2 compatibility boundary', () => {
	it('preserves every supplied field in a fully populated persisted thought', () => {
		// Given
		const fullyPopulatedThought = {
			available_mcp_tools: ['Read'],
			available_skills: ['programming'],
			thought: 'Persisted full thought',
			id: 'thought-full',
			next_thought_needed: false,
			thought_number: 7,
			total_thoughts: 9,
			is_revision: true,
			revises_thought: 3,
			branch_from_thought: 2,
			branch_id: 'branch-current',
			needs_more_thoughts: true,
			current_step: {
				step_description: 'Inspect persisted state',
				recommended_tools: [
					{
						tool_name: 'Read',
						confidence: 0.91,
						rationale: 'Reads the persisted snapshot',
						priority: 4,
						suggested_inputs: {
							path: '/data/snapshot.json',
							limit: 25,
							strict: true,
							offset: null,
						},
						alternatives: ['Bash'],
					},
				],
				recommended_skills: [
					{
						skill_name: 'programming',
						confidence: 0.82,
						rationale: 'Applies TypeScript contracts',
						priority: 6,
						alternatives: ['debugging'],
						allowed_tools: ['Read', 'Bash'],
						user_invocable: true,
					},
				],
				expected_outcome: 'The snapshot contract is understood',
				next_step_conditions: ['Continue when fields are accounted for'],
			},
			previous_steps: [
				{
					step_description: 'Locate persisted state',
					recommended_tools: [
						{
							tool_name: 'Glob',
							confidence: 0.73,
							rationale: 'Locates snapshot files',
							priority: 8,
							suggested_inputs: { pattern: '**/snapshot.json' },
							alternatives: ['Read'],
						},
					],
					recommended_skills: [
						{
							skill_name: 'debugging',
							confidence: 0.64,
							rationale: 'Checks runtime evidence',
							priority: 10,
							alternatives: ['programming'],
							allowed_tools: ['Bash'],
							user_invocable: false,
						},
					],
					expected_outcome: 'The snapshot file is located',
					next_step_conditions: ['Inspect the located file'],
				},
			],
			remaining_steps: ['Validate compatibility'],
			thought_type: 'synthesis',
			quality_score: 0.88,
			confidence: 0.86,
			hypothesis_id: 'compatibility-hypothesis',
			verification_target: 5,
			synthesis_sources: [3, 5],
			merge_from_thoughts: [2, 4],
			merge_branch_ids: ['branch-alpha', 'branch-beta'],
			meta_observation: 'Compatibility fields remain stable',
			reasoning_depth: 'deep',
			session_id: 'session-full',
			reset_state: false,
			tool_name: 'Read',
			tool_arguments: { path: '/data/snapshot.json' },
			tool_result: { loaded: true },
			continuation_token: 'continuation-full',
			decomposition_children: ['child-a', 'child-b'],
			backtrack_target: 2,
			register_branch_id: 'branch-future',
		} as const;

		// When
		const parsed = parseThoughtData(fullyPopulatedThought, SNAPSHOT_SOURCE_PATH);

		// Then
		expect(parsed).toEqual(fullyPopulatedThought);
	});

	it('accepts a minimal persisted thought with an explicit session identity', () => {
		// Given
		const persistedThoughtPayload = MINIMAL_PERSISTED_THOUGHT;

		// When
		const parsed = parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH);

		// Then
		expect(parsed).toEqual({
			thought: 'Persisted minimal thought',
			thought_number: 1,
			total_thoughts: 1,
			session_id: 'session-minimal',
		});
	});

	it('rejects a persisted thought missing its session identity', () => {
		// Given
		const persistedThoughtPayload = { ...MINIMAL_PERSISTED_THOUGHT };
		Reflect.deleteProperty(persistedThoughtPayload, 'session_id');

		// When / Then
		expect(() => parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH)).toThrow();
	});

	it.each([
		[
			'partition',
			{
				sessionId: '__global__',
				thoughts: [persistedThought('retired-partition-thought', '__global__')],
			},
		],
		[
			'nested thought',
			{
				sessionId: 'ordinary-session',
				thoughts: [persistedThought('retired-thought', '__global__')],
			},
		],
	] as const)('rejects a retired %s session identity', (_, thoughtRecord) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, thoughts: [thoughtRecord] };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({ code: 'PERSISTENCE_COMPATIBILITY' })
		);
	});

	it.each([
		['confidence', { tool_name: 'Read', rationale: 'Reads persisted data', priority: 3 }],
		['rationale', { tool_name: 'Read', confidence: 0.8, priority: 3 }],
		['priority', { tool_name: 'Read', confidence: 0.8, rationale: 'Reads persisted data' }],
	] as const)(
		'rejects a persisted tool recommendation missing its %s default',
		(_, recommendation) => {
			// Given
			const persistedThoughtPayload = {
				...MINIMAL_PERSISTED_THOUGHT,
				previous_steps: [
					{
						step_description: 'Inspect persisted data',
						recommended_tools: [recommendation],
						expected_outcome: 'Persisted data is inspected',
					},
				],
			};

			// When / Then
			expect(() => parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH)).toThrowError(
				expect.objectContaining({
					name: 'PersistenceCompatibilityError',
					code: 'PERSISTENCE_COMPATIBILITY',
					sourcePath: SNAPSHOT_SOURCE_PATH,
					detail: 'tool recommendation defaults are absent',
				})
			);
		}
	);

	it.each([
		[
			'confidence',
			{
				skill_name: 'programming',
				rationale: 'Applies TypeScript contracts',
				priority: 2,
			},
		],
		['rationale', { skill_name: 'programming', confidence: 0.7, priority: 2 }],
		[
			'priority',
			{
				skill_name: 'programming',
				confidence: 0.7,
				rationale: 'Applies TypeScript contracts',
			},
		],
	] as const)(
		'rejects a persisted skill recommendation missing its %s default',
		(_, recommendation) => {
			// Given
			const persistedThoughtPayload = {
				...MINIMAL_PERSISTED_THOUGHT,
				current_step: {
					step_description: 'Apply compatibility guidance',
					recommended_tools: [],
					recommended_skills: [recommendation],
					expected_outcome: 'Compatibility guidance is applied',
				},
			};

			// When / Then
			expect(() => parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH)).toThrowError(
				expect.objectContaining({
					name: 'PersistenceCompatibilityError',
					code: 'PERSISTENCE_COMPATIBILITY',
					sourcePath: SNAPSHOT_SOURCE_PATH,
					detail: 'skill recommendation defaults are absent',
				})
			);
		}
	);

	it.each([
		[
			'current',
			'step_description',
			{
				current_step: {
					recommended_tools: [],
					expected_outcome: 'Current step completes',
				},
			},
			'document does not match File v2',
		],
		[
			'current',
			'expected_outcome',
			{
				current_step: {
					step_description: 'Run current step',
					recommended_tools: [],
				},
			},
			'document does not match File v2',
		],
		[
			'previous',
			'step_description',
			{
				previous_steps: [
					{
						recommended_tools: [],
						expected_outcome: 'Previous step completed',
					},
				],
			},
			'document does not match File v2',
		],
		[
			'previous',
			'expected_outcome',
			{
				previous_steps: [
					{
						step_description: 'Run previous step',
						recommended_tools: [],
					},
				],
			},
			'step recommendation defaults are absent',
		],
	] as const)('rejects a persisted %s step missing %s', (_, __, stepFields, detail) => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			thoughts: [
				{
					sessionId: 'session-step',
					thoughts: [
						{
							...persistedThought('thought-step', 'session-step'),
							...stepFields,
						},
					],
				},
			],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail,
			})
		);
	});

	it.each([
		[
			'omitted',
			{
				step_description: 'Step without skill recommendations',
				recommended_tools: [],
				expected_outcome: 'No skill recommendation field is added',
			},
			{
				step_description: 'Step without skill recommendations',
				recommended_tools: [],
				expected_outcome: 'No skill recommendation field is added',
			},
		],
		[
			'present',
			{
				step_description: 'Step with explicit skill recommendations',
				recommended_tools: [],
				recommended_skills: [],
				expected_outcome: 'The explicit empty skill recommendation field remains',
			},
			{
				step_description: 'Step with explicit skill recommendations',
				recommended_tools: [],
				recommended_skills: [],
				expected_outcome: 'The explicit empty skill recommendation field remains',
			},
		],
	] as const)(
		'preserves the %s recommended_skills representation',
		(_, currentStep, expectedStep) => {
			// Given
			const persistedThoughtPayload = {
				...MINIMAL_PERSISTED_THOUGHT,
				current_step: currentStep,
			};

			// When
			const parsed = parseThoughtData(persistedThoughtPayload, SNAPSHOT_SOURCE_PATH);

			// Then
			expect(parsed.current_step).toEqual(expectedStep);
		}
	);

	it.each([
		[
			'duplicate',
			[
				{ sessionId: 'session-a', thoughts: [persistedThought('thought-a1', 'session-a')] },
				{ sessionId: 'session-a', thoughts: [persistedThought('thought-a2', 'session-a')] },
			],
		],
		[
			'out-of-order',
			[
				{ sessionId: 'session-b', thoughts: [persistedThought('thought-b', 'session-b')] },
				{ sessionId: 'session-a', thoughts: [persistedThought('thought-a', 'session-a')] },
			],
		],
	] as const)('rejects %s persisted thought session records', (_, thoughtRecords) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, thoughts: thoughtRecords };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'thought records are duplicate or out of order',
			})
		);
	});

	it('rejects duplicate edge identifiers within a persisted session record', () => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			edges: [
				{
					sessionId: 'session-edge',
					edges: [
						{
							id: 'edge-duplicate',
							from: 'thought-a',
							to: 'thought-b',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 1,
						},
						{
							id: 'edge-duplicate',
							from: 'thought-b',
							to: 'thought-c',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 2,
						},
					],
				},
			],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: "duplicate edge id 'edge-duplicate'",
			})
		);
	});

	it('rejects edges outside deterministic creation order', () => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			edges: [
				{
					sessionId: 'session-edge',
					edges: [
						{
							id: 'edge-later',
							from: 'thought-b',
							to: 'thought-c',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 2,
						},
						{
							id: 'edge-earlier',
							from: 'thought-a',
							to: 'thought-b',
							kind: 'sequence',
							sessionId: 'session-edge',
							createdAt: 1,
						},
					],
				},
			],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'edge records are out of order',
			})
		);
	});

	it('rejects an explicitly present empty thought session record', () => {
		// Given
		const snapshot = {
			...EMPTY_FILE_V2_SNAPSHOT,
			thoughts: [{ sessionId: 'session-empty', thoughts: [] }],
		};

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'empty thought record',
			})
		);
	});

	it.each([
		[
			'duplicate',
			[
				{ sessionId: 'session-branch', branchId: 'branch-a', thoughts: [] },
				{ sessionId: 'session-branch', branchId: 'branch-a', thoughts: [] },
			],
		],
		[
			'out-of-order',
			[
				{ sessionId: 'session-branch', branchId: 'branch-b', thoughts: [] },
				{ sessionId: 'session-branch', branchId: 'branch-a', thoughts: [] },
			],
		],
	] as const)('rejects %s persisted branch records', (_, branchRecords) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, branches: branchRecords };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail: 'branch records are duplicate or out of order',
			})
		);
	});

	it.each([
		[
			'edge',
			{
				edges: [
					{
						sessionId: 'session-record',
						edges: [
							{
								id: 'edge-mismatch',
								from: 'thought-a',
								to: 'thought-b',
								kind: 'sequence',
								sessionId: 'session-payload',
								createdAt: 1,
							},
						],
					},
				],
			},
			'edge session does not match its record',
		],
		[
			'summary',
			{
				summaries: [
					{
						sessionId: 'session-record',
						summaries: [
							{
								id: 'summary-mismatch',
								sessionId: 'session-payload',
								rootThoughtId: 'thought-a',
								coveredIds: ['thought-a'],
								coveredRange: [1, 1],
								topics: ['compatibility'],
								aggregateConfidence: 0.75,
								createdAt: 1,
							},
						],
					},
				],
			},
			'summary session does not match its record',
		],
	] as const)('rejects a persisted %s payload from another session', (_, records, detail) => {
		// Given
		const snapshot = { ...EMPTY_FILE_V2_SNAPSHOT, ...records };

		// When / Then
		expect(() => parseFileSnapshotV2(JSON.stringify(snapshot), SNAPSHOT_SOURCE_PATH)).toThrowError(
			expect.objectContaining({
				name: 'PersistenceCompatibilityError',
				code: 'PERSISTENCE_COMPATIBILITY',
				sourcePath: SNAPSHOT_SOURCE_PATH,
				detail,
			})
		);
	});

	it('publishes only the canonical strict snapshot document', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-layout-'));
		const backend = await FilePersistence.create({ dataDir });
		try {
			await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'named-1' }));
			const snapshot: unknown = JSON.parse(await readFile(join(dataDir, 'snapshot.json'), 'utf-8'));
			expect(snapshot).toMatchObject({ version: 2, branches: [], edges: [], summaries: [] });
			expect(await backend.loadHistoryForSession(TEST_SESSION_ID)).toHaveLength(1);
		} finally {
			await backend.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('reopens history in admission order when thought numbers are non-monotonic', async () => {
		// Given
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-admission-order-'));
		const thoughts = [30, 10, 20].map((thoughtNumber) =>
			createTestThought({ id: `file-admitted-${thoughtNumber}`, thought_number: thoughtNumber })
		);

		try {
			const writer = await FilePersistence.create({ dataDir });
			try {
				for (const thought of thoughts)
					await writer.saveThoughtForSession(TEST_SESSION_ID, thought);
			} finally {
				await writer.close();
			}

			// When
			const reader = await FilePersistence.create({ dataDir });
			try {
				const reopened = await reader.loadHistoryForSession(TEST_SESSION_ID);

				// Then
				expect(reopened.map(({ id }) => id)).toEqual([
					'file-admitted-30',
					'file-admitted-10',
					'file-admitted-20',
				]);
			} finally {
				await reader.close();
			}
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('distinguishes malformed JSON, well-formed drift, and unsupported nonempty layouts', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tracelattice-task7-classify-'));
		try {
			for (const [name, bytes, code] of [
				['malformed', '{', 'PERSISTENCE_CORRUPTION'],
				['wrong-version', '{"version":1}', 'PERSISTENCE_COMPATIBILITY'],
			] as const) {
				const dataDir = join(root, name);
				await import('node:fs/promises').then(async ({ mkdir }) => await mkdir(dataDir));
				await writeFile(join(dataDir, 'snapshot.json'), bytes, 'utf-8');
				await expect(FilePersistence.create({ dataDir })).rejects.toMatchObject({ code });
			}
			const unsupportedDir = join(root, 'unsupported');
			await import('node:fs/promises').then(async ({ mkdir }) => await mkdir(unsupportedDir));
			await writeFile(join(unsupportedDir, 'foreign.bin'), 'opaque', 'utf-8');
			await expect(FilePersistence.create({ dataDir: unsupportedDir })).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
				detail: 'directory does not match File v2 layout',
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		['edge', { sessionId: 'empty-session', edges: [] }],
		['summary', { sessionId: 'empty-session', summaries: [] }],
	] as const)('rejects an explicitly present empty v2 %s record', async (_, emptyRecord) => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-empty-v2-record-'));
		const snapshot = {
			version: 2,
			thoughts: [],
			branches: [],
			edges: 'edges' in emptyRecord ? [emptyRecord] : [],
			summaries: 'summaries' in emptyRecord ? [emptyRecord] : [],
		};
		await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot), 'utf-8');

		try {
			await expect(FilePersistence.create({ dataDir })).rejects.toMatchObject({
				code: 'PERSISTENCE_COMPATIBILITY',
			});
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('preserves every namespace when scoped clear publication is interrupted', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'tracelattice-task7-clear-failure-'));
		let failReplacement = false;
		const backend = await FilePersistence.create({
			dataDir,
			writerOperations: {
				...nodeFileWriterOperations,
				rename: async (source, destination) => {
					if (failReplacement) throw new Error('injected scoped clear replacement failure');
					await nodeFileWriterOperations.rename(source, destination);
				},
			},
		});
		const sessionA = asSessionId('session-A');
		const sessionB = asSessionId('session-B');
		try {
			await backend.saveThoughtForSession(
				sessionA,
				createTestThought({ id: 'A-thought', session_id: sessionA })
			);
			await backend.saveThoughtForSession(
				sessionB,
				createTestThought({ id: 'B-thought', session_id: sessionB })
			);
			const snapshotPath = join(dataDir, 'snapshot.json');
			const before = await readFile(snapshotPath, 'utf-8');

			failReplacement = true;
			await expect(backend.clearSession(sessionA)).rejects.toMatchObject({
				code: 'PERSISTENCE_PUBLICATION',
			});

			expect(await readFile(snapshotPath, 'utf-8')).toBe(before);
			expect(await backend.loadHistoryForSession(sessionA)).toHaveLength(1);
			expect(await backend.loadHistoryForSession(sessionB)).toHaveLength(1);
		} finally {
			failReplacement = false;
			await backend.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it('uses an explicit named session through every mandatory scoped operation', async () => {
		const backend = new MemoryPersistence();
		const branchId = asBranchId('named-branch');
		await expect(
			backend.saveThoughtForSession(
				TEST_SESSION_ID,
				createTestThought({ id: 'named', session_id: 'named' })
			)
		).rejects.toMatchObject({ code: 'PERSISTENCE_SCOPE_MISMATCH' });
		await backend.saveThoughtForSession(TEST_SESSION_ID, createTestThought({ id: 'named-main' }));
		await backend.saveBranchForSession(TEST_SESSION_ID, branchId, [
			createTestThought({ id: 'named-branch-thought', branch_id: branchId }),
		]);
		expect((await backend.loadHistoryForSession(TEST_SESSION_ID)).map(({ id }) => id)).toEqual([
			'named-main',
		]);
		expect(await backend.listBranchesForSession(TEST_SESSION_ID)).toEqual([branchId]);
		expect(await backend.listSessions()).toEqual([TEST_SESSION_ID]);
		expect(asSessionId('named')).not.toBe(TEST_SESSION_ID);
	});
});
