# HEALTH

**Updated:** 2026-09-17
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
- `checkReadiness()` — **async**. Only calls `persistence.healthy()` (with latency).
- Pass `persistence: null` (or omit) to skip — readiness is `ok` with no components.
- Aggregate: all healthy or none registered → `ok`; some → `degraded`; none healthy → `unhealthy`.
- With only persistence wired, `degraded` cannot occur.

## CONSUMERS

- `GET /health` → `checkLiveness()` and `GET /ready` → `checkReadiness()` only when a `HealthChecker` was injected.
- CLI never constructs one, so those routes do not consult persistence.

## NOTES

- JSDoc mentioning a **pool** is aspirational — **not wired**.
- Not in DI. Transport options accept an instance.
- Default logger is an inline no-op.
