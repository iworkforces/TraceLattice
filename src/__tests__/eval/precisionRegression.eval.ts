import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import { createServer } from '../../lib.js';
import { ServerConfig } from '../../ServerConfig.js';

// allow: SIZE_OK - task scope requires the independent oracle and public processor report in one eval.
const TRAINING_SESSION = asSessionId('precision-eval-training');
const PROCESSOR_SESSION = asSessionId('precision-eval-processor');
const AMBIGUOUS_SESSION = asSessionId('precision-eval-ambiguous');
const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');
const EPSILON = 1e-9;
const TEMPERATURE = 0.5;
const PRIOR_WEIGHT = 0.5;

const TRAINING = [
	...Array.from({ length: 5 }, (_, index) => ({
		id: `training-success-${index}`,
		raw: 0.9,
		actual: 1 as const,
	})),
	...Array.from({ length: 5 }, (_, index) => ({
		id: `training-failure-${index}`,
		raw: 0.2,
		actual: 0 as const,
	})),
] as const;

const HOLDOUT = [
	{ raw: 0.8, actual: 1 },
	{ raw: 0.6, actual: 0 },
	{ raw: 0.3, actual: 0 },
	{ raw: 0.1, actual: 1 },
] as const;

const PRE_TEMPERATURE = [0.65, 0.55, 0.4, 0.3] as const;

const processorPayloadSchema = v.looseObject({
	reasoning_stats: v.optional(
		v.looseObject({
			hypothesis_count: v.number(),
			verified_hypothesis_count: v.number(),
			unresolved_hypothesis_count: v.number(),
		})
	),
	strategy_hint: v.optional(v.looseObject({ action: v.string() })),
	code: v.optional(v.string()),
});

type ProbabilitySample = { readonly probability: number; readonly actual: 0 | 1 };
type ProbabilityMetrics = { readonly nll: number; readonly brier: number; readonly ece: number };
type Server = Awaited<ReturnType<typeof createServer>>;
type PublicInput = Parameters<Server['processThought']>[0];
type EvalThought = Omit<
	PublicInput,
	'thought' | 'total_thoughts' | 'next_thought_needed' | 'session_id'
> & { readonly id: string; readonly session_id?: PublicInput['session_id'] };

function processorInput(input: EvalThought): PublicInput {
	return {
		thought: input.id,
		total_thoughts: 4,
		next_thought_needed: true,
		session_id: PROCESSOR_SESSION,
		...input,
	};
}

function scaleTemperature(probability: number): number {
	const clamped = Math.min(1 - EPSILON, Math.max(EPSILON, probability));
	const odds = clamped / (1 - clamped);
	return 1 / (1 + odds ** (-1 / TEMPERATURE));
}

function probabilityMetrics(samples: readonly ProbabilitySample[]): ProbabilityMetrics {
	let nll = 0;
	let brier = 0;
	const bins = Array.from({ length: 10 }, () => ({ confidence: 0, accuracy: 0, count: 0 }));
	for (const sample of samples) {
		const probability = Math.min(1 - EPSILON, Math.max(EPSILON, sample.probability));
		nll -= sample.actual * Math.log(probability) + (1 - sample.actual) * Math.log(1 - probability);
		brier += (probability - sample.actual) ** 2;
		const bin = bins[Math.min(9, Math.floor(probability * 10))];
		if (bin === undefined) throw new RangeError('Expected calibration bin');
		bin.confidence += probability;
		bin.accuracy += sample.actual;
		bin.count += 1;
	}
	const ece = bins.reduce(
		(total, bin) =>
			bin.count === 0
				? total
				: total +
					(bin.count / samples.length) *
						Math.abs(bin.confidence / bin.count - bin.accuracy / bin.count),
		0
	);
	return { nll: nll / samples.length, brier: brier / samples.length, ece };
}

async function calibrationReport() {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({ persistenceFlushInterval: 60_000 }),
	});
	try {
		const recorder = server.getContainer().resolve('outcomeRecorder');
		const calibrator = server.getContainer().resolve('calibrator');
		for (const sample of TRAINING) {
			recorder.recordVerification({
				thoughtId: asThoughtId(sample.id),
				sessionId: TRAINING_SESSION,
				predicted: sample.raw,
				actual: sample.actual,
				type: 'hypothesis',
			});
		}
		calibrator.refit(TRAINING_SESSION);
		const samplesBefore = recorder.getOutcomes(TRAINING_SESSION);
		const metricsBefore = calibrator.metrics(TRAINING_SESSION);
		const transformed = HOLDOUT.map((sample) =>
			calibrator.calibrate(sample.raw, 'hypothesis', TRAINING_SESSION)
		);
		const expectedPreTemperature = HOLDOUT.map((sample) => PRIOR_WEIGHT * sample.raw + 0.25);
		const expectedTransformed = expectedPreTemperature.map(scaleTemperature);

		expect(expectedPreTemperature).toEqual(PRE_TEMPERATURE);
		expect(transformed.map((result) => result.temperature)).toEqual([0.5, 0.5, 0.5, 0.5]);
		expect(transformed.map((result) => result.priorWeight)).toEqual([0.5, 0.5, 0.5, 0.5]);
		expect(transformed.map((result) => result.calibrated)).toEqual(expectedTransformed);
		calibrator.refit(TRAINING_SESSION);
		expect(recorder.getOutcomes(TRAINING_SESSION)).toEqual(samplesBefore);
		expect(calibrator.metrics(TRAINING_SESSION)).toEqual(metricsBefore);
		expect(calibrator.calibrate(0.8, 'hypothesis', TRAINING_SESSION).temperature).toBe(0.5);

		const rawMetrics = probabilityMetrics(
			HOLDOUT.map((sample) => ({ probability: sample.raw, actual: sample.actual }))
		);
		const calibratedMetrics = probabilityMetrics(
			HOLDOUT.map((sample) => ({
				probability: scaleTemperature(PRIOR_WEIGHT * sample.raw + 0.25),
				actual: sample.actual,
			}))
		);
		expect(rawMetrics).toEqual({
			nll: 0.9496735800302857,
			brier: 0.325,
			ece: 0.49999999999999994,
		});
		expect(calibratedMetrics).toEqual({
			nll: 0.8498395259825748,
			brier: 0.30443572742729563,
			ece: 0.49407510927278453,
		});
		return {
			holdout: {
				source: 'controlled_in_test',
				training_sample_count: samplesBefore.length,
				samples: HOLDOUT,
			},
			raw_probability_metrics: { status: 'reported', metrics: rawMetrics },
			calibrated_probability_metrics: {
				status: 'reported',
				transform_scope: 'fixed_holdout_only',
				temperature: TEMPERATURE,
				prior_weight: PRIOR_WEIGHT,
				pre_temperature: PRE_TEMPERATURE,
				probabilities: expectedTransformed,
				metrics: calibratedMetrics,
			},
		};
	} finally {
		await server.stop();
	}
}

async function structuralReport() {
	const server = await createServer({
		autoDiscover: false,
		loadFromPersistence: false,
		config: new ServerConfig({
			persistenceFlushInterval: 60_000,
			features: { reasoningStrategy: 'tot', compression: false, toolInterleave: false },
		}),
	});
	try {
		await server.processThought(
			processorInput({
				id: 'processor-hypothesis',
				thought_number: 1,
				thought_type: 'hypothesis',
				confidence: 0.4,
				quality_score: 0.4,
			})
		);
		const verification = await server.processThought(
			processorInput({
				id: 'processor-verification',
				thought_number: 2,
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 1,
			})
		);
		const verifiedPayload = v.parse(
			processorPayloadSchema,
			JSON.parse(verification.content[0]?.text ?? '{}')
		);
		await server.processThought(
			processorInput({
				id: 'processor-ambiguous-source-a',
				thought_number: 1,
				session_id: AMBIGUOUS_SESSION,
			})
		);
		await server.processThought(
			processorInput({
				id: 'processor-ambiguous-source-b',
				thought_number: 1,
				session_id: AMBIGUOUS_SESSION,
			})
		);
		const ambiguous = await server.processThought(
			processorInput({
				id: 'processor-ambiguous-verification',
				thought_number: 3,
				thought_type: 'verification',
				verification_target: 1,
				verification_result: 0,
				session_id: AMBIGUOUS_SESSION,
			})
		);
		const ambiguousPayload = v.parse(
			processorPayloadSchema,
			JSON.parse(ambiguous.content[0]?.text ?? '{}')
		);
		const duplicate = await server.processThought(
			processorInput({
				id: 'processor-verification',
				thought_number: 3,
			})
		);
		const duplicatePayload = v.parse(
			processorPayloadSchema,
			JSON.parse(duplicate.content[0]?.text ?? '{}')
		);
		const high = await server.processThought(
			processorInput({
				id: 'processor-high',
				thought_number: 3,
				confidence: 1,
				quality_score: 1,
			})
		);
		const highPayload = v.parse(processorPayloadSchema, JSON.parse(high.content[0]?.text ?? '{}'));
		const backtrack = await server.processThought(
			processorInput({
				id: 'processor-backtrack',
				thought_number: 4,
				thought_type: 'backtrack',
				backtrack_target: 3,
				confidence: 0.1,
				quality_score: 0.1,
			})
		);
		const backtrackPayload = v.parse(
			processorPayloadSchema,
			JSON.parse(backtrack.content[0]?.text ?? '{}')
		);
		const structural = {
			duplicate_rejected_without_mutation:
				duplicate.isError === true &&
				duplicatePayload.code === 'VALIDATION_ERROR' &&
				server.history.getHistory(PROCESSOR_SESSION).length === 4,
			ambiguous_target_rejected_without_mutation:
				ambiguous.isError === true && ambiguousPayload.code === 'VALIDATION_ERROR',
			canonical_verification:
				verifiedPayload.reasoning_stats?.hypothesis_count === 1 &&
				verifiedPayload.reasoning_stats.verified_hypothesis_count === 1 &&
				verifiedPayload.reasoning_stats.unresolved_hypothesis_count === 0,
			active_tot_retraction:
				highPayload.strategy_hint?.action === 'terminate' &&
				backtrackPayload.strategy_hint?.action === 'continue' &&
				server.history
					.getHistory(PROCESSOR_SESSION)
					.find((thought) => thought.id === 'processor-high')?.retracted === true,
		};
		expect(structural).toEqual({
			duplicate_rejected_without_mutation: true,
			ambiguous_target_rejected_without_mutation: true,
			canonical_verification: true,
			active_tot_retraction: true,
		});
		return { status: 'pass', processor_contract: structural };
	} finally {
		await server.stop();
	}
}

async function runPrecisionEval() {
	return {
		evaluation: 'precision-regression',
		structural_correctness: await structuralReport(),
		...(await calibrationReport()),
		natural_language_accuracy: {
			status: 'unmeasured',
			reason: 'no_external_inference_or_generated_language_judge',
		},
	};
}

describe.skipIf(!process.env.RUN_EVAL)('Precision Regression Eval', () => {
	it('repeats substantive production-path and controlled-holdout results exactly', async () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
		try {
			const first = await runPrecisionEval();
			const second = await runPrecisionEval();
			expect(second).toEqual(first);
			console.log(JSON.stringify(first));
		} finally {
			clock.mockRestore();
		}
	});
});
