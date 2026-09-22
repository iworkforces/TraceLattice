import type { SessionId } from '../contracts/ids.js';
import type { IOutcomeRecorder, VerificationOutcome } from '../contracts/interfaces.js';
import { ValidationError } from '../errors.js';
import type { HistorySessionSnapshot, ResolvedThoughtReferences } from './IHistoryManager.js';
import type { ThoughtData } from './thought.js';

interface VerificationOutcomeAdmissionContext {
	readonly input: ThoughtData;
	readonly snapshot: HistorySessionSnapshot;
	readonly resolvedReferences: ResolvedThoughtReferences;
	readonly sessionId: SessionId;
	readonly recorder?: IOutcomeRecorder;
}

/**
 * Builds one immutable calibration sample from the canonical retained pre-admission target.
 *
 * An explicit stable target resolved during admission is authoritative. Missing, ambiguous,
 * id-less, or retracted targets fail closed before recorder side effects. Legacy label fallback
 * is allowed only when it resolves one identity-bearing target. Outcome-key duplicate admission
 * is separate from duplicate thought-ID admission.
 */
export function prepareVerificationOutcome(
	context: VerificationOutcomeAdmissionContext
): Omit<VerificationOutcome, 'recordedAt'> | undefined {
	const { input, resolvedReferences, sessionId, snapshot, recorder } = context;
	if (input.thought_type !== 'verification' || input.verification_result === undefined) {
		return undefined;
	}
	const thoughtId = resolvedReferences.verificationTargetThoughtId;
	if (thoughtId === undefined) {
		throw new ValidationError('verification_result', 'requires a retained verification_target');
	}
	const target = findTarget(snapshot, thoughtId);
	if (target === undefined) {
		throw new ValidationError('verification_result', 'verification_target is no longer retained');
	}
	if (target.retracted === true) {
		throw new ValidationError('verification_result', 'verification_target must not be retracted');
	}
	if (target.confidence === undefined) {
		throw new ValidationError('verification_result', 'verification_target must have confidence');
	}
	recorder?.assertCanRecord(sessionId, thoughtId);
	return Object.freeze({
		thoughtId,
		sessionId,
		predicted: target.confidence,
		actual: input.verification_result,
		type: target.thought_type ?? 'regular',
	});
}

function findTarget(
	snapshot: HistorySessionSnapshot,
	thoughtId: VerificationOutcome['thoughtId']
): ThoughtData | undefined {
	for (const thought of snapshot.history) {
		if (thought.id === thoughtId) return thought;
	}
	for (const branch of Object.values(snapshot.branches)) {
		for (const thought of branch) {
			if (thought.id === thoughtId) return thought;
		}
	}
	return undefined;
}
