import type { SessionId, ThoughtId } from '../contracts/ids.js';
import { assertNever } from '../utils.js';
import type { RestoredBranch } from './PersistenceRestore.js';
import type { ThoughtData } from './thought.js';
import { ThoughtReferenceIndex } from './ThoughtReferenceIndex.js';

export function reconstructVerificationTargets(
	sessionId: SessionId,
	history: readonly ThoughtData[],
	branches: readonly RestoredBranch[]
): Map<ThoughtId, ThoughtId> {
	const references = new ThoughtReferenceIndex();
	const verificationTargets = new Map<ThoughtId, ThoughtId>();

	for (const thought of admissionOrder(history, branches)) {
		const verifierId = thought.id;
		if (verifierId === undefined) continue;
		const targetId = restoredVerificationTarget(thought, sessionId, references);
		if (targetId !== undefined) verificationTargets.set(verifierId, targetId);
		references.add(sessionId, thought);
	}

	return verificationTargets;
}

function admissionOrder(
	history: readonly ThoughtData[],
	branches: readonly RestoredBranch[]
): readonly ThoughtData[] {
	const thoughts: ThoughtData[] = [];
	const identities = new Set<ThoughtId>();
	for (const candidate of [...history, ...branches.flatMap((branch) => branch.thoughts)]) {
		if (!candidate.id || identities.has(candidate.id)) continue;
		identities.add(candidate.id);
		thoughts.push(candidate);
	}
	return thoughts;
}

function restoredVerificationTarget(
	thought: ThoughtData,
	sessionId: SessionId,
	references: ThoughtReferenceIndex
): ThoughtId | undefined {
	const thoughtType = thought.thought_type ?? 'regular';
	switch (thoughtType) {
		case 'verification': {
			if (thought.verification_target === undefined) return undefined;
			const resolution = references.resolve(sessionId, thought.verification_target);
			switch (resolution.kind) {
				case 'unique':
					return resolution.thoughtId;
				case 'missing':
				case 'ambiguous':
					return undefined;
				default:
					return assertNever(resolution);
			}
		}
		case 'regular':
		case 'hypothesis':
		case 'critique':
		case 'synthesis':
		case 'meta':
		case 'tool_call':
		case 'tool_observation':
		case 'assumption':
		case 'decomposition':
		case 'backtrack':
			return undefined;
		default:
			return assertNever(thoughtType);
	}
}
