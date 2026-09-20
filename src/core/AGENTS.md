# CORE DOMAIN

## OVERVIEW

Reasoning engine: ingest → graph mutation → quality signals → strategy. `HistoryManager` owns live session maps. `ThoughtProcessor` is the only admission seam.

## PIPELINE

`ThoughtProcessor.process()`:

1. **prepare** (unlocked): `normalizeInput` → valibot requires explicit named `session_id` → re-normalize → bump `total_thoughts` → flag type gates
2. **admit**: `SessionLifecycleCoordinator.runOperation` (or exclusive reset)
3. **lock**: `SessionLock.withLock` (~5s)
4. **cross-ref** `CrossReferenceValidator` + optional reset / `registerBranch`
5. **persist**: `tool_call` → suspend envelope (skip evaluate/strategy); `tool_observation` → `compareAndAdmit`; else `addThought`
6. **outcome** + calibrator `refit` (verification only)
7. **format** → **evaluate** → max-3 warning hints (cooldown on processor, not detector)
8. **strategy** `decide()`. On `terminate` + `branch_id` + compression wired → rollup

## SUBSYSTEMS

| Dir / cluster       | Role                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `graph/`            | Edges + `EdgeEmitter` (moved here) + `GraphView`                                                        |
| `compression/`      | Deterministic `Summary` rollup                                                                          |
| `evaluator/`        | Signals / stats / patterns / calibrator                                                                 |
| `tools/`            | `InMemorySuspensionStore`                                                                               |
| `reasoning/`        | `OutcomeRecorder` + `strategies/`                                                                       |
| Session cluster     | `SessionManager` (policy only), `SessionLock`, `SessionLifecycleCoordinator`, `SessionResetCoordinator` |
| Persistence cluster | `PersistenceBuffer` / `PersistenceWriter` / `PersistenceWorkQueue` / `PersistenceRestore`               |

## WHERE TO LOOK

| Task                  | File                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Add a thought type    | `contracts/reasoning-types.ts` + `thought.ts` + processor gates + `totScoring` `assertNever`       |
| Change pipeline order | `ThoughtProcessor.ts` — extract helpers, don't reorder casually                                    |
| Edge emit             | `graph/EdgeEmitter.ts`                                                                             |
| Session eviction      | `SessionManager` (TTL 30min, cap 100, 50/owner). Every entry is an explicit named thought session. |
| Drain / barriers      | `PersistenceBuffer.ts`                                                                             |
| Outcome samples       | `VerificationOutcomeAdmission.ts` — verification + `verification_result` 0\|1 only                 |

## NOTES

- Branch thoughts are appended to **both** `thought_history` and `session.branches[id]`.
- Backtrack is append-only (`retracted: true`). Evaluator filters retracted.
- Public clearing is awaitable: `resetSession(sessionId)` or `resetAll()` coordinates admission, locks, persistence barriers, and auxiliary state.
- Thought processing and scoped reads require a named session; omitted sessions and retired `__global__` fail validation. Successful processor responses always include `session_id`.
- `resetAll()` and shutdown deliberately coordinate every thought session. MCP transport sessions, request owners, and `ConnectionPool` slots do not provide thought-session defaults.
- Restored sessions (`provenance: 'restored'`) deny owner-aware access.
- Processor ctor default is imported `DEFAULT_FLAGS` — **all on**. JSDoc saying “off” is stale. Tests that need off must pass explicit flags.
- Hint cooldown `Map<SessionId, Map<PatternName, number>>` is wiped by production exclusive reset via `clearSessionAuxiliaryState`. Survives only mocks that skip that callback.
- `ISessionLock` is `withLock` / `isActive` / `size` — not acquire/release. `@internal` — only HM / processor / DI.
- ToT `depthCap` (default 8) uses `GraphView.depthFromRoots`. Isolated thoughts are invisible to the graph.
