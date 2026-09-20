# Reliability Contract

TraceLattice persistence is a current-v2, session-scoped contract. The file, SQLite, and memory backends implement the same `PersistenceBackend` interface. Persisted data is accepted only when it matches the current schema and ownership rules.

## Scope

Each thought call carries a required, authoritative, explicitly named `session_id`. Omission and the retired `__global__` value are rejected, and every successful response echoes the accepted session. Library thought reads such as `getBranches(sessionId)` also require the session argument. Thought, branch, edge, and summary payloads must agree with that session. A scope mismatch rejects the whole operation before publication.

The persistence surface is:

- `saveThoughtForSession` and `loadHistoryForSession`
- `saveBranchForSession`, `deleteBranchForSession`, `loadBranchForSession`, and `listBranchesForSession`
- `saveEdges` and `loadEdges`
- `saveSummaries` and `loadSummaries`
- `listSessions`, `clearSession`, and `clearAll`
- `healthy` and `close`

`clearSession` removes thoughts, branches, edges, and summaries for exactly one session. `clearAll` removes all four collections. Edges and summaries are replacement snapshots per session.

`listSessions`, `clearAll`, `resetAll()`, and complete shutdown are explicit all-session administration. They do not define a default thought session and are never selected by omitting `session_id`.

## File v2

File persistence owns one `<dataDir>/snapshot.json` document with this strict top-level shape:

```json
{
	"version": 2,
	"thoughts": [],
	"branches": [],
	"edges": [],
	"summaries": []
}
```

Unknown fields, missing fields, an unexpected version, invalid identifiers, malformed payloads, duplicate coordinates, and cross-session references are rejected. Reads never convert parse or validation failures into empty data.

One process owns a canonical data directory through the exclusive `.tracelattice-writer.lock` directory. A second writer fails before mutation. Mutations are serialized through one promise tail, validate the complete prospective snapshot, write a uniquely named temporary file with exclusive creation, and atomically rename it over `snapshot.json`. Publication failures preserve the prior snapshot and report cleanup failures alongside the primary error.

Serialization is deterministic: session records use code-point order; branches additionally order by branch ID; edges and summaries order by creation time and ID.

## SQLite v2

SQLite persistence accepts only the exact v2 tables, indexes, constraints, and one `schema_version` row containing `(singleton, version) = (1, 2)`. A new empty database is initialized transactionally. A non-empty database with missing, extra, or structurally different schema objects is rejected.

Thought append and retention, branch replacement, per-session clearing, global clearing, edge replacement, and summary replacement run in transactions. Reads that combine or validate multiple rows use read transactions. Stored JSON is decoded and validated before it is returned.

WAL is enabled unless `enableWAL` is `false`. Foreign keys, a five-second busy timeout, and normal synchronization are configured at startup. The optional `better-sqlite3` dependency must be available when this backend is selected.

## Ordering and Buffering

The core owns buffering; persistence backends are sinks and do not create timers or retry loops.

Accepted writes receive stable work tokens. One joinable drain generation runs at a time. Explicit drains can join an active generation. Thought writes preserve accepted order. Branch, edge, and summary entries represent the latest accepted replacement for their session coordinate. Failed work is not acknowledged as successful.

Session barriers close admission for the affected session, wait for attributable work, perform the exclusive operation, and reopen only after success. Global reset and shutdown close global admission and wait for active operations. Reentrant barrier upgrades are rejected rather than deadlocked.

## Lifecycle and Failure Semantics

`resetSession(sessionId)` and `resetAll()` are asynchronous because they coordinate admitted operations, queued persistence work, persistent state, and auxiliary in-memory state. Callers must await them.

`dispose()` is the complete library cleanup operation. It stops admission, drains or reports persistence failure, stops watchers and suspension timers, closes persistence, and disposes container-owned resources.

Lifecycle failures are sticky and fail closed:

- failed session reset leaves that session in `reset_failed`;
- failed eviction leaves it in `eviction_failed`;
- failed global reset leaves the server in `reset_failed`;
- failed shutdown leaves the server in `shutdown_failed`.

New work is rejected while the relevant scope is resetting, evicting, shutting down, stopped, or failed. Concurrent shutdown callers share one settlement.

## Ownership

Request ownership is independent from thought `session_id` and transport connection slots. Owner-aware access cannot read or mutate a session owned by another request owner. Restored sessions deny owner-aware access until an allowed ownerless context manages them. Stdio operation, which has no request owner, remains unrestricted.

The MCP-standard `Mcp-Session-Id` header is the Streamable HTTP session mechanism. It carries transport state; request-owner identity is a separate authorization context. Neither supplies a thought `session_id`. Query-string session aliases are not part of the transport contract. Optional `ConnectionPool` slots are a third isolation mechanism and likewise do not substitute for thought sessions.

## Configuration Contract

Runtime environment configuration uses only the `TRACELATTICE_*` namespace documented in the README and `.example.env`. Environment values override file configuration. Unknown or unprefixed process variables do not configure the server.

## Release Evidence

Release verification must prove the contract at three surfaces:

1. Source checks reject removed filenames and symbols, optional public thought-session declarations, implicit thought-session fallbacks, method aliases, and unprefixed runtime environment reads. Negative tests are excluded, and camel-case session checks are limited to thought APIs so transport, ownership, pool, and explicit all-session administration remain distinct.
2. Build checks inspect emitted JavaScript and declarations, including `dist/lib.js`, `dist/lib.d.ts`, and `dist/cli.js`, for the same removed surfaces.
3. Packed checks inspect the installed tarball, compile package-root declarations requiring `processThought` input sessions and `getBranches(sessionId)`, and execute the library and CLI. A named CLI call must succeed and echo its session; omitted and retired sessions must fail.

The release pipeline fails closed when any check is missing or detects a removed surface.
