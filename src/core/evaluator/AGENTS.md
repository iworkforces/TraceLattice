# EVALUATOR

**Parent:** ../AGENTS.md

## OVERVIEW

Specialists only. Facade is parent `ThoughtEvaluator`. Patterns drop `retracted` thoughts. Signals and stats use `VerificationLinks` (active main plus branch-only).

## COMPONENTS

| File | Role |
|------|------|
| `SignalComputer.ts` | `ConfidenceSignals` + structural quality |
| `Aggregator.ts` | `ReasoningStats` |
| `PatternDetector.ts` | Firehose of pattern signals |
| `Calibrator.ts` | Shrinkage + optional temperature |
| `calibration-math.ts` | `TEMPERATURE_GRID`, `MIN_OUTCOMES_FOR_TEMPERATURE=10` |
| `internals.ts` | `ALL_THOUGHT_TYPES` — **must stay 11-wide** |
| `VerificationLinks.ts` | Active set + canonical verification targets |

## SIGNALCOMPUTER

`type_diversity` = Shannon entropy / **`log2(6)`** even though there are **11** types. Do not “fix” the divisor without a scoring-compat decision.

Other components: `verification_coverage`, `depth_efficiency`, `confidence_stability` (null when n<2). Geomean, floor 0.01; no-cs weights renormalize.

## PATTERNS / HINTS

Detector is a **firehose**. Hint selection lives on **`ThoughtProcessor`**, not here.

- Warning-only, **max 3**, **3-thought cooldown**.
- Cooldown is **not** on the detector. Map **survives `reset_state`** (cleared only via processor auxiliary-state wipe).

Processor priority (lower first):

1. `confidence_drift`
2. `unverified_hypothesis`
3. `no_alternatives_explored`
4. `consecutive_without_verification`

`monotonic_type` is **warning** but **unranked (99)** — after the four. `healthy_verification` is **info**, never a hint.

Detector still emits all six (`PatternName` in `contracts/reasoning-types.ts`).

## CALIBRATOR

Actual math: **raw-signal prior blended with the per-type empirical mean** (`priorWeight = 10/(10+n)`; empty type mean 0.5 receives zero empirical weight). There are no Beta α/β counters, and cold start returns raw confidence exactly.

- Temperature applied only if outcomes **≥ 10**. Else identity on the blended value.
- `refit` scores T against per-type leave-one-out blends; inference uses all observed type outcomes before T.
- Mutable **per-session T map** (`refit` writes it). Grid in `calibration-math.ts`: `{0.5, 0.75, 1.0, 1.25, 1.5, 2.0}`. Exact ties prefer T=1, then grid order.
- Brier + 10-bin ECE. `perTypeBrier` keyed by all 11 types.

Outcomes come from `OutcomeRecorder` (verification path) — not this dir.
