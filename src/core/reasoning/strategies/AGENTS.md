# STRATEGIES

**Parent:** ../AGENTS.md

## OVERVIEW

Pure next-action policy over an immutable active `StrategyContext` projection. No I/O or graph mutation. The projection deep-copies active retained evidence, preserves main-history order, includes branch-only lookup, and induces a graph only between active endpoints. It never contracts paths or changes the audit store.

`reasoningStrategy` (`sequential` \| `tot`) picks the impl **at wire time** (`createReasoningStrategy`).

## STRUCTURE

```
strategies/
├── SequentialStrategy.ts
├── TreeOfThoughtStrategy.ts
├── StrategyFactory.ts     # assertNever on name
├── totScoring.ts          # scoreThought / selectBeam / breadthFirstFrontier
└── plateau.ts             # range + no upward trend
```

## CONTRACT

`IReasoningStrategy` (`src/contracts/strategy.ts`): `name` + `decide` + `shouldBranch` + `shouldTerminate`.

**Processor only calls `decide()`.** The predicates exist for tests / other callers.

## SEQUENTIAL

Terminates when `next_thought_needed === false`. Otherwise **continue**. Not “always continue”.

`shouldBranch` iff `branch_from_thought` + `branch_id` set.

## TOT

`decide` order:

- No `ctx.evidence.graph` → **`continue`** (no active graph, no search).
- `graph.depthFromRoots(current) >= depthCap` (default **8**) → terminate (`reason: 'depth cap'`). Isolated thoughts are invisible → no cap.
- Frontier = **`graph.leaves()`**, **not** `breadthFirstFrontier` (`totScoring` helper is unused on this path).
- Score ≥ `terminationConfidence` (default 0.85) → terminate.
- `detectPlateau` on **recent active main-history scores** (not frontier) → terminate.
- Current thought outside top-`beamWidth` leaves → `branch`.
- Else continue.

Config lives in a **module `WeakMap`**, not on `this`. Defaults: `beamWidth=3`, `depthCap=8`, `terminationConfidence=0.85`, plateau 3/0.02. `terminationConfidence` is finite and nonnegative; values above 1 are valid.

## SCORING

`(calibrated_confidence ?? confidence ?? 0) * (quality_score ?? 0.5) * typeWeight`

**No novelty term.**

Type weights: `assumption` 0.5 · `decomposition` 1.2 · `backtrack` 0.8 · else 1.0.

`getTypeWeight` / factory: `assertNever` on `ThoughtType` / strategy name.

## ANTI-PATTERNS

- Do not persist, log, or mutate from `decide`.
- Do not wire `shouldTerminate` / `shouldBranch` into the processor.
- Do not treat `breadthFirstFrontier` as the live ToT frontier.
