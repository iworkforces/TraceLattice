# LOGGER MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

Structured logging to **stderr**. **Never write stdout** — MCP owns it.

## FILES

```
logger/
├── StructuredLogger.ts  # Logger interface + StructuredLogger
└── NullLogger.ts        # no-op (tests / fallbacks)
```

## API

```
debug / info / warn / error(message, meta?)
setLevel(level)
getLevel()
```

`createChild(context: string)` is on `StructuredLogger` and `NullLogger`, **not** on `Logger`. Do not widen `Logger` so watcher no-ops can omit it. There is no `child({ ...meta })`.

Depend on the `Logger` interface, not `StructuredLogger`. DI key is `Logger`.

`LogLevel`: `debug < info < warn < error`.

## MODES

- Pretty is the default (`pretty ?? true`): `[timestamp] [LEVEL] [context] message {meta}` on stderr. Not Chalk.
- JSON when `pretty: false`. `meta` stays nested. `TRACELATTICE_PRETTY_LOG=false` is the only env value that turns pretty off.

## NOTES

- Every line auto-injects `getRequestId()` from ALS (`RequestContext`) when a request is active.
- `NullLogger` implements the same surface, including `createChild`.
- Watcher no-op loggers omit `createChild` — keep them local, do not widen `Logger` for that.
- Child inherits parent level + pretty; `setLevel` on a child is independent.
