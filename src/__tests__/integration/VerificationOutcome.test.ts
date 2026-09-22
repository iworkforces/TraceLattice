import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import type { FeatureFlags } from '../../contracts/features.js';
import { asBranchId, asSessionId } from '../../contracts/ids.js';
import { createServer } from '../../lib.js';
import { SequentialThinkingSchema, SEQUENTIAL_THINKING_TOOL } from '../../schema.js';
import { ServerConfig } from '../../ServerConfig.js';
import { HttpTransport } from '../../transport/HttpTransport.js';
import {
	INITIALIZE_PARAMS,
	ToolCallResultSchema,
	getListeningPort,
	postJson,
} from './ProtocolHarness.js';

type Server = Awaited<ReturnType<typeof createServer>>;
type PublicInput = Parameters<Server['processThought']>[0];

const BASE_FEATURES: FeatureFlags = {
	dagEdges: true,
	reasoningStrategy: 'sequential',
	calibration: true,
	compression: false,
	toolInterleave: false,
	newThoughtTypes: true,
	outcomeRecording: true,
};
const DEFAULT_SESSION_ID = asSessionId('verification-outcome');

function input(
	thought: string,
	thoughtNumber: number,
	overrides: Partial<PublicInput> = {}
): PublicInput {
	return {
		thought,
		thought_number: thoughtNumber,
		total_thoughts: 20,
		next_thought_needed: thoughtNumber < 20,
		session_id: DEFAULT_SESSION_ID,
		...overrides,
	};
}

function payload(result: Awaited<ReturnType<Server['processThought']>>): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function configuredServer(
	features: Partial<FeatureFlags> = {},
	maxHistorySize = 1000
): Promise<Server> {
	return await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({
			maxHistorySize,
			features: { ...BASE_FEATURES, ...features },
		}),
	});
}

describe('explicit verification outcomes', () => {
	it.each([true, false])(
		'keeps target-only verification analytics stable when dagEdges=%s after a duplicate number arrives',
		async (dagEdges) => {
			const server = await configuredServer({ dagEdges });
			const sessionId = asSessionId(`target-only-${dagEdges}`);
			try {
				await server.processThought(
					input('first hypothesis', 1, {
						session_id: sessionId,
						thought_type: 'hypothesis',
						hypothesis_id: 'shared-label',
					})
				);
				await server.processThought(
					input('target-only verification', 2, {
						session_id: sessionId,
						thought_type: 'verification',
						verification_target: 1,
					})
				);
				const duplicate = await server.processThought(
					input('second hypothesis with duplicate number', 1, {
						session_id: sessionId,
						thought_type: 'hypothesis',
						hypothesis_id: 'shared-label',
					})
				);

				const response = payload(duplicate);
				const stats = response.reasoning_stats as Record<string, unknown>;
				const signals = response.confidence_signals as Record<string, unknown>;
				const qualityComponents = signals.quality_components_raw as
					Record<string, unknown> | undefined;
				expect(stats.hypothesis_count).toBe(2);
				expect(stats.verified_hypothesis_count).toBe(1);
				expect(stats.unresolved_hypothesis_count).toBe(1);
				expect(qualityComponents?.verification_coverage).toBe(0.5);
				const verifies = server
					.getContainer()
					.resolve('EdgeStore')
					.edgesForSession(sessionId)
					.filter((edge) => edge.kind === 'verifies');
				expect(verifies).toHaveLength(dagEdges ? 1 : 0);
			} finally {
				await server.stop();
			}
		}
	);

	it('keeps a branch-only retained hypothesis verified after main history trimming', async () => {
		const server = await configuredServer({}, 1);
		const sessionId = asSessionId('branch-only-retained');
		const branchId = asBranchId('retained-hypothesis');
		try {
			await server.processThought(input('anchor', 1, { session_id: sessionId }));
			await server.processThought(
				input('branch hypothesis', 2, {
					session_id: sessionId,
					thought_type: 'hypothesis',
					branch_from_thought: 1,
					branch_id: branchId,
				})
			);
			const verified = await server.processThought(
				input('branch target verified', 3, {
					session_id: sessionId,
					thought_type: 'verification',
					verification_target: 2,
				})
			);

			const response = payload(verified);
			const stats = response.reasoning_stats as Record<string, unknown>;
			const signals = response.confidence_signals as Record<string, unknown>;
			expect(server.history.getHistory(sessionId)).toHaveLength(1);
			expect(server.history.getBranches(sessionId)[branchId]).toHaveLength(1);
			expect(stats.hypothesis_count).toBe(1);
			expect(stats.verified_hypothesis_count).toBe(1);
			expect(stats.unresolved_hypothesis_count).toBe(0);
			expect(
				(signals.quality_components_raw as Record<string, unknown> | undefined)
					?.verification_coverage
			).toBe(1);
		} finally {
			await server.stop();
		}
	});

	it('excludes an exact retracted verifier from public verification coverage', async () => {
		const server = await configuredServer();
		const sessionId = asSessionId('retracted-verifier');
		try {
			await server.processThought(
				input('hypothesis', 1, { session_id: sessionId, thought_type: 'hypothesis' })
			);
			await server.processThought(
				input('verification', 2, {
					session_id: sessionId,
					thought_type: 'verification',
					verification_target: 1,
				})
			);
			await server.processThought(
				input('retract verifier', 3, {
					session_id: sessionId,
					thought_type: 'backtrack',
					backtrack_target: 2,
				})
			);
			const result = await server.processThought(
				input('later thought', 4, { session_id: sessionId })
			);

			const response = payload(result);
			const stats = response.reasoning_stats as Record<string, unknown>;
			const signals = response.confidence_signals as Record<string, unknown>;
			expect(stats.hypothesis_count).toBe(1);
			expect(stats.verified_hypothesis_count).toBe(0);
			expect(stats.unresolved_hypothesis_count).toBe(1);
			expect(
				(signals.quality_components_raw as Record<string, unknown> | undefined)
					?.verification_coverage
			).toBe(0);
		} finally {
			await server.stop();
		}
	});

	it('accepts exact public 0/1 labels and records the stable target snapshot', async () => {
		const server = await configuredServer();
		const sessionId = asSessionId('exact-labels');
		try {
			await server.processThought(
				input('first prediction', 1, { confidence: 0.8, session_id: sessionId })
			);
			await server.processThought(
				input('second prediction', 2, { confidence: 0.3, session_id: sessionId })
			);
			const targets = server.history.getHistory(sessionId);

			const zero = await server.processThought(
				input('first was wrong', 3, {
					session_id: sessionId,
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 0,
				})
			);
			const one = await server.processThought(
				input('second was correct', 4, {
					session_id: sessionId,
					thought_type: 'verification',
					verification_target: 2,
					verification_result: 1,
				})
			);

			expect(zero.isError).toBeUndefined();
			expect(one.isError).toBeUndefined();
			expect(server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId)).toEqual([
				expect.objectContaining({
					thoughtId: targets[0]?.id,
					predicted: 0.8,
					actual: 0,
					type: 'regular',
				}),
				expect.objectContaining({
					thoughtId: targets[1]?.id,
					predicted: 0.3,
					actual: 1,
					type: 'regular',
				}),
			]);
			expect(
				server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId)[0]
			).not.toHaveProperty('thoughtNumber');
		} finally {
			await server.stop();
		}
	});

	it('rejects non-numeric and non-binary public labels before mutation', async () => {
		const server = await configuredServer();
		try {
			await server.processThought(input('prediction', 1, { confidence: 0.8 }));
			for (const invalid of ['1', true, 2, -1]) {
				const candidate = {
					...input('invalid label', 2),
					thought_type: 'verification',
					verification_target: 1,
					verification_result: invalid,
				};
				const result = await server.processThought(candidate as unknown as PublicInput);
				expect(result.isError).toBe(true);
			}
			expect(server.history.getHistory(DEFAULT_SESSION_ID)).toHaveLength(1);
			expect(server.getContainer().resolve('outcomeRecorder').getAllOutcomes()).toEqual([]);
		} finally {
			await server.stop();
		}
	});

	it('never infers labels from prose, tool results, or non-verification fields', async () => {
		const server = await configuredServer();
		try {
			await server.processThought(input('prediction', 1, { confidence: 0.8 }));
			await server.processThought(
				input('tool succeeded, so the target is correct', 2, {
					thought_type: 'verification',
					verification_target: 1,
					tool_result: { success: true, result: 'correct' },
				})
			);
			await server.processThought(
				input('regular thought carrying an explicit-looking field', 3, {
					verification_result: 1,
				})
			);

			expect(server.getContainer().resolve('outcomeRecorder').getAllOutcomes()).toEqual([]);
		} finally {
			await server.stop();
		}
	});

	it('serializes duplicate submissions so only one mutates history and outcomes', async () => {
		const server = await configuredServer();
		const sessionId = asSessionId('duplicate-session');
		try {
			await server.processThought(
				input('prediction', 1, { confidence: 0.9, session_id: sessionId })
			);
			const [first, second] = await Promise.all([
				server.processThought(
					input('label one', 2, {
						session_id: sessionId,
						thought_type: 'verification',
						verification_target: 1,
						verification_result: 1,
					})
				),
				server.processThought(
					input('label two', 3, {
						session_id: sessionId,
						thought_type: 'verification',
						verification_target: 1,
						verification_result: 0,
					})
				),
			]);

			expect([first.isError, second.isError].filter(Boolean)).toHaveLength(1);
			expect(server.history.getHistory(sessionId)).toHaveLength(2);
			expect(server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId)).toHaveLength(
				1
			);
		} finally {
			await server.stop();
		}
	});

	it.each([
		{ recording: false, calibration: false },
		{ recording: false, calibration: true },
		{ recording: true, calibration: false },
		{ recording: true, calibration: true },
	])('keeps recording=$recording independent from calibration=$calibration', async (flags) => {
		const server = await configuredServer({
			outcomeRecording: flags.recording,
			calibration: flags.calibration,
		});
		try {
			await server.processThought(input('prediction', 1, { confidence: 0.9 }));
			const result = await server.processThought(
				input('explicit label', 2, {
					confidence: 0.7,
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 1,
				})
			);
			const response = payload(result);
			const confidenceSignals = response.confidence_signals as Record<string, unknown>;
			const recorder = server.getContainer().resolve('outcomeRecorder');

			expect(recorder.getAllOutcomes()).toHaveLength(flags.recording ? 1 : 0);
			expect(confidenceSignals.calibrated_confidence !== undefined).toBe(flags.calibration);
			if (flags.calibration) {
				expect(confidenceSignals.calibration_metrics).toMatchObject({
					sampleCount: flags.recording ? 1 : 0,
				});
			}
			if (!flags.recording) {
				const repeated = await server.processThought(
					input('second explicit label', 3, {
						thought_type: 'verification',
						verification_target: 1,
						verification_result: 0,
					})
				);
				expect(repeated.isError).toBeUndefined();
				expect(recorder.getAllOutcomes()).toEqual([]);
			}
		} finally {
			await server.stop();
		}
	});

	it('isolates named branch targets while deduplicating stable branch copies', async () => {
		const server = await configuredServer();
		const otherSessionId = asSessionId('other-session');
		const sessionId = asSessionId('branch-session');
		const branchId = asBranchId('alternate');
		try {
			await server.processThought(
				input('other prediction', 1, { confidence: 0.2, session_id: otherSessionId })
			);
			await server.processThought(input('branch anchor', 1, { session_id: sessionId }));
			await server.processThought(
				input('branch prediction', 2, {
					session_id: sessionId,
					confidence: 0.8,
					branch_from_thought: 1,
					branch_id: branchId,
				})
			);
			const branchTarget = server.history.getHistory(sessionId)[1];
			expect(server.history.getBranches(sessionId)[branchId]?.[0]?.id).toBe(branchTarget?.id);

			await server.processThought(
				input('other label', 2, {
					session_id: otherSessionId,
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 0,
				})
			);
			await server.processThought(
				input('branch label', 3, {
					session_id: sessionId,
					thought_type: 'verification',
					verification_target: 2,
					verification_result: 1,
				})
			);

			const recorder = server.getContainer().resolve('outcomeRecorder');
			expect(recorder.getOutcomes(otherSessionId)).toEqual([
				expect.objectContaining({ actual: 0, predicted: 0.2 }),
			]);
			expect(recorder.getOutcomes(sessionId)).toEqual([
				expect.objectContaining({ thoughtId: branchTarget?.id, actual: 1, predicted: 0.8 }),
			]);
		} finally {
			await server.stop();
		}
	});

	it('retains captured samples after admission pruning and later logical retraction', async () => {
		const pruned = await configuredServer({}, 1);
		try {
			await pruned.processThought(input('soon pruned', 1, { confidence: 0.8 }));
			const result = await pruned.processThought(
				input('label after capture', 2, {
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 1,
				})
			);
			expect(result.isError).toBeUndefined();
			expect(
				pruned.history.getHistory(DEFAULT_SESSION_ID).map((thought) => thought.thought_number)
			).toEqual([2]);
			expect(pruned.getContainer().resolve('outcomeRecorder').getAllOutcomes()).toHaveLength(1);
		} finally {
			await pruned.stop();
		}

		const retracted = await configuredServer();
		try {
			await retracted.processThought(input('later retracted', 1, { confidence: 0.8 }));
			await retracted.processThought(
				input('label before retraction', 2, {
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 0,
				})
			);
			await retracted.processThought(
				input('retract target', 3, { thought_type: 'backtrack', backtrack_target: 1 })
			);
			expect(retracted.history.getHistory(DEFAULT_SESSION_ID)[0]?.retracted).toBe(true);
			expect(retracted.getContainer().resolve('outcomeRecorder').getAllOutcomes()).toHaveLength(1);
		} finally {
			await retracted.stop();
		}
	});
});

it('validates exact verification labels at the MCP protocol boundary', async () => {
	const labels: Array<0 | 1 | undefined> = [];
	const mcp = new McpServer(
		{ name: 'verification-outcome', version: '1.0.0' },
		{ adapter: new ValibotJsonSchemaAdapter(), capabilities: { tools: {} } }
	);
	mcp.tool(
		{
			name: SEQUENTIAL_THINKING_TOOL.name,
			description: SEQUENTIAL_THINKING_TOOL.description,
			schema: SequentialThinkingSchema,
		},
		async (value) => {
			labels.push(value.verification_result);
			return { content: [{ type: 'text' as const, text: 'accepted' }] };
		}
	);
	const transport = new HttpTransport({ port: 0, host: '127.0.0.1', enableRateLimit: false });
	await transport.connect(mcp);
	const endpoint = `http://127.0.0.1:${getListeningPort(transport)}/messages`;
	try {
		await postJson(endpoint, {
			jsonrpc: '2.0',
			id: 'initialize',
			method: 'initialize',
			params: INITIALIZE_PARAMS,
		});
		const validZero = await postJson(endpoint, {
			jsonrpc: '2.0',
			id: 'valid-zero',
			method: 'tools/call',
			params: {
				name: SEQUENTIAL_THINKING_TOOL.name,
				arguments: input('protocol label', 2, {
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 0,
				}),
			},
		});
		const validOne = await postJson(endpoint, {
			jsonrpc: '2.0',
			id: 'valid-one',
			method: 'tools/call',
			params: {
				name: SEQUENTIAL_THINKING_TOOL.name,
				arguments: input('protocol label', 2, {
					thought_type: 'verification',
					verification_target: 1,
					verification_result: 1,
				}),
			},
		});
		const invalid = await postJson(endpoint, {
			jsonrpc: '2.0',
			id: 'invalid-string',
			method: 'tools/call',
			params: {
				name: SEQUENTIAL_THINKING_TOOL.name,
				arguments: {
					...input('invalid protocol label', 3),
					thought_type: 'verification',
					verification_target: 1,
					verification_result: '1',
				},
			},
		});

		expect(v.parse(ToolCallResultSchema, validZero.body?.result).isError).toBeUndefined();
		expect(v.parse(ToolCallResultSchema, validOne.body?.result).isError).toBeUndefined();
		expect(v.parse(ToolCallResultSchema, invalid.body?.result).isError).toBe(true);
		expect(labels).toEqual([0, 1]);
	} finally {
		await transport.stop();
	}
});
