# EVAL SUITE

**Parent:** ../AGENTS.md

## OVERVIEW

Scored category regression + precision regression + ToT-vs-Sequential behavioral diff. All three local suites run by default in Vitest via `npm test`, `npm run test:coverage`, and `npm run verify:release`. Do not park battle scoring in `integration/` or `strategies/`.

## STRUCTURE

```
eval/
├── battleTest.eval.ts          # Runs runBattleTest()
├── totVsSequential.eval.ts     # ToT vs Sequential report (not battle)
├── precisionRegression.eval.ts # Fixed clock 2026-01-01
├── fixtures/scenarios.ts       # 10 ToT trajectories — not battle cases
└── battleTest/
    ├── runner.ts / calculator.ts / gates.ts / reporter.ts / baseline.ts
    ├── baseline.json / overrides.json
    └── scenarios/              # 11 category files + all.ts + helpers.ts
```

## BATTLE PIPELINE

`scenarios/*.ts` → `runScenarios` → calculator → gates vs `baseline.json` + `overrides.json` → reporter.

- 11 categories × 3 scenarios = 33. Unique `caseId`. Register in the category file **and** `scenarios/all.ts`.
- `BattleScenario.run()` may return a `Promise` (`stateIsolation` awaits `resetSession`). Double-run equality is still required (`scenarios.test.ts`). `battleTest/**/*.test.ts` and all three `*.eval.ts` files run in default CI.
- `scoreChecks({ checks })` → 0/100 dimensions; average is the case score.
- Isolation (`state-isolation-and-reset`) + malformed (`malformed-and-edge-inputs`) gate **0**. Other categories allow drop **5**.
- `overrides.json` entries need `owner`, `reason`; optional `expiresAt` / `caseIds`. Empty array is fine.

## ToT vs SEQUENTIAL

`totVsSequential.eval.ts` consumes `eval/fixtures/scenarios.ts` (10 trajectories: converge, plateau, dead-end, branch, …). Different catalog from `battleTest/scenarios/`. Behavioral diff / JSON report, separate from strategy unit tests. Expected-behavior mismatches fail the eval.

## CONVENTIONS

- Do not assert production APIs except as scoring inputs.
- Categories live in `CATEGORY_NAMES` (`battleTest/types.ts`). New category = 3 cases + baseline averages + gate.
- Critical failures (`cross-session-leakage`, `malformed-input-crash`, …) force `blocked` even with an override.
- Reporter prints one JSON line per category plus a summary. `overallStatus === 'blocked'` fails the eval.

## NOTES

- Invoke locally: `npm test`.
- `baseline.json` is the approved snapshot; bump only with a reviewed score change.
- Do not import battle helpers from integration or strategy unit tests.
