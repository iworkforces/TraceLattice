import { createStepRecommendation, createToolRecommendation } from '../../../helpers/factories.js';
import { scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'tool-recommendation-quality';

export const TOOL_RECOMMENDATION_SCENARIOS = [
	{
		caseId: 'tool-recommendation-specific-tool',
		category,
		description:
			'Input-contract fixture checks tool fields, confidence, rationale, and suggested inputs.',
		run: () => {
			const recommendation = createToolRecommendation({
				tool_name: 'codegraph_codegraph_explore',
				confidence: 0.93,
				rationale:
					'Fetch the relevant symbol bodies and dependency path in one deterministic call.',
				suggested_inputs: { query: 'ThoughtEvaluator PatternDetector', maxFiles: 4 },
			});
			return scoreChecks({
				caseId: 'tool-recommendation-specific-tool',
				category,
				checks: {
					specificName: recommendation.tool_name.includes('codegraph'),
					strongConfidence: recommendation.confidence >= 0.9,
					actionableRationale: recommendation.rationale.includes('symbol'),
					hasSuggestedInputs:
						recommendation.suggested_inputs?.query === 'ThoughtEvaluator PatternDetector',
				},
			});
		},
	},
	{
		caseId: 'tool-recommendation-step-current-tools',
		category,
		description:
			'Input-contract fixture preserves current-step tool ordering and expected outcome.',
		run: () => {
			const step = createStepRecommendation({
				step_description: 'Inspect evaluator patterns before adding tests.',
				recommended_tools: [
					createToolRecommendation({ tool_name: 'Read', confidence: 0.88, priority: 1 }),
					createToolRecommendation({ tool_name: 'Grep', confidence: 0.76, priority: 2 }),
				],
				expected_outcome: 'Relevant functions and callers are known.',
			});
			return scoreChecks({
				caseId: 'tool-recommendation-step-current-tools',
				category,
				checks: {
					twoTools: step.recommended_tools.length === 2,
					firstPriority: step.recommended_tools[0]?.priority === 1,
					outcomeSpecific: step.expected_outcome.includes('functions'),
				},
			});
		},
	},
	{
		caseId: 'tool-recommendation-alternative-paths',
		category,
		description: 'Input-contract fixture preserves alternatives and the primary tool.',
		run: () => {
			const recommendation = createToolRecommendation({
				tool_name: 'lsp_find_references',
				confidence: 0.84,
				rationale: 'Find all references to a symbol before a safe rename.',
				alternatives: ['codegraph_codegraph_explore', 'rg'],
			});
			return scoreChecks({
				caseId: 'tool-recommendation-alternative-paths',
				category,
				checks: {
					keepsPrimaryTool: recommendation.tool_name === 'lsp_find_references',
					hasAlternatives: recommendation.alternatives?.length === 2,
					rationaleExplainsWhy: recommendation.rationale.includes('references'),
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
