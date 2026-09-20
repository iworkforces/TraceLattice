# CONFIG MODULE

**Updated:** 2026-09-17
**Parent:** ../AGENTS.md

## OVERVIEW

This folder is **only** `ConfigLoader.ts`. There is **no** `server-config.ts` shim here.

Canonical validated config is `src/ServerConfig.ts`. Loader returns raw `ConfigFileOptions`; `ServerConfig` validates + resolves feature flags.

## LOAD ORDER

env > project > user > defaults.

1. `TRACELATTICE_CONFIG` (custom path)
2. `.claude/config.yaml` \| `.claude/config.json`
3. `~/.claude/config.yaml` \| `~/.claude/config.json`

YAML or JSON. All fields optional. Extra keys kept (`looseObject`).

## DI KEYS

| Key | Type | Meaning |
|-----|------|---------|
| `FileConfig` | `ConfigFileOptions` | raw pre-validation blob |
| `Config` | `ServerConfig` | validated + flags |

## FLAGS

`ServerConfig.validateFeatures()`:

- booleans default **ON** (`dagEdges`, `calibration`, `compression`, `toolInterleave`, `newThoughtTypes`, `outcomeRecording`)
- `reasoningStrategy` default `'sequential'` (`'tot'` allowed)

`contracts/features.ts` exports `FeatureFlags` + `DEFAULT_FLAGS`. **No `hasFeature()`**.

## NOTES

- CLI does **not** parse config args. Env + files only.
- Env overrides use only `TRACELATTICE_*`. `TRACELATTICE_CONFIG` selects an explicit file.
- `src/types/server-config.ts` is a **runtime** tools/skills bag — not this loader, not `ServerConfig`.
- Do not add a re-export shim in this directory.
