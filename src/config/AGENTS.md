# CONFIG MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

This folder is **only** `ConfigLoader.ts`. There is **no** `server-config.ts` shim here.

Canonical validated config is `src/ServerConfig.ts`. Loader returns raw `ConfigFileOptions`; `ServerConfig` validates + resolves feature flags.

## LOAD ORDER

env > project > user > defaults.

1. `TRACELATTICE_CONFIG` or a constructor path replaces the search list.
2. Else first hit: `.claude/config.json`, `.yaml`, `.yml`, then the same three under `~/`.

YAML or JSON. All fields optional. Extra keys kept (`looseObject`). Env overrides the file.

## DI KEYS

| Key | Type | Meaning |
|-----|------|---------|
| `FileConfig` | `ConfigFileOptions` | raw pre-validation blob |
| `Config` | `ServerConfig` | validated + flags |

## FLAGS

See `contracts/features.ts`. `ServerConfig.validateFeatures()` fills booleans **on** and `reasoningStrategy: 'sequential'`. **No `hasFeature()`**.

## NOTES

- CLI does **not** parse config args. Env + files only.
- `load()` is declared `| null` and the JSDoc says `null`, but it always returns `applyEnvironmentOverrides(...)`. A bad file is logged and skipped.
- Startup reads the chosen file with `readFileSync` (not only `existsSync`).
- `src/types/server-config.ts` is a **runtime** tools/skills bag — not this loader, not `ServerConfig`.
- Do not add a re-export shim in this directory.
