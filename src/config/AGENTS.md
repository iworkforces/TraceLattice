# CONFIG MODULE

**Updated:** 2026-09-22
**Parent:** ../AGENTS.md

## OVERVIEW

This folder contains `ConfigLoader.ts` (YAML/JSON and environment loading), `EnvironmentInteger.ts` (shared strict unsigned-decimal safe-integer grammar), and `CliTransportConfig.ts` (CLI transport environment parser, imported by `cli.ts`, with no transport imports). There is **no** `server-config.ts` shim here.

Canonical validated config is `src/ServerConfig.ts`. Loader returns raw `ConfigFileOptions`; `ServerConfig` validates + resolves feature flags.

## LOAD ORDER

env > project > user > defaults.

1. `TRACELATTICE_CONFIG` or a constructor path replaces the search list.
2. Else first hit: `.claude/config.json`, `.yaml`, `.yml`, then the same three under `~/`.

YAML or JSON. All fields optional. Extra keys kept (`looseObject`). Supported env vars override the file. Buffer size, flush interval, and retries are file-only.

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
- `maxHistorySize` default and cap are **10000** (`ServerConfig`). This loader does not apply defaults.
- `src/types/server-config.ts` is an unused `{ available_tools, available_skills }` type. Not this loader, not `ServerConfig`.
- Do not add a re-export shim in this directory.
