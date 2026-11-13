# TraceLattice

[![npm version](https://img.shields.io/npm/v/%40iworkforces%2Ftracelattice?color=blue&label=npm)](https://www.npmjs.com/package/@iworkforces/tracelattice)

An MCP server that gives AI agents structured sequential thinking with tool and skill recommendations. Thoughts live in a DAG, reasoning strategies are pluggable, and confidence scores can be calibrated against recorded outcomes.

## Features

- 11 thought types: regular, hypothesis, verification, critique, synthesis, meta, tool_call, tool_observation, assumption, decomposition, backtrack
- DAG-based thought graph with 8 edge kinds (sequence, branch, merge, verifies, critiques, derives_from, tool_invocation, revises), topological traversal, and graph analytics (`graph_signals`, per-thought `graph_context`, graph-aware warnings)
- Pluggable reasoning strategies. Sequential by default, or Tree-of-Thought with BFS/beam search and plateau detection
- Tool interleave: suspend a thinking chain, run a tool call, then resume where you left off
- Confidence calibration with raw-prior shrinkage, plus Brier score and Expected Calibration Error (ECE) for recorded raw predictions
- Branch compression: cold branches get rolled into summaries automatically, with a sliding-window dehydration policy
- Outcome recording for tool_call/tool_observation results with metadata
- Tool and skill recommendations with confidence scores, rationales, and automatic discovery
- Per-session isolation with TTL eviction and LRU caching
- CLI transports: stdio (default) and Streamable HTTP (production). A stateless HTTP JSON-RPC transport is also available as a library transport
- Strict TypeScript, Valibot validation, and a 20-service DI container

## Install

Requires [Node.js](https://nodejs.org/) v22+ for development and build tooling. The packaged CLI is built with a Bun shebang, so install [Bun](https://bun.sh/) when running the `tracelattice` binary directly.

```bash
npm install -g @iworkforces/tracelattice
```

## Configure your MCP client

The default transport is stdio. Add the server to your client:

### Claude Code

User-scoped (`~/.claude.json`) or project-scoped (`.mcp.json` in project root):

```json
{
	"mcpServers": {
		"tracelattice": {
			"command": "tracelattice"
		}
	}
}
```

Or via CLI:

```bash
claude mcp add tracelattice -- tracelattice
```

### Codex CLI

User-scoped (`~/.codex/config.toml`) or project-scoped (`.codex/config.toml`):

```toml
[mcp_servers.tracelattice]
command = "tracelattice"
```

Or via CLI:

```bash
codex mcp add tracelattice -- tracelattice
```

### Grok Build

Add TraceLattice as a local MCP server:

```bash
grok mcp add tracelattice -- tracelattice
```

For a project-scoped MCP configuration, add `--scope project`:

```bash
grok mcp add --scope project tracelattice -- tracelattice
```

### OpenCode

Global (`~/.config/opencode/opencode.json`) or project-scoped (`.opencode.json`):

```json
{
	"mcpServers": {
		"tracelattice": {
			"type": "local",
			"command": ["npx", "-y", "@iworkforces/tracelattice"],
			"enabled": true,
			"environment": {
				"TRACELATTICE_TRANSPORT_TYPE": "stdio",
				"TRACELATTICE_MAX_HISTORY_SIZE": "10000",
				"TRACELATTICE_LOG_LEVEL": "debug"
			}
		}
	}
}
```

## Configuration

### Server

Set `TRACELATTICE_LOG_LEVEL` in the process environment to `debug`, `info`, `warn`, or `error`:

```bash
TRACELATTICE_LOG_LEVEL=debug tracelattice
```

Supported environment variables override values from configuration files. The defaults below describe
`ServerConfig` when no file or environment override is present; `.example.env` contains explicit example
overrides, not another set of defaults.

| Variable                                | Default      | Description                                                                                   |
| --------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `TRACELATTICE_CONFIG`                   | search paths | Explicit YAML or JSON configuration file                                                      |
| `TRACELATTICE_MAX_HISTORY_SIZE`         | `10000`      | Maximum thoughts to keep in history                                                           |
| `TRACELATTICE_MAX_BRANCHES`             | `50`         | Maximum number of branches                                                                    |
| `TRACELATTICE_MAX_BRANCH_SIZE`          | `100`        | Maximum size of each branch                                                                   |
| `TRACELATTICE_LOG_LEVEL`                | `info`       | Log level: `debug`, `info`, `warn`, `error`                                                   |
| `TRACELATTICE_PRETTY_LOG`               | `true`       | Only the literal `false` disables pretty logging; other values do not override a file setting |
| `TRACELATTICE_SESSION_MAX_PER_OWNER`    | `50`         | Maximum isolated sessions per owner                                                           |
| `TRACELATTICE_TOOL_INTERLEAVE_TTL_MS`   | `60000`      | Suspended tool-call token TTL in ms                                                           |
| `TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS` | `60000`      | Expired suspension cleanup interval in ms                                                     |

### Config files

Configuration files are loaded from the first valid path in this order: an explicit `ConfigLoader` path or `TRACELATTICE_CONFIG` replaces the search list; otherwise `.claude/config.json`, `.claude/config.yaml`, `.claude/config.yml`, then the same filenames under `~/.claude/`. An invalid file is logged and the next candidate is tried. With no valid file, the loader applies environment overrides to an empty object; `ServerConfig` supplies defaults. Only supported environment variables override file values. Logging (`logLevel` and `prettyLog`) is read from the loaded file/environment configuration separately from `ServerConfig`.

```yaml
maxHistorySize: 10000
maxBranches: 50
maxBranchSize: 100
skillDirs:
  - .claude/skills
  - ~/.claude/skills
  - .agents/skills
  - ~/.agents/skills
discoveryCache:
  ttl: 42000 # example override in milliseconds; default 300000, env TTL is seconds
  maxSize: 100
persistence:
  enabled: false
  backend: memory # memory, file, or sqlite
  options:
    dataDir: ./.tracelattice
    dbPath: ./.tracelattice/history.db
persistenceBufferSize: 7 # example file-only override; default 100
persistenceFlushInterval: 750 # milliseconds, file-only; default 1000
persistenceMaxRetries: 2 # example file-only override; default 3
persistenceMaxPendingThoughtsPerSession: 500 # example file-only override; default and maximum 10000
persistenceWriteTimeout: 5000 # milliseconds, file-only; default 5000, maximum 2147483647
features:
  dagEdges: true
  reasoningStrategy: sequential # sequential or tot
  calibration: true
  compression: true
  toolInterleave: true
  newThoughtTypes: true
  outcomeRecording: true
toolInterleaveTtlMs: 45000 # example override in milliseconds; default 60000
toolInterleaveSweepMs: 55000 # example override in milliseconds; default 60000
maxSessionsPerOwner: 50
```

### Feature flags

All feature flags default to enabled in `ServerConfig`. Set a boolean flag to `false` or `0` to opt out, or to `true` or `1` to opt back in.

| Variable                                   | Description                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `TRACELATTICE_FEATURES_DAG_EDGES`          | Enable DAG edges for thought relationships                               |
| `TRACELATTICE_FEATURES_CALIBRATION`        | Enable raw-prior confidence calibration                                  |
| `TRACELATTICE_FEATURES_COMPRESSION`        | Enable branch compression for cold branches                              |
| `TRACELATTICE_FEATURES_TOOL_INTERLEAVE`    | Enable suspend/resume for tool calls                                     |
| `TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES`  | Enable tool_call, tool_observation, assumption, decomposition, backtrack |
| `TRACELATTICE_FEATURES_OUTCOME_RECORDING`  | Enable outcome recording for tool results                                |
| `TRACELATTICE_FEATURES_REASONING_STRATEGY` | Strategy: `sequential` (default) or `tot`                                |

### Transport

| Variable                                                 | Default                 | Description                                                 |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `TRACELATTICE_TRANSPORT_TYPE`                            | `stdio`                 | Transport: `stdio` or `streamable-http`                     |
| `TRACELATTICE_STREAMABLE_HTTP_PORT`                      | `9007`                  | Port for Streamable HTTP server                             |
| `TRACELATTICE_STREAMABLE_HTTP_HOST`                      | `localhost`             | Host for Streamable HTTP server                             |
| `TRACELATTICE_STREAMABLE_HTTP_STATEFUL`                  | `true`                  | Enable stateful session tracking                            |
| `TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS`              | unset                   | Maximum retained transport sessions                         |
| `TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS`   | unset                   | Transport-session idle timeout in milliseconds              |
| `TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS` | unset                   | Idle-session sweep interval in milliseconds                 |
| `TRACELATTICE_CORS_ORIGIN`                               | `*`                     | CORS origin                                                 |
| `TRACELATTICE_ENABLE_CORS`                               | `true`                  | Enable CORS preflight                                       |
| `TRACELATTICE_ALLOWED_HOSTS`                             | derived from bound host | Comma-separated allowed `Host` header values                |
| `TRACELATTICE_SHUTDOWN_DEADLINE_MS`                      | `30000`                 | Total CLI shutdown budget in ms (stdio and Streamable HTTP) |

### Skill discovery

| Variable                                | Default                                                                     | Description                                             |
| --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `TRACELATTICE_SKILL_DIRS`               | `.claude/skills:<home>/.claude/skills:.agents/skills:<home>/.agents/skills` | Colon-separated skill directories                       |
| `TRACELATTICE_TOOL_DIRS`                | `.claude/tools:<home>/.claude/tools`                                        | Colon-separated tool directories                        |
| `TRACELATTICE_DISCOVERY_CACHE_TTL`      | `300`                                                                       | Discovery cache TTL in seconds; stored internally as ms |
| `TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE` | `100`                                                                       | Discovery cache max entries                             |
| `TRACELATTICE_WATCHER_VERBOSE`          | unset                                                                       | Log skill watcher events when set to `true`             |

The default skill paths include project-local `.claude/skills` and `.agents/skills` plus both paths
under the user's home directory. The default tool paths include only `.claude/tools` and its home
directory counterpart. Setting either root variable replaces its entire default list; `~` in an
environment value is not expanded by `ConfigLoader`. `TRACELATTICE_DISCOVERY_CACHE_TTL=300` means
300 seconds and becomes `discoveryCache.ttl: 300000` milliseconds. The interleave environment
variables ending in `_MS` and the corresponding YAML fields use milliseconds.

`persistenceBufferSize` (default 100 thoughts), `persistenceFlushInterval` (default 1000 ms),
`persistenceMaxRetries` (default 3), `persistenceMaxPendingThoughtsPerSession` (default 10000,
allowed 1 to 10000), and `persistenceWriteTimeout` (default 5000 ms, above 0 and at most 2147483647)
are YAML/JSON settings, not environment variables. There are no
`TRACELATTICE_PERSISTENCE_BUFFER_SIZE`, `TRACELATTICE_PERSISTENCE_FLUSH_INTERVAL`,
`TRACELATTICE_PERSISTENCE_MAX_RETRIES`, `TRACELATTICE_PERSISTENCE_MAX_PENDING_THOUGHTS_PER_SESSION`,
or `TRACELATTICE_PERSISTENCE_WRITE_TIMEOUT` overrides.

`persistenceWriteTimeout` is the deadline for each persistence backend write, for the `clearSession` or
`clearAll` call of a session or global reset, and, during `stop()`, for the `close()` of a server-owned
backend. A write still pending at the deadline fails with `PERSISTENCE_WRITE_TIMEOUT` and is reported
once through `persistenceError`; it is kept as a failed write unless a newer snapshot of the same
branch, edges or summaries already replaced it, and the drain that sent it rejects either way. A timer
retry of that failed write that times out again is logged but not reported again. A reset whose clear
misses the deadline fails with `PERSISTENCE_WRITE_TIMEOUT` through the failed-reset path and leaves
live state in place.
Writes reach the backend one at a time. No write is sent while a reset's clear runs, and resets of
different sessions clear one at a time; a clear can still start while a write of another session is
in flight. A timed-out write or clear keeps running: until
it settles, no other call is sent, drains, flushes and session barriers reject with the
`PERSISTENCE_WRITE_TIMEOUT` of the oldest pending call, and session and global resets fail without
calling `clearSession` or `clearAll`, so retrying a reset never sends a second clear. `drainSession`
rejects only for a session that still has unsaved writes or owns a pending call; `clearAll` belongs to
every session. A timed-out write's real outcome is applied once, so a late success is never sent again
and a late failure stays retained. A timed-out clear's late outcome does not change the reset's
result: the reset stays failed and a retry clears again. Background draining resumes on the next flush
tick. A close that misses the deadline is one of the failures `stop()` rejects with;
an injected backend is still never closed. A timer cannot interrupt the synchronous SQLite driver,
so the deadline only takes effect for asynchronous backends such as File or an injected backend.
Size it for shutdown. `stop(timeoutMs)` splits its budget using one start time: the buffer flush
and the owned-backend close each get `min(persistenceWriteTimeout, floor(timeoutMs / 3))`, and the
wait for admitted requests, resets and the watcher teardown gets the rest. The CLI passes 14000 ms
at the default 30000 ms deadline, which at the default 5000 ms timeout is 4668 ms of waiting,
4666 ms of flush and 4666 ms of close. A wait that ends early leaves its unused time to the flush.
A longer timeout no longer stretches shutdown: each phase
stops at its own deadline. `stop()` with no argument keeps the unbounded wait and flush. A
`timeoutMs` that is not above 0 and at most 2147483647 rejects with a `RangeError` before anything
changes.

`persistenceMaxPendingThoughtsPerSession` limits the thought and backtrack writes one session may hold
unacknowledged, counting writes that failed terminally. At the limit a thought is rejected with
`PERSISTENCE_BACKLOG_FULL` before any history, branch, edge, outcome or suspension state changes, so
the same call can be retried with the same thought id. Other sessions are unaffected. A thought write
that fails terminally holds every later write of its session until it succeeds or the session is
reset, so durable history keeps accepted order. Each rejection retries the retained failures at once,
and timer and size-triggered drains retry them on a backoff capped at one minute, so the backlog clears
once the backend is back.

## Transports

Set `TRACELATTICE_TRANSPORT_TYPE` to pick one:

| Transport         | When to use            | Command                                                    |
| ----------------- | ---------------------- | ---------------------------------------------------------- |
| `stdio` (default) | Local MCP clients      | `tracelattice`                                             |
| `streamable-http` | Production deployments | `TRACELATTICE_TRANSPORT_TYPE=streamable-http tracelattice` |

The Streamable HTTP endpoint defaults to `POST /mcp` for JSON-RPC requests and supports stateful sessions via the `Mcp-Session-Id` header. `GET /mcp` is not allowed. The library also exposes `HttpTransport` for stateless JSON-RPC over HTTP, but the CLI does not select it with `TRACELATTICE_TRANSPORT_TYPE`.

Streamable HTTP also serves `GET /health` (liveness) and `GET /ready` (readiness). Both answer after Host validation and the shutting-down 503 but ahead of the per-client rate limiter, so an orchestrator polling them neither spends nor is rejected by the client budget. They still apply CORS origin validation and headers. With persistence disabled, `/ready` is `ok` with no components. With persistence enabled it probes the backend under a one second deadline: concurrent polls share one probe, a probe that timed out is joined until it settles, and a settled result is reused for one second. `/ready` answers 503 when the probe fails or times out, or when persistence is globally quarantined after a failed global reset. Otherwise it answers 200 and lists the quarantined session count (failed resets), the count of sessions awaiting an eviction retry, blocked session count, retained write failure count and pending thought count in the `persistenceBacklog` component details. A blocked session has later writes held behind a failed thought write. Those counts do not make the instance unready, because timer drains keep retrying retained failures on a capped backoff.

Set all three transport-session retention variables or leave all three unset. Each must be a positive safe integer; the two timing values use milliseconds. With none set, transport sessions remain unbounded and live until shutdown. Retention settings are rejected with `TRACELATTICE_STREAMABLE_HTTP_STATEFUL=false`. At capacity, a request that would create a new session receives HTTP 503 with JSON-RPC code `-32000`. After an idle session is swept, a request using its header receives HTTP 404 with code `-32001`; the client must re-initialize without the old `Mcp-Session-Id`. Sweeps skip sessions with accepted POSTs still in flight and don't change thought sessions (`session_id`), their history, ownership, or TTL handling.

In Streamable HTTP mode, the port and retention values accept only unsigned decimal integers without leading zeros (except `0`), signs, whitespace, or trailing characters, and must be safe integers. `TRACELATTICE_STREAMABLE_HTTP_PORT` accepts 0 through 65535 and defaults to 9007. `TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS` must be at most 2147483647, the largest timer delay Node and Bun honor. Invalid values, a partial retention set, or an unknown `TRACELATTICE_TRANSPORT_TYPE` stop CLI startup with exit code 1. Stdio ignores HTTP-only variables.

`TRACELATTICE_SHUTDOWN_DEADLINE_MS` is parsed for stdio and Streamable HTTP alike. It accepts a positive safe integer of at most 2147483647; zero, a malformed value, an empty string, or a larger value stops CLI startup with exit code 1 after stopping the already initialized server. On SIGINT, SIGTERM, or stdin end (stdio) the CLI gives the transport half of the budget as its stop timeout, then always stops the server with a fixed budget: the deadline minus that half and minus a reserve of a tenth of the deadline (at most 1000 ms), so 14000 ms at the default 30000, even when the transport stopped at once. The server splits it into waiting, flush and close phases as described under `persistenceWriteTimeout`; the flush drains buffered writes and the close releases the File backend's writer lock. A phase that runs past its deadline is reported with a typed error. `SERVER_STOP_TIMEOUT` with `phase` `operations` means an admitted request or reset was still running; it is abandoned and can no longer change sessions or queue writes. `phase` `discovery` means the watcher stops or an accepted discovery refresh were still running. `phase` `flush` means writes were still queued, and no further write is sent. A close past its deadline is `PERSISTENCE_WRITE_TIMEOUT`. The flush and the close still run after an operations or discovery overrun, so writes already accepted from other sessions are saved and the lock is released, and the CLI exits with code 1 and those errors before the total deadline. A transport still waiting on an accepted request at that point is abandoned with a `TRANSPORT_STOP_TIMEOUT` failure. Every failure is reported and exits with code 1; a server stop that still outlives the total budget fails with `CLI_SHUTDOWN_TIMEOUT` at the deadline. A clean stop exits with code 0. Set the budget below your process supervisor's kill timeout.

### Session model

TraceLattice uses separate session concepts with separate identifiers:

- A **thought session** is the required `session_id` in every `sequentialthinking_tools` call. Callers choose an explicit named session, and each successful response echoes that identifier. The retired `__global__` value and omitted `session_id` are rejected. Library reads such as `getBranches(sessionId)` also require the thought session explicitly.
- An **MCP transport session** is the Streamable HTTP connection identified by the `Mcp-Session-Id` header. It controls transport state. Request-owner identity is a separate authorization context; neither supplies or replaces a thought `session_id`.
- An **all-session administration operation** is explicit. `resetAll()`, persistence `clearAll()`, and complete server shutdown intentionally act across every thought session. They are not fallback behavior for an omitted thought session.

`ConnectionPool` slots are an optional HTTP isolation layer and are separate from both thought sessions and MCP transport sessions.

Thought sessions have a 30-minute idle TTL, checked every five minutes, and can also be evicted for live-session capacity. Once eviction succeeds, ordinary access to that named session returns `SESSION_EXPIRED` instead of creating empty history. To start a fresh chain, use a new `session_id`, await an authorized `resetSession(sessionId)`, or submit a validated replacement thought with `reset_state: true`. Explicit reset deletes that session's durable data; it doesn't resume or rehydrate the old chain. Authorization runs before reset, and a failed or invalid reset doesn't reopen the session. See the [reliability contract](docs/reliability-contract.md#lifecycle-and-failure-semantics) for marker lifetime and ownership guarantees.

### Stateless HTTP library API

Import the stateless transport from the package root. The package does not expose transport internals or deep import paths.

```typescript
import {
	createHttpTransport,
	type HttpTransportOptions,
	type ITransport,
} from '@iworkforces/tracelattice';
import type { McpServer } from 'tmcp';

const options: HttpTransportOptions = {
	host: '127.0.0.1',
	port: 9108,
	path: '/messages',
};

export async function startHttpTransport(mcpServer: McpServer): Promise<ITransport> {
	const transport = createHttpTransport(options);
	await transport.connect(mcpServer);
	return transport;
}
```

Call and await `transport.stop(timeout)` during application shutdown. It joins accepted requests for up to `timeout` milliseconds (default 30000). At the timeout it force-closes connections and settles from its own timer: it rejects with an error whose `code` is `TRANSPORT_STOP_TIMEOUT`, carrying `timeoutMs` and `abandonedRequests`, while accepted requests are still running, and resolves otherwise. A later `stop()` call starts a new bounded join. The package root also exports the typed errors its public API rejects with (`SequentialThinkingError`, `TransportStopTimeoutError`, `PersistenceWriteTimeoutError`, `PersistenceDrainError`, `SessionLifecycleClosedError`, `ServerStopTimeoutError`), plus `ERROR_CODES`, `isErrorCode`, and the `ErrorCode` and `ServerStopPhase` types. Test a rejection with `error instanceof TransportStopTimeoutError`, or compare `error.code` with `ERROR_CODES.TRANSPORT_STOP_TIMEOUT` (or call `isErrorCode(error, ERROR_CODES.TRANSPORT_STOP_TIMEOUT)`).

## Current v2 contract

TraceLattice exposes only the current API and persistence contract. There are no compatibility aliases or data import shims.

| Removed surface                                               | Current replacement                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Omitted thought sessions or the retired `__global__` sentinel | Supply an explicit named `session_id` on every thought; use explicit all-session administration only when intentionally operating across every session                               |
| Unscoped persistence operations                               | `saveThoughtForSession`, `loadHistoryForSession`, `saveBranchForSession`, `deleteBranchForSession`, `loadBranchForSession`, `listBranchesForSession`, `clearSession`, and `clearAll` |
| Tool/skill-specific registry aliases                          | Canonical `add`, `remove`, `update`, `get`, `getAll`, `has`, and `getNames` methods                                                                                                  |
| Synchronous server/history clearing                           | Await `resetSession(sessionId)` or `resetAll()`                                                                                                                                      |
| Partial server cleanup                                        | Await `dispose()` to release the server and all container-owned resources                                                                                                            |
| Unprefixed environment variables                              | The `TRACELATTICE_*` variables documented above                                                                                                                                      |

File persistence accepts the strict v2 `snapshot.json` document. SQLite persistence accepts the exact v2 schema with its authoritative `schema_version` row. Invalid, unknown, or differently versioned storage fails closed; startup does not rewrite it. Backtrack support did not change File or SQLite from v2 and requires no migration or version bump.

## Precision behavior

### Calibration and evaluation limits

Calibration blends a raw confidence with the empirical outcome mean for its thought type. For `n` recorded outcomes of that type, `priorWeight = 10 / (10 + n)` and the blended value is `priorWeight * raw + (1 - priorWeight) * perTypeMean`. With no outcomes for a type, the empirical component has zero weight and calibration returns the raw confidence exactly.

Temperature fitting begins at 10 outcomes. It uses per-type leave-one-out blends, the fixed grid `[0.5, 0.75, 1, 1.25, 1.5, 2]`, and deterministic ties that retain `1` before grid order. Temperature is applied after the blend. Brier and ECE reported by `Calibrator.metrics()` always score the stored raw predictions and outcomes, not transformed holdout outputs.

The checked evaluation report separates deterministic structural validation and controlled raw and calibrated probability metrics. `natural_language_accuracy` is unmeasured. These checks do not judge factuality, guarantee better calibration, or promise that every individual confidence changes in one direction.

### Persistence, recovery, and backtracking

Library callers can supply their own backend with `createServer({ persistenceBackend })`. This skips the persistence factory and the configured backend, whether or not configured persistence is enabled. The package root exports the implementation types `PersistenceBackend`, `ThoughtData`, `Edge`, `Summary`, `SessionId`, `ThoughtId`, and `BranchId`, plus the restore-read types `PersistenceRestoreRead`, `PersistedSessionRecord`, and `PersistedBranchRecord`, as types only; deep imports aren't needed. Startup restore reads the injected backend unless `loadFromPersistence: false` is set.

An injected backend belongs to the caller. The server drains buffered writes before `stop()` or `dispose()` resolves, but never calls the backend's `close()`, including during startup-failure cleanup. The caller must close it after the awaited shutdown resolves. Factory-created backends are server-owned and closed exactly once.

SQLite selects its driver by runtime. Bun, including the packed `tracelattice` CLI, uses the built-in `bun:sqlite` module. Node uses the optional `better-sqlite3` package, which you must install yourself (`npm install better-sqlite3`). Neither runtime falls back to the other driver. A missing or failing driver stops startup with a `PersistenceCompatibilityError` naming the required driver.

`PersistenceBackend` requires `saveBacktrackForSession(sessionId, thought, targetThoughtId)`. Every custom backend must implement it. The operation atomically corrects every retained stable-ID copy of the target, appends the backtrack thought, and applies retention. There is no capability fallback; the ordinary persistence methods retain their existing contracts.

`PersistenceBackend` also requires `loadAllSessionsForRestore()`, which returns a `PersistenceRestoreRead`. Every custom backend must implement it. Startup restore calls `healthy()` and then this one method: no `listSessions`, per-session, or per-branch load. The result must come from one consistent view of storage and hold each session exactly once in ascending id order, with its history, branches (ascending by branch id), edges, and summaries. Its sessions are the same set `listSessions()` reports, including sessions that exist only through edges or summaries; with branch persistence disabled the branches are empty. Duplicate session or branch records are rejected as incompatible storage. The per-item loads remain on the interface for other callers, and restore does not fall back to them.

Startup File/SQLite restore reads supported retained durable records with provenance restrictions; it doesn't restore all transient auxiliary state. It repairs retained backtrack copies without writing the snapshot, ignores an absent retained target, and rejects an ambiguous retained numeric target. TTL and capacity eviction remove live state without deleting durable records, but ordinary access doesn't reload them. Evidence pruned from durable storage by retention or deleted by explicit reset cannot be recovered. With persistence disabled, state cannot resume across restart; process-local expiration markers are also lost on restart.

Branches and revisions may legally reuse thought numbers. A numeric `verification_target` must uniquely identify a retained thought identity in the same session, so avoid reusing numbers when you intend unique numeric verification references. Targets may have any thought type. Recording a verification outcome requires an explicit result of `0` or `1` and a non-retracted target with confidence.

## Development

```bash
npm install
npm run dev              # MCP inspector (bunx @modelcontextprotocol/inspector dist/cli.js)
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run test:coverage    # vitest run --coverage
npm run type-check       # tsc --noEmit
npm run lint             # eslint src/
npm run lint:fix         # eslint src/ --fix
npm run format           # prettier --write
npm run format:check     # prettier --check
npm run build            # rslib build + rsbuild build + postbuild-cli.mjs
npm run build:lib        # rslib build only
npm run build:cli        # rsbuild build + postbuild-cli.mjs
npm start                # bun dist/cli.js
```

## Architecture

```
src/
├── core/               # Domain logic
│   ├── graph/          # DAG edges: Edge, EdgeStore, GraphView
│   ├── evaluator/      # SignalComputer, Aggregator, PatternDetector, Calibrator
│   ├── compression/    # CompressionService, DehydrationPolicy, InMemorySummaryStore
│   ├── reasoning/      # OutcomeRecorder + strategies (Sequential, TreeOfThought, StrategyFactory)
│   └── tools/          # InMemorySuspensionStore (suspend/resume)
├── contracts/          # Shared interfaces and branded ID types (cross-module coupling point)
├── persistence/        # Session-scoped File v2, SQLite v2, and Memory sinks
├── transport/          # Streamable HTTP, HTTP JSON-RPC
├── di/                 # IoC container (20 services) + ServiceRegistry
├── registry/           # Tool/Skill discovery with frontmatter parsing and LRU cache
├── config/             # YAML + env var loading
├── cache/              # LRU+TTL discovery cache
├── logger/             # Structured logging (JSON/pretty)
├── pool/               # Multi-user session pool
├── metrics/            # Prometheus metrics
├── health/             # Aggregate health checking
├── watchers/           # File-system watchers for tool/skill discovery
├── context/            # Request context via AsyncLocalStorage
└── types/              # Shared type definitions
```

## License

MIT
