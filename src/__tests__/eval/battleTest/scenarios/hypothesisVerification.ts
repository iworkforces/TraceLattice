import { createTestThought } from '../../../helpers/factories.js';
import { createDisabledThoughtEvaluator } from '../../../helpers/evaluator.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'hypothesis-and-verification';

export const HYPOTHESIS_VERIFICATION_SCENARIOS = [
	{
		caseId: 'hypothesis-verified-stats',
		category,
		description: 'Evaluator counts a verified hypothesis as resolved in reasoning stats.',
		run: () => {
			const history = [
				createTestThought({ thought_number: 1, thought_type: 'hypothesis', hypothesis_id: 'h1' }),
				createTestThought({ thought_number: 2, thought_type: 'verification', hypothesis_id: 'h1' }),
			];
			const stats = createDisabledThoughtEvaluator().computeReasoningStats(history, {});
			return scoreChecks({
				caseId: 'hypothesis-verified-stats',
				category,
				checks: {
					hypothesisCount: stats.hypothesis_count === 1,
					verifiedCount: stats.verified_hypothesis_count === 1,
					unresolvedCount: stats.unresolved_hypothesis_count === 0,
				},
			});
		},
	},
	{
		caseId: 'hypothesis-healthy-pattern',
		category,
		description:
			'Pattern detector emits healthy_verification when verification follows within three thoughts.',
		run: () => {
			const history = [
				createTestThought({ thought_number: 1, thought_type: 'hypothesis', hypothesis_id: 'h2' }),
				createTestThought({ thought_number: 2, thought_type: 'regular' }),
				createTestThought({ thought_number: 3, thought_type: 'verification', hypothesis_id: 'h2' }),
			];
			const signals = createDisabledThoughtEvaluator().computePatternSignals(history, {});
			return scoreChecks({
				caseId: 'hypothesis-healthy-pattern',
				category,
				checks: {
					healthySignal: signals.some((signal) => signal.pattern === 'healthy_verification'),
					infoSeverity: signals.some(
						(signal) => signal.pattern === 'healthy_verification' && signal.severity === 'info'
					),
					thoughtRange: signals.some(
						(signal) => signal.pattern === 'healthy_verification' && signal.thought_range[1] === 3
					),
				},
			});
		},
	},
	{
		caseId: 'hypothesis-unverified-warning',
		category,
		description:
			'Pattern detector warns when a hypothesis has no verification within three thoughts.',
		run: () => {
			const history = [
				createTestThought({ thought_number: 1, thought_type: 'hypothesis', hypothesis_id: 'h3' }),
				createTestThought({ thought_number: 2, thought_type: 'regular' }),
				createTestThought({ thought_number: 3, thought_type: 'critique' }),
				createTestThought({ thought_number: 4, thought_type: 'synthesis' }),
			];
			const signals = createDisabledThoughtEvaluator().computePatternSignals(history, {});
			return scoreChecks({
				caseId: 'hypothesis-unverified-warning',
				category,
				checks: {
					warningSignal: signals.some((signal) => signal.pattern === 'unverified_hypothesis'),
					warningSeverity: signals.some(
						(signal) => signal.pattern === 'unverified_hypothesis' && signal.severity === 'warning'
					),
					messageNamesThought: signals.some((signal) => signal.message.includes('thought 1')),
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
