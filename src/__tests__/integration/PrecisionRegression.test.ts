// allow: SIZE_OK - one public-path regression matrix is intentionally kept auditable in one file.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';

import type { FeatureFlags } from '../../contracts/features.js';
import { asBranchId, asSessionId, asThoughtId } from '../../contracts/ids.js';
import { resolveVerificationLinks } from '../../core/evaluator/VerificationLinks.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';

const STRATEGY_SCHEMA = v.variant('action', [
	v.object({ action: v.literal('continue'), nextHint: v.optional(v.string()) }),
	v.object({ action: v.literal('terminate'), reason: v.string() }),
	v.object({ action: v.literal('branch'), fromThought: v.number(), branchId: v.string() }),
]);
const RESPONSE_SCHEMA = v.object({
	thought_history_length: v.number(),
	next_thought_needed: v.boolean(),
	confidence_signals: v.object({
		calibrated_confidence: v.optional(v.number()),
		calibration_metrics: v.optional(v.object({ sampleCount: v.number() })),
		quality_components_raw: v.object({ verification_coverage: v.number() }),
	}),
	reasoning_stats: v.object({
		hypothesis_count: v.number(),
		verified_hypothesis_count: v.number(),
		unresolved_hypothesis_count: v.number(),
	}),
	reasoning_hints: v.optional(v.array(v.string())),
	strategy_hint: v.optional(STRATEGY_SCHEMA),
	continuation_token: v.optional(v.string()),
});
const ERROR_SCHEMA = v.object({
	code: v.string(),
	status: v.literal('failed'),
});
const SUSPENDED_SCHEMA = v.object({
	status: v.literal('suspended'),
	continuation_token: v.string(),
});

type Server = Awaited<ReturnType<typeof createServer>>;
type PublicInput = Parameters<Server['processThought']>[0];
type Result = Awaited<ReturnType<Server['processThought']>>;
type PublicResponse = v.InferOutput<typeof RESPONSE_SCHEMA>;

const BASE_FEATURES: FeatureFlags = {
	dagEdges: true,
	reasoningStrategy: 'tot',
	calibration: true,
	compression: true,
	toolInterleave: true,
	newThoughtTypes: true,
	outcomeRecording: true,
};
const servers = new Set<Server>();
const directories = new Set<string>();

function text(result: Result): string {
	const content = result.content[0]?.text;
	if (content === undefined) throw new TypeError('processThought returned no text content');
	return content;
}

function response(result: Result): PublicResponse {
	return v.parse(RESPONSE_SCHEMA, JSON.parse(text(result)));
}

function error(result: Result): v.InferOutput<typeof ERROR_SCHEMA> {
	expect(result.isError).toBe(true);
	return v.parse(ERROR_SCHEMA, JSON.parse(text(result)));
}

function suspended(result: Result): v.InferOutput<typeof SUSPENDED_SCHEMA> {
	return v.parse(SUSPENDED_SCHEMA, JSON.parse(text(result)));
}

function input(
	sessionId: string,
	id: string,
	thoughtNumber: number,
	overrides: Partial<PublicInput> = {}
): PublicInput {
	return {
		id,
		session_id: asSessionId(sessionId),
		thought: id,
		thought_number: thoughtNumber,
		total_thoughts: 30,
		next_thought_needed: true,
		...overrides,
	};
}

async function memoryServer(features: Partial<FeatureFlags> = {}): Promise<Server> {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({ features: { ...BASE_FEATURES, ...features } }),
	});
	servers.add(server);
	return server;
}

async function fileServer(
	dataDir: string,
	loadFromPersistence: boolean,
	features: Partial<FeatureFlags> = {}
): Promise<Server> {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence,
		fileConfig: {
			persistence: { enabled: true, backend: 'file', options: { dataDir } },
			persistenceBufferSize: 1,
			persistenceFlushInterval: 60_000,
			features: { ...BASE_FEATURES, ...features },
		},
	});
	servers.add(server);
	return server;
}

async function closeServer(server: Server): Promise<void> {
	await server.dispose();
	servers.delete(server);
}

afterEach(async () => {
	for (const server of servers) await server.dispose();
	servers.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe('precision regressions through the public production path', () => {
	it('rejects live and queued duplicate ids atomically while isolating sessions', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'tracelattice-precision-duplicate-'));
		directories.add(directory);
		const server = await fileServer(directory, false);
		const sessionId = asSessionId('precision-duplicate-a');
		await server.processThought(input(sessionId, 'stable-target', 1, { confidence: 0.8 }));
		await server.processThought(input(sessionId, 'duplicate-id', 2));
		await server.history._flushBuffer();
		const before = server.history.inspectSession(sessionId);
		const edgesBefore = server.getContainer().resolve('EdgeStore').edgesForSession(sessionId);
		const outcomesBefore = server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId);
		const bytesBefore = await readFile(join(directory, 'snapshot.json'));

		const liveDuplicate = await server.processThought(
			input(sessionId, 'duplicate-id', 3, {
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 1,
			})
		);
		expect(error(liveDuplicate).code).toBe('VALIDATION_ERROR');
		expect(server.history.inspectSession(sessionId)).toEqual(before);
		expect(server.getContainer().resolve('EdgeStore').edgesForSession(sessionId)).toEqual(
			edgesBefore
		);
		expect(server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId)).toEqual(
			outcomesBefore
		);
		await server.history._flushBuffer();
		expect(await readFile(join(directory, 'snapshot.json'))).toEqual(bytesBefore);

		const queuedSession = asSessionId('precision-duplicate-queued');
		const queued = await Promise.all([
			server.processThought(input(queuedSession, 'queued-id', 1)),
			server.processThought(input(queuedSession, 'queued-id', 2)),
		]);
		expect(queued.filter((result) => result.isError === true)).toHaveLength(1);
		const queuedError = queued.find((result) => result.isError === true);
		if (queuedError === undefined) throw new TypeError('expected one queued duplicate error');
		expect(error(queuedError).code).toBe('VALIDATION_ERROR');
		expect(server.history.getHistory(queuedSession)).toHaveLength(1);
		const otherSession = asSessionId('precision-duplicate-b');
		const crossSession = await server.processThought(input(otherSession, 'duplicate-id', 1));
		expect(crossSession.isError).toBeUndefined();
		expect(server.history.getHistory(otherSession)).toHaveLength(1);
	});

	it('keeps the canonical verifier target after a later duplicate thought number', async () => {
		const server = await memoryServer();
		const sessionId = asSessionId('precision-canonical-target');
		await server.processThought(
			input(sessionId, 'canonical-hypothesis', 1, {
				thought_type: 'hypothesis',
				hypothesis_id: 'duplicate-label',
				confidence: 0.8,
			})
		);
		await server.processThought(
			input(sessionId, 'canonical-verifier', 2, {
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 1,
			})
		);
		await server.processThought(
			input(sessionId, 'later-duplicate-number', 1, {
				thought_type: 'hypothesis',
				hypothesis_id: 'duplicate-label',
				confidence: 0.2,
			})
		);
		const result = response(await server.processThought(input(sessionId, 'probe', 3)));
		const outcomes = server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId);
		const snapshot = server.history.inspectSession(sessionId);
		const links = resolveVerificationLinks(
			snapshot.history,
			snapshot.branches,
			snapshot.verificationTargets
		);

		expect(result.reasoning_stats).toEqual({
			hypothesis_count: 2,
			verified_hypothesis_count: 1,
			unresolved_hypothesis_count: 1,
		});
		expect(result.confidence_signals.quality_components_raw.verification_coverage).toBe(0.5);
		expect(outcomes).toEqual([
			expect.objectContaining({ thoughtId: 'canonical-hypothesis', actual: 1, predicted: 0.8 }),
		]);
		expect(links.targetFor(asThoughtId('canonical-verifier'))).toBe('canonical-hypothesis');
	});

	it('does not misattribute unrelated verification or duplicate hypothesis labels', async () => {
		const server = await memoryServer();
		const sessionId = asSessionId('precision-unrelated-verification');
		await server.processThought(
			input(sessionId, 'hypothesis-a', 1, {
				thought_type: 'hypothesis',
				hypothesis_id: 'shared',
			})
		);
		await server.processThought(input(sessionId, 'regular-target', 2));
		await server.processThought(
			input(sessionId, 'unrelated-verifier', 3, {
				thought_type: 'verification',
				verification_target: 2,
			})
		);
		const result = response(
			await server.processThought(
				input(sessionId, 'hypothesis-b', 4, {
					thought_type: 'hypothesis',
					hypothesis_id: 'shared',
				})
			)
		);

		expect(result.reasoning_stats.verified_hypothesis_count).toBe(0);
		expect(result.reasoning_stats.unresolved_hypothesis_count).toBe(2);
		expect(result.confidence_signals.quality_components_raw.verification_coverage).toBe(0);
	});

	it('rejects ambiguous result and backtrack targets before any mutation', async () => {
		const server = await memoryServer();
		const sessionId = asSessionId('precision-ambiguous-target');
		await server.processThought(input(sessionId, 'ambiguous-a', 1, { confidence: 0.7 }));
		await server.processThought(input(sessionId, 'ambiguous-b', 1, { confidence: 0.8 }));
		const before = server.history.inspectSession(sessionId);
		const edgesBefore = server.getContainer().resolve('EdgeStore').edgesForSession(sessionId);
		const outcomesBefore = server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId);

		const verification = await server.processThought(
			input(sessionId, 'ambiguous-verification', 2, {
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 0,
			})
		);
		expect(error(verification).code).toBe('VALIDATION_ERROR');
		expect(server.history.inspectSession(sessionId)).toEqual(before);
		expect(server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId)).toEqual(
			outcomesBefore
		);

		const backtrack = await server.processThought(
			input(sessionId, 'ambiguous-backtrack', 2, {
				thought_type: 'backtrack',
				backtrack_target: 1,
			})
		);
		expect(error(backtrack).code).toBe('INVALID_BACKTRACK');
		expect(server.history.inspectSession(sessionId)).toEqual(before);
		expect(server.getContainer().resolve('EdgeStore').edgesForSession(sessionId)).toEqual(
			edgesBefore
		);
	});

	it('removes retracted verifier and hypothesis evidence from analytics and hints', async () => {
		const verifierServer = await memoryServer();
		const verifierSession = asSessionId('precision-retracted-verifier');
		await verifierServer.processThought(
			input(verifierSession, 'hypothesis', 1, { thought_type: 'hypothesis' })
		);
		await verifierServer.processThought(
			input(verifierSession, 'verifier', 2, {
				thought_type: 'verification',
				verification_target: 1,
			})
		);
		const retractedVerifier = response(
			await verifierServer.processThought(
				input(verifierSession, 'retract-verifier', 3, {
					thought_type: 'backtrack',
					backtrack_target: 2,
				})
			)
		);
		expect(retractedVerifier.reasoning_stats.verified_hypothesis_count).toBe(0);
		expect(retractedVerifier.reasoning_stats.unresolved_hypothesis_count).toBe(1);
		expect(retractedVerifier.reasoning_hints).toBeUndefined();

		const hypothesisServer = await memoryServer();
		const hypothesisSession = asSessionId('precision-retracted-hypothesis');
		await hypothesisServer.processThought(
			input(hypothesisSession, 'hypothesis', 1, { thought_type: 'hypothesis' })
		);
		await hypothesisServer.processThought(input(hypothesisSession, 'regular-2', 2));
		await hypothesisServer.processThought(input(hypothesisSession, 'regular-3', 3));
		const retractedHypothesis = response(
			await hypothesisServer.processThought(
				input(hypothesisSession, 'retract-hypothesis', 4, {
					thought_type: 'backtrack',
					backtrack_target: 1,
				})
			)
		);
		expect(retractedHypothesis.reasoning_stats.hypothesis_count).toBe(0);
		expect(retractedHypothesis.reasoning_stats.unresolved_hypothesis_count).toBe(0);
		expect(retractedHypothesis.reasoning_hints?.join(' ') ?? '').not.toContain('unverified');
	});

	it.each([true, false])(
		'preserves copied-target retraction after File reopen when compression=%s',
		async (compression) => {
			const directory = await mkdtemp(join(tmpdir(), `tracelattice-precision-${compression}-`));
			directories.add(directory);
			const sessionId = asSessionId(`precision-compression-${compression}`);
			const first = await fileServer(directory, false, { compression });
			await first.processThought(input(sessionId, 'anchor', 1));
			await first.processThought(
				input(sessionId, 'copied-target', 2, {
					thought_type: 'hypothesis',
					branch_from_thought: 1,
					branch_id: 'retained-copy',
				})
			);
			await first.processThought(
				input(sessionId, 'verifier', 3, {
					thought_type: 'verification',
					verification_target: 2,
				})
			);
			await closeServer(first);

			const reopened = await fileServer(directory, true, { compression });
			const result = response(
				await reopened.processThought(
					input(sessionId, 'retract-target', 4, {
						thought_type: 'backtrack',
						backtrack_target: 2,
					})
				)
			);
			const mainCopy = reopened.history
				.getHistory(sessionId)
				.find((item) => item.id === 'copied-target');
			const branchCopy = reopened.history.getBranches(sessionId)[asBranchId('retained-copy')]?.[0];
			expect(mainCopy?.retracted).toBe(true);
			expect(branchCopy?.retracted).toBe(true);
			expect(result.reasoning_stats.hypothesis_count).toBe(0);
			expect(result.reasoning_stats.verified_hypothesis_count).toBe(0);
		}
	);

	it('uses active-only ToT evidence while retaining append-only audit state', async () => {
		const server = await memoryServer();
		const sessionId = asSessionId('precision-active-tot');
		await server.processThought(
			input(sessionId, 'root', 1, { confidence: 0.1, quality_score: 0.1 })
		);
		const high = response(
			await server.processThought(
				input(sessionId, 'high-leaf', 2, { confidence: 1, quality_score: 1 })
			)
		);
		expect(high.strategy_hint).toEqual({ action: 'terminate', reason: 'confidence threshold' });
		const edgeStore = server.getContainer().resolve('EdgeStore');
		const auditBefore = structuredClone(edgeStore.edgesForSession(sessionId));
		const active = response(
			await server.processThought(
				input(sessionId, 'retract-high', 3, {
					thought_type: 'backtrack',
					backtrack_target: 2,
					confidence: 0.1,
					quality_score: 0.1,
				})
			)
		);
		expect(active.strategy_hint).toEqual({ action: 'continue', nextHint: 'explore frontier' });
		expect(server.history.getHistory(sessionId)).toHaveLength(3);
		expect(server.history.getHistory(sessionId)[1]?.retracted).toBe(true);
		expect(edgeStore.edgesForSession(sessionId).slice(0, auditBefore.length)).toEqual(auditBefore);

		const plateauServer = await memoryServer();
		const plateauSession = asSessionId('precision-active-plateau');
		for (const number of [1, 2]) {
			await plateauServer.processThought(
				input(plateauSession, `plateau-${number}`, number, {
					confidence: 0.3,
					quality_score: 0.3,
				})
			);
		}
		const plateau = response(
			await plateauServer.processThought(
				input(plateauSession, 'plateau-3', 3, { confidence: 0.3, quality_score: 0.3 })
			)
		);
		expect(plateau.strategy_hint).toEqual({ action: 'terminate', reason: 'plateau' });
		expect(plateauServer.history.getHistory(plateauSession)).toHaveLength(3);
	});
});

describe('one-feature-at-a-time precision matrix', () => {
	it('calibration=false preserves submitted raw confidence without a fitted transform', async () => {
		const server = await memoryServer({ calibration: false });
		const sessionId = asSessionId('precision-calibration-off');
		const calibrator = server.getContainer().resolve('calibrator');
		expect(calibrator.calibrate(0.73, 'regular', sessionId)).toEqual({
			raw: 0.73,
			calibrated: 0.73,
			temperature: 1,
			priorWeight: 0,
		});
		const result = response(
			await server.processThought(input(sessionId, 'raw-confidence', 1, { confidence: 0.73 }))
		);
		expect(result.confidence_signals.calibrated_confidence).toBeUndefined();
		expect(server.history.getHistory(sessionId)[0]?.confidence).toBe(0.73);
	});

	it('newThoughtTypes=false rejects backtrack before history and persistence mutation', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'tracelattice-precision-types-off-'));
		directories.add(directory);
		const server = await fileServer(directory, false, { newThoughtTypes: false });
		const sessionId = asSessionId('precision-types-off');
		await server.processThought(input(sessionId, 'existing', 1));
		await server.history._flushBuffer();
		const before = server.history.inspectSession(sessionId);
		const bytesBefore = await readFile(join(directory, 'snapshot.json'));
		const rejected = await server.processThought(
			input(sessionId, 'forbidden-backtrack', 2, {
				thought_type: 'backtrack',
				backtrack_target: 1,
			})
		);
		expect(error(rejected).code).toBe('VALIDATION_ERROR');
		expect(server.history.inspectSession(sessionId)).toEqual(before);
		await server.history._flushBuffer();
		expect(await readFile(join(directory, 'snapshot.json'))).toEqual(bytesBefore);
	});

	it('toolInterleave=false keeps ordinary duplicate rejection without a suspension store', async () => {
		const server = await memoryServer({ toolInterleave: false });
		const sessionId = asSessionId('precision-tools-off');
		expect(server.getContainer().has('suspensionStore')).toBe(false);
		await server.processThought(input(sessionId, 'ordinary-id', 1));
		const before = server.history.inspectSession(sessionId);
		const duplicate = await server.processThought(input(sessionId, 'ordinary-id', 2));
		expect(error(duplicate).code).toBe('VALIDATION_ERROR');
		expect(server.history.inspectSession(sessionId)).toEqual(before);
	});

	it('toolInterleave=true preserves a suspension when its observation id is duplicate', async () => {
		const server = await memoryServer();
		const sessionId = asSessionId('precision-tools-on');
		server.tools.add({ name: 'precision-tool', description: 'precision tool', inputSchema: {} });
		const suspendedCall = suspended(
			await server.processThought(
				input(sessionId, 'tool-id', 1, {
					thought_type: 'tool_call',
					tool_name: 'precision-tool',
					tool_arguments: {},
				})
			)
		);
		const token = suspendedCall.continuation_token;
		const store = server.getContainer().resolve('suspensionStore');
		const before = store.peek(token);
		const historyBefore = server.history.inspectSession(sessionId);
		const duplicate = await server.processThought(
			input(sessionId, 'tool-id', 2, {
				thought_type: 'tool_observation',
				continuation_token: token,
			})
		);
		expect(error(duplicate).code).toBe('VALIDATION_ERROR');
		expect(store.peek(token)).toEqual(before);
		expect(server.history.inspectSession(sessionId)).toEqual(historyBefore);
	});

	it('outcomeRecording=false keeps samples empty and calibration output unchanged', async () => {
		const server = await memoryServer({ outcomeRecording: false });
		const sessionId = asSessionId('precision-outcomes-off');
		const calibrator = server.getContainer().resolve('calibrator');
		const before = calibrator.calibrate(0.81, 'regular', sessionId);
		for (let number = 1; number <= 10; number += 1) {
			await server.processThought(
				input(sessionId, `prediction-${number}`, number * 2 - 1, { confidence: 0.81 })
			);
			await server.processThought(
				input(sessionId, `verification-${number}`, number * 2, {
					thought_type: 'verification',
					verification_target: number * 2 - 1,
					verification_result: number % 2 === 0 ? 0 : 1,
				})
			);
		}
		expect(server.getContainer().resolve('outcomeRecorder').getOutcomes(sessionId)).toEqual([]);
		expect(calibrator.calibrate(0.81, 'regular', sessionId)).toEqual(before);
		expect(before).toEqual({ raw: 0.81, calibrated: 0.81, temperature: 1, priorWeight: 1 });
	});

	it('explicit sequential strategy follows next_thought_needed exactly', async () => {
		const server = await memoryServer({ reasoningStrategy: 'sequential' });
		const sessionId = asSessionId('precision-sequential');
		const ongoing = response(
			await server.processThought(
				input(sessionId, 'ongoing', 1, {
					next_thought_needed: true,
					confidence: 1,
					quality_score: 1,
				})
			)
		);
		const finished = response(
			await server.processThought(input(sessionId, 'finished', 2, { next_thought_needed: false }))
		);
		expect(ongoing.strategy_hint).toEqual({ action: 'continue' });
		expect(finished.strategy_hint).toEqual({
			action: 'terminate',
			reason: 'next_thought_needed=false',
		});
	});

	it('dagEdges=false keeps target semantics while suppressing every edge and ToT predicate', async () => {
		const server = await memoryServer({ dagEdges: false });
		const sessionId = asSessionId('precision-dag-off');
		await server.processThought(
			input(sessionId, 'hypothesis', 1, {
				thought_type: 'hypothesis',
				confidence: 1,
				quality_score: 1,
			})
		);
		const verified = response(
			await server.processThought(
				input(sessionId, 'verification', 2, {
					thought_type: 'verification',
					verification_target: 1,
				})
			)
		);
		expect(verified.reasoning_stats.verified_hypothesis_count).toBe(1);
		expect(verified.strategy_hint).toEqual({ action: 'continue', nextHint: 'explore frontier' });
		const retracted = response(
			await server.processThought(
				input(sessionId, 'backtrack', 3, {
					thought_type: 'backtrack',
					backtrack_target: 1,
				})
			)
		);
		expect(retracted.reasoning_stats.hypothesis_count).toBe(0);
		expect(server.history.getHistory(sessionId)[0]?.retracted).toBe(true);
		expect(server.getContainer().resolve('EdgeStore').edgesForSession(sessionId)).toEqual([]);
		expect(retracted.strategy_hint).toEqual({ action: 'continue', nextHint: 'explore frontier' });
	});
});
