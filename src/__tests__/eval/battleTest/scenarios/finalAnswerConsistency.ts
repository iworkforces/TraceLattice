import { fixedScore } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'final-answer-consistency';

type TraceAnswerInput = {
	readonly caseId: string;
	readonly traceFacts: readonly string[];
	readonly finalAnswer: string;
};

function scoreSyntheticFixtureConsistency(
	input: TraceAnswerInput
): ReturnType<BattleScenario['run']> {
	const matchedFacts = input.traceFacts.filter((fact) => input.finalAnswer.includes(fact));
	const hasContradiction = input.finalAnswer.includes('contradiction');
	const dimensions = {
		factsRepresented: Math.round((matchedFacts.length / input.traceFacts.length) * 100),
		noContradictionMarker: hasContradiction ? 0 : 100,
	};
	const score = Math.round((dimensions.factsRepresented + dimensions.noContradictionMarker) / 2);
	return fixedScore({
		caseId: input.caseId,
		category,
		score,
		dimensions,
		...(hasContradiction ? { criticalFailure: 'final-answer-contradicts-trace' } : {}),
	});
}

export const FINAL_ANSWER_CONSISTENCY_SCENARIOS = [
	{
		caseId: 'final-answer-hypothesis-trace',
		category,
		description: 'Synthetic fixture output contains the expected hypothesis trace tokens.',
		run: () =>
			scoreSyntheticFixtureConsistency({
				caseId: 'final-answer-hypothesis-trace',
				traceFacts: ['hypothesis h1', 'verified at thought 3'],
				finalAnswer: 'The trace records hypothesis h1 and says it was verified at thought 3.',
			}),
	},
	{
		caseId: 'final-answer-tool-trace',
		category,
		description: 'Synthetic fixture output contains the expected tool trace tokens.',
		run: () =>
			scoreSyntheticFixtureConsistency({
				caseId: 'final-answer-tool-trace',
				traceFacts: ['Read', 'schema.ts'],
				finalAnswer:
					'The trace selected Read for schema.ts and used that evidence in the conclusion.',
			}),
	},
	{
		caseId: 'final-answer-scope-trace',
		category,
		description: 'Synthetic fixture output is checked for expected scope trace tokens.',
		run: () =>
			scoreSyntheticFixtureConsistency({
				caseId: 'final-answer-scope-trace',
				traceFacts: ['no runtime files', 'test-only catalog'],
				finalAnswer: 'The result is a test-only catalog.',
			}),
	},
] as const satisfies readonly BattleScenario[];
