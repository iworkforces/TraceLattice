# INTEGRATION TESTS

**Parent:** ../AGENTS.md

## OVERVIEW

Cross-module + child-process harnesses. New multi-module work goes HERE, not suite root. Unit facets stay in `core/`, `compression/`, `strategies/`. Battle scoring stays in `eval/`.

## CLUSTERS

| Cluster | Files |
|---------|-------|
| Persistence matrix | PersistenceConformance, NativeSqliteConformance, PartitionedRestore, dag-edges, FileWriterOwnership, RetractionPersistence |
| Verification / precision | VerificationOutcome, VerificationTargetPersistence, NativeVerificationTargetRestore, PrecisionRegression |
| Compression e2e | CompressionAutoTrigger, CompressionPersistence, CompressionCoordinatorPersistence — not `__tests__/compression/` |
| Strategy e2e | StrategyIntegration, ToTStrategyIntegration |
| Session / config | SessionLifecycle, SessionReset*, ContinuationOwnership, EffectiveConfiguration, ServerLifecycleConfiguration, DiscoveryRefresh |
| Transport / protocol | TransportContract, TransportLifecycle, ShutdownContract + `*Harness.ts` |
| Reliability | ReliabilityScenarios* + ReliabilityScenarioHarness + `reliability-scenarios.fixture.mjs` |

## HARNESSES

- `*Harness.ts` owns spawn / probe / teardown. Specs stay thin.
- Child fixtures: `*.fixture.mjs`, `stdio-server.fixture.ts`. Spawn with `process.execPath`. `afterEach` kill + drain.
- IPC / JSON-RPC over stdio. Do not write logs to stdout (MCP).

## CONVENTIONS

- Conformance matrices: Memory / File / SQLite. `it.skipIf(!SQLITE_AVAILABLE)` with a local comment (`import('better-sqlite3')` probe).
- Disable persistence timers: `persistenceFlushInterval: 60_000` so flushes are explicit (`_flushBuffer()` / barrier).
- Flags via constructor (see parent).
- Temp dirs via `mkdtemp`; remove in `afterEach`. Close backends before `rm`.

## NOTES

- `NativeSqliteConformance` is the `verify:native` target — keep it backend-faithful.
- File writer ownership and partitioned restore assert exclusive publish + session scope, not sink internals.
- Compression e2e covers persist/reload of `Summary` across backends; unit rollup stays in `__tests__/compression/`.
- Strategy e2e drives the live pipeline; pure `decide()` contracts stay in `__tests__/strategies/`.
