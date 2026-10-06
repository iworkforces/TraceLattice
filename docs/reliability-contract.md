# Reliability Contract

TraceLattice persistence is a current-v2, session-scoped contract. The file, SQLite, and memory backends implement the same `PersistenceBackend` interface. Persisted data is accepted only when it matches the current schema and ownership rules.

## Scope

Each thought call carries a required, authoritative, explicitly named `session_id`. Omission and the retired `__global__` value are rejected, and every successful response echoes the accepted session. Library thought reads such as `getBranches(sessionId)` also require the session argument. Thought, branch, edge, and summary payloads must agree with that session. A scope mismatch rejects the whole operation before publication.

The persistence surface is:

- `saveThoughtForSession` and `loadHistoryForSession`
- `saveBacktrackForSession(sessionId, thought, targetThoughtId)`
- `saveBranchForSession`, `deleteBranchForSession`, `loadBranchForSession`, and `listBranchesForSession`
- `saveEdges` and `loadEdges`
- `saveSummaries` and `loadSummaries`
- `listSessions`, `clearSession`, and `clearAll`
- `healthy` and `close`

`clearSession` removes thoughts, branches, edges, and summaries for exactly one session. `clearAll` removes all four collections. Edges and summaries are replacement snapshots per session.

`saveBacktrackForSession` is required for every `PersistenceBackend`, including custom backends. It must atomically mark every retained stable-ID copy of `targetThoughtId` as retracted, append the supplied backtrack thought, and apply configured retention. The correction, append, and retention either all publish or none do. The core does not probe for this capability or fall back to ordinary thought writes; the ordinary persistence methods otherwise keep their existing meanings.

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

Thought append and retention, atomic backtrack correction and append, branch replacement, per-session clearing, global clearing, edge replacement, and summary replacement run in transactions. Reads that combine or validate multiple rows use read transactions. Stored JSON is decoded and validated before it is returned.

WAL is enabled unless `enableWAL` is `false`. Foreign keys, a five-second busy timeout, and normal synchronization are configured at startup. Bun, including the packed `tracelattice` CLI, uses built-in `bun:sqlite`; Node uses the optional `better-sqlite3` package, which the caller must install. There is no fallback between drivers. A missing or failing driver rejects startup with a `PersistenceCompatibilityError` naming the required driver. Both drivers use the same v2 schema and validation contract.

## Ordering and Buffering

The core owns buffering; persistence backends are sinks and do not create timers or retry loops.

Accepted writes receive stable work tokens. One joinable drain generation runs at a time. Explicit drains can join an active generation. Thought writes preserve accepted order. Branch, edge, and summary entries represent the latest accepted replacement for their session coordinate. Failed work is not acknowledged as successful.

Session barriers close admission for the affected session, wait for attributable work, perform the exclusive operation, and reopen only after success. Global reset and shutdown close global admission and wait for active operations. Reentrant barrier upgrades are rejected rather than deadlocked.

## Lifecycle and Failure Semantics

`resetSession(sessionId)` and `resetAll()` are asynchronous because they coordinate admitted operations, queued persistence work, persistent state, and auxiliary in-memory state. Callers must await them.

Thought sessions have a 30-minute idle TTL with cleanup every five minutes, and live-session capacity can also trigger eviction. Successfully evicted names cannot continue the old chain: ordinary access returns `SESSION_EXPIRED` without creating empty history. TTL and capacity eviction remove live state without deleting durable records. Recovery requires an authorized, awaited `resetSession(sessionId)`, a validated `reset_state: true` replacement, or a new `session_id`. Explicit reset deletes the affected session's durable data and starts a fresh chain; it doesn't resume or rehydrate history. A failed or invalid reset must not reopen the session.

Expiration markers contain only the session identity and former owner, never histories. They remain for this server/process instance until a committed scoped or global reset, or terminal cleanup. They have no TTL or LRU forgetting. Marker memory is `O(distinct evicted names not reset)` and isn't bounded by the live-session quotas (100 total, 50 per owner by default).

Restart loses expiration markers. With persistence disabled, state cannot resume across restart. Startup File/SQLite restore restores supported retained durable records subject to provenance restrictions, not all transient auxiliary state; ordinary access to an expired session doesn't trigger runtime restore.

Branches and revisions may legally reuse thought numbers, but numeric `verification_target` must uniquely identify a retained thought identity in the same session. Clients should avoid reusing numbers when they intend unique numeric verification references. Targets may have any thought type. Recording a verification outcome requires an explicit result of `0` or `1` and a non-retracted target with confidence.

`dispose()` is the complete library cleanup operation. It stops admission, drains or reports persistence failure, stops watchers and suspension timers, closes server-owned persistence, and disposes container-owned resources.

Lifecycle failures are sticky and fail closed:

- failed session reset leaves that session in `reset_failed`;
- failed eviction leaves it in `eviction_failed`;
- failed global reset leaves the server in `reset_failed`;
- failed shutdown leaves the server in `shutdown_failed`.

New work is rejected while the relevant scope is resetting, evicting, shutting down, stopped, or failed. Concurrent shutdown callers share one settlement.

## Ownership

`createServer({ persistenceBackend })` uses the caller's backend instead of the configured persistence factory. The package root exports the types `PersistenceBackend`, `ThoughtData`, `Edge`, `Summary`, `SessionId`, `ThoughtId`, and `BranchId` for implementing it. Startup restore reads this backend unless `loadFromPersistence: false` is set. The injected backend is caller-owned: the server never calls its `close()`, even during failed startup. Buffered writes are drained before `stop()` or `dispose()` resolves successfully; the caller closes the backend afterward. Factory-created backends are server-owned and closed exactly once.

Request ownership is independent from thought `session_id` and transport connection slots. Owner-aware access cannot read or mutate a session owned by another request owner. Restored sessions deny owner-aware access until an allowed ownerless context manages them. Stdio operation, which has no request owner, remains unrestricted.

Authorization applies before reset, including for expired names. A same-owner reset or trusted ownerless administrative reset preserves an existing former owner; a foreign-owner reset is denied. Expiration and reset do not bypass the owner-aware denial for restored sessions. Request ownership is carried by the AsyncLocalStorage (ALS) context, separately from thought-session identity.

The MCP-standard `Mcp-Session-Id` header is the Streamable HTTP session mechanism. It carries transport state; request-owner identity is a separate authorization context. Neither supplies a thought `session_id`. Query-string session aliases are not part of the transport contract. Optional `ConnectionPool` slots are a third isolation mechanism and likewise do not substitute for thought sessions.

CLI transport retention requires all three variables: `TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS`, `TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS`, and `TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS`. Values must be positive safe integers; both timing values use milliseconds. With none set, transport sessions remain unbounded until shutdown. Retention is rejected when `TRACELATTICE_STREAMABLE_HTTP_STATEFUL=false`. Capacity rejects new sessions with HTTP 503 and JSON-RPC code `-32000`; a swept session's next request receives HTTP 404 and code `-32001`, requiring client re-initialization. Sweeps skip sessions with accepted POSTs in flight and leave thought-session history, ownership, and TTL handling untouched.

## Configuration Contract

Runtime environment configuration uses only the `TRACELATTICE_*` namespace documented in the README and `.example.env`. Environment values override file configuration. Unknown or unprefixed process variables do not configure the server.

## Release Evidence

Release verification must prove the contract at three surfaces:

1. Source checks reject removed filenames and symbols, optional public thought-session declarations, implicit thought-session fallbacks, method aliases, and unprefixed runtime environment reads. Negative tests are excluded, and camel-case session checks are limited to thought APIs so transport, ownership, pool, and explicit all-session administration remain distinct.
2. Build checks inspect emitted JavaScript and declarations, including `dist/lib.js`, `dist/lib.d.ts`, and `dist/cli.js`, for the same removed surfaces.
3. Packed checks inspect the installed tarball, compile package-root declarations requiring `processThought` input sessions and `getBranches(sessionId)`, and execute the library and CLI. A named CLI call must succeed and echo its session; omitted and retired sessions must fail.

The release pipeline fails closed when any check is missing or detects a removed surface.
