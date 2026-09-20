import { describe, it, expect } from 'vitest';
import { ThoughtProcessor } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import type { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { HistoryManager } from '../../core/HistoryManager.js';
import { InMemorySuspensionStore } from '../../core/tools/InMemorySuspensionStore.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import type { FeatureFlags } from '../../contracts/features.js';
import { asBranchId, asSessionId, type SessionId } from '../../contracts/ids.js';
import { createMockToolRegistry } from '../helpers/factories.js';
import { confidenceSignalContext, createDisabledThoughtEvaluator } from '../helpers/evaluator.js';

const RETRACTION_SESSION = asSessionId('retraction-session');

function makeFeatures(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
	return {
		dagEdges: false,
		reasoningStrategy: 'sequential',
		calibration: false,
		compression: false,
		toolInterleave: false,
		newThoughtTypes: false,
		outcomeRecording: false,
		...overrides,
	};
}

function makeProcessor(features: FeatureFlags): {
	proc: ThoughtProcessor;
	history: HistoryManager;
	evaluator: ThoughtEvaluator;
} {
	const history = new HistoryManager();
	const evaluator = createDisabledThoughtEvaluator();
	const proc = new ThoughtProcessor(
		history,
		new ThoughtFormatter(),
		evaluator,
		undefined,
		new SequentialStrategy(),
		undefined,
		new InMemorySuspensionStore(),
		createMockToolRegistry(['search', 'fetch', 'test-tool']),
		features
	);
	return { proc, history, evaluator };
}

async function seed(
	proc: ThoughtProcessor,
	count: number,
	sessionId: SessionId = RETRACTION_SESSION
): Promise<void> {
	for (let i = 1; i <= count; i++) {
		await proc.process({
			thought: `thought ${i}`,
			thought_number: i,
			total_thoughts: count + 5,
			next_thought_needed: true,
			session_id: sessionId,
		});
	}
}

describe('Logical retraction via backtrack', () => {
	it('marks the target thought as retracted in main history', async () => {
		const { proc, history } = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		await seed(proc, 3);

		const result = await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'undoing #2',
			thought_number: 4,
			total_thoughts: 8,
			next_thought_needed: true,
			thought_type: 'backtrack',
			backtrack_target: 2,
		});
		expect(result.isError).toBeFalsy();

		const all = history.getHistory(RETRACTION_SESSION);
		const target = all.find((t) => t.thought_number === 2);
		expect(target).toBeDefined();
		expect(target!.retracted).toBe(true);
		// Target remains in history (append-only / event-sourcing)
		expect(all).toHaveLength(4);
	});

	it('excludes retracted thoughts from confidence signals', async () => {
		const { proc, history, evaluator } = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'h1',
			thought_number: 1,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'hypothesis',
			confidence: 0.9,
		});
		await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'h2',
			thought_number: 2,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'hypothesis',
			confidence: 0.4,
		});
		await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'retract h2',
			thought_number: 3,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'backtrack',
			backtrack_target: 2,
		});

		const currentHistory = history.getHistory(RETRACTION_SESSION);
		const signals = evaluator.computeConfidenceSignals(
			currentHistory,
			history.getBranches(RETRACTION_SESSION),
			confidenceSignalContext(currentHistory, RETRACTION_SESSION)
		);
		// thought_type_distribution should not count the retracted hypothesis
		const dist = signals.thought_type_distribution as Record<string, number>;
		expect(dist.hypothesis).toBe(1);
	});

	it('throws InvalidBacktrackError when backtrack_target does not exist', async () => {
		const { proc } = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		await seed(proc, 2);

		const result = await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'invalid',
			thought_number: 5,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'backtrack',
			backtrack_target: 4,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/backtrack_target 4 does not exist/);
	});

	it('throws ValidationError when backtrack_target is missing', async () => {
		const { proc } = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		await seed(proc, 2);

		const result = await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'no target',
			thought_number: 3,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'backtrack',
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/requires backtrack_target/);
	});

	it('marks branch thoughts as retracted', async () => {
		const { proc, history } = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		await seed(proc, 1);
		// Add a branch thought (#2 on branch "alt")
		await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'branch step',
			thought_number: 2,
			total_thoughts: 5,
			next_thought_needed: true,
			branch_from_thought: 1,
			branch_id: asBranchId('alt'),
		});
		await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'retract branch',
			thought_number: 3,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'backtrack',
			backtrack_target: 2,
		});

		const branches = history.getBranches(RETRACTION_SESSION);
		expect(branches[asBranchId('alt')]).toBeDefined();
		const branchThought = branches[asBranchId('alt')]!.find((t) => t.thought_number === 2);
		expect(branchThought).toBeDefined();
		expect(branchThought!.retracted).toBe(true);
		// Also retracted in main history
		const mainCopy = history.getHistory(RETRACTION_SESSION).find((t) => t.thought_number === 2);
		expect(mainCopy!.retracted).toBe(true);
	});

	it('rejects backtrack when newThoughtTypes flag is OFF', async () => {
		const { proc } = makeProcessor(makeFeatures({ newThoughtTypes: false }));
		await seed(proc, 2);

		const result = await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'attempt retract',
			thought_number: 3,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'backtrack',
			backtrack_target: 1,
		});
		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0]!.text);
		expect(payload.error).toMatch(/newThoughtTypes feature flag/);
	});

	it('does not physically delete the target (append-only)', async () => {
		const { proc, history } = makeProcessor(makeFeatures({ newThoughtTypes: true }));
		await seed(proc, 3);
		await proc.process({
			session_id: RETRACTION_SESSION,
			thought: 'retract #2',
			thought_number: 4,
			total_thoughts: 5,
			next_thought_needed: true,
			thought_type: 'backtrack',
			backtrack_target: 2,
		});
		const all = history.getHistory(RETRACTION_SESSION);
		expect(all.map((t) => t.thought_number)).toEqual([1, 2, 3, 4]);
		expect(all.find((t) => t.thought_number === 2)?.thought).toBe('thought 2');
	});
});
