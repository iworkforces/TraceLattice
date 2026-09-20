import { asSessionId } from '../../../../contracts/ids.js';
import { createTestThought } from '../../../helpers/factories.js';
import {
	confidenceSignalContext,
	createDisabledThoughtEvaluator,
} from '../../../helpers/evaluator.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'long-horizon-tasks';
const LONG_HORIZON_SESSION = asSessionId('long-horizon-session');

export const LONG_HORIZON_SCENARIOS = [
	{
		caseId: 'long-horizon-six-step-chain',
		category,
		description: 'Evaluator preserves depth and confidence aggregation across a six-step chain.',
		run: () => {
			const history = Array.from({ length: 6 }, (_, index) =>
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: index + 1,
					total_thoughts: 6,
					confidence: 0.8,
				})
			);
			const signals = createDisabledThoughtEvaluator().computeConfidenceSignals(
				history,
				{},
				confidenceSignalContext(history, LONG_HORIZON_SESSION)
			);
			return scoreChecks({
				caseId: 'long-horizon-six-step-chain',
				category,
				checks: {
					depthTracked: signals.reasoning_depth === 6,
					averageStable: signals.average_confidence === 0.8,
					detectedRegularCount: signals.thought_type_distribution.regular === 6,
				},
			});
		},
	},
	{
		caseId: 'long-horizon-branch-depth-efficiency',
		category,
		description: 'Branch count contributes to structural quality without losing chain statistics.',
		run: () => {
			const history = [
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 1,
					total_thoughts: 4,
					confidence: 0.6,
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 2,
					total_thoughts: 4,
					confidence: 0.7,
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 3,
					total_thoughts: 4,
					confidence: 0.8,
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 4,
					total_thoughts: 4,
					confidence: 0.9,
				}),
			];
			const branches = {
				branchA: [
					createTestThought({ thought_number: 5, total_thoughts: 5, branch_from_thought: 2 }),
				],
			};
			const signals = createDisabledThoughtEvaluator().computeConfidenceSignals(
				history,
				branches,
				confidenceSignalContext(history, LONG_HORIZON_SESSION)
			);
			return scoreChecks({
				caseId: 'long-horizon-branch-depth-efficiency',
				category,
				checks: {
					branchCountTracked: signals.branch_count === 1,
					depthEfficiencyPresent: signals.quality_components?.depth_efficiency === 1,
					confidenceStabilityPresent: signals.quality_components?.confidence_stability !== null,
				},
			});
		},
	},
	{
		caseId: 'long-horizon-revision-and-merge-stats',
		category,
		description: 'Reasoning stats retain revision and merge counts across an extended trace.',
		run: () => {
			const history = [
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 1,
					total_thoughts: 5,
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 2,
					total_thoughts: 5,
					is_revision: true,
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 3,
					total_thoughts: 5,
					merge_from_thoughts: [1, 2],
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 4,
					total_thoughts: 5,
					branch_from_thought: 2,
				}),
				createTestThought({
					session_id: LONG_HORIZON_SESSION,
					thought_number: 5,
					total_thoughts: 5,
				}),
			];
			const stats = createDisabledThoughtEvaluator().computeReasoningStats(history, {});
			return scoreChecks({
				caseId: 'long-horizon-revision-and-merge-stats',
				category,
				checks: {
					totalThoughts: stats.total_thoughts === 5,
					revisionCount: stats.total_revisions === 1,
					mergeCount: stats.total_merges === 1,
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
