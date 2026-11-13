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
7. **format** → build active-evidence projection **once** (one clone per active thought) → `computeAdmissionSignals` shares live verification links and filtered branches across graph-aware signals/stats/patterns → max-3 warning hints (cooldown on processor, not detector)
8. **strategy** `decide()` and response `graph_context` read that same projection. On `terminate` + `branch_id` + compression wired → rollup

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
- Persistence backlog: `HistoryManager.assertThoughtIdentityAvailable` (authorize, duplicate id, then `PersistenceBuffer.assertThoughtBacklogAvailable`) rejects with `PERSISTENCE_BACKLOG_FULL` before any mutation once `PersistenceWorkQueue.pendingThoughtCountForSession` reaches `persistenceMaxPendingThoughtsPerSession` (terminal failures count). `bufferThought`/`bufferBacktrack` never throw on backlog. Each rejection joins or starts an explicit drain without awaiting it; explicit drains retry terminal failures at once.
- Durable write order: `PersistenceWorkQueue` selection holds every entry a session accepted after its oldest retained thought/backtrack failure (all kinds, also within one generation) until that write succeeds or `discardSession`/`discardAll`. Failed branch/edge/summary snapshots never hold. Background (timer/size) generations retry a retained failure once `now >= retryAfter`, backoff `min(flushInterval * 2^(n-1), 60000)` driven by the existing flush tick and `PersistenceBufferConfig.clock`; no extra timers. Retry state lives on the queue entry. `_sessionQuiescence` never resolves while the session has a retained thought/backtrack failure. Background generations emit `persistenceError` only for a newly retained failure. Background recovery never clears reset or eviction quarantine.
- Write deadline: `PersistenceWriter` ends an attempt at `persistenceWriteTimeout` with a `PersistenceWriteTimeoutError` cause (its `lateOutcome` reports the same call) and never retries it. `SessionResetCoordinator` bounds only `clearSession`/`clearAll` with `callWithinDeadline` (call kinds `clearSession`/`clearAll`). Either kind of timed-out call closes the write gate (`PersistenceWriteGate`, an insertion-ordered set of `work` and `clear` stalls; the oldest is reported): no dispatch, inert timer/size triggers, explicit drains and every barrier reject with the oldest stall's error, and both reset barriers fail before `clearSession`/`clearAll`, so a retried reset never sends a second clear. The barriers recognise a clear stall in `_runResetOperation` by the error's call kind. `_reopenWriteGate` applies a late write outcome once (`acknowledgeSuccess` or `replaceFailureCause`, never a second retry-state bump); a settled clear touches no queue entry and lifts no quarantine, so the reset stays failed. The gate reopens when the set is empty. `_runResetOperation` also marks the clear in flight from its start until the barrier has discarded the reset scope, and runs clears one at a time: drain generations wait for it before selecting work, so no write is dispatched next to a clear. A clear may still start while another session's write is in flight (pinned by `PersistenceWriteDeadline.test.ts` 'settles stop behind a reset…'). `_dispatchBlocked()` is the one dispatch predicate. A write's retry attempts obey the same rules as its first attempt: `PersistenceWriter` asks `admitRetry` after each retry delay, never before the first attempt; `_retryAdmitted` answers with the clear's settlement while a clear is in flight and the gate is open (the writer then asks again) and otherwise answers synchronously, and the writer dispatches in the same step as a `true` answer, so a reset queued behind the same clear cannot start its own clear between the admission and the dispatch. A refused retry ends the write as a retained failure of the attempts made, with the cause of the last real attempt and never a gate error. A generation that dispatched a timed-out write, or that the closed gate stopped, rejects with a timeout error, never resolves. `drainSession(S)` rejects for a timeout only while S has queued or failed work or owns a pending stall (`clearAll` belongs to every session). A background generation reports a timeout only when the write is newly retained or was superseded (`isRetainedFailure`); explicit generations always report. Selection is untouched; `undefined` timeout = no gate, but the clear-in-flight hold still applies.
- Shutdown seal: `HistoryManager.shutdownWithinLifecycle(flushTimeoutMs?)` stages restore-branch reconciliation, then calls `PersistenceBuffer.closeForShutdown(timeoutMs?)`. The seal closes admission first: `buffer*`, `assertSessionAdmissionOpen`, `assertThoughtBacklogAvailable` and every barrier's quiescence wait throw `SessionLifecycleClosedError` (`shutting_down`) without touching the queue, and timer/size triggers start nothing. This closes the seams abandoned operations reach without `runMutation`; `_runResetOperation` re-checks the seal after waiting for a clear in flight, so a reset queued behind another clear never sends its own. Then one explicit drain runs; without a timeout it is unbounded. With one, `_dispatchSealed` (the third term of `_dispatchBlocked()`) is set as soon as the drain settles or the bound elapses, so no backend call starts once the server's close begins. At the bound the method rejects with `ServerStopTimeoutError('flush', ms, queue.pendingWorkCount)`. A generation stopped by that seal with eligible work left rejects with `SessionLifecycleClosedError`, never resolves. `lib.ts` derives the idle, flush and close deadlines in `ServerStopBudget.ts`.
- Verification resolves its canonical retained stable target before mutation. An explicit target is authoritative; duplicate, missing, ambiguous, and id-less canonical targets fail closed. A legacy label can resolve only one identity-bearing target. This verification outcome-key check is distinct from thought-ID duplicate admission.
- `eviction_failed` recovery spans three owners. `SessionLifecycleCoordinator` admits a reset from `eviction_failed` (`retryFrom`) and notifies `onSessionExclusiveFailed` listeners; `HistoryManager` mirrors every failed exclusive into `PersistenceBuffer.quarantineFailedSession` and adds `sessionsInPhase('eviction_failed')` filtered by `canRetryEviction` to each sweep tick; the retry barrier (`withSessionEvictionBarrier(…, { retry: true })`) waits with background selection. Quarantine sets live in `PersistenceQuarantine`; the backlog view counts reset-quarantined and eviction-retry sessions disjointly.
- Public clearing is awaitable: `resetSession(sessionId)` or `resetAll()` coordinates admission, locks, persistence barriers, and auxiliary state. A reset abandoned by an overrun stop rejects: `SessionResetCoordinator` runs the live replacement through `runLiveReplacement` (`SessionLifecycleCoordinator.runMutation`), so live and auxiliary state stay as they were even when its clear succeeds late.
- Thought processing and scoped reads require a named session; omitted sessions and retired `__global__` fail validation. Successful processor responses always include `session_id`.
- `resetAll()` and shutdown deliberately coordinate every thought session. MCP transport sessions, request owners, and `ConnectionPool` slots do not provide thought-session defaults.
- Restored sessions (`provenance: 'restored'`) deny owner-aware access.
- Processor ctor default is imported `DEFAULT_FLAGS` — **all on**. JSDoc saying “off” is stale. Tests that need off must pass explicit flags.
- Hint cooldown `Map<SessionId, Map<PatternName, number>>` is wiped by production exclusive reset via `clearSessionAuxiliaryState`. Survives only mocks that skip that callback.
- `decide()` reads `buildActiveEvidenceProjection` (`reasoning/ActiveEvidenceProjection.ts`), not the live `EdgeStore`.
- `ISessionLock` (`contracts/interfaces.ts`) is `withLock` / `isActive` / `size` — not acquire/release. `withLock` is called from HistoryManager and ThoughtProcessor. `lib.ts` constructs `SessionLock`. ServiceRegistry only types the key.
- ToT `depthCap` (default 8) uses `GraphView.depthFromRoots`. Isolated thoughts are invisible to the graph.
