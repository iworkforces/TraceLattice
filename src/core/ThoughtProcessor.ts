/**
 * Core thought processing logic and validation.
 *
 * This module provides the `ThoughtProcessor` class which handles the main
 * sequential thinking request processing pipeline, including input validation,
 * history management, and response formatting.
 *
 * @module processor
 */

import * as v from 'valibot';

import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import {
	asBranchId,
	asSessionId,
	type BranchId,
	type SessionId,
	type ThoughtId,
} from '../contracts/ids.js';
import type { IEdgeStore, IOutcomeRecorder } from '../contracts/interfaces.js';
import type { ICalibrator } from '../contracts/calibrator.js';
import type { ISuspensionStore, SuspensionRecord } from '../contracts/suspension.js';
import type { IReasoningStrategy, StrategyDecision } from '../contracts/strategy.js';
import { DEFAULT_FLAGS, type FeatureFlags } from '../contracts/features.js';
import type { ISessionLock, IToolRegistry } from '../contracts/interfaces.js';
import {
	InvalidBacktrackError,
	InvalidToolCallError,
	SequentialThinkingError,
	UnknownToolError,
	ValidationError,
} from '../errors.js';
import { getErrorMessage, WARNING_CODES } from '../errors.js';
import { enforceJsonShape, JsonShapeError } from '../sanitize.js';
import { SequentialThinkingSchema } from '../schema.js';
import { GraphView } from './graph/GraphView.js';
import { assertNever } from '../utils.js';
import type {
	HistorySessionSnapshot,
	IHistoryManager,
	ThoughtAdmissionContext,
} from './IHistoryManager.js';
import { normalizeInput } from './InputNormalizer.js';
import type {
	ThoughtData,
	ToolCallThought,
	ToolObservationThought,
	ValidatedThought,
} from './thought.js';
import type { ThoughtEvaluator } from './ThoughtEvaluator.js';
import type { ThoughtFormatter } from './ThoughtFormatter.js';
import type { PatternName } from '../contracts/reasoning-types.js';
import type { PatternSignal } from './reasoning.js';
import { SequentialStrategy } from './reasoning/strategies/SequentialStrategy.js';
import type { CompressionService } from './compression/CompressionService.js';
import { validateThoughtCrossReferences } from './CrossReferenceValidator.js';
import { SessionLifecycleCoordinator } from './SessionLifecycleCoordinator.js';
import { prepareVerificationOutcome } from './VerificationOutcomeAdmission.js';

type ConfidenceSignalsResult = ReturnType<ThoughtEvaluator['computeConfidenceSignals']>;
type ReasoningStatsResult = ReturnType<ThoughtEvaluator['computeReasoningStats']>;

type ReasoningSignalBundle = {
	readonly history: ThoughtData[];
	readonly confidenceSignals: ConfidenceSignalsResult;
	readonly reasoningStats: ReasoningStatsResult;
	readonly reasoningHints: readonly string[];
};

type ProcessedThoughtResponseState = {
	readonly thought: ThoughtData;
	readonly reasoning: {
		readonly confidenceSignals: ConfidenceSignalsResult;
		readonly reasoningStats: ReasoningStatsResult;
		readonly reasoningHints: readonly string[];
	};
	readonly decision: StrategyDecision | undefined;
	readonly warnings: readonly string[];
};

type ThoughtProcessInput = ThoughtData & { readonly register_branch_id?: string };

type PreparedThought = {
	readonly thought: ThoughtData;
	readonly resetState: boolean;
	readonly registerBranchId: BranchId | undefined;
	readonly validationWarnings: readonly string[];
};

/**
 * The return type expected by MCP tool invocations.
 *
 * This structure matches the MCP protocol for tool results,
 * supporting both success and error responses.
 *
 * @example
 * ```typescript
 * const successResult: CallToolResult = {
 *   content: [{ type: 'text', text: '{"status":"success"}' }]
 * };
 *
 * const errorResult: CallToolResult = {
 *   content: [{ type: 'text', text: '{"error":"Something went wrong"}' }],
 *   isError: true
 * };
 * ```
 */
export interface CallToolResult extends Record<string, unknown> {
	/** Array of content blocks (typically text) to return to the client. */
	content: Array<{
		type: 'text';
		text: string;
	}>;

	/** Whether this result represents an error condition. */
	isError?: boolean;
}

/**
 * Core processor for sequential thinking requests.
 *
 * Pipeline: validate → normalize → add to history → format → evaluate signals
 * → run reasoning strategy → return structured response.
 *
 * Auto-adjusts `total_thoughts` if `thought_number` exceeds it. All errors are
 * caught and returned as formatted error responses with `isError: true`.
 *
 * @example
 * ```typescript
 * const processor = new ThoughtProcessor(historyManager, formatter, new ThoughtEvaluator());
 * const result = await processor.process({
 *   thought: '...',
 *   thought_number: 1,
 *   total_thoughts: 5,
 *   next_thought_needed: true,
 *   session_id: asSessionId('analysis')
 * });
 * ```
 */
export class ThoughtProcessor {
	/** Logger for debugging and monitoring. */
	private _logger: Logger;

	/** Evaluator for quality signal computation. */
	private readonly _thoughtEvaluator: ThoughtEvaluator;

	/**
	 * Per-session cooldown tracker: session_id → pattern → last_fired_thought_number.
	 * Prevents re-firing the same pattern hint within 3 thoughts.
	 */
	private _hintCooldowns = new Map<SessionId, Map<PatternName, number>>();

	/**
	 * Creates a new ThoughtProcessor instance.
	 *
	 * @param historyManager - History manager for storing thoughts
	 * @param thoughtFormatter - Formatter for output formatting
	 * @param thoughtEvaluator - Evaluator for quality signal computation
	 * @param logger - Optional logger for diagnostics (defaults to NullLogger)
	 * @param strategy - Reasoning strategy controlling next-action decisions (defaults to SequentialStrategy)
	 * @param compressionService - Optional compression service for auto-compression on terminate
	 * @param suspensionStore - Optional suspension store enabling tool interleave
	 * @param toolRegistry - Optional tool registry for tool_name allowlist validation (required when toolInterleave is enabled)
	 * @param features - Optional feature flags (defaults to DEFAULT_FLAGS — all opt-in flags off)
	 * @param sessionLock - Optional per-session async lock; when provided, `process()` runs under it
	 * @param outcomeRecorder - Optional per-session calibration outcome store
	 */
	constructor(
		private historyManager: IHistoryManager,
		private thoughtFormatter: ThoughtFormatter,
		thoughtEvaluator: ThoughtEvaluator,
		logger?: Logger,
		private readonly strategy: IReasoningStrategy = new SequentialStrategy(),
		private readonly _compressionService?: CompressionService,
		private readonly _suspensionStore?: ISuspensionStore,
		private readonly _toolRegistry?: IToolRegistry,
		private readonly _features: FeatureFlags = DEFAULT_FLAGS,
		private readonly _sessionLock?: ISessionLock,
		private readonly _outcomeRecorder?: IOutcomeRecorder,
		private readonly _lifecycle: SessionLifecycleCoordinator = new SessionLifecycleCoordinator(),
		private readonly _calibrator?: ICalibrator
	) {
		this._thoughtEvaluator = thoughtEvaluator;
		this._logger = logger ?? new NullLogger();
	}

	/**
	 * Internal logging method.
	 * @param message - The message to log
	 * @param meta - Optional metadata
	 * @private
	 */
	private log(message: string, meta?: Record<string, unknown>): void {
		this._logger.info(message, meta);
	}

	/**
	 * Priority ordering for warning patterns (lower = higher priority).
	 * Ensures the most actionable patterns fill the hint cap first.
	 */
	private static readonly _HINT_PRIORITY: Readonly<Partial<Record<PatternName, number>>> = {
		confidence_drift: 1, // Most actionable — degrading confidence
		unverified_hypothesis: 2, // Important for quality
		no_alternatives_explored: 3, // Breadth gap
		consecutive_without_verification: 4, // Routine pattern
	};

	/**
	 * Generate actionable hints from pattern signals.
	 * Rules: max 3 hints, warning-severity only, cooldown of 3 thoughts per pattern per session.
	 *
	 * Warning patterns are sorted by priority before selection (see _HINT_PRIORITY).
	 * Higher-priority patterns (lower number) fill the hint cap first.
	 *
	 * @param patterns - Detected pattern signals
	 * @param currentThoughtNumber - The current thought number being processed
	 * @param sessionId - Session identifier for cooldown scoping
	 * @returns Array of hint strings (max 3), empty if no warnings
	 */
	private _generateHints(
		patterns: PatternSignal[],
		currentThoughtNumber: number,
		sessionId: SessionId
	): string[] {
		const warnings = patterns.filter((p) => p.severity === 'warning');
		if (warnings.length === 0) return [];

		// Sort by priority (lower number = higher priority)
		warnings.sort((a, b) => {
			const pa = ThoughtProcessor._HINT_PRIORITY[a.pattern] ?? 99;
			const pb = ThoughtProcessor._HINT_PRIORITY[b.pattern] ?? 99;
			return pa - pb;
		});

		let cooldowns = this._hintCooldowns.get(sessionId);
		if (cooldowns === undefined) {
			cooldowns = new Map();
			this._hintCooldowns.set(sessionId, cooldowns);
		}

		const hints: string[] = [];
		for (const warning of warnings) {
			if (hints.length >= 3) break;

			const lastFired = cooldowns.get(warning.pattern);
			if (lastFired !== undefined && currentThoughtNumber - lastFired < 3) {
				continue; // Still in cooldown
			}

			hints.push(warning.message);
			cooldowns.set(warning.pattern, currentThoughtNumber);
		}

		return hints;
	}

	/**
	 * Processes a thought through the sequential thinking pipeline.
	 *
	 * This method validates the input, adds it to history, formats the output,
	 * computes quality signals via the ThoughtEvaluator, and returns
	 * a structured response with metadata about the current state.
	 *
	 * @param input - The thought data to process
	 * @returns A Promise resolving to the formatted tool result containing:
	 *   - `thought_number` — Current thought index
	 *   - `total_thoughts` — Estimated total thoughts
	 *   - `next_thought_needed` — Whether to continue
	 *   - `branches` — Active branch IDs
	 *   - `thought_history_length` — Number of thoughts in history
	 *   - `available_mcp_tools` — MCP tools available for recommendation
	 *   - `available_skills` — Skills available for recommendation
	 *   - `current_step` — Current step recommendation
	 *   - `previous_steps` — Previously recommended steps
	 *   - `remaining_steps` — Upcoming step descriptions
	 *   - `thought_type` — Classification of thought purpose (optional)
	 *   - `quality_score` — Self-assessed quality score 0-1 (optional)
	 *   - `confidence` — Self-assessed confidence 0-1 (optional)
	 *   - `hypothesis_id` — Hypothesis link for verification chains (optional)
	 *   - `confidence_signals` — Computed reasoning quality signals (includes structural_quality and quality_components)
	 *   - `reasoning_stats` — Aggregated reasoning analytics
	 *   - `reasoning_hints` — (Conditional) Actionable hints from pattern analysis, max 3, warning-severity only (optional)
	 *
	 * @example
	 * ```typescript
	 * const result = await processor.process({
	 *   thought: 'I should read the README file',
	 *   thought_number: 1,
	 *   total_thoughts: 3,
	 *   next_thought_needed: true,
	 *   session_id: asSessionId('analysis')
	 * });
	 *
	 * console.log(result.content[0].text);
	 * // Output includes: thought_number, total_thoughts, next_thought_needed,
	 * // branches, thought_history_length, and any recommendations
	 * ```
	 */
	public async process(input: ThoughtProcessInput): Promise<CallToolResult> {
		try {
			const prepared = this._prepareInput(input);
			const sessionId = prepared.thought.session_id;
			const operation = async (): Promise<CallToolResult> => {
				if (this._sessionLock !== undefined) {
					return await this._sessionLock.withLock(sessionId, () => this._processInner(prepared));
				}
				return await this._processInner(prepared);
			};
			if (prepared.resetState) {
				this.historyManager.inspectSession(sessionId);
				return await this._lifecycle.withSessionReset(sessionId, operation);
			}
			return await this._lifecycle.runOperation(sessionId, operation);
		} catch (error) {
			return this._buildErrorResponse(error);
		}
	}

	/** Resets one canonical session and its processor-owned auxiliary state. */
	public async resetSession(sessionId: string): Promise<void> {
		const canonicalSessionId = asSessionId(sessionId);
		this.historyManager.inspectSession(canonicalSessionId);
		const operation = async (): Promise<void> => {
			await this.historyManager.resetSessionWithinExclusive(canonicalSessionId, () =>
				this.clearSessionAuxiliaryState(canonicalSessionId)
			);
		};
		await this._lifecycle.withSessionReset(canonicalSessionId, async () => {
			if (this._sessionLock !== undefined) {
				await this._sessionLock.withLock(canonicalSessionId, operation);
				return;
			}
			await operation();
		});
	}

	/** Resets all history and processor-owned auxiliary state from a trusted context. */
	public async resetAll(): Promise<void> {
		await this._lifecycle.withGlobalReset(
			async () =>
				await this.historyManager.resetAllWithinExclusive(() => this.clearAllAuxiliaryState())
		);
	}

	private _prepareInput(input: ThoughtProcessInput): PreparedThought {
		const normalized = normalizeInput(input);
		if (typeof normalized === 'object' && normalized !== null) {
			this._validateToolArgumentsShape(normalized.tool_arguments);
		}
		const parsed = v.safeParse(SequentialThinkingSchema, normalized);
		if (!parsed.success) {
			const firstIssue = parsed.issues[0];
			const field = firstIssue?.path?.map((item) => String(item.key)).join('.') || 'input';
			throw new ValidationError(field, firstIssue?.message ?? 'Invalid input');
		}

		const internal = normalizeInput(parsed.output) as ThoughtData & {
			register_branch_id?: string;
		};
		const registerBranchId =
			internal.register_branch_id === undefined
				? undefined
				: asBranchId(internal.register_branch_id);
		const thought = { ...internal };
		delete thought.register_branch_id;
		const { result, warnings } = this.validateInput(thought);
		this._validateStatelessNewTypes(result);
		return {
			thought: result,
			resetState: result.reset_state === true,
			registerBranchId,
			validationWarnings: warnings,
		};
	}

	private _buildErrorResponse(error: unknown): CallToolResult {
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(
						{
							...(error instanceof SequentialThinkingError && { code: error.code }),
							error: getErrorMessage(error),
							message: getErrorMessage(error),
							status: 'failed',
						},
						null,
						2
					),
				},
			],
			isError: true,
		};
	}

	private static _emptySessionSnapshot(): HistorySessionSnapshot {
		return {
			history: [],
			branches: {},
			branchIds: [],
			availableMcpTools: undefined,
			availableSkills: undefined,
		};
	}

	/** Clears all processor-owned state for one removed session. */
	public clearSessionAuxiliaryState(sessionId: SessionId): void {
		this._hintCooldowns.delete(sessionId);
		this._suspensionStore?.clearSession(sessionId);
		this._outcomeRecorder?.clearOutcomes(sessionId);
		this._calibrator?.clearSession(sessionId);
	}

	/** Clears all processor-owned state after global reset or successful shutdown. */
	public clearAllAuxiliaryState(): void {
		this._suspensionStore?.clearAll();
		this._outcomeRecorder?.clearAllOutcomes();
		this._calibrator?.clearAll();
		this._hintCooldowns.clear();
	}

	private _validateToolArgumentsShape(toolArguments: unknown): void {
		try {
			enforceJsonShape(toolArguments ?? {});
		} catch (error) {
			if (error instanceof JsonShapeError) {
				throw new ValidationError('tool_arguments', error.reason);
			}
			throw error;
		}
	}

	private async _processInner(prepared: PreparedThought): Promise<CallToolResult> {
		const { thought, resetState, registerBranchId } = prepared;
		const sessionId = thought.session_id;
		const existingSnapshot = this.historyManager.inspectSession(sessionId);
		const validationSnapshot = resetState
			? ThoughtProcessor._emptySessionSnapshot()
			: existingSnapshot;
		if (!resetState) {
			if (!thought.available_mcp_tools && validationSnapshot.availableMcpTools) {
				thought.available_mcp_tools = [...validationSnapshot.availableMcpTools];
			}
			if (!thought.available_skills && validationSnapshot.availableSkills) {
				thought.available_skills = [...validationSnapshot.availableSkills];
			}
		}
		const resolveThoughtReference = resetState
			? () => ({ kind: 'missing' as const })
			: (thoughtNumber: number) =>
					this.historyManager.resolveThoughtReference(sessionId, thoughtNumber);
		const {
			result: checkedInput,
			warnings: refWarnings,
			resolvedReferences,
		} = validateThoughtCrossReferences(thought, {
			snapshot: validationSnapshot,
			resolveThoughtReference,
			strictBranchReferences: resetState || registerBranchId !== undefined,
			logger: this._logger,
		});
		const verificationOutcome = prepareVerificationOutcome({
			input: checkedInput,
			snapshot: validationSnapshot,
			resolvedReferences,
			sessionId,
			recorder: this._outcomeRecorder,
		});
		const allWarnings = [...prepared.validationWarnings, ...refWarnings];
		const validated = this._validateNewTypes(checkedInput);
		const admissionContext: ThoughtAdmissionContext = { resolvedReferences };
		if (resetState && validated.thought_type === 'tool_observation') {
			throw new ValidationError(
				'thought_type',
				'tool_observation cannot resume a suspension in reset replacement state'
			);
		}

		if (resetState) {
			await this.historyManager.resetSessionWithinExclusive(sessionId, () =>
				this.clearSessionAuxiliaryState(sessionId)
			);
			this.log('State reset for session', { sessionId });
		}
		if (registerBranchId !== undefined) {
			this.historyManager.registerBranch(sessionId, registerBranchId);
		}

		// Tool-interleave suspend path: persist the tool_call thought, then return
		// a `suspended` envelope without running strategy/evaluator.
		if (validated.thought_type === 'tool_call' && this._suspensionStore) {
			return this._handleToolCall(validated, admissionContext);
		}

		// Tool-interleave resume path: consume the suspension and continue the
		// normal pipeline (addThought → format → evaluate → strategy).
		if (validated.thought_type === 'tool_observation' && this._suspensionStore) {
			await this._handleToolObservation(validated, admissionContext);
		} else {
			this.historyManager.addThought(checkedInput, admissionContext);
		}
		this._recordVerificationOutcome(verificationOutcome, sessionId);

		const formattedThought = this.thoughtFormatter.formatThought(checkedInput);
		this.log(formattedThought, { sessionId });

		const signals = this._collectReasoningSignals(checkedInput);

		// Strategy decision — pluggable reasoning policy hook.
		// Built after history/stats so strategies see the latest state.
		const decision = this._runStrategy(checkedInput, signals.history, signals.reasoningStats);

		return this._buildSuccessResponse({
			thought: checkedInput,
			reasoning: {
				confidenceSignals: signals.confidenceSignals,
				reasoningStats: signals.reasoningStats,
				reasoningHints: signals.reasoningHints,
			},
			decision,
			warnings: allWarnings,
		});
	}

	private _recordVerificationOutcome(
		outcome: ReturnType<typeof prepareVerificationOutcome>,
		sessionId: SessionId
	): void {
		if (outcome === undefined) return;
		if (this._outcomeRecorder?.enabled === true) {
			this._outcomeRecorder.recordVerification(outcome);
		}
		if (this._calibrator?.enabled === true) this._calibrator.refit(sessionId);
	}

	private _collectReasoningSignals(input: ThoughtData): ReasoningSignalBundle {
		const sessionId = input.session_id;
		const history = this.historyManager.getHistory(sessionId);
		const branches = this.historyManager.getBranches(sessionId);
		const confidenceSignals = this._thoughtEvaluator.computeConfidenceSignals(history, branches, {
			currentThought: input,
			sessionId,
		});
		const reasoningStats = this._thoughtEvaluator.computeReasoningStats(history, branches);
		const patternSignals = this._thoughtEvaluator.computePatternSignals(history, branches);
		const reasoningHints = this._generateHints(patternSignals, input.thought_number, sessionId);

		return {
			history,
			confidenceSignals,
			reasoningStats,
			reasoningHints,
		};
	}

	private _buildSuccessResponse(state: ProcessedThoughtResponseState): CallToolResult {
		const sessionId = state.thought.session_id;
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							thought_number: state.thought.thought_number,
							total_thoughts: state.thought.total_thoughts,
							next_thought_needed: state.thought.next_thought_needed ?? true,
							branches: this.historyManager.getBranchIds(sessionId),
							thought_history_length: this.historyManager.getHistoryLength(sessionId),
							available_mcp_tools: state.thought.available_mcp_tools,
							available_skills: state.thought.available_skills,
							current_step: state.thought.current_step,
							previous_steps: state.thought.previous_steps,
							remaining_steps: state.thought.remaining_steps,
							thought_type: state.thought.thought_type,
							quality_score: state.thought.quality_score,
							confidence: state.thought.confidence,
							hypothesis_id: state.thought.hypothesis_id,
							confidence_signals: state.reasoning.confidenceSignals,
							reasoning_stats: state.reasoning.reasoningStats,
							...(state.reasoning.reasoningHints.length > 0 && {
								reasoning_hints: state.reasoning.reasoningHints,
							}),
							...(state.decision !== undefined && { strategy_hint: state.decision }),
							...(state.warnings.length > 0 && { warnings: state.warnings.slice(0, 3) }),
							session_id: sessionId,
						},
						null,
						2
					),
				},
			],
		};
	}

	/**
	 * Run the configured reasoning strategy and return its decision.
	 * Strategy errors omit the decision from the public response.
	 * @private
	 */
	private _runStrategy(
		currentThought: ThoughtData,
		history: ThoughtData[],
		stats: ReturnType<ThoughtEvaluator['computeReasoningStats']>
	): StrategyDecision | undefined {
		const sessionId = currentThought.session_id;
		let decision: StrategyDecision | undefined;
		try {
			const edgeStore = this._getEdgeStore();
			const graph = edgeStore ? new GraphView(edgeStore) : undefined;
			decision = this.strategy.decide({
				sessionId,
				history,
				graph,
				stats,
				currentThought,
			});
		} catch (error) {
			this._logger.warn('Reasoning strategy threw — omitting strategy hint', {
				strategy: this.strategy.name,
				error: getErrorMessage(error),
			});
		}

		// Auto-compression trigger: when strategy terminates a branch and
		// compression is enabled, summarize the branch subtree. Compression
		// failures must NEVER break the thought pipeline.
		if (decision?.action === 'terminate' && this._compressionService && currentThought.branch_id) {
			try {
				const branchRoot = this._findBranchRoot(sessionId, currentThought.branch_id);
				if (branchRoot) {
					this._compressionService.compressBranch(
						sessionId,
						currentThought.branch_id,
						branchRoot as ThoughtId
					);
				}
			} catch (err) {
				this._logger.debug('Compression auto-trigger failed', {
					error: getErrorMessage(err),
				});
			}
		}

		return decision;
	}

	/**
	 * Locate the root thought id for a branch.
	 * Prefers GraphView.branchThoughts() when an EdgeStore is available;
	 * falls back to historyManager.getBranches(sessionId)[branchId][0].id.
	 * @private
	 */
	private _findBranchRoot(sessionId: SessionId, branchId: BranchId): string | undefined {
		const edgeStore = this._getEdgeStore();
		const branches = this.historyManager.getBranches(sessionId);
		const branchList = branches[branchId];
		const firstId = branchList?.[0]?.id;
		if (edgeStore && firstId) {
			const graph = new GraphView(edgeStore);
			const ids = graph.branchThoughts(sessionId, firstId);
			if (ids.length > 0) return ids[0];
		}
		return firstId;
	}

	/** Access the EdgeStore via IHistoryManager. @private */
	private _getEdgeStore(): IEdgeStore | undefined {
		return this.historyManager.getEdgeStore();
	}

	/**
	 * Validates and normalizes thought input.
	 *
	 * Ensures that thought numbers are consistent and within valid ranges.
	 * If `thought_number` exceeds `total_thoughts`, `total_thoughts` is
	 * automatically adjusted to match and a warning is emitted.
	 *
	 * @param input - The input to validate
	 * @returns Object with validated input and any warnings generated
	 * @private
	 *
	 * @example
	 * ```typescript
	 * // Auto-adjusts total_thoughts when thought_number exceeds it
	 * const { result, warnings } = this.validateInput(input);
	 * // result.total_thoughts === 10 (auto-adjusted from 5)
	 * // warnings === ['Auto-adjusted total_thoughts from 5 to 10 to match thought_number']
	 * ```
	 */
	private validateInput(input: ThoughtData): {
		result: ThoughtData;
		warnings: string[];
	} {
		const warnings: string[] = [];
		if (input.thought_number > input.total_thoughts) {
			const originalTotal = input.total_thoughts;
			warnings.push(
				`[${WARNING_CODES.TOTAL_THOUGHTS_ADJUSTED}] Auto-adjusted total_thoughts from ${originalTotal} to ${input.thought_number} to match thought_number`
			);
			this._logger.warn('Auto-adjusted total_thoughts to match thought_number', {
				thought_number: input.thought_number,
				original_total_thoughts: originalTotal,
				adjusted_total_thoughts: input.thought_number,
			});
			input.total_thoughts = input.thought_number;
		}
		return { result: input, warnings };
	}

	/**
	 * Validate new thought-type invariants behind feature flags.
	 * @private
	 */
	private _validateStatelessNewTypes(input: ThoughtData): void {
		const t = input.thought_type;
		if ((t === 'tool_call' || t === 'tool_observation') && !this._features.toolInterleave) {
			throw new ValidationError(
				'thought_type',
				`Type '${t}' requires the toolInterleave feature flag. Set TRACELATTICE_FEATURES_TOOL_INTERLEAVE=true to enable it.`
			);
		}
		if (
			(t === 'assumption' || t === 'decomposition' || t === 'backtrack') &&
			!this._features.newThoughtTypes
		) {
			throw new ValidationError(
				'thought_type',
				`Type '${t}' requires the newThoughtTypes feature flag. Set TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES=true to enable it, or use '${ThoughtProcessor._getWorkaroundType(t)}' type as a workaround.`
			);
		}
		if (t === 'tool_call') {
			if (!input.tool_name) {
				throw new InvalidToolCallError(
					'tool_call thought ' + input.thought_number + ' missing required tool_name'
				);
			}
			this._validateToolName(input.tool_name);
		}
		if (t === 'tool_observation' && !input.continuation_token) {
			throw new ValidationError(
				'continuation_token',
				'tool_observation thought ' + input.thought_number + ' missing continuation_token'
			);
		}
		if (t === 'backtrack') {
			if (input.backtrack_target === undefined) {
				throw new ValidationError(
					'backtrack_target',
					'backtrack thought ' + input.thought_number + ' requires backtrack_target'
				);
			}
			if (input.backtrack_target > input.thought_number) {
				throw new InvalidBacktrackError(
					'backtrack_target ' +
						input.backtrack_target +
						' must be <= thought_number ' +
						input.thought_number
				);
			}
		}
		if (t === 'tool_call') {
			this._validateToolArgumentsShape(input.tool_arguments);
		}
	}

	private _validateNewTypes(input: ThoughtData): ValidatedThought {
		return input as ValidatedThought;
	}

	/**
	 * Validate a tool_call's tool_name against the configured allowlist.
	 *
	 * Fails closed: if no tool registry was wired, all tool_call invocations are
	 * rejected. This prevents arbitrary tool name injection through the protocol.
	 *
	 * @param toolName - The tool name from the tool_call thought
	 * @throws {UnknownToolError} When no registry is wired or the tool is not registered
	 * @private
	 */
	private _validateToolName(toolName: string): void {
		if (!this._toolRegistry) {
			throw new UnknownToolError(
				toolName,
				`Tool '${toolName}' rejected: no tool registry configured. Tool interleave requires a registered allowlist.`
			);
		}
		if (!this._toolRegistry.has(toolName)) {
			throw new UnknownToolError(toolName);
		}
	}

	/**
	 * Returns a workaround thought type for a feature-flagged type.
	 * @private
	 */
	private static _getWorkaroundType(t: 'assumption' | 'decomposition' | 'backtrack'): string {
		switch (t) {
			case 'assumption':
				return 'regular';
			case 'decomposition':
				return 'hypothesis';
			case 'backtrack':
				return 'regular';
			default:
				assertNever(t);
		}
	}

	/**
	 * Persist a tool_call thought and return a `suspended` envelope.
	 * Strategy/evaluator are intentionally skipped.
	 * @private
	 */
	private _handleToolCall(
		input: ToolCallThought,
		admissionContext: ThoughtAdmissionContext
	): CallToolResult {
		if (input.id === undefined) {
			throw new ValidationError('id', 'tool_call requires an admitted thought id');
		}
		this.historyManager.addThought(input, admissionContext);
		if (!this._suspensionStore) {
			throw new ValidationError('thought_type', 'tool_call requires suspensionStore');
		}
		const record: SuspensionRecord = this._suspensionStore.suspend({
			sessionId: input.session_id,
			toolCallThoughtNumber: input.thought_number,
			toolCallThoughtId: input.id,
			toolName: input.tool_name,
			toolArguments: input.tool_arguments ?? {},
			expiresAt: 0,
		});
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							status: 'suspended',
							continuation_token: record.token,
							tool_name: record.toolName,
							tool_arguments: record.toolArguments,
							expires_at: record.expiresAt,
							thought_number: input.thought_number,
							total_thoughts: input.total_thoughts,
							session_id: input.session_id,
						},
						null,
						2
					),
				},
			],
		};
	}

	/**
	 * Resume from a tool_observation and atomically admit it before consuming the record.
	 * @private
	 */
	private async _handleToolObservation(
		input: ToolObservationThought,
		admissionContext: ThoughtAdmissionContext
	): Promise<void> {
		if (!this._suspensionStore) {
			throw new ValidationError('thought_type', 'tool_observation requires suspensionStore');
		}
		await this._suspensionStore.compareAndAdmit(
			input.continuation_token,
			input.session_id,
			(record) => {
				this.historyManager.addThought(input, {
					...admissionContext,
					toolInvocationSourceThoughtId: record.toolCallThoughtId,
				});
			}
		);
	}
}
