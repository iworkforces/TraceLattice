# TRANSPORT MODULE

**Updated:** 2026-09-22
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
- Idle reaper is **opt-in**: `maxSessions` + `sessionIdleTimeoutMs` + `sessionSweepIntervalMs` must all be set together. CLI never sets them → sessions live until `stop()`.
- `stop()` closes `PreDispatchTracker` then joins `_acceptedWork`. Do not drop in-flight POSTs. Cancel reasons: `peer` | `shutdown` | `timeout`.
- `ConnectionPool` is unused here. Do not wire it in.
- `HealthChecker` feeds `/health` + `/ready`.
- ALS owner: stateful Streamable = `Mcp-Session-Id`; stateless Streamable and `HttpTransport` = fresh UUID per request. Stdio never wraps ALS.

## FORBIDDEN

- `transport → core`, `transport → registry`.
- **Known exception:** `BaseTransport` imports `SESSION_ID_PATTERN` and `MAX_SESSION_ID_LENGTH` (100) from `core/ids.ts`. Do not add more core imports. `asSessionId` stays in `contracts/ids.ts`.
