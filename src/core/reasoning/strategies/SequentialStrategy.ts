/**
 * Sequential reasoning strategy — the default policy that preserves existing
 * {@link ThoughtProcessor} behavior. Continues the chain unless the current
 * thought explicitly signals termination via `next_thought_needed === false`.
 *
 * Pure policy: no mutable state, no I/O, no module-level variables. All
 * methods are deterministic functions of their inputs.
 *
 * @module core/reasoning/strategies/SequentialStrategy
 */

import type {
	IReasoningStrategy,
	StrategyContext,
	StrategyDecision,
} from '../../../contracts/strategy.js';

/**
 * Default sequential strategy. Applies the linear thinking flow:
 *
 * - Continue while `next_thought_needed` is truthy (or unset).
 * - Terminate as soon as `next_thought_needed === false`.
 * - Branch when both `branch_from_thought` and `branch_id` are present.
 *
 * Type-agnostic: all `ThoughtType` variants (including `assumption`,
 * `decomposition`, `backtrack`, `tool_call`, and `tool_observation`) pass
 * through unchanged. The strategy intentionally inspects
 * only `next_thought_needed`, `branch_from_thought`, and `branch_id` —
 * type-aware behavior lives in evaluator/scoring layers, not here.
 *
 * @example
 * ```ts
 * const strategy = new SequentialStrategy();
 * const decision = strategy.decide(ctx);
 * if (decision.action === 'terminate') stop();
 * ```
 */
export class SequentialStrategy implements IReasoningStrategy {
	readonly name = 'sequential' as const;

	/**
	 * Compute the next action for the chain.
	 *
	 * @param ctx - Read-only session snapshot.
	 * @returns `{ action: 'terminate' }` when current thought signals stop,
	 *          otherwise `{ action: 'continue' }`.
	 */
	decide(ctx: StrategyContext): StrategyDecision {
		if (ctx.currentThought.next_thought_needed === false) {
			return { action: 'terminate', reason: 'next_thought_needed=false' };
		}
		return { action: 'continue' };
	}

	/**
	 * Predicate: should the chain branch right now?
	 * True iff both `branch_from_thought` and `branch_id` are set on the
	 * current thought.
	 */
	shouldBranch(ctx: StrategyContext): boolean {
		const t = ctx.currentThought;
		return t.branch_from_thought !== undefined && t.branch_id !== undefined;
	}

	/**
	 * Predicate: should the chain terminate right now?
	 * True iff `next_thought_needed === false`.
	 */
	shouldTerminate(ctx: StrategyContext): boolean {
		return ctx.currentThought.next_thought_needed === false;
	}
}
