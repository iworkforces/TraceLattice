# PERSISTENCE MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

Dumb session-scoped sinks. Buffering and flush live in `src/core/`. `repairRetainedBacktracks` here rewrites restored copies in memory only. Contract is `src/contracts/PersistenceBackend.ts`.

## STRUCTURE

```
persistence/
├── PersistenceFactory.ts     # file | sqlite | memory, or null when disabled
├── MemoryPersistence.ts
├── FilePersistence.ts + FileWriter + FileSnapshotV2 + types/validation
├── SqlitePersistence.ts + SqliteDriver + SqliteSchemaV2 + SqliteSnapshotWriter
├── BacktrackPersistence.ts   # stageBacktrackPersistence + repairRetainedBacktracks
└── PersistenceScope.ts / PersistenceCodec.ts / PersistenceErrors.ts
```

## BACKENDS

| Backend   | Storage                           | Notes                                                       |
| --------- | --------------------------------- | ----------------------------------------------------------- |
| Memory    | 4 `Map`s by `SessionId`           | Enabled fallback and tests. Omitted config is `enabled: false` → factory `null` |
| File v2   | **one** `<dataDir>/snapshot.json` | Exclusive lock; full rewrite; not `edges/{session}.json`    |
| SQLite v2 | tables + `schema_version=(1,2)`   | WAL unless `enableWAL === false`; `better-sqlite3` optional |

All three implement the indivisible, session-scoped `PersistenceBackend`. Every thought, branch, edge, summary, and single-session clear operation carries an explicit named `SessionId`; no backend recognizes a default or `__global__` session.

## CONVENTIONS

- Sinks only: no timers, no batching, no debounce.
- The contract is all-or-nothing. Never add partial backend capability probes.
- `saveBacktrackForSession` is required and FIFO work reaches it as one atomic correction: retract every retained stable-ID copy, append the backtrack thought, then apply retention. Custom backends must implement it; no fallback is allowed.
- Restore session list is `listSessions()`, **not** `listEdgeSessions()`.
- `listSessions()` and `clearAll()` are explicit all-session administration. They do not imply that a scoped operation may omit its session.
- Edges/summaries are replace-sets per session. Scope mismatch → `PersistenceScopeMismatchError`.
- File and SQLite startup validate the exact v2 shape and fail closed on incompatible storage.
- File and SQLite remain v2 with no migration or version bump. `repairRetainedBacktracks` rewrites retained copies in memory only (no storage write), ignores a missing target, and rejects an ambiguous numeric target. Already-pruned or evicted evidence cannot be recovered.

## ANTI-PATTERNS

- Do not add unscoped persistence methods.
- Do not translate an omitted or retired thought session into a persistence key.
- Do not swallow parse errors into `[]`.
- Do not persist thoughts without `id`.
- Forbidden: `persistence → transport`.
