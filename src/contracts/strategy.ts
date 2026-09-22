/**
 * Reasoning Strategy contract — defines how a strategy observes reasoning state
 * and decides the next action (continue, branch, terminate, suspend).
 *
 * Strategies are pluggable policies that drive higher-level reasoning control
 * flow on top of the sequential thinking pipeline. They are pure (no I/O) and
 * receive a snapshot of session state via {@link StrategyContext}.
 *
 * @module contracts/strategy
 */

import type { SessionId } from './ids.js';
import type { ThoughtData } from '../core/thought.js';
import type { ReasoningStats } from '../core/reasoning.js';
import type { GraphView } from '../core/graph/GraphView.js';

export interface ActiveEvidenceProjection {
	/** Active, immutable deep-copied main-history evidence in retained main order. */
	readonly mainHistory: readonly ThoughtData[];
	/** Active, immutable deep-copied thoughts, including branch-only retained evidence. */
	readonly activeThoughts: readonly ThoughtData[];
	/** Graph induced only by active endpoints, without path contraction or audit-store mutation. */
	readonly graph: GraphView | undefined;
}

/**
 * Read-only snapshot of session state passed to a reasoning strategy.
 *
 * Evidence is a first-class active projection. Its thoughts and graph are immutable deep copies;
 * `mainHistory` preserves retained main order, `activeThoughts` permits branch-only lookup, and
 * its graph includes only active endpoints. It never contracts paths or mutates the audit store.
 *
 * @example
 * ```ts
 * const ctx: StrategyContext = {
 *   sessionId: 'sess_42',
 *   evidence: buildActiveEvidenceProjection(...),
 *   stats: evaluator.computeStats(history),
 *   currentThought: latestThought,
 * };
 * const decision = strategy.decide(ctx);
 * ```
 */
export interface StrategyContext {
	/** Session identifier this context belongs to. */
	readonly sessionId: SessionId;
	readonly evidence: ActiveEvidenceProjection;
	/** Aggregated reasoning analytics for the session. */
	readonly stats: ReasoningStats;
	/** The thought that just triggered the strategy decision. */
	readonly currentThought: ThoughtData;
}

/**
 * Discriminated union describing the action a strategy wants to take.
 *
 * - `continue`  — keep the current chain; optionally hint at next direction.
 * - `branch`    — fork a new branch from a prior thought.
 * - `terminate` — stop the reasoning chain; reason is required.
 * - `suspend`   — pause the chain; may be resumed after `resumeAfter` ms.
 *
 * @example
 * ```ts
 * const d: StrategyDecision = { action: 'branch', branchId: 'alt-1', fromThought: 3 };
 * if (d.action === 'branch') console.log(d.branchId);
 * ```
 */
export type StrategyDecision =
	| { action: 'continue'; reason?: string; nextHint?: string }
	| { action: 'branch'; branchId: string; fromThought: number; reason?: string }
	| { action: 'terminate'; reason: string }
	| { action: 'suspend'; reason: string; resumeAfter?: number };

/**
 * Pluggable reasoning strategy interface.
 *
 * Implementations are stateless with respect to global state — all input
 * comes from the {@link StrategyContext}. Strategies are registered via DI
 * and selected by name (e.g. `tot`, `cot`, `react`).
 *
 * @example
 * ```ts
 * class GreedyStrategy implements IReasoningStrategy {
 *   readonly name = 'greedy';
 *   decide(ctx: StrategyContext): StrategyDecision {
 *     return { action: 'continue' };
 *   }
 *   shouldBranch(_ctx: StrategyContext): boolean { return false; }
 *   shouldTerminate(ctx: StrategyContext): boolean {
 *     return ctx.evidence.mainHistory.length >= 50;
 *   }
 * }
 * ```
 */
export interface IReasoningStrategy {
	/** Stable identifier (used for DI lookup and metrics labels). */
	readonly name: string;
	/** Compute the next action given the current state snapshot. */
	decide(ctx: StrategyContext): StrategyDecision;
	/** Predicate: should the chain branch right now? */
	shouldBranch(ctx: StrategyContext): boolean;
	/** Predicate: should the chain terminate right now? */
	shouldTerminate(ctx: StrategyContext): boolean;
}
