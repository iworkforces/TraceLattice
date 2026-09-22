import * as v from 'valibot';
import {
	asBranchId,
	asEdgeId,
	asSessionId,
	asSuspensionToken,
	asThoughtId,
} from '../contracts/ids.js';
import type { Summary } from '../core/compression/Summary.js';
import { SummarySchema } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { ThoughtData } from '../core/thought.js';
import type { StepRecommendation } from '../core/step.js';
import { EdgeSchema, SequentialThinkingSchema } from '../schema.js';
import { PersistenceCompatibilityError } from '../errors.js';
import { parsePersistenceBranchId } from './PersistenceScope.js';

type PersistedToolRecommendation = {
	readonly tool_name: string;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly priority?: number;
	readonly suggested_inputs?: Record<string, string | number | boolean | null>;
	readonly alternatives?: string[];
};

type PersistedSkillRecommendation = {
	readonly skill_name: string;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly priority?: number;
	readonly alternatives?: string[];
	readonly allowed_tools?: string[];
	readonly user_invocable?: boolean;
};

type PersistedStepRecommendation = {
	readonly step_description?: string;
	readonly recommended_tools: readonly PersistedToolRecommendation[];
	readonly recommended_skills?: readonly PersistedSkillRecommendation[];
	readonly expected_outcome?: string;
	readonly next_step_conditions?: string[];
};

function parseToolRecommendation(recommendation: PersistedToolRecommendation, sourcePath: string) {
	if (
		recommendation.confidence === undefined ||
		recommendation.rationale === undefined ||
		recommendation.priority === undefined
	) {
		throw new PersistenceCompatibilityError(sourcePath, 'tool recommendation defaults are absent');
	}
	return {
		...recommendation,
		confidence: recommendation.confidence,
		rationale: recommendation.rationale,
		priority: recommendation.priority,
	};
}

function parseSkillRecommendation(
	recommendation: PersistedSkillRecommendation,
	sourcePath: string
) {
	if (
		recommendation.confidence === undefined ||
		recommendation.rationale === undefined ||
		recommendation.priority === undefined
	) {
		throw new PersistenceCompatibilityError(sourcePath, 'skill recommendation defaults are absent');
	}
	return {
		...recommendation,
		confidence: recommendation.confidence,
		rationale: recommendation.rationale,
		priority: recommendation.priority,
	};
}

function parseStepRecommendation(
	step: PersistedStepRecommendation,
	sourcePath: string
): StepRecommendation {
	if (step.step_description === undefined || step.expected_outcome === undefined) {
		throw new PersistenceCompatibilityError(sourcePath, 'step recommendation defaults are absent');
	}
	const { recommended_tools, recommended_skills, ...fields } = step;
	return {
		...fields,
		step_description: step.step_description,
		expected_outcome: step.expected_outcome,
		recommended_tools: recommended_tools.map((tool) => parseToolRecommendation(tool, sourcePath)),
		...(recommended_skills === undefined
			? {}
			: {
					recommended_skills: recommended_skills.map((skill) =>
						parseSkillRecommendation(skill, sourcePath)
					),
				}),
	};
}

export function parseThoughtData(raw: unknown, sourcePath: string): ThoughtData {
	const retracted =
		typeof raw === 'object' && raw !== null && 'retracted' in raw
			? Reflect.get(raw, 'retracted')
			: undefined;
	if (retracted !== undefined && typeof retracted !== 'boolean') {
		throw new PersistenceCompatibilityError(sourcePath, 'thought retracted flag is not boolean');
	}
	const parsed = v.parse(SequentialThinkingSchema, raw);
	const {
		id,
		session_id,
		branch_id,
		merge_branch_ids,
		continuation_token,
		current_step,
		previous_steps,
		...thought
	} = parsed;
	return {
		...thought,
		...(id === undefined ? {} : { id: asThoughtId(id) }),
		session_id: asSessionId(session_id),
		...(branch_id === undefined
			? {}
			: { branch_id: parsePersistenceBranchId(branch_id, sourcePath) }),
		...(merge_branch_ids === undefined
			? {}
			: { merge_branch_ids: merge_branch_ids.map(asBranchId) }),
		...(continuation_token === undefined
			? {}
			: { continuation_token: asSuspensionToken(continuation_token) }),
		...(current_step === undefined
			? {}
			: { current_step: parseStepRecommendation(current_step, sourcePath) }),
		...(previous_steps === undefined
			? {}
			: {
					previous_steps: previous_steps.map((step) => parseStepRecommendation(step, sourcePath)),
				}),
		...(retracted === undefined ? {} : { retracted }),
	};
}

export function parseEdge(raw: unknown): Edge {
	const parsed = v.parse(EdgeSchema, raw);
	return {
		...parsed,
		id: asEdgeId(parsed.id),
		from: asThoughtId(parsed.from),
		to: asThoughtId(parsed.to),
		sessionId: asSessionId(parsed.sessionId),
	};
}

export function parseSummary(raw: unknown, sourcePath: string): Summary {
	const parsed = v.parse(SummarySchema, raw);
	const { branchId, sessionId, rootThoughtId, coveredIds, coveredRange, ...summary } = parsed;
	const [rangeStart, rangeEnd] = coveredRange;
	if (rangeStart === undefined || rangeEnd === undefined) {
		throw new PersistenceCompatibilityError(
			sourcePath,
			'summary coveredRange must contain two values'
		);
	}
	return {
		...summary,
		sessionId: asSessionId(sessionId),
		...(branchId === undefined ? {} : { branchId: parsePersistenceBranchId(branchId, sourcePath) }),
		rootThoughtId: asThoughtId(rootThoughtId),
		coveredIds: coveredIds.map(asThoughtId),
		coveredRange: [rangeStart, rangeEnd],
	};
}
