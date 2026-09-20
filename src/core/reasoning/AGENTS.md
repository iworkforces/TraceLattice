# REASONING

**Parent:** ../AGENTS.md

## OVERVIEW

Two unrelated seams: `OutcomeRecorder` (calibration samples) and `strategies/` (policy). No shared state.

## STRUCTURE

```
reasoning/
├── OutcomeRecorder.ts
└── strategies/          # own AGENTS.md — contract method is decide(), not decideNext
```

## OUTCOMERECORDER

Dumb store. Records `VerificationOutcome` for `Calibrator`. Does not score.

Write path: **`thought_type === 'verification'` + `verification_result` ∈ {0,1}** via `prepareVerificationOutcome` / `recordVerification`.

**Not** `tool_call` / `tool_observation`.

| Field        | Notes                                               |
| ------------ | --------------------------------------------------- |
| `thoughtId`  | **target** hypothesis, not the verification thought |
| `predicted`  | target `confidence`                                 |
| `actual`     | `verification_result` 0\|1                          |
| `type`       | target `thought_type`                               |
| `recordedAt` | set by recorder                                     |

Gated by `outcomeRecording`. Disabled → all writes/reads no-op (`enabled` false, `getOutcomes` `[]`). Duplicate target in-session → `ValidationError` (`assertCanRecord`).

Methods: `assertCanRecord` · `recordVerification` · `getOutcomes` · `getAllOutcomes` · `clearOutcomes` · `clearAllOutcomes`.

DI key: `outcomeRecorder`.

## STRATEGIES

See `strategies/AGENTS.md`. Processor calls **`decide()`** only.
