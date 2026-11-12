# TRANSPORT MODULE

**Updated:** 2026-11-12
**Parent:** ../AGENTS.md

## OVERVIEW

MCP HTTP channels. Contract is `ITransport` in `src/contracts/transport.ts`: `kind`, `connect`, `stop`, `clientCount`, `isShuttingDown`, `serverUrl`.

## FILES

```
transport/
├── BaseTransport.ts            # host allowlist, CORS, rate limit, health
├── StreamableHttpTransport.ts  # ~847L production MCP path (not a lib export)
├── HttpTransport.ts            # stateless JSON-RPC; library export; CLI does not select it
├── HttpHelpers.ts              # readRequestBody + shared writers
└── HttpRequestLifecycle.ts     # PreDispatchTracker + AcceptedWorkTracker + ResponseFinalizer
```

## TRANSPORTS

| Class | Endpoints | Mode | CLI |
|-------|-----------|------|-----|
| `StreamableHttpTransport` | POST `/mcp` | stateful **default true**; `Mcp-Session-Id`; GET `/mcp` is **405** | `TRACELATTICE_TRANSPORT_TYPE=streamable-http` |
| `HttpTransport` | POST `/messages` | always stateless | **not** selected |

Shared GET: `/health`, `/ready`, `/metrics`.

`StreamableHttpTransport` order: metrics → Host check → shutdown 503 → **`/health` + `/ready`** → rate limit → CORS → `/metrics` → `/mcp`. Probes sit ahead of the limiter so orchestrator polling neither spends nor is rejected by the client budget; they still get CORS validation and headers. The library `HttpTransport` order is unchanged (probes stay behind its limiter).

## SHARED BASE

- Host allowlist (`TRACELATTICE_ALLOWED_HOSTS`)
- CORS preflight + headers
- 100 req/min per-IP (`X-Forwarded-For` aware)
- 10MB body, 30s request timeout
- JSON-RPC via `safeParse(JsonRpcRequestSchema, raw)` — never `JSON.parse` as typed RPC
- `PreDispatchTracker` + `AcceptedWorkTracker` so `stop()` aborts pre-body work then joins in-flight POSTs

## NOTES

- Factories: `createStreamableHttpTransport()`, `createHttpTransport()`. Lib exports only `HttpTransport` / `createHttpTransport`.
- Stateful StreamableHTTP keys sessions by `Mcp-Session-Id` after init.
- Idle reaper is **opt-in**: `maxSessions` + `sessionIdleTimeoutMs` + `sessionSweepIntervalMs` must all be set together. CLI passes all three when `TRACELATTICE_STREAMABLE_HTTP_MAX_SESSIONS`, `TRACELATTICE_STREAMABLE_HTTP_SESSION_IDLE_TIMEOUT_MS`, and `TRACELATTICE_STREAMABLE_HTTP_SESSION_SWEEP_INTERVAL_MS` are set. `src/config/CliTransportConfig.ts` parses them and rejects partial sets or stateless retention. With none set, sessions live until `stop()`.
- `stop()` closes `PreDispatchTracker` then joins `_acceptedWork`. Do not drop in-flight POSTs. Cancel reasons: `peer` | `shutdown` | `timeout`.
- `ConnectionPool` is unused here. Do not wire it in.
- `HealthChecker` feeds `/health` + `/ready`. Readiness is 200 only for `ok`; any other status is 503. The CLI injects one. Keep probe routing in the `_isProbeRoute`/`_serveProbe` helpers and keep non-probe requests synchronous up to the body read.
- ALS owner: stateful Streamable = `Mcp-Session-Id`; stateless Streamable and `HttpTransport` = fresh UUID per request. Stdio never wraps ALS.

## FORBIDDEN

- `transport → core`, `transport → registry`.
- **Known exception:** `BaseTransport` imports `SESSION_ID_PATTERN` and `MAX_SESSION_ID_LENGTH` (100) from `core/ids.ts`. Do not add more core imports. `asSessionId` stays in `contracts/ids.ts`.
