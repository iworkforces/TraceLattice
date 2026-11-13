# WATCHERS MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Chokidar live-refresh for tool/skill registries. Both watchers serialize `refreshAsync()` — they do **not** mutate the registry by name. Both delegate the chokidar lifecycle to one shared supervisor so they cannot drift.

## FILES

```
watchers/
├── RecoverableWatcher.ts # chokidar supervisor: error → close → capped-backoff restart, bounded ready/stop
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
- `directory` in a fault is a configured root, spelled as configured. `lib.ts` forwards each fault as the `discoveryError` event.
- `stop()` cancels the restart and ready timers, closes the live instance with a 2000 ms bound, and joins the in-flight refresh. A fault after `stop()` creates nothing.
- Instantiated only if `enableWatcher`. Stopped with the server.

## FORBIDDEN

- `watchers → persistence`.
- Do not embed watcher logic in `src/registry/`.
