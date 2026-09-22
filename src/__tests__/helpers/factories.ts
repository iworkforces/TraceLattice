import type { ThoughtData } from '../../core/thought.js';
import type { IToolRegistry } from '../../contracts/interfaces.js';
import {
	asSessionId,
	asThoughtId,
	asEdgeId,
	asSuspensionToken,
	type SessionId,
	type ThoughtId,
	type EdgeId,
	type SuspensionToken,
} from '../../contracts/ids.js';
import { asBranchId, type BranchId } from '../../contracts/ids.js';
import type { ToolRecommendation } from '../../types/tool.js';
import type { SkillRecommendation } from '../../types/skill.js';
import type { StepRecommendation } from '../../core/step.js';
import type {
	HistorySessionSnapshot,
	IHistoryManager,
	ThoughtAdmissionContext,
} from '../../core/IHistoryManager.js';
import { ThoughtReferenceIndex } from '../../core/ThoughtReferenceIndex.js';
import { resolvedVerificationTarget } from '../../core/evaluator/VerificationLinks.js';
import type { ThoughtFormatter } from '../../core/ThoughtFormatter.js';
import { ValidationError } from '../../errors.js';

// === Branded ID Helpers ===

export function createTestSessionId(value = 'test-session'): SessionId {
	return asSessionId(value);
}

export function createTestThoughtId(value = 'test-thought'): ThoughtId {
	return asThoughtId(value);
}

export function createTestEdgeId(value = 'test-edge'): EdgeId {
	return asEdgeId(value);
}

export function createTestSuspensionToken(value = 'test-token'): SuspensionToken {
	return asSuspensionToken(value);
}

// === Data Factories ===

// Loose overrides type allows tests to pass plain strings for branded ID fields.
// They are branded internally before being merged.
type ThoughtOverrides = Partial<Omit<ThoughtData, 'id' | 'session_id' | 'continuation_token'>> & {
	id?: string;
	session_id?: string;
	continuation_token?: string;
};

export function createTestThought(overrides?: ThoughtOverrides): ThoughtData {
	const { id, session_id = 'test-session', continuation_token, ...rest } = overrides ?? {};
	return {
		available_mcp_tools: ['test-tool'],
		available_skills: ['test-skill'],
		thought: 'Test thought',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
		session_id: asSessionId(session_id),
		...(id !== undefined ? { id: asThoughtId(id) } : {}),
		...(continuation_token !== undefined
			? { continuation_token: asSuspensionToken(continuation_token) }
			: {}),
		...rest,
	};
}

export function createToolRecommendation(
	overrides?: Partial<ToolRecommendation>
): ToolRecommendation {
	return {
		tool_name: 'test-tool',
		confidence: 0.8,
		rationale: 'Test rationale',
		priority: 1,
		...overrides,
	};
}

export function createSkillRecommendation(
	overrides?: Partial<SkillRecommendation>
): SkillRecommendation {
	return {
		skill_name: 'test-skill',
		confidence: 0.7,
		rationale: 'Test skill rationale',
		priority: 1,
		...overrides,
	};
}

export function createStepRecommendation(
	overrides?: Partial<StepRecommendation>
): StepRecommendation {
	return {
		step_description: 'Test step description',
		recommended_tools: [createToolRecommendation()],
		expected_outcome: 'Test expected outcome',
		...overrides,
	};
}

export function createHypothesisThought(overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		thought: 'Hypothesis: This might be the solution',
		thought_type: 'hypothesis',
		quality_score: 0.7,
		confidence: 0.6,
		hypothesis_id: 'hyp-1',
		reasoning_depth: 'moderate',
		...overrides,
	});
}

export function createVerificationThought(overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		thought: 'Verification: Testing the hypothesis',
		thought_type: 'verification',
		quality_score: 0.8,
		confidence: 0.9,
		hypothesis_id: 'hyp-1',
		verification_target: 1,
		...overrides,
	});
}

export function createCritiqueThought(overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		thought: 'Critique: This reasoning has issues',
		thought_type: 'critique',
		quality_score: 0.5,
		confidence: 0.7,
		verification_target: 2,
		meta_observation: 'Previous reasoning overlooked edge cases',
		...overrides,
	});
}

export function createSynthesisThought(overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		thought: 'Synthesis: Combining insights from multiple branches',
		thought_type: 'synthesis',
		quality_score: 0.85,
		confidence: 0.8,
		synthesis_sources: [1, 2, 3],
		merge_from_thoughts: [1, 3],
		merge_branch_ids: [asBranchId('branch-a')],
		...overrides,
	});
}

export function createMetaThought(overrides?: Partial<ThoughtData>): ThoughtData {
	return createTestThought({
		thought: 'Meta: Observing the reasoning process itself',
		thought_type: 'meta',
		meta_observation: 'Current reasoning path is converging well',
		reasoning_depth: 'shallow',
		...overrides,
	});
}

// === Mock Classes ===

/**
 * Mock implementation of IHistoryManager for testing.
 * Tracks calls and stores data in-memory.
 */
export class MockHistoryManager implements IHistoryManager {
	private _sessions = new Map<
		string,
		{
			history: ThoughtData[];
			branches: Record<string, ThoughtData[]>;
			mcpTools: string[] | undefined;
			skills: string[] | undefined;
			verificationTargets: Map<ThoughtId, ThoughtId>;
		}
	>();
	private _resetCallCount = 0;
	private readonly _referenceIndex = new ThoughtReferenceIndex();

	private _getSession(sessionId: string) {
		if (!this._sessions.has(sessionId)) {
			this._sessions.set(sessionId, {
				history: [],
				branches: {},
				mcpTools: undefined,
				skills: undefined,
				verificationTargets: new Map(),
			});
		}
		return this._sessions.get(sessionId)!;
	}

	addThought(thought: ThoughtData, context?: ThoughtAdmissionContext): void {
		const s = this._getSession(thought.session_id);
		s.history.push(thought);
		this._referenceIndex.add(thought.session_id, thought);
		const targetId =
			context?.resolvedReferences === undefined
				? undefined
				: resolvedVerificationTarget(thought, context.resolvedReferences);
		if (thought.id !== undefined && targetId !== undefined)
			s.verificationTargets.set(thought.id, targetId);
		if (thought.available_mcp_tools) s.mcpTools = thought.available_mcp_tools;
		if (thought.available_skills) s.skills = thought.available_skills;
	}

	assertThoughtIdentityAvailable(thought: ThoughtData): void {
		if (thought.id !== undefined && this._referenceIndex.has(thought.session_id, thought.id)) {
			throw new ValidationError('id', `Thought id already exists in session: ${thought.id}`);
		}
	}

	resolveThoughtReference(sessionId: SessionId, thoughtNumber: number) {
		return this._referenceIndex.resolve(sessionId, thoughtNumber);
	}

	getHistory(sessionId: string): ThoughtData[] {
		return this._getSession(sessionId).history;
	}

	getHistoryLength(sessionId: string): number {
		return this._getSession(sessionId).history.length;
	}

	getBranches(sessionId: string): Record<BranchId, ThoughtData[]> {
		return this._getSession(sessionId).branches as Record<BranchId, ThoughtData[]>;
	}

	getBranchIds(sessionId: string): BranchId[] {
		return Object.keys(this._getSession(sessionId).branches) as BranchId[];
	}

	registerBranch(_sessionId: string, _branchId: BranchId): void {
		const session = this._getSession(_sessionId);
		if (!session.branches[_branchId]) session.branches[_branchId] = [];
	}

	branchExists(sessionId: string, branchId: BranchId): boolean {
		return branchId in this._getSession(sessionId).branches;
	}

	async resetSession(sessionId: string, clearAuxiliaryState?: () => void): Promise<void> {
		await this.resetSessionWithinExclusive(asSessionId(sessionId), clearAuxiliaryState);
	}

	async resetSessionWithinExclusive(
		sessionId: SessionId,
		clearAuxiliaryState?: () => void
	): Promise<void> {
		this._sessions.delete(sessionId);
		this._referenceIndex.clearSession(sessionId);
		clearAuxiliaryState?.();
		this._resetCallCount++;
	}

	async resetAll(clearAuxiliaryState?: () => void): Promise<void> {
		await this.resetAllWithinExclusive(clearAuxiliaryState);
	}

	async resetAllWithinExclusive(clearAuxiliaryState?: () => void): Promise<void> {
		this._sessions.clear();
		this._referenceIndex.clearAll();
		clearAuxiliaryState?.();
		this._resetCallCount++;
	}

	inspectSession(sessionId: string): HistorySessionSnapshot {
		const session = this._sessions.get(sessionId);
		return {
			history: [...(session?.history ?? [])],
			branches: (session === undefined ? {} : { ...session.branches }) as Record<
				BranchId,
				ThoughtData[]
			>,
			verificationTargets: new Map(session?.verificationTargets),
			branchIds: Object.keys(session?.branches ?? {}) as BranchId[],
			availableMcpTools: session?.mcpTools,
			availableSkills: session?.skills,
		};
	}

	getSessionIds(): string[] {
		return Array.from(this._sessions.keys());
	}

	getResetCallCount(): number {
		return this._resetCallCount;
	}

	getAvailableMcpTools(sessionId: string): string[] | undefined {
		return this._getSession(sessionId).mcpTools;
	}

	getAvailableSkills(sessionId: string): string[] | undefined {
		return this._getSession(sessionId).skills;
	}

	getEdgeStore(): undefined {
		return undefined;
	}
}

// === Formatter Mock ===

export function createMockFormatter(): Pick<ThoughtFormatter, 'formatThought'> {
	return {
		formatThought(thoughtData: ThoughtData): string {
			const result = {
				thought_number: thoughtData.thought_number,
				total_thoughts: thoughtData.total_thoughts,
				next_thought_needed: thoughtData.next_thought_needed,
				thought: thoughtData.thought,
			};
			return JSON.stringify(result);
		},
	};
}

// === ToolRegistry Mock ===

/**
 * Create a mock IToolRegistry that allowlists the given tool names.
 * When no names provided, defaults to a permissive 'test-tool' allowlist
 * matching `createTestThought()`'s `available_mcp_tools`.
 */
export function createMockToolRegistry(allowedTools: string[] = ['test-tool']): IToolRegistry {
	const set = new Set(allowedTools);
	return {
		has: (name: string): boolean => set.has(name),
		getNames: (): string[] => Array.from(set),
	};
}
