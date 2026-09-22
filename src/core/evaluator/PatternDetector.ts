/**
 * Pattern detection for sequential thinking reasoning analytics.
 *
 * Provides the {@link PatternDetector} class — a stateless service that detects
 * reasoning patterns (anti-patterns and positive signals) from thought history.
 * Extracted from {@link ThoughtEvaluator} to keep concerns isolated and reduce
 * cyclomatic complexity per function.
 *
 * Detected patterns:
 * - `consecutive_without_verification` (warning) — 3+ consecutive regular thoughts
 *   without a verification step
 * - `unverified_hypothesis` (warning) — hypothesis not verified within 3 subsequent
 *   thoughts
 * - `no_alternatives_explored` (info) — 5+ thoughts with no critique and no branches
 * - `monotonic_type` (info) — 4+ consecutive thoughts with the same thought_type
 *   (requires ≥1 explicit type and ≥5 thoughts)
 * - `confidence_drift` (warning) — 3+ consecutive thoughts with strictly decreasing
 *   confidence
 * - `healthy_verification` (info) — hypothesis verified within 3 subsequent thoughts
 *
 * @module core/evaluator/PatternDetector
 */

import type { PatternSignal } from '../reasoning.js';
import type { ThoughtData } from '../thought.js';
import type { VerificationLinks } from './VerificationLinks.js';

/**
 * Stateless service that detects reasoning patterns from thought history.
 *
 * @remarks
 * All methods are pure computations — no side effects, no I/O, no internal state.
 * Designed to be registered as transient in the DI container or composed directly
 * into {@link ThoughtEvaluator}.
 *
 * @example
 * ```typescript
 * const detector = new PatternDetector();
 * const signals = detector.computePatternSignals(history, branches);
 * const warnings = signals.filter((s) => s.severity === 'warning');
 * ```
 */
export class PatternDetector {
	/**
	 * Detect all reasoning patterns from history and branches.
	 *
	 * @param history - All thoughts in the current session
	 * @param branches - Map of branch IDs to their thought arrays
	 * @returns Array of detected pattern signals (possibly empty)
	 */
	public computePatternSignals(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>,
		links: VerificationLinks
	): PatternSignal[] {
		if (history.length === 0) return [];

		const signals: PatternSignal[] = [];
		signals.push(...this._detectConsecutiveWithoutVerification(history));
		signals.push(...this._detectUnverifiedHypothesis(history, links));
		signals.push(...this._detectNoAlternativesExplored(history, branches));
		signals.push(...this._detectMonotonicType(history));
		signals.push(...this._detectConfidenceDrift(history));
		signals.push(...this._detectHealthyVerification(history, links));
		return signals;
	}

	/** Detect runs of 3+ consecutive thoughts without verification. */
	private _detectConsecutiveWithoutVerification(history: ThoughtData[]): PatternSignal[] {
		const signals: PatternSignal[] = [];
		let runStart = 0;
		for (let i = 0; i < history.length; i++) {
			const type = history[i]!.thought_type ?? 'regular';
			if (type === 'verification') {
				runStart = i + 1;
				continue;
			}
			if (i - runStart + 1 >= 3) {
				const start = history[runStart]!.thought_number ?? runStart + 1;
				const end = history[i]!.thought_number ?? i + 1;
				signals.push({
					pattern: 'consecutive_without_verification',
					severity: 'warning',
					message: `3+ consecutive thoughts (${start}-${end}) without verification`,
					thought_range: [start, end],
				});
				runStart = i + 1;
			}
		}
		return signals;
	}

	/** Detect hypothesis thoughts not verified within 3 subsequent thoughts. */
	private _detectUnverifiedHypothesis(
		history: ThoughtData[],
		links: VerificationLinks
	): PatternSignal[] {
		const signals: PatternSignal[] = [];
		for (let i = 0; i < history.length; i++) {
			const hypothesis = history[i]!;
			if (
				hypothesis.thought_type !== 'hypothesis' ||
				!hypothesis.id ||
				!links.hypothesisIds.has(hypothesis.id)
			) {
				continue;
			}
			const remaining = history.length - i - 1;
			if (remaining < 3) continue;
			const lookahead = history.slice(i + 1, i + 4);
			const hasVerification = lookahead.some((verifier) => links.verifies(verifier, hypothesis));
			if (!hasVerification) {
				const n = hypothesis.thought_number ?? i + 1;
				signals.push({
					pattern: 'unverified_hypothesis',
					severity: 'warning',
					message: `Hypothesis at thought ${n} has not been verified within 3 thoughts`,
					thought_range: [n, n],
				});
			}
		}
		return signals;
	}

	/** Detect 5+ thoughts with no critique and no branches. */
	private _detectNoAlternativesExplored(
		history: ThoughtData[],
		branches: Record<string, ThoughtData[]>
	): PatternSignal[] {
		if (history.length < 5) return [];
		if (history.some((t) => t.thought_type === 'critique')) return [];
		if (Object.keys(branches).length > 0) return [];
		const start = history[0]!.thought_number ?? 1;
		const end = history[history.length - 1]!.thought_number ?? history.length;
		return [
			{
				pattern: 'no_alternatives_explored',
				severity: 'warning',
				message: '5+ thoughts with no critique or branching — consider exploring alternatives',
				thought_range: [start, end],
			},
		];
	}

	/**
	 * Detect runs of 4+ consecutive thoughts with the same thought_type.
	 * Only fires when history has ≥5 thoughts and at least one explicitly set thought_type.
	 */
	private _detectMonotonicType(history: ThoughtData[]): PatternSignal[] {
		if (history.length < 5) return [];
		const hasExplicitType = history.some((t) => t.thought_type !== undefined);
		if (!hasExplicitType) return [];

		const signals: PatternSignal[] = [];
		let runType = history[0]!.thought_type ?? 'regular';
		let runStart = 0;
		let runLength = 1;

		for (let i = 1; i < history.length; i++) {
			const type = history[i]!.thought_type ?? 'regular';
			if (type === runType) {
				runLength++;
			} else {
				this._flushMonotonicRun(history, runStart, runLength, runType, signals);
				runType = type;
				runStart = i;
				runLength = 1;
			}
		}
		this._flushMonotonicRun(history, runStart, runLength, runType, signals);
		return signals;
	}

	/** Emit a monotonic_type signal if the run length qualifies. */
	private _flushMonotonicRun(
		history: ThoughtData[],
		runStart: number,
		runLength: number,
		runType: string,
		signals: PatternSignal[]
	): void {
		if (runLength < 4) return;
		const start = history[runStart]!.thought_number ?? runStart + 1;
		const end = history[runStart + runLength - 1]!.thought_number ?? runStart + runLength;
		signals.push({
			pattern: 'monotonic_type',
			severity: 'warning',
			message: `4+ consecutive '${runType}' thoughts (${start}-${end}) — consider varying approach`,
			thought_range: [start, end],
		});
	}

	/** Detect runs of 3+ consecutive thoughts with strictly decreasing confidence. */
	private _detectConfidenceDrift(history: ThoughtData[]): PatternSignal[] {
		const signals: PatternSignal[] = [];
		let runStart = -1;
		let runLength = 0;
		let prevConf = -1;

		for (let i = 0; i < history.length; i++) {
			const conf = history[i]!.confidence;
			if (conf === undefined) {
				this._flushDriftRun(history, runStart, runLength, signals);
				runStart = -1;
				runLength = 0;
				prevConf = -1;
				continue;
			}
			if (runLength === 0) {
				runStart = i;
				runLength = 1;
				prevConf = conf;
			} else if (conf < prevConf) {
				runLength++;
				prevConf = conf;
			} else {
				this._flushDriftRun(history, runStart, runLength, signals);
				runStart = i;
				runLength = 1;
				prevConf = conf;
			}
		}
		this._flushDriftRun(history, runStart, runLength, signals);
		return signals;
	}

	/** Emit a confidence_drift signal if the run length qualifies. */
	private _flushDriftRun(
		history: ThoughtData[],
		runStart: number,
		runLength: number,
		signals: PatternSignal[]
	): void {
		if (runLength < 3) return;
		const first = history[runStart];
		const last = history[runStart + runLength - 1];
		if (!first || !last) return;
		if (first.confidence === undefined || last.confidence === undefined) return;
		const start = first.thought_number ?? runStart + 1;
		const end = last.thought_number ?? runStart + runLength;
		const firstConf = first.confidence;
		const lastConf = last.confidence;
		signals.push({
			pattern: 'confidence_drift',
			severity: 'warning',
			message: `Confidence decreasing across thoughts ${start}-${end} (${firstConf} → ${lastConf})`,
			thought_range: [start, end],
		});
	}

	/** Detect hypothesis verified within 3 subsequent thoughts — positive signal. */
	private _detectHealthyVerification(
		history: ThoughtData[],
		links: VerificationLinks
	): PatternSignal[] {
		const signals: PatternSignal[] = [];
		for (let i = 0; i < history.length; i++) {
			const hypothesis = history[i]!;
			if (
				hypothesis.thought_type !== 'hypothesis' ||
				!hypothesis.id ||
				!links.hypothesisIds.has(hypothesis.id)
			) {
				continue;
			}
			const lookahead = history.slice(i + 1, i + 4);
			const verifier = lookahead.find((candidate) => links.verifies(candidate, hypothesis));
			if (verifier) {
				const n = hypothesis.thought_number ?? i + 1;
				const m = verifier.thought_number ?? history.indexOf(verifier) + 1;
				signals.push({
					pattern: 'healthy_verification',
					severity: 'info',
					message: `Hypothesis at thought ${n} verified at thought ${m} — good practice`,
					thought_range: [n, m],
				});
			}
		}
		return signals;
	}
}
