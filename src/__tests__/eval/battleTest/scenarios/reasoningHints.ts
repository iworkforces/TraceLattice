import { asSessionId } from '../../../../contracts/ids.js';
import { createTestThought } from '../../../helpers/factories.js';
import {
	confidenceSignalContext,
	createDisabledThoughtEvaluator,
} from '../../../helpers/evaluator.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'reasoning-hints-and-confidence';
const REASONING_HINTS_SESSION = asSessionId('reasoning-hints-session');

export const REASONING_HINTS_SCENARIOS = [
	{
		caseId: 'reasoning-hints-confidence-drift',
		category,
		description: 'Pattern detector flags three strictly decreasing confidence values.',
		run: () => {
			const history = [0.9, 0.8, 0.7].map((confidence, index) =>
				createTestThought({
					session_id: REASONING_HINTS_SESSION,
					thought_number: index + 1,
					confidence,
				})
			);
			const signals = createDisabledThoughtEvaluator().computePatternSignals(history, {});
			return scoreChecks({
				caseId: 'reasoning-hints-confidence-drift',
				category,
				checks: {
					driftWarning: signals.some((signal) => signal.pattern === 'confidence_drift'),
					warningSeverity: signals.some(
						(signal) => signal.pattern === 'confidence_drift' && signal.severity === 'warning'
					),
					rangeCaptured: signals.some(
						(signal) => signal.thought_range[0] === 1 && signal.thought_range[1] === 3
					),
				},
			});
		},
	},
	{
		caseId: 'reasoning-hints-no-alternatives',
		category,
		description: 'Pattern detector flags five thoughts without critique or branches.',
		run: () => {
			const history = Array.from({ length: 5 }, (_, index) =>
				createTestThought({
					session_id: REASONING_HINTS_SESSION,
					thought_number: index + 1,
					thought_type: 'regular',
				})
			);
			const signals = createDisabledThoughtEvaluator().computePatternSignals(history, {});
			return scoreChecks({
				caseId: 'reasoning-hints-no-alternatives',
				category,
				checks: {
					alternativeWarning: signals.some(
						(signal) => signal.pattern === 'no_alternatives_explored'
					),
					messageActionable: signals.some((signal) => signal.message.includes('alternatives')),
					warningSeverity: signals.some(
						(signal) =>
							signal.pattern === 'no_alternatives_explored' && signal.severity === 'warning'
					),
				},
			});
		},
	},
	{
		caseId: 'reasoning-hints-structural-quality',
		category,
		description: 'SignalComputer emits stable confidence components for mixed thought types.',
		run: () => {
			const history = [
				createTestThought({
					session_id: REASONING_HINTS_SESSION,
					thought_number: 1,
					thought_type: 'hypothesis',
					hypothesis_id: 'rh1',
					confidence: 0.8,
				}),
				createTestThought({
					session_id: REASONING_HINTS_SESSION,
					thought_number: 2,
					thought_type: 'verification',
					hypothesis_id: 'rh1',
					confidence: 0.82,
				}),
				createTestThought({
					session_id: REASONING_HINTS_SESSION,
					thought_number: 3,
					thought_type: 'critique',
					confidence: 0.78,
				}),
			];
			const signals = createDisabledThoughtEvaluator().computeConfidenceSignals(
				history,
				{},
				confidenceSignalContext(history, REASONING_HINTS_SESSION)
			);
			return scoreChecks({
				caseId: 'reasoning-hints-structural-quality',
				category,
				checks: {
					hasHypothesis: signals.has_hypothesis,
					hasVerification: signals.has_verification,
					structuralQualityPresent: signals.structural_quality !== undefined,
					confidenceStabilityHigh: (signals.quality_components?.confidence_stability ?? 0) > 0.9,
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
