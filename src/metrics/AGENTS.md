# METRICS

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Prometheus-compatible collector. Implements `IMetrics` from `contracts/interfaces.ts`.

## FILE

```
metrics/
├── metrics.impl.ts              # Metrics + MetricType + Metric
└── __tests__/metrics.test.ts    # ONLY colocated test in the repo
```

**Filename is `metrics.impl.ts` (lowercase). Not `Metrics.impl.ts`.**

## API

`IMetrics`: `counter`, `gauge`, `histogram`, `get`, `inc`, `dec`, `reset`, `export()`.

- `counter(name, value=1, labels, help)` — only increases
- `gauge(name, value, labels, help)` — set current value
- `histogram(name, value, labels, buckets?)` — observe. Boundaries must be finite and strictly increasing. A later observe with a different layout throws.
- `export()` — Prometheus text (`# HELP` / `# TYPE` / samples)

Default histogram buckets (seconds):
`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`

Constructor: `{ prefix?, defaultLabels? }`. Prefix prepended with `_`.

## RULES

- Low-cardinality labels only.
- Counters only increase. Use gauge for up/down (e.g. active sessions).
- DI key: `Metrics`. Import from `metrics/metrics.impl.js`.
- Extra class methods (`getOperationCount`) are **not** on `IMetrics`.

## TESTS

Central suite: `src/__tests__/metrics-integration.test.ts`.
This dir's `__tests__/metrics.test.ts` is the **only** colocated test in the repo.
