# TEST SUITE

**Parent:** ../AGENTS.md

## OVERVIEW

Vitest under `src/__tests__/` (path-alias parity). Thresholds: branches 90 / functions 60 / lines 65 / statements 65. Single config: `vitest.config.ts`.

## WHERE NEW FILES GO

| Testing… | Put it in |
|----------|-----------|
| Shared doubles | `helpers/factories.ts` (extend; don't clone) |
| Sync fake clock | `helpers/timers.ts` |
| One core class / facet | `core/…` (`HistoryManager.ownership.test.ts`) |
| Compression unit | `compression/` |
| Pure `decide()` / scoring | `strategies/` + register in `StrategyContract` |
| Processor + backends + HTTP | `integration/` |
| Scored category vs baseline | `eval/battleTest/` (`RUN_EVAL=1`) |
| CI/CD / pack / transport ban | `release/` (own AGENTS.md) |
| Extra branch coverage | `*-cov.test.ts` stay at **suite root** |

Mirror `src/foo/Bar.ts` → `src/__tests__/foo/Bar.test.ts` for **new** files. Older kebab-case files at suite root stay.

## CONVENTIONS

- Feature flags via **constructor**, never env.
- Spread only asserted fields on `createTestThought`.
- Branded IDs: `createTestSessionId()` etc. — not `generateUlid`.
- One concern per `it`. `it.skip` / `skipIf` needs a local comment.
- `await` shutdowns / `store.stop()` in `afterEach`.
- `*.eval.ts` gated by `RUN_EVAL`. `*.test-d.ts` are type-only (tsc, not vitest include).
- Only colocated suite: `src/metrics/__tests__/metrics.test.ts`.
