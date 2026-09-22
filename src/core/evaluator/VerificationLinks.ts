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
	const hypothesisIds = new Set(hypotheses.flatMap((thought) => (thought.id ? [thought.id] : [])));
	const activeThoughtIds = new Set(thoughts.flatMap((thought) => (thought.id ? [thought.id] : [])));
	const targetsByVerifier = new Map<ThoughtData, ThoughtData>();
	const targetsByVerifierId = new Map<ThoughtId, ThoughtId>();
	const legacyTargets = uniqueLegacyTargets(hypotheses);

	for (const verifier of thoughts) {
		if (verifier.thought_type !== 'verification') continue;
		const target = resolveTarget(
			verifier,
			hypotheses,
			admissionTargets,
			activeThoughtIds,
			legacyTargets
		);
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
	const branchThoughts = Object.values(branches).flat();
	const allThoughts = [...history, ...branchThoughts];
	const retractedIds = new Set(
		allThoughts.flatMap((thought) => (thought.retracted === true && thought.id ? [thought.id] : []))
	);
	const includedIds = new Set<ThoughtId>();
	const active: ThoughtData[] = [];
	for (const thought of history) {
		if (thought.retracted === true) continue;
		if (!thought.id) {
			active.push(thought);
			continue;
		}
		if (retractedIds.has(thought.id) || includedIds.has(thought.id)) continue;
		includedIds.add(thought.id);
		active.push(thought);
	}
	return active;
}

export function collectActiveThoughts(
	history: readonly ThoughtData[],
	branches: ActiveThoughtBranches
): ThoughtData[] {
	const branchThoughts = Object.values(branches).flat();
	const allThoughts = [...history, ...branchThoughts];
	const retractedIds = new Set(
		allThoughts.flatMap((thought) => (thought.retracted === true && thought.id ? [thought.id] : []))
	);
	const active = collectActiveMainThoughts(history, branches);
	const includedIds = new Set(active.flatMap((thought) => (thought.id ? [thought.id] : [])));
	for (const thought of branchThoughts) {
		if (!thought.id || thought.retracted === true) continue;
		if (retractedIds.has(thought.id) || includedIds.has(thought.id)) continue;
		includedIds.add(thought.id);
		active.push(thought);
	}
	return active;
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

function resolveTarget(
	verifier: ThoughtData,
	hypotheses: readonly ThoughtData[],
	admissionTargets: ReadonlyMap<ThoughtId, ThoughtId>,
	activeThoughtIds: ReadonlySet<ThoughtId>,
	legacyTargets: ReadonlyMap<string, ThoughtData>
): ThoughtData | undefined {
	if (verifier.verification_target !== undefined) {
		if (!verifier.id) return undefined;
		const targetId = admissionTargets.get(verifier.id);
		if (targetId === undefined || !activeThoughtIds.has(targetId)) return undefined;
		return hypotheses.find((hypothesis) => hypothesis.id === targetId);
	}
	return !verifier.id || verifier.hypothesis_id === undefined
		? undefined
		: legacyTargets.get(verifier.hypothesis_id);
}
