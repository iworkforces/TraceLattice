# WATCHERS MODULE

**Updated:** 2026-11-13
**Parent:** ../AGENTS.md

## OVERVIEW

Chokidar live-refresh for tool/skill registries. Both watchers serialize `refreshAsync()` — they do **not** mutate the registry by name. Both delegate the chokidar lifecycle to one shared supervisor so they cannot drift.

## FILES

```
watchers/
├── RecoverableWatcher.ts # chokidar supervisor: error → close → capped-backoff restart, bounded ready/stop, degraded replacement ready
├── ToolWatcher.ts        # .tool.md add/change/unlink → ToolRegistry.refreshAsync()
└── SkillWatcher.ts       # add/change/unlink → SkillRegistry.refreshAsync()
```

## EVENTS

| Event | ToolWatcher | SkillWatcher |
|-------|-------------|--------------|
| `add` | refresh | refresh |
| `change` | refresh | refresh |
| `unlink` | refresh | refresh |

`ToolWatcher` **does** watch `change`. Unlink is **not** delete-by-name. Both queue a single in-flight refresh (`_pendingRefresh` + `_refreshQueued`).

## DIRS

Wired in `lib.ts` when `enableWatcher`:

- `new ToolWatcher(tools, logger, config.toolDirs, reportFault)`
- `new SkillWatcher(skills, logger, config.skillDirs, reportFault)`

Constructor fallbacks (only if no dirs passed):

- tools: `.claude/tools`, `~/.claude/tools`
- skills: `.claude/skills`, `~/.claude/skills`

Skill **discovery** defaults also include `.agents/skills` + `~/.agents/skills`. Watcher fallbacks do **not**. Pass `config.skillDirs` so those extra dirs are watched.

## RULES

- Errors from `refreshAsync()` are logged, never thrown.
- `ignoreInitial: true`. Ignore `node_modules` + `.DS_Store`.
- Tool events that are not `.tool.md` are ignored. Skills log add/change/remove when `TRACELATTICE_WATCHER_VERBOSE=true`.
- `ready()` returns the constructor-time promise. It resolves on chokidar's first `ready`, or degraded after a fixed 5000 ms bound with a logged warning. It never rejects, and a timeout alone does not restart the watcher.
- Every chokidar instance has an `error` listener. A fault (including a synchronous `watch()` throw) is logged, reported through the optional constructor callback `(fault: { error: Error; directory: string }) => void`, and the instance is closed without awaiting `close()`. One replacement is scheduled after a capped exponential backoff (1000 ms doubling to 30000 ms, reset when a replacement reports ready). Events from retired instances are ignored.
- When a replacement reports ready, the watcher runs one `refreshAsync()` through the same single-in-flight scheduling, because changes during the outage went unseen.
- Every replacement gets the same fixed 5000 ms ready bound, armed only after `watch()` succeeded and bound to that instance. If the live replacement misses it, the watcher logs a warning, reports one fault (a plain `Error` naming the watcher label and the bound, with `directory` set to the first configured root), and runs the recovery refresh once, because changes during the outage went unseen. The instance is **not** closed or restarted and the backoff is unchanged: one hung directory read also blocks `close()`, so a restart per backoff period would leak one chokidar instance each time. A late `ready` from that instance resets the backoff and refreshes once more. An `error` still retires it and schedules a restart. `ready`, a fault and `stop()` clear the bound. The first instance keeps its own bound: it only resolves `ready()` degraded, with no fault and no refresh.
- `directory` in a fault is a configured root, spelled as configured. `lib.ts` forwards each fault as the `discoveryError` event.
- `stop()` cancels the restart, ready and replacement-bound timers, closes the live instance with a 2000 ms bound, and joins the in-flight refresh. A fault after `stop()` creates nothing.
- Instantiated only if `enableWatcher`. Stopped with the server.

## PLATFORM NOTES

On macOS, chokidar 6 reports `ready` before the native backend delivers events, so a file change in roughly the first 100-350 ms after `ready` can be lost with no event at all (measured: about 0.7-2.8% of writes made immediately after `ready` under load, none after 100 ms). `create()` runs discovery after `ready`, so only an edit made in that window after a file's discovery read is missed, until the next change or `refreshDiscovery()`.

## FORBIDDEN

- `watchers → persistence`.
- Do not embed watcher logic in `src/registry/`.
