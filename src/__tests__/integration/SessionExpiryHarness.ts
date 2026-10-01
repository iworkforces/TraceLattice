import { expect, vi } from 'vitest';
import { runWithContext } from '../../context/RequestContext.js';
import { asSessionId } from '../../contracts/ids.js';
import { HistoryManager, type HistoryManagerConfig } from '../../core/HistoryManager.js';
import { SessionLifecycleCoordinator } from '../../core/SessionLifecycleCoordinator.js';
import { ThoughtProcessor, type CallToolResult } from '../../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ThoughtEvaluator } from '../../core/ThoughtEvaluator.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import { SequentialStrategy } from '../../core/reasoning/strategies/SequentialStrategy.js';
import { createTestThought } from '../helpers/factories.js';

export const expiredId = asSessionId('expired');

export function owned<T>(owner: string, action: () => T): T {
	return runWithContext({ requestId: `request-${owner}`, owner }, action);
}

export function expiryHarness(config: HistoryManagerConfig = {}) {
	const lifecycle = new SessionLifecycleCoordinator();
	const history = new HistoryManager({ ...config, lifecycleCoordinator: lifecycle });
	const recorder = new OutcomeRecorder({ enabled: true });
	const calibrator = new Calibrator(recorder, true);
	const processor = new ThoughtProcessor(
		history,
		new ThoughtFormatter(),
		new ThoughtEvaluator(calibrator),
		undefined,
		new SequentialStrategy(),
		undefined,
		undefined,
		undefined,
		{
			dagEdges: true,
			reasoningStrategy: 'sequential',
			calibration: true,
			compression: false,
			toolInterleave: false,
			newThoughtTypes: true,
			outcomeRecording: true,
		},
		undefined,
		recorder,
		lifecycle,
		calibrator
	);
	return { history, processor, lifecycle };
}

export function seed(history: HistoryManager, sessionId = expiredId): void {
	history.addThought(
		createTestThought({
			session_id: sessionId,
			id: `target-${sessionId}`,
			thought_number: 3,
			total_thoughts: 20,
			next_thought_needed: true,
			confidence: 0.8,
		})
	);
}

export async function expire(history: HistoryManager): Promise<void> {
	await history.drainSession(expiredId);
	await vi.advanceTimersByTimeAsync(35 * 60_000 + 1);
	expect(history.getSessionIds()).not.toContain(expiredId);
}

export function responseBody(result: CallToolResult): unknown {
	expect(result.content).toHaveLength(1);
	for (const content of result.content) return JSON.parse(content.text);
	throw new Error('Missing tool response');
}
