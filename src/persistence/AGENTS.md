# PERSISTENCE MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Dumb session-scoped sinks. Buffering / flush / restore live in `src/core/`. Contract is `src/contracts/PersistenceBackend.ts` (not in this folder).

## STRUCTURE

```
persistence/
├── PersistenceFactory.ts     # file | sqlite | memory | null
├── MemoryPersistence.ts
├── FilePersistence.ts + FileWriter + FileSnapshotV2
├── SqlitePersistence.ts + SqliteDriver + SqliteSchemaV2
└── PersistenceScope.ts / PersistenceCodec.ts / PersistenceErrors.ts
```

## BACKENDS

| Backend   | Storage                           | Notes                                                       |
| --------- | --------------------------------- | ----------------------------------------------------------- |
| Memory    | 4 `Map`s by `SessionId`           | Tests / default                                             |
| File v2   | **one** `<dataDir>/snapshot.json` | Exclusive lock; full rewrite; not `edges/{session}.json`    |
| SQLite v2 | tables + `schema_version=(1,2)`   | WAL unless `enableWAL === false`; `better-sqlite3` optional |

All three implement the indivisible, session-scoped `PersistenceBackend`. Every thought, branch, edge, summary, and single-session clear operation carries an explicit named `SessionId`; no backend recognizes a default or `__global__` session.

## CONVENTIONS

- Sinks only: no timers, no batching, no debounce.
- The contract is all-or-nothing. Never add partial backend capability probes.
- Restore session list is `listSessions()`, **not** `listEdgeSessions()`.
- `listSessions()` and `clearAll()` are explicit all-session administration. They do not imply that a scoped operation may omit its session.
- Edges/summaries are replace-sets per session. Scope mismatch → `PersistenceScopeMismatchError`.
- File and SQLite startup validate the exact v2 shape and fail closed on incompatible storage.

## ANTI-PATTERNS

- Do not add unscoped persistence methods.
- Do not translate an omitted or retired thought session into a persistence key.
- Do not swallow parse errors into `[]`.
- Do not persist thoughts without `id`.
- Forbidden: `persistence → transport`.
