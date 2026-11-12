# HEALTH

**Updated:** 2026-11-12
**Parent:** ../AGENTS.md

## OVERVIEW

One class. Liveness + readiness for HTTP transports.

## FILE

```
health/
└── HealthChecker.ts   # HealthChecker + HealthCheckResult + HealthComponent
```

## BEHAVIOR

- `checkLiveness()` — **sync**, always `status: 'ok'`, empty `components`.
- `checkReadiness()` — **async**. Probes `persistence.healthy()` (with latency) and, when `persistenceBacklog` is set, reads the backlog on every call.
- Pass `persistence: null` (or omit) to skip — readiness is `ok` with no components.
- Aggregate: all healthy or none registered → `ok`; some → `degraded`; none healthy → `unhealthy`. Only `ok` is ready (HTTP 200); the transports answer 503 for the rest.
- With only persistence wired, `degraded` cannot occur. The `persistenceBacklog` component adds it: persistence healthy while globally quarantined is `degraded`.

## PROBE

- `probeTimeoutMs` (default 1000) bounds `healthy()`. On timeout the `persistence` component is unhealthy (`Health check timed out after Nms`).
- The backend call is **never abandoned**: it stays tracked in `_inFlight` until it settles. Concurrent checks and checks made after the deadline join it instead of starting another, so a slow snapshot parse never stacks. A late rejection is logged once and swallowed.
- `probeFreshnessMs` (default **0**, probe on every call; the CLI passes 1000) reuses a settled result. Only a settled result is reused, never the timeout verdict.
- The deadline timer is cleared when the probe settles first and is `unref`'d.
- Do not replace this with a bare `Promise.race`: the loser keeps running and every poll would start another probe.

## BACKLOG

- `persistenceBacklog` takes a `PersistenceBacklogSource` from `contracts/persistence-backlog.ts`; `HistoryManager` satisfies it. **Never import `HistoryManager` or any `core/` class here.**
- `null` view (persistence disabled) adds no component.
- `persistenceBacklog` component is unhealthy only for `globalQuarantined`. Quarantined sessions, retained terminal failures and pending thoughts are counts in `details` and do not make the instance unready: nothing retries them until an explicit drain.

## CONSUMERS

- `GET /health` → `checkLiveness()` and `GET /ready` → `checkReadiness()` only when a `HealthChecker` was injected.
- The CLI builds one for Streamable HTTP from the container's `Persistence` and `HistoryManager` (freshness 1000 ms). With persistence disabled `/ready` is `ok` with no components.

## NOTES

- JSDoc mentioning a **pool** is aspirational — **not wired**.
- Not in DI. Transport options accept an instance.
- Default logger is an inline no-op.
