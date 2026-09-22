# TraceLattice

[![npm version](https://img.shields.io/npm/v/%40iworkforces%2Ftracelattice?color=blue&label=npm)](https://www.npmjs.com/package/@iworkforces/tracelattice)

An MCP server that gives AI agents structured sequential thinking with tool and skill recommendations. Thoughts live in a DAG, reasoning strategies are pluggable, and confidence scores can be calibrated against recorded outcomes.

## Features

- 11 thought types: regular, hypothesis, verification, critique, synthesis, meta, tool_call, tool_observation, assumption, decomposition, backtrack
- DAG-based thought graph with 8 edge kinds (sequence, branch, merge, verifies, critiques, derives_from, tool_invocation, revises) and topological traversal
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

Environment variables override values from configuration files.

| Variable                                | Default      | Description                                 |
| --------------------------------------- | ------------ | ------------------------------------------- |
| `TRACELATTICE_CONFIG`                   | search paths | Explicit YAML or JSON configuration file    |
| `TRACELATTICE_MAX_HISTORY_SIZE`         | `10000`      | Maximum thoughts to keep in history         |
| `TRACELATTICE_MAX_BRANCHES`             | `50`         | Maximum number of branches                  |
| `TRACELATTICE_MAX_BRANCH_SIZE`          | `100`        | Maximum size of each branch                 |
| `TRACELATTICE_LOG_LEVEL`                | `info`       | Log level: `debug`, `info`, `warn`, `error` |
| `TRACELATTICE_PRETTY_LOG`               | `true`       | Enable pretty log output                    |
| `TRACELATTICE_SESSION_MAX_PER_OWNER`    | `50`         | Maximum isolated sessions per owner         |
| `TRACELATTICE_TOOL_INTERLEAVE_TTL_MS`   | `60000`      | Suspended tool-call token TTL in ms         |
| `TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS` | `60000`      | Expired suspension cleanup interval in ms   |

### Config files

Configuration files are loaded from the first matching path in this order: a custom path passed to `ConfigLoader`, `.claude/config.json`, `.claude/config.yaml`, `.claude/config.yml`, then the same filenames under `~/.claude/`. Environment variables override file values.

```yaml
maxHistorySize: 10000
maxBranches: 50
maxBranchSize: 100
skillDirs:
  - .claude/skills
  - ~/.claude/skills
discoveryCache:
  ttl: 300000
  maxSize: 100
persistence:
  enabled: false
  backend: memory # memory, file, or sqlite
  options:
    dataDir: ./.tracelattice
    dbPath: ./.tracelattice/history.db
features:
  dagEdges: true
  reasoningStrategy: sequential # sequential or tot
  calibration: true
  compression: true
  toolInterleave: true
  newThoughtTypes: true
  outcomeRecording: true
toolInterleaveTtlMs: 60000
toolInterleaveSweepMs: 60000
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

| Variable                                | Default                 | Description                                  |
| --------------------------------------- | ----------------------- | -------------------------------------------- |
| `TRACELATTICE_TRANSPORT_TYPE`           | `stdio`                 | Transport: `stdio` or `streamable-http`      |
| `TRACELATTICE_STREAMABLE_HTTP_PORT`     | `9007`                  | Port for Streamable HTTP server              |
| `TRACELATTICE_STREAMABLE_HTTP_HOST`     | `localhost`             | Host for Streamable HTTP server              |
| `TRACELATTICE_STREAMABLE_HTTP_STATEFUL` | `true`                  | Enable stateful session tracking             |
| `TRACELATTICE_CORS_ORIGIN`              | `*`                     | CORS origin                                  |
| `TRACELATTICE_ENABLE_CORS`              | `true`                  | Enable CORS preflight                        |
| `TRACELATTICE_ALLOWED_HOSTS`            | derived from bound host | Comma-separated allowed `Host` header values |

### Skill discovery

| Variable                                | Default                                | Description                                             |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `TRACELATTICE_SKILL_DIRS`               | `.claude/skills:<home>/.claude/skills` | Colon-separated skill directories                       |
| `TRACELATTICE_TOOL_DIRS`                | `.claude/tools:<home>/.claude/tools`   | Colon-separated tool directories                        |
| `TRACELATTICE_DISCOVERY_CACHE_TTL`      | `300`                                  | Discovery cache TTL in seconds; stored internally as ms |
| `TRACELATTICE_DISCOVERY_CACHE_MAX_SIZE` | `100`                                  | Discovery cache max entries                             |
| `TRACELATTICE_WATCHER_VERBOSE`          | unset                                  | Log skill watcher events when set to `true`             |

## Transports

Set `TRACELATTICE_TRANSPORT_TYPE` to pick one:

| Transport         | When to use            | Command                                                    |
| ----------------- | ---------------------- | ---------------------------------------------------------- |
| `stdio` (default) | Local MCP clients      | `tracelattice`                                             |
| `streamable-http` | Production deployments | `TRACELATTICE_TRANSPORT_TYPE=streamable-http tracelattice` |

The Streamable HTTP endpoint defaults to `POST /mcp` for JSON-RPC requests and supports stateful sessions via the `Mcp-Session-Id` header. `GET /mcp` is not allowed. The library also exposes `HttpTransport` for stateless JSON-RPC over HTTP, but the CLI does not select it with `TRACELATTICE_TRANSPORT_TYPE`.

### Session model

TraceLattice uses separate session concepts with separate identifiers:

- A **thought session** is the required `session_id` in every `sequentialthinking_tools` call. Callers choose an explicit named session, and each successful response echoes that identifier. The retired `__global__` value and omitted `session_id` are rejected. Library reads such as `getBranches(sessionId)` also require the thought session explicitly.
- An **MCP transport session** is the Streamable HTTP connection identified by the `Mcp-Session-Id` header. It controls transport state. Request-owner identity is a separate authorization context; neither supplies or replaces a thought `session_id`.
- An **all-session administration operation** is explicit. `resetAll()`, persistence `clearAll()`, and complete server shutdown intentionally act across every thought session. They are not fallback behavior for an omitted thought session.

`ConnectionPool` slots are an optional HTTP isolation layer and are separate from both thought sessions and MCP transport sessions.

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

Call and await `transport.stop()` during application shutdown.

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

`PersistenceBackend` requires `saveBacktrackForSession(sessionId, thought, targetThoughtId)`. Every custom backend must implement it. The operation atomically corrects every retained stable-ID copy of the target, appends the backtrack thought, and applies retention. There is no capability fallback; the ordinary persistence methods retain their existing contracts.

Restore reads retained records only. It repairs retained backtrack copies without writing the snapshot, ignores an absent retained target, and rejects an ambiguous retained numeric target. Evidence already pruned by retention or eviction cannot be recovered.

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
