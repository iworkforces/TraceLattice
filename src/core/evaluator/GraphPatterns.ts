import type { ThoughtId } from '../../contracts/ids.js';
import type { PatternSignal } from '../reasoning.js';
import type { ThoughtData } from '../thought.js';
import type { ActiveGraphContext } from './GraphSignalComputer.js';
import type { VerificationLinks } from './VerificationLinks.js';

/** Warn about active dependencies on the latest refuted hypothesis outcomes. */
export function detectRefutedHypothesisDependency(
	links: VerificationLinks,
	activeGraph?: ActiveGraphContext
): PatternSignal[] {
	if (activeGraph === undefined) return [];
	const { view, sessionId } = activeGraph;
	const thoughtsById = new Map(
		links.thoughts.flatMap((thought) => (thought.id ? [[thought.id, thought] as const] : []))
	);
	const latest = new Map<ThoughtId, ThoughtData>();
	for (const thought of links.thoughts) {
		if (
			thought.thought_type !== 'verification' ||
			thought.id === undefined ||
			thought.verification_result === undefined
		)
			continue;
		const target = links.targetFor(thought.id);
		if (target !== undefined) latest.set(target, thought);
	}
	const signals: PatternSignal[] = [];
	for (const [id, verifier] of latest) {
		if (verifier.verification_result !== 0) continue;
		const hypothesis = thoughtsById.get(id);
		if (hypothesis === undefined) continue;
		const dependents = view
			.descendants(sessionId, id, undefined, ['derives_from', 'merge', 'branch'])
			.filter((dep) => !view.inbound(sessionId, dep).some((r) => r.kind === 'revises'))
			.flatMap((dep) => {
				const thought = thoughtsById.get(dep);
				return thought === undefined ? [] : [thought.thought_number];
			});
		if (dependents.length === 0) continue;
		const numbers = [hypothesis.thought_number, ...dependents];
		signals.push({
			pattern: 'refuted_hypothesis_dependency',
			severity: 'warning',
			message: `Thought(s) ${dependents.join(', ')} build on hypothesis at thought ${hypothesis.thought_number}, which was refuted at thought ${verifier.thought_number} - revise or backtrack them`,
			thought_range: [Math.min(...numbers), Math.max(...numbers)],
		});
	}
	return signals;
}

/** Warn after three active thoughts when a critique target remains unaddressed. */
export function detectUnaddressedCritique(
	links: VerificationLinks,
	activeGraph?: ActiveGraphContext
): PatternSignal[] {
	if (activeGraph === undefined) return [];
	const { view, sessionId } = activeGraph;
	const positions = new Map(
		links.thoughts.flatMap((thought, index) => (thought.id ? [[thought.id, index] as const] : []))
	);
	const thoughtsById = new Map(
		links.thoughts.flatMap((thought) => (thought.id ? [[thought.id, thought] as const] : []))
	);
	const signals: PatternSignal[] = [];
	for (const [index, critique] of links.thoughts.entries()) {
		if (
			critique.thought_type !== 'critique' ||
			critique.id === undefined ||
			links.thoughts.length - index - 1 < 3
		)
			continue;
		for (const relation of view.outbound(sessionId, critique.id)) {
			if (relation.kind !== 'critiques') continue;
			const target = thoughtsById.get(relation.id);
			if (target === undefined) continue;
			const addressed = view
				.inbound(sessionId, relation.id)
				.some(
					(r) =>
						r.kind === 'revises' || (r.kind === 'verifies' && (positions.get(r.id) ?? -1) > index)
				);
			if (addressed) continue;
			const numbers = [critique.thought_number, target.thought_number];
			signals.push({
				pattern: 'unaddressed_critique',
				severity: 'warning',
				message: `Critique at thought ${critique.thought_number} of thought ${target.thought_number} has not been addressed by a revision or verification within 3 thoughts`,
				thought_range: [Math.min(...numbers), Math.max(...numbers)],
			});
		}
	}
	return signals;
}
