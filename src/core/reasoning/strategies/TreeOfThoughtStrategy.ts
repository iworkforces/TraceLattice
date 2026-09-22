/**
 * Tree-of-Thought reasoning strategy — beam search over the thought DAG.
 *
 * Observes the frontier (graph leaves), scores each leaf via
 * {@link scoreThought}, and decides whether to continue, branch (when the
 * current thought falls outside the beam), or terminate (on depth cap,
 * confidence threshold, or score plateau). It reads only the immutable active evidence projection;
 * the audit history and graph remain unchanged.
 *
 * Pure policy: configuration lives in a module-level {@link WeakMap}, not
 * on the instance, so `Object.getOwnPropertyNames(strategy)` only ever
 * surfaces the readonly `name` discriminator. All other state is derived
 * from the {@link StrategyContext} on every call.
 *
 * @module core/reasoning/strategies/TreeOfThoughtStrategy
 */

import type {
	IReasoningStrategy,
	StrategyContext,
	StrategyDecision,
} from '../../../contracts/strategy.js';
import { asThoughtId, type ThoughtId } from '../../../contracts/ids.js';
import type { ThoughtData } from '../../thought.js';
import { scoreThought, selectBeam, type ScoredCandidate } from './totScoring.js';
import { detectPlateau } from './plateau.js';

/**
 * Configuration knobs for {@link TreeOfThoughtStrategy}. All fields are
 * optional; defaults are applied in the constructor.
 */
export interface TotConfig {
	/** Top-K candidates kept on the frontier (default `3`). */
	readonly beamWidth?: number;
	/** Maximum exploration depth before forcing termination (default `8`). */
	readonly depthCap?: number;
	/** Finite nonnegative score at/above which the chain terminates (default `0.85`; values >1 valid). */
	readonly terminationConfidence?: number;
	/** Window size for plateau detection (default `3`). */
	readonly plateauWindow?: number;
	/** Minimum meaningful score change for plateau detection (default `0.02`). */
	readonly plateauEpsilon?: number;
}

/** Defaults applied when a {@link TotConfig} field is omitted. */
const DEFAULTS: Required<TotConfig> = {
	beamWidth: 3,
	depthCap: 8,
	terminationConfidence: 0.85,
	plateauWindow: 3,
	plateauEpsilon: 0.02,
};

/**
 * Module-private config storage. Keyed by strategy instance so that no
 * own-properties leak onto `this` (preserving the purity contract).
 */
const CONFIGS: WeakMap<TreeOfThoughtStrategy, Required<TotConfig>> = new WeakMap();

/** Resolve the per-instance config (constructor always populates the map). */
function configOf(s: TreeOfThoughtStrategy): Required<TotConfig> {
	return CONFIGS.get(s) ?? DEFAULTS;
}

/** Stable identifier for a thought: `id` if present, else its sequence number. */
function thoughtKey(t: ThoughtData): ThoughtId {
	return t.id ?? asThoughtId(String(t.thought_number));
}

/** Index history by stable key for O(1) leaf-id → ThoughtData lookup. */
function indexHistory(history: readonly ThoughtData[]): Map<string, ThoughtData> {
	const out = new Map<string, ThoughtData>();
	for (const t of history) out.set(thoughtKey(t), t);
	return out;
}

/** Score the frontier (graph leaves), skipping ids absent from history. */
function scoreFrontier(
	frontier: readonly string[],
	byKey: Map<string, ThoughtData>
): ScoredCandidate[] {
	const out: ScoredCandidate[] = [];
	for (const id of frontier) {
		const t = byKey.get(id);
		if (t !== undefined) out.push({ id, score: scoreThought(t) });
	}
	return out;
}

/** Highest score in a candidate set, or `-Infinity` when empty. */
function bestScore(scored: readonly ScoredCandidate[]): number {
	let best = Number.NEGATIVE_INFINITY;
	for (const c of scored) {
		if (c.score > best) best = c.score;
	}
	return best;
}

/** Recent per-thought scores, used for plateau detection. */
function recentScores(history: readonly ThoughtData[], window: number): number[] {
	const start = history.length > window ? history.length - window : 0;
	const out: number[] = [];
	for (let i = start; i < history.length; i++) out.push(scoreThought(history[i]!));
	return out;
}

/** Whether the current graph-visible thought has reached the configured depth cap. */
function isAtDepthCap(ctx: StrategyContext, depthCap: number): boolean {
	const depth = ctx.evidence.graph?.depthFromRoots(ctx.sessionId, thoughtKey(ctx.currentThought));
	return depth !== undefined && depth >= depthCap;
}

/**
 * Tree-of-Thought strategy: beam search over the thought DAG. Pure policy.
 *
 * @example
 * ```typescript
 * const strategy = new TreeOfThoughtStrategy({ beamWidth: 4 });
 * const decision = strategy.decide(ctx);
 * ```
 */
export class TreeOfThoughtStrategy implements IReasoningStrategy {
	readonly name = 'tot' as const;

	/** @param config - See {@link TotConfig}. */
	constructor(config?: TotConfig) {
		const beamWidth = config?.beamWidth ?? DEFAULTS.beamWidth;
		const depthCap = config?.depthCap ?? DEFAULTS.depthCap;
		const terminationConfidence = config?.terminationConfidence ?? DEFAULTS.terminationConfidence;
		const plateauWindow = config?.plateauWindow ?? DEFAULTS.plateauWindow;
		const plateauEpsilon = config?.plateauEpsilon ?? DEFAULTS.plateauEpsilon;
		if (!Number.isFinite(beamWidth) || !Number.isInteger(beamWidth) || beamWidth < 1) {
			throw new TypeError('beamWidth must be a finite positive integer');
		}
		if (!Number.isFinite(depthCap) || !Number.isInteger(depthCap) || depthCap < 0) {
			throw new TypeError('depthCap must be a finite nonnegative integer');
		}
		if (!Number.isFinite(plateauWindow) || !Number.isInteger(plateauWindow) || plateauWindow < 2) {
			throw new TypeError('plateauWindow must be a finite integer of at least 2');
		}
		if (!Number.isFinite(plateauEpsilon) || plateauEpsilon < 0) {
			throw new TypeError('plateauEpsilon must be a finite nonnegative number');
		}
		if (!Number.isFinite(terminationConfidence) || terminationConfidence < 0) {
			throw new TypeError('terminationConfidence must be a finite nonnegative number');
		}
		CONFIGS.set(this, {
			beamWidth,
			depthCap,
			terminationConfidence,
			plateauWindow,
			plateauEpsilon,
		});
	}

	/**
	 * Compute the next action for the chain.
	 *
	 * Order of checks: depth cap, frontier confidence, plateau over retained main-history scores,
	 * branch when the current thought is outside the beam, then continue. Missing graphs continue.
	 */
	decide(ctx: StrategyContext): StrategyDecision {
		const cfg = configOf(this);
		if (!ctx.evidence.graph) {
			return { action: 'continue' };
		}
		if (isAtDepthCap(ctx, cfg.depthCap)) {
			return { action: 'terminate', reason: 'depth cap' };
		}
		const frontier = ctx.evidence.graph.leaves(ctx.sessionId);
		const byKey = indexHistory(ctx.evidence.activeThoughts);
		const scored = scoreFrontier(frontier, byKey);
		if (scored.length > 0 && bestScore(scored) >= cfg.terminationConfidence) {
			return { action: 'terminate', reason: 'confidence threshold' };
		}

		const recent = recentScores(ctx.evidence.mainHistory, cfg.plateauWindow);
		if (detectPlateau(recent, cfg.plateauWindow, cfg.plateauEpsilon)) {
			return { action: 'terminate', reason: 'plateau' };
		}

		if (scored.length > cfg.beamWidth) {
			const beam = selectBeam(scored, cfg.beamWidth);
			const currentKey = thoughtKey(ctx.currentThought);
			if (!beam.includes(currentKey)) {
				return {
					action: 'branch',
					branchId: `tot-${ctx.currentThought.thought_number}`,
					fromThought: ctx.currentThought.thought_number,
					reason: 'outside beam',
				};
			}
		}

		return { action: 'continue', nextHint: 'explore frontier' };
	}

	/** True below the depth cap when the frontier is wider than the beam. */
	shouldBranch(ctx: StrategyContext): boolean {
		const cfg = configOf(this);
		if (!ctx.evidence.graph) return false;
		if (isAtDepthCap(ctx, cfg.depthCap)) return false;
		const frontier = ctx.evidence.graph.leaves(ctx.sessionId);
		return frontier.length > cfg.beamWidth;
	}

	/** True at the depth cap, confidence threshold, or score plateau. */
	shouldTerminate(ctx: StrategyContext): boolean {
		const cfg = configOf(this);
		if (!ctx.evidence.graph) return false;
		if (isAtDepthCap(ctx, cfg.depthCap)) return true;
		const frontier = ctx.evidence.graph.leaves(ctx.sessionId);
		const byKey = indexHistory(ctx.evidence.activeThoughts);
		const scored = scoreFrontier(frontier, byKey);
		if (scored.length > 0 && bestScore(scored) >= cfg.terminationConfidence) {
			return true;
		}
		const recent = recentScores(ctx.evidence.mainHistory, cfg.plateauWindow);
		return detectPlateau(recent, cfg.plateauWindow, cfg.plateauEpsilon);
	}
}
