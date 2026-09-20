# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-20
**Commit:** c963732
**Branch:** develop

## OVERVIEW

MCP sequential-thinking server (`@iworkforces/tracelattice`). TypeScript ESM + Valibot + custom DI. Public API is `src/lib.ts` → `dist/lib.js`; CLI is Bun-shebang `src/cli.ts` → `dist/cli.js`. Pipeline: normalize → validate → persist → format → evaluate → strategy → hints. MCP runtime is `tmcp` + `@tmcp/adapter-valibot`, not the official SDK.

## STRUCTURE

```
./
├── src/lib.ts            # Public API: createServer / initializeServer / HttpTransport
├── src/cli.ts            # Bin entry (tracelattice). Do not mix with lib.ts
├── src/CliLifecycle.ts   # SIGINT/SIGTERM + stdin-end shutdown
├── src/schema.ts         # Valibot SSOT + TOOL_DESCRIPTION
├── src/ServerConfig.ts   # Validated config + 7 feature flags
├── src/errors.ts         # SequentialThinkingError + ERROR_CODES (41)
├── src/core/             # Pipeline + session/persistence coordinators
├── src/persistence/      # File v2 / SQLite v2 / Memory sinks
├── src/contracts/        # Cross-module interfaces (no barrels)
├── src/di/               # Container + ServiceRegistry (20 keys)
├── src/transport/        # Streamable HTTP + HTTP JSON-RPC
├── src/__tests__/        # Central Vitest suite (not colocated)
├── scripts/              # Packed-CLI shebang + verify:packed
└── .sentrux/             # 9 layers, 6 forbidden import edges
```

## WHERE TO LOOK

| Task                   | Location                            | Notes                                                            |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Public API / DI wiring | `src/lib.ts`                        | 20 ServiceRegistry keys; `refreshDiscovery()`                    |
| CLI + shutdown         | `src/cli.ts`, `src/CliLifecycle.ts` | stdio default; Streamable HTTP via `TRACELATTICE_TRANSPORT_TYPE` |
| Thought ingest         | `src/core/ThoughtProcessor.ts`      | Only admission seam                                              |
| History / ownership    | `src/core/HistoryManager.ts`        | Coordinates; does not score                                      |
| DAG emit / walk        | `src/core/graph/`                   | `EdgeEmitter`; `GraphView.depthFromRoots`                        |
| Persistence backends   | `src/persistence/`                  | Sinks only; buffer is in `core/`                                 |
| Contracts              | `src/contracts/`                    | `IHistoryManager` + `ThoughtData` stay in `core/`                |
| Strategy policy        | `src/core/reasoning/strategies/`    | `decide()`, not `decideNext`; ToT `depthCap` 8                   |
| Packed release         | `scripts/`                          | `verify:packed` + postbuild shebang                              |

## CODE MAP

Import fan-in (src, tests excluded). No LSP / codegraph in this workspace. Sentrux DSM: 1255 edges, 0 inversions, acyclic.

| Symbol                              | Type   | Location                                   | Refs | Role                                                               |
| ----------------------------------- | ------ | ------------------------------------------ | ---- | ------------------------------------------------------------------ |
| `asSessionId`                       | fn     | `src/contracts/ids.ts`                     | —    | Only validated SessionId constructor; rejects retired `__global__` |
| `SequentialThinkingError`           | class  | `src/errors.ts`                            | 44   | ERROR_CODES hub (41)                                               |
| `ThoughtData` / `ValidatedThought`  | type   | `src/core/thought.ts`                      | 35   | Schema output + branded IDs + 7-way union                          |
| `PersistenceBackend`                | iface  | `src/contracts/PersistenceBackend.ts`      | 16   | Session-scoped sink contract                                       |
| `SequentialThinkingSchema`          | schema | `src/schema.ts`                            | 11   | ThoughtData input SSOT                                             |
| `HistoryManager`                    | class  | `src/core/HistoryManager.ts`               | 8    | Session maps + mutation coordinator (~990L)                        |
| `IHistoryManager`                   | iface  | `src/core/IHistoryManager.ts`              | 6    | Stays in core                                                      |
| `ThoughtProcessor`                  | class  | `src/core/ThoughtProcessor.ts`             | 2    | Ingest seam (~890L)                                                |
| `ToolAwareSequentialThinkingServer` | class  | `src/lib.ts`                               | 1    | Public server; wires 20 DI keys (~873L)                            |
| `createServer` / `initializeServer` | fn     | `src/lib.ts`                               | —    | Library factory / CLI convenience                                  |
| `ServiceRegistry`                   | iface  | `src/di/ServiceRegistry.ts`                | 1    | 20 typed keys incl. `sessionLifecycle`                             |
| `IReasoningStrategy`                | iface  | `src/contracts/strategy.ts`                | 5    | `decide` / `shouldBranch` / `shouldTerminate`                      |
| `EdgeEmitter`                       | class  | `src/core/graph/EdgeEmitter.ts`            | 1    | DAG writes; `dagEdges` gates this path                             |
| `PersistenceBuffer`                 | class  | `src/core/PersistenceBuffer.ts`            | 1    | Write queue / barriers (~652L)                                     |
| `SessionLifecycleCoordinator`       | class  | `src/core/SessionLifecycleCoordinator.ts`  | 4    | Admission + exclusive reset/evict                                  |
| `createPersistenceBackend`          | fn     | `src/persistence/PersistenceFactory.ts`    | 1    | file / sqlite / memory / null                                      |
| `StreamableHttpTransport`           | class  | `src/transport/StreamableHttpTransport.ts` | 0    | Production HTTP MCP path (~847L); not a lib export                 |

## CONVENTIONS

- **ESM + `.js` specifiers**, no barrels, tabs + single quotes + printWidth 100.
- **Valibot** in `src/schema.ts` — not Zod. `ThoughtData` brands schema output.
- **DI**: 20 `ServiceRegistry` keys registered in `lib.ts`. Typed `resolve(key)` only; `resolveDynamic` is untyped escape hatch.
- **Contracts hub**: cross-module types via `src/contracts/`. Exceptions: `IHistoryManager` + `ThoughtData` stay in `core/`.
- **Branded IDs**: `asSessionId()` validates and rejects the retired `__global__` value. Other `asX()` are unchecked casts. Never `as SessionId`. Every thought path carries an explicit named `SessionId`; there is no default session.
- **Feature flags** (7): `dagEdges`, `reasoningStrategy` (`sequential`\|`tot`), `calibration`, `compression`, `toolInterleave`, `newThoughtTypes`, `outcomeRecording`. `DEFAULT_FLAGS` / `validateFeatures()` booleans **on**. Flags gate **writes**; stores stay in DI except `suspensionStore` (registered only if `toolInterleave`).
- **Session ownership**: `getOwner()` from ALS. Stdio (no owner) unrestricted. Cross-owner → `SessionAccessDeniedError`. Restored sessions deny owner-aware access.
- **Strategy purity**: `decide(ctx)` over a snapshot. No I/O, no graph mutation.
- **`override` + `_` private prefix**. `noImplicitOverride`, unused args `^_`.

## ANTI-PATTERNS (THIS PROJECT)

- No `as SessionId`, no inline `import()` types, no barrels, no `export { } from` / `export * from`, no `as any` / `@ts-ignore`.
- No mixing `lib.ts` (public API) and `cli.ts` (bin).
- No stdout logs (MCP). No empty catch. No sync I/O except startup `existsSync`.
- Forbidden sentrux edges: `transport→core`, `transport→registry`, `watchers→persistence`, `cluster→registry`, `persistence→transport`, `registry→core/HistoryManager.ts`.
- `BaseTransport` currently imports `SESSION_ID_PATTERN` from `core/ids.ts` — do not add more `transport→core` imports.
- Max CC 25, max function 100 lines (sentrux). `generateUlid` is not a real ULID — do not rename.
- Do not “fix” evaluator `type_diversity` divisor `log2(6)` without a scoring-compat decision.

## UNIQUE STYLES

- Dual build: rslib unbundled lib then rsbuild overwrites `dist/cli.js`. `cleanDistPath` must stay **false**.
- Packed runtime is **Bun 1.4.2**; scripts/tests are Node. Shebang writer is only `scripts/postbuild-cli.mjs`.
- Three “session” words: required thought `session_id`, MCP `Mcp-Session-Id` transport session, and `ConnectionPool` slot. They are independent and do not share defaults or reapers. ALS request-owner identity is a separate authorization context. `resetAll()` / `clearAll()` / shutdown are explicit all-session administration, not a fourth session identity.
- Mixed DI key casing: `HistoryManager` vs `sessionLifecycle`.
- Runtime environment keys use the `TRACELATTICE_*` namespace exclusively.

## NOTES

- CI: Node **24.x + 26.x** (library); native/packed **26.x**. Hard gates: `verify:library`, `verify:native`, `verify:packed`. Soft: `npm audit` only.
- CD publishes the packed tarball artifact (does not rebuild). Packed CLI shebang is **Bun 1.4.2**.
- Coverage: branches 90 / functions 60 / lines 65 / statements 65.
- Layers: types → crosscutting → config → core → domain → infrastructure → di → app → cli. `contracts/` and `utils.ts` are unlayered.
- `ConnectionPool` is off CLI/DI. `HttpTransport` is a **library export**; CLI never selects it. `cluster/` does not exist (still a sentrux boundary).
- Large files: `HistoryManager` 990, `ThoughtProcessor` 890, `lib` 873, `errors` 867, `StreamableHttpTransport` 847, `schema` 738, `PersistenceBuffer` 652, `ConnectionPool` 645.
- Tests: `src/__tests__/` mirrors source; flags via constructor; `RUN_EVAL=1` for `*.eval.ts`.

## COMMANDS

```bash
npm run build            # rslib && rsbuild && postbuild shebang
npm run start            # bun dist/cli.js
npm run dev              # bunx MCP inspector
npm test                 # vitest run --config vitest.config.ts
npm run test:coverage
npm run test:native
npm run type-check
npm run lint
npm run verify:library   # type-check + lint + build + coverage
npm run verify:native
npm run verify:packed
npm run verify:release   # all three (also prepublishOnly)
```
