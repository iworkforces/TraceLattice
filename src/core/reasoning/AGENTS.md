# REASONING

**Parent:** ../AGENTS.md

## OVERVIEW

Three seams, no shared mutable store: `OutcomeRecorder` (calibration samples), `ActiveEvidenceProjection` (what `decide()` reads), and `strategies/` (policy).

## STRUCTURE

```
reasoning/
├── OutcomeRecorder.ts
├── ActiveEvidenceProjection.ts   # retained copy + induced GraphView
└── strategies/                   # own AGENTS.md — decide(), not decideNext
```

## ACTIVE EVIDENCE

`buildActiveEvidenceProjection` deep-copies retained main history plus branch-only thoughts and induces a graph on active endpoints only. `decide()` reads that projection, not the live `EdgeStore`.

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

Gated by `outcomeRecording`. Disabled → all writes/reads no-op (`enabled` false, `getOutcomes` `[]`). Duplicate outcome target in-session → `ValidationError` (`assertCanRecord`); this outcome-key guard is separate from thought-ID admission. The target is resolved before mutation: an explicit stable target is authoritative, while legacy labels require one identity-bearing target. Missing, ambiguous, id-less, and retracted targets fail closed. Cross-session outcome reuse is allowed.

Methods: `assertCanRecord` · `recordVerification` · `getOutcomes` · `getAllOutcomes` · `clearOutcomes` · `clearAllOutcomes`.

DI key: `outcomeRecorder`.

## STRATEGIES

See `strategies/AGENTS.md`. Processor calls **`decide()`** only.
