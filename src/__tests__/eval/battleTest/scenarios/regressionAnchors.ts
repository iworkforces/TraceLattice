import { EdgeStore } from '../../../../core/graph/EdgeStore.js';
import { buildActiveEvidenceProjection } from '../../../../core/reasoning/ActiveEvidenceProjection.js';
import { TreeOfThoughtStrategy } from '../../../../core/reasoning/strategies/TreeOfThoughtStrategy.js';
import type { StrategyContext } from '../../../../contracts/strategy.js';
import { createTestSessionId, createTestThought } from '../../../helpers/factories.js';
import { createDisabledThoughtEvaluator } from '../../../helpers/evaluator.js';
import { battleEdge, scoreChecks } from './helpers.js';
import type { BattleScenario } from './types.js';

const category = 'regression-anchors-and-calibration';

type ContextInput = {
	readonly history: ReturnType<typeof createTestThought>[];
	readonly edgeStore: EdgeStore | undefined;
};

function createContext(input: ContextInput): StrategyContext {
	const sessionId = createTestSessionId('tot-anchor');
	const evaluator = createDisabledThoughtEvaluator();
	const currentThought = input.history[input.history.length - 1];
	if (currentThought === undefined) {
		throw new Error('strategy context requires at least one thought');
	}
	return {
		sessionId,
		evidence: buildActiveEvidenceProjection({
			sessionId,
			history: input.history,
			branches: {},
			edgeStore: input.edgeStore,
		}),
		stats: evaluator.computeReasoningStats(input.history, {}),
		currentThought,
	};
}

export const REGRESSION_ANCHOR_SCENARIOS = [
	{
		caseId: 'regression-anchor-tot-no-graph-continues',
		category,
		description: 'TreeOfThoughtStrategy continues when no graph snapshot is available.',
		run: () => {
			const context = createContext({
				history: [createTestThought({ id: 'root', thought_number: 1 })],
				edgeStore: undefined,
			});
			const decision = new TreeOfThoughtStrategy().decide(context);
			return scoreChecks({
				caseId: 'regression-anchor-tot-no-graph-continues',
				category,
				checks: {
					continues: decision.action === 'continue',
				},
			});
		},
	},
	{
		caseId: 'regression-anchor-tot-confidence-terminates',
		category,
		description:
			'TreeOfThoughtStrategy terminates when the best frontier crosses confidence threshold.',
		run: () => {
			const sessionId = createTestSessionId('tot-anchor');
			const store = new EdgeStore();
			store.addEdge(
				battleEdge({
					id: 'e-tot-root-leaf',
					from: 'root',
					to: 'leaf',
					kind: 'sequence',
					sessionId,
					createdAt: 1,
				})
			);
			const history = [
				createTestThought({ id: 'root', thought_number: 1, confidence: 0.5, quality_score: 0.5 }),
				createTestThought({ id: 'leaf', thought_number: 2, confidence: 1, quality_score: 1 }),
			];
			const context = createContext({ history, edgeStore: store });
			const decision = new TreeOfThoughtStrategy().decide(context);
			return scoreChecks({
				caseId: 'regression-anchor-tot-confidence-terminates',
				category,
				checks: {
					terminates: decision.action === 'terminate',
					reason: decision.action === 'terminate' && decision.reason === 'confidence threshold',
				},
			});
		},
	},
	{
		caseId: 'regression-anchor-tot-outside-beam-branches',
		category,
		description:
			'TreeOfThoughtStrategy branches when current frontier thought falls outside the beam.',
		run: () => {
			const sessionId = createTestSessionId('tot-anchor');
			const store = new EdgeStore();
			store.addEdge(
				battleEdge({
					id: 'e-tot-a',
					from: 'root',
					to: 'a',
					kind: 'branch',
					sessionId,
					createdAt: 1,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-tot-b',
					from: 'root',
					to: 'b',
					kind: 'branch',
					sessionId,
					createdAt: 2,
				})
			);
			store.addEdge(
				battleEdge({
					id: 'e-tot-c',
					from: 'root',
					to: 'c',
					kind: 'branch',
					sessionId,
					createdAt: 3,
				})
			);
			const history = [
				createTestThought({ id: 'root', thought_number: 1, confidence: 0.4, quality_score: 0.5 }),
				createTestThought({ id: 'a', thought_number: 2, confidence: 0.9, quality_score: 0.9 }),
				createTestThought({ id: 'b', thought_number: 3, confidence: 0.8, quality_score: 0.8 }),
				createTestThought({ id: 'c', thought_number: 4, confidence: 0.2, quality_score: 0.5 }),
			];
			const context = createContext({ history, edgeStore: store });
			const decision = new TreeOfThoughtStrategy({
				beamWidth: 2,
				terminationConfidence: 1.1,
			}).decide(context);
			return scoreChecks({
				caseId: 'regression-anchor-tot-outside-beam-branches',
				category,
				checks: {
					branches: decision.action === 'branch',
					branchId: decision.action === 'branch' && decision.branchId === 'tot-4',
					fromThought: decision.action === 'branch' && decision.fromThought === 4,
				},
			});
		},
	},
] as const satisfies readonly BattleScenario[];
