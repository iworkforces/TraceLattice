# REGISTRY MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

Passive tool/skill stores. `BaseRegistry<T extends { name: string }>` owns CRUD + discovery. Watchers in `src/watchers/` drive refresh. Identity is the `name` string — **not** a branded ID.

## FILES

```
registry/
├── BaseRegistry.ts    # generic store, frontmatter, discovery
├── ToolRegistry.ts    # .tool.md → Tool
└── SkillRegistry.ts   # .md / .yml / .yaml → Skill
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| New entity registry | Subclass `BaseRegistry<T>`; implement the abstract hooks |
| Frontmatter | `BaseRegistry._parseFrontmatter` (YAML between `---`) |
| Tool allowlist | `IToolRegistry` (skill `allowed_tools`) |
| Cache | `src/cache/DiscoveryCache.ts` — only key `'all'` is written |
| FS events | `src/watchers/` — do not embed chokidar here |

## HOOKS

Subclasses implement: `_fileExtensions`, `_entityName`, `_shouldSkipFile`, `_parseFrontmatter`, `_buildItem`, `_createInvalidError`, `_createDuplicateError`, `_createNotFoundError`.

## RULES

- Manual `add()` wins on name. Discovered rows are keyed by path (`_discoveredItemsByPath`). `refreshAsync` coalesces to one in-flight scan plus one queued pass.
- Tools: `.tool.md`. Skills: `.md`, `.yml`, `.yaml`.
- Both registries use `add`, `remove`, `update`, `get`, `getAll`, `has`, `getNames`, `clear`, and `size` from `BaseRegistry`.
- `lazyDiscovery` is accepted on the options type but **unused in the class**. Gated in `lib.ts` (`autoDiscover` vs `lazyDiscovery`).
- `existsSync` is the only sync FS call (skip missing dirs). Everything else is async.
- `ToolRegistry.get()` still probes `tool:${name}` — that per-name cache is **dead**. Only `'all'` is set.

## FORBIDDEN

- `registry → core/HistoryManager.ts`. Zero `core/` imports today. Keep it that way.
- Do not put watchers or chokidar in this folder.
- Do not throw raw `Error` — use the `_create*Error` hooks.
