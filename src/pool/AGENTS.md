# POOL MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

Optional HTTP-layer session isolation. Each slot is a `SessionServer` from `serverFactory`. **Not** `HistoryManager._sessions` (`SessionManager` only plans TTL/LRU) and not the Streamable HTTP `Mcp-Session-Id`.

Unused by `lib.ts` / `cli.ts`. Tests + optional HTTP isolation only. Not a DI key.

## FILES

```
pool/
├── ConnectionPool.ts    # lifecycle, TTL sweep, stats
├── IConnectionPool.ts   # contract + shared types
└── PoolErrors.ts        # SessionNotFoundError, SessionNotActiveError
```

Shared types live on `IConnectionPool.ts`: `ContentBlock`, `ProcessResult`, `SessionServer`, `SessionInfo`, `ConnectionPoolStats`, `SessionRunResult`. Import `IConnectionPool`, not the concrete class.

## DEFAULTS

| Option            | Default |
| ----------------- | ------- |
| `maxSessions`     | 100     |
| `sessionTimeout`  | 5 min   |
| `cleanupInterval` | 1 min   |
| `autoCleanup`     | true    |

## API

- `createSession()` → `SessionId`
- `process(poolSessionId, input)` — `input.session_id` stays the thought key
- `runWithSession(sessionId, operation)` → completed / inactive / missing
- `getSessionInfo` / `getActiveSessions` / `getStats` / `isRunning`
- `closeSession(sessionId)` / `dispose()`

## ERRORS

| Error                     | Where           | When                       |
| ------------------------- | --------------- | -------------------------- |
| `MaxSessionsReachedError` | `errors.ts`     | `createSession` at cap     |
| `PoolTerminatedError`     | `errors.ts`     | any call after `dispose()` |
| `SessionNotFoundError`    | `PoolErrors.ts` | unknown id                 |
| `SessionNotActiveError`   | `PoolErrors.ts` | closed session             |

All extend `SequentialThinkingError`.

## NOTES

- Cleanup closes sessions idle longer than `sessionTimeout`.
- `Session` tracks `lastActivityAt` independently of StreamableHTTP's `lastActivityAt` (no shared reaper).
- A pool slot never supplies a thought `session_id`; callers still pass the named thought session to processing.
- Do not import `ConnectionPool` from transports or `lib.ts` unless adding a real consumer.
