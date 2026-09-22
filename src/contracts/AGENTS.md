# CONTRACTS MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

Cross-module type hub. No barrel. Import the specific file.

## FILES

| File                    | Exports                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interfaces.ts`         | `IMetrics`, `IDiscoveryCache`, `IEdgeStore` (+ `pruneSession`/`clearAll`), `IGraphViewStore`, `IOutcomeRecorder`, `IToolRegistry`, `ISessionLock` (`withLock`/`isActive`/`size`) |
| `strategy.ts`           | `IReasoningStrategy.decide` (not `decideNext`), `shouldBranch`, `shouldTerminate`                                                                             |
| `summary.ts`            | `ISummaryStore` (`add`/`get`/`forSession`/`forBranch`/`clearSession`/`clearAll`/`size`). `Summary` value stays in `core/compression/Summary.ts`                  |
| `calibrator.ts`         | `ICalibrator`, metrics/result types                                                                                                                           |
| `suspension.ts`         | `ISuspensionStore` (`suspend`/`resume`→null/`compareAndAdmit`/`peek`/`expireOlderThan`)                                                                       |
| `ids.ts`                | branded IDs. Only `asSessionId()` validates, including rejection of retired `__global__`. `asBranchId()` does **not**.                                        |
| `reasoning-types.ts`    | `ThoughtType` (11), `PatternName` (6)                                                                                                                         |
| `features.ts`           | `FeatureFlags`, `DEFAULT_FLAGS`. **No `hasFeature()`**.                                                                                                       |
| `transport.ts`          | `ITransport`                                                                                                                                                  |
| `PersistenceBackend.ts` | Session-scoped persistence contract + config                                                                                                                  |
| `persistence-work.ts`   | Queue jobs (`thought`, `backtrack`, coalesced branch/edge/summary snapshots) and tokens                                                                       |

## RULES

- Cross-module types go through here.
- Stay in `core/`: `IHistoryManager`, `ThoughtData`, `ConfidenceSignals`/`ReasoningStats`, `Edge`/`EdgeKind`, `Summary` value type.
- Define interface here, implement in the owning module. Do not import implementations across modules.
- Thought-scoped contracts require an explicit `SessionId`; do not add optional parameters, default-session constants, or fallback sentinels. Optional aggregate filters are not thought-session admission.
- `clearAll` remains an explicit all-session administrative operation. MCP `Mcp-Session-Id` and pool slot identifiers are separate contracts.
