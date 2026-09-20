import type { SessionId } from '../../contracts/ids.js';
import { ThoughtEvaluator, type ConfidenceSignalContext } from '../../core/ThoughtEvaluator.js';
import { Calibrator } from '../../core/evaluator/Calibrator.js';
import { OutcomeRecorder } from '../../core/reasoning/OutcomeRecorder.js';
import type { ThoughtData } from '../../core/thought.js';

export function createDisabledThoughtEvaluator(): ThoughtEvaluator {
	return new ThoughtEvaluator(new Calibrator(new OutcomeRecorder({ enabled: false }), false));
}

export function confidenceSignalContext(
	history: readonly ThoughtData[],
	sessionId: SessionId
): ConfidenceSignalContext {
	const currentThought = history.at(-1);
	if (currentThought === undefined) {
		throw new TypeError('confidence signal context requires at least one thought');
	}
	return { currentThought, sessionId };
}
