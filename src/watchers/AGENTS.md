# WATCHERS MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

Chokidar live-refresh for tool/skill registries. Both watchers serialize `refreshAsync()` — they do **not** mutate the registry by name.

## FILES

```
watchers/
├── ToolWatcher.ts    # .tool.md add/change/unlink → ToolRegistry.refreshAsync()
└── SkillWatcher.ts   # add/change/unlink → SkillRegistry.refreshAsync()
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

- `new ToolWatcher(tools, logger, config.toolDirs)`
- `new SkillWatcher(skills, logger, config.skillDirs)`

Constructor fallbacks (only if no dirs passed):

- tools: `.claude/tools`, `~/.claude/tools`
- skills: `.claude/skills`, `~/.claude/skills`

Skill **discovery** defaults also include `.agents/skills` + `~/.agents/skills`. Watcher fallbacks do **not**. Pass `config.skillDirs` so those extra dirs are watched.

## RULES

- Errors from `refreshAsync()` are logged, never thrown.
- `ignoreInitial: true`. Ignore `node_modules` + `.DS_Store`.
- Tool events that are not `.tool.md` are ignored. Skills log add/change/remove when `TRACELATTICE_WATCHER_VERBOSE=true`.
- `ready()` waits for chokidar's initial scan. `stop()` closes the watcher and joins the in-flight refresh.
- Instantiated only if `enableWatcher`. Stopped with the server.

## FORBIDDEN

- `watchers → persistence`.
- Do not embed watcher logic in `src/registry/`.
