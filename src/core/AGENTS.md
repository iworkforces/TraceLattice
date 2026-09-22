# CORE DOMAIN

**Parent:** ../AGENTS.md

## OVERVIEW

Reasoning engine: ingest → graph mutation → quality signals → strategy. `HistoryManager` owns live session maps. `ThoughtProcessor` is the only admission seam.

## PIPELINE

`ThoughtProcessor.process()`:

1. **prepare** (unlocked): `normalizeInput` → valibot requires a named `session_id` → re-normalize → bump `total_thoughts` only when `thought_number` exceeds it → flag type gates
2. **admit**: `SessionLifecycleCoordinator.runOperation` (or exclusive reset)
3. **lock**: `SessionLock.withLock` (~5s) when a lock is wired
4. **inside the lock**: cross-ref → verification-outcome check → optional reset → identity admission → `registerBranch`
5. **persist**: `tool_call` returns a suspend envelope and skips the rest; `tool_observation` → `compareAndAdmit`; else `addThought`
6. **outcome** + calibrator `refit` (verification only)
7. **format** → **evaluate** → max-3 warning hints (cooldown on processor, not detector)
8. **strategy** `decide()` on the active-evidence projection. On `terminate` + `branch_id` + compression wired → rollup

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
| Durable thought id    | `DurableThoughtIdentityIndex.ts` — unique per session while live, queued, or durable               |
| Target restore        | `VerificationTargetRestore.ts` — canonical verification target across restart                      |

## NOTES

- Every thought is appended to `thought_history`. A branch copy is stored only when both `branch_from_thought` and `branch_id` are set.
- Thought IDs admit once per named session while live, queued, or durable. Admission rejects duplicates before branch registration, history, graph, outcome, suspension, or persistence side effects; cross-session reuse is allowed and ownership releases only when every owned copy is discarded.
- Backtrack is append-only (`retracted: true`). Evaluator filters retracted.
- Verification resolves its canonical retained stable target before mutation. An explicit target is authoritative; duplicate, missing, ambiguous, and id-less canonical targets fail closed. A legacy label can resolve only one identity-bearing target. This verification outcome-key check is distinct from thought-ID duplicate admission.
- Public clearing is awaitable: `resetSession(sessionId)` or `resetAll()` coordinates admission, locks, persistence barriers, and auxiliary state.
- Thought processing and scoped reads require a named session; omitted sessions and retired `__global__` fail validation. Successful processor responses always include `session_id`.
- `resetAll()` and shutdown deliberately coordinate every thought session. MCP transport sessions, request owners, and `ConnectionPool` slots do not provide thought-session defaults.
- Restored sessions (`provenance: 'restored'`) deny owner-aware access.
- Processor ctor default is imported `DEFAULT_FLAGS` — **all on**. JSDoc saying “off” is stale. Tests that need off must pass explicit flags.
- Hint cooldown `Map<SessionId, Map<PatternName, number>>` is wiped by production exclusive reset via `clearSessionAuxiliaryState`. Survives only mocks that skip that callback.
- `decide()` reads `buildActiveEvidenceProjection` (`reasoning/ActiveEvidenceProjection.ts`), not the live `EdgeStore`.
- `ISessionLock` (`contracts/interfaces.ts`) is `withLock` / `isActive` / `size` — not acquire/release. Call sites: HistoryManager, ThoughtProcessor, ServiceRegistry.
- ToT `depthCap` (default 8) uses `GraphView.depthFromRoots`. Isolated thoughts are invisible to the graph.
