import type { ThoughtId } from '../../contracts/ids.js';
import type { ResolvedThoughtReferences } from '../IHistoryManager.js';
import type { ThoughtData } from '../thought.js';

export type ActiveThoughtBranches = Readonly<Record<string, readonly ThoughtData[]>>;

export interface VerificationLinks {
	readonly thoughts: readonly ThoughtData[];
	readonly hypotheses: readonly ThoughtData[];
	readonly hypothesisIds: ReadonlySet<ThoughtId>;
	readonly verifiedHypothesisIds: ReadonlySet<ThoughtId>;
	readonly verifiedHypothesisCount: number;
	targetFor(verifierId: ThoughtId): ThoughtId | undefined;
	isVerified(hypothesis: ThoughtData): boolean;
	verifies(verifier: ThoughtData, hypothesis: ThoughtData): boolean;
}

export function resolvedVerificationTarget(
	thought: ThoughtData,
	references: ResolvedThoughtReferences
): ThoughtId | undefined {
	return thought.thought_type === 'verification'
		? references.verificationTargetThoughtId
		: undefined;
}

export function resolveVerificationLinks(
	history: readonly ThoughtData[],
	branches: ActiveThoughtBranches,
	admissionTargets: ReadonlyMap<ThoughtId, ThoughtId> = new Map()
): VerificationLinks {
	const thoughts = collectActiveThoughts(history, branches);
	const hypotheses = thoughts.filter(
		(thought) => thought.thought_type === 'hypothesis' && Boolean(thought.id)
	);
	const hypothesesById = new Map<ThoughtId, ThoughtData>();
	for (const hypothesis of hypotheses) {
		const id = hypothesis.id;
		if (id && !hypothesesById.has(id)) hypothesesById.set(id, hypothesis);
	}
	const hypothesisIds = new Set(hypothesesById.keys());
	const targetsByVerifier = new Map<ThoughtData, ThoughtData>();
	const targetsByVerifierId = new Map<ThoughtId, ThoughtId>();
	const legacyTargets = uniqueLegacyTargets(hypotheses);

	for (const verifier of thoughts) {
		if (verifier.thought_type !== 'verification') continue;
		const targetId = verifier.id ? admissionTargets.get(verifier.id) : undefined;
		const target =
			verifier.verification_target !== undefined
				? targetId === undefined
					? undefined
					: hypothesesById.get(targetId)
				: !verifier.id || verifier.hypothesis_id === undefined
					? undefined
					: legacyTargets.get(verifier.hypothesis_id);
		if (target === undefined) continue;
		targetsByVerifier.set(verifier, target);
		if (verifier.id && target.id) {
			targetsByVerifierId.set(verifier.id, target.id);
		}
	}

	const verifiedHypotheses = new Set(targetsByVerifier.values());
	const verifiedHypothesisIds = new Set(
		[...verifiedHypotheses].flatMap((thought) => (thought.id ? [thought.id] : []))
	);
	return Object.freeze({
		thoughts: Object.freeze(thoughts),
		hypotheses: Object.freeze(hypotheses),
		hypothesisIds: new Set(hypothesisIds),
		verifiedHypothesisIds: new Set(verifiedHypothesisIds),
		verifiedHypothesisCount: verifiedHypotheses.size,
		targetFor: (verifierId: ThoughtId) => targetsByVerifierId.get(verifierId),
		isVerified: (hypothesis: ThoughtData) => verifiedHypotheses.has(hypothesis),
		verifies: (verifier: ThoughtData, hypothesis: ThoughtData) =>
			targetsByVerifier.get(verifier) === hypothesis,
	});
}

export function collectActiveMainThoughts(
	history: readonly ThoughtData[],
	branches: ActiveThoughtBranches
): ThoughtData[] {
	const { thoughts, mainCount } = collectActiveEvidence(history, branches);
	return thoughts.slice(0, mainCount);
}

export function collectActiveThoughts(
	history: readonly ThoughtData[],
	branches: ActiveThoughtBranches
): ThoughtData[] {
	return collectActiveEvidence(history, branches).thoughts;
}

/** Visit each retained record once; later retractions delete earlier copies without reordering. */
export function collectActiveEvidence(
	history: readonly ThoughtData[],
	branches: ActiveThoughtBranches
): { readonly thoughts: ThoughtData[]; readonly mainCount: number } {
	const retained = new Map<ThoughtId | symbol, { thought: ThoughtData; main: boolean }>();
	const retractedIds = new Set<ThoughtId>();
	const lists = [history, ...Object.values(branches)];
	for (const [index, list] of lists.entries()) {
		for (const thought of list) {
			const id = thought.id;
			if (thought.retracted === true) {
				if (id) {
					retractedIds.add(id);
					retained.delete(id);
				}
				continue;
			}
			if (!id) {
				if (index === 0) retained.set(Symbol(), { thought, main: true });
				continue;
			}
			if (retractedIds.has(id) || retained.has(id)) continue;
			retained.set(id, { thought, main: index === 0 });
		}
	}
	const thoughts: ThoughtData[] = [];
	let mainCount = 0;
	for (const entry of retained.values()) {
		thoughts.push(entry.thought);
		if (entry.main) mainCount++;
	}
	return { thoughts, mainCount };
}

function uniqueLegacyTargets(hypotheses: readonly ThoughtData[]): ReadonlyMap<string, ThoughtData> {
	const candidates = new Map<string, ThoughtData | undefined>();
	for (const hypothesis of hypotheses) {
		const label = hypothesis.hypothesis_id;
		if (label === undefined) continue;
		const existing = candidates.get(label);
		candidates.set(
			label,
			existing === undefined && !candidates.has(label) ? hypothesis : undefined
		);
	}
	return new Map(
		[...candidates].flatMap(([label, target]) =>
			target === undefined ? [] : ([[label, target]] as const)
		)
	);
}
