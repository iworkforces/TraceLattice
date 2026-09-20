import { asBranchId, asSessionId, type BranchId, type SessionId } from '../contracts/ids.js';
/**
 * Integration tests for the full reasoning pipeline.
 *
 * Exercises ThoughtProcessor + ThoughtEvaluator together across multi-step
 * reasoning chains: hypothesis → verification → synthesis, branching + merge,
 * baseline thought behavior, metacognitive observations, and confidence tracking.
 *
 * @module __tests__/reasoning-integration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ThoughtProcessor } from '../core/ThoughtProcessor.js';
import { ThoughtFormatter } from '../core/ThoughtFormatter.js';
import type { ThoughtEvaluator } from '../core/ThoughtEvaluator.js';
import { StructuredLogger } from '../logger/StructuredLogger.js';
import type { ThoughtData } from '../core/thought.js';
import type { HistorySessionSnapshot, IHistoryManager } from '../core/IHistoryManager.js';
import { ThoughtReferenceIndex } from '../core/ThoughtReferenceIndex.js';
import { createTestThought } from './helpers/factories.js';
import { createDisabledThoughtEvaluator } from './helpers/evaluator.js';

const REASONING_SESSION = asSessionId('test-session');

/**
 * Branch-aware mock that routes thoughts with `branch_id` into the branches map,
 * matching real HistoryManager behavior for evaluator integration tests.
 */
class BranchAwareMockHistoryManager implements IHistoryManager {
	private _history: ThoughtData[] = [];
	private _branches: Record<string, ThoughtData[]> = {};
	private _availableMcpTools: string[] | undefined;
	private _availableSkills: string[] | undefined;
	private readonly _referenceIndex = new ThoughtReferenceIndex();

	addThought(thought: ThoughtData): void {
		this._history.push(thought);
		this._referenceIndex.add(thought.session_id, thought);
		if (thought.branch_id) {
			if (!this._branches[thought.branch_id]) {
				this._branches[thought.branch_id] = [];
			}
			this._branches[thought.branch_id]!.push(thought);
		}
		if (thought.available_mcp_tools) {
			this._availableMcpTools = thought.available_mcp_tools;
		}
		if (thought.available_skills) {
			this._availableSkills = thought.available_skills;
		}
	}

	resolveThoughtReference(sessionId: SessionId, thoughtNumber: number) {
		return this._referenceIndex.resolve(sessionId, thoughtNumber);
	}

	getHistory(_sessionId: string): ThoughtData[] {
		return this._history;
	}

	getHistoryLength(_sessionId: string): number {
		return this._history.length;
	}

	getBranches(_sessionId: string): Record<BranchId, ThoughtData[]> {
		return this._branches as Record<BranchId, ThoughtData[]>;
	}

	getBranchIds(_sessionId: string): BranchId[] {
		return Object.keys(this._branches) as BranchId[];
	}

	registerBranch(_sessionId: string, _branchId: BranchId): void {}

	branchExists(_sessionId: string, branchId: BranchId): boolean {
		return branchId in this._branches;
	}

	async resetSession(_sessionId: string, _clearAuxiliaryState?: () => void): Promise<void> {
		await this.resetAllWithinExclusive();
	}
	async resetSessionWithinExclusive(
		_sessionId: SessionId,
		_clearAuxiliaryState?: () => void
	): Promise<void> {
		await this.resetAllWithinExclusive();
	}

	async resetAll(): Promise<void> {
		await this.resetAllWithinExclusive();
	}
	async resetAllWithinExclusive(): Promise<void> {
		this._history = [];
		this._branches = {};
		this._availableMcpTools = undefined;
		this._availableSkills = undefined;
		this._referenceIndex.clearAll();
	}

	inspectSession(_sessionId: string): HistorySessionSnapshot {
		return {
			history: [...this._history],
			branches: { ...this._branches } as Record<BranchId, ThoughtData[]>,
			branchIds: Object.keys(this._branches) as BranchId[],
			availableMcpTools: this._availableMcpTools,
			availableSkills: this._availableSkills,
		};
	}

	getSessionIds(): string[] {
		return [REASONING_SESSION];
	}

	getAvailableMcpTools(_sessionId: string): string[] | undefined {
		return this._availableMcpTools;
	}

	getAvailableSkills(_sessionId: string): string[] | undefined {
		return this._availableSkills;
	}

	getEdgeStore(): undefined {
		return undefined;
	}
}

describe('Reasoning Integration', () => {
	let historyManager: BranchAwareMockHistoryManager;
	let formatter: ThoughtFormatter;
	let logger: StructuredLogger;
	let evaluator: ThoughtEvaluator;
	let processor: ThoughtProcessor;

	beforeEach(() => {
		historyManager = new BranchAwareMockHistoryManager();
		formatter = new ThoughtFormatter();
		logger = new StructuredLogger({ context: 'ReasoningIntegration', pretty: false });
		evaluator = createDisabledThoughtEvaluator();
		processor = new ThoughtProcessor(historyManager, formatter, evaluator, logger);
	});

	it('should track hypothesis through verification to synthesis', async () => {
		// Step 1: Create hypothesis
		const r1 = await processor.process({
			session_id: REASONING_SESSION,
			thought: 'I hypothesize the issue is in the auth module',
			thought_number: 1,
			total_thoughts: 4,
			next_thought_needed: true,
			thought_type: 'hypothesis',
			quality_score: 0.6,
			confidence: 0.7,
			hypothesis_id: 'auth-bug',
		});
		const j1 = JSON.parse(r1.content[0]!.text);
		expect(j1.thought_type).toBe('hypothesis');
		expect(j1.confidence_signals.has_hypothesis).toBe(true);
		expect(j1.confidence_signals.has_verification).toBe(false);

		// Step 2: Verify hypothesis
		const r2 = await processor.process({
			session_id: REASONING_SESSION,
			thought: 'Checking auth module — confirmed the bug',
			thought_number: 2,
			total_thoughts: 4,
			next_thought_needed: true,
			thought_type: 'verification',
			quality_score: 0.9,
			confidence: 0.95,
			hypothesis_id: 'auth-bug',
			verification_target: 1,
		});
		const j2 = JSON.parse(r2.content[0]!.text);
		expect(j2.thought_type).toBe('verification');
		expect(j2.confidence_signals.has_verification).toBe(true);
		expect(j2.reasoning_stats.hypothesis_count).toBe(1);
		expect(j2.reasoning_stats.verified_hypothesis_count).toBe(1);
		expect(j2.reasoning_stats.unresolved_hypothesis_count).toBe(0);

		// Step 3: Synthesize final answer
		const r3 = await processor.process({
			session_id: REASONING_SESSION,
			thought: 'Auth bug confirmed and fixed',
			thought_number: 3,
			total_thoughts: 3,
			next_thought_needed: false,
			thought_type: 'synthesis',
			quality_score: 0.95,
			confidence: 0.98,
			synthesis_sources: [1, 2],
		});
		const j3 = JSON.parse(r3.content[0]!.text);
		expect(j3.thought_type).toBe('synthesis');
		expect(j3.reasoning_stats.total_thoughts).toBe(3);
		expect(j3.reasoning_stats.average_quality_score).toBeCloseTo((0.6 + 0.9 + 0.95) / 3);
	});

	it('should track branch creation and merge operations', async () => {
		// Main chain
		await processor.process(
			createTestThought({
				thought: 'Main analysis',
				thought_number: 1,
				total_thoughts: 4,
				next_thought_needed: true,
			})
		);

		// Create branch
		await processor.process(
			createTestThought({
				thought: 'Alternative approach',
				thought_number: 2,
				total_thoughts: 4,
				next_thought_needed: true,
				branch_from_thought: 1,
				branch_id: asBranchId('alt-approach'),
				thought_type: 'hypothesis',
				hypothesis_id: 'alt-hyp',
			})
		);

		// Merge back
		const r3 = await processor.process(
			createTestThought({
				thought: 'Combining main and alternative insights',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
				thought_type: 'synthesis',
				merge_from_thoughts: [1, 2],
				merge_branch_ids: ['alt-approach'].map(asBranchId),
				synthesis_sources: [1, 2],
			})
		);

		const j3 = JSON.parse(r3.content[0]!.text);
		expect(j3.reasoning_stats.total_merges).toBe(1);
		expect(j3.reasoning_stats.total_branches).toBe(1);
		expect(j3.branches).toContain('alt-approach');
	});

	it('should handle existing input format without reasoning fields', async () => {
		const result = await processor.process({
			session_id: REASONING_SESSION,
			thought: 'Standard thinking step',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
		});

		const json = JSON.parse(result.content[0]!.text);
		// All standard fields present
		expect(json.thought_number).toBe(1);
		expect(json.total_thoughts).toBe(1);
		expect(json.next_thought_needed).toBe(false);
		// New reasoning fields are undefined when not provided
		expect(json.thought_type).toBe('regular');
		expect(json.quality_score).toBeUndefined();
		expect(json.confidence).toBeUndefined();
		// Evaluator still provides stats even for basic thoughts
		expect(json.confidence_signals).toBeDefined();
		expect(json.reasoning_stats).toBeDefined();
	});

	it('should track meta observations across reasoning chain', async () => {
		await processor.process(
			createTestThought({
				thought: 'Initial analysis',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
			})
		);

		await processor.process(
			createTestThought({
				thought: 'Observing that my reasoning is converging',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				thought_type: 'meta',
				meta_observation: 'Current reasoning path shows good convergence',
			})
		);

		const r3 = await processor.process(
			createTestThought({
				thought: 'Final answer',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
			})
		);

		const j3 = JSON.parse(r3.content[0]!.text);
		expect(j3.reasoning_stats.thought_type_counts.meta).toBe(1);
		expect(j3.reasoning_stats.total_thoughts).toBe(3);
	});

	it('should track confidence trends across reasoning chain', async () => {
		// Low confidence start
		await processor.process(
			createTestThought({
				thought: 'Uncertain initial analysis',
				thought_number: 1,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.3,
			})
		);

		// Growing confidence
		await processor.process(
			createTestThought({
				thought: 'Getting clearer',
				thought_number: 2,
				total_thoughts: 3,
				next_thought_needed: true,
				confidence: 0.7,
				thought_type: 'verification',
			})
		);

		// High confidence end
		const r3 = await processor.process(
			createTestThought({
				thought: 'Confident conclusion',
				thought_number: 3,
				total_thoughts: 3,
				next_thought_needed: false,
				confidence: 0.95,
			})
		);

		const j3 = JSON.parse(r3.content[0]!.text);
		expect(j3.confidence_signals.average_confidence).toBeCloseTo((0.3 + 0.7 + 0.95) / 3);
		expect(j3.reasoning_stats.average_confidence).toBeCloseTo((0.3 + 0.7 + 0.95) / 3);
	});
});
