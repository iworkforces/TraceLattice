# GRAPH

**Parent:** ../AGENTS.md

## OVERVIEW

Thought DAG: typed edges, per-session store, live traversal, write-gated emitter.

## STRUCTURE

```
graph/
├── Edge.ts         # Edge + EdgeKind (8)
├── EdgeStore.ts    # IEdgeStore impl
├── GraphView.ts    # read-only id walks
└── EdgeEmitter.ts  # lives HERE (not src/core/EdgeEmitter.ts)
```

## WHERE TO LOOK

| Task            | File                                        |
| --------------- | ------------------------------------------- |
| New kind        | `Edge.ts` + emit arm in `EdgeEmitter`       |
| Mutate graph    | `EdgeEmitter` → `EdgeStore.addEdge`         |
| Walk / frontier | `GraphView`                                 |
| Root distance   | `GraphView.depthFromRoots` — ToT `depthCap` |
| Retention prune | `EdgeStore.pruneSession`                    |

## EDGE KINDS (8)

`sequence` · `branch` · `merge` · `verifies` · `critiques` · `derives_from` · `tool_invocation` · `revises`

Endpoints are `thought.id`, never `thought_number`.

Direction: `branch`, `merge`, `derives_from`, `tool_invocation`, and `sequence` run source → current. `verifies`, `critiques`, and `revises` run current → target. `verifies` uses `resolvedVerificationTarget`; `critiques` uses `references.verificationTargetThoughtId`.

## IEDGESTORE

`addEdge` · `getEdge` · `outgoing` · `incoming` · `edgesForSession` · `pruneSession` · `clearSession` · `clearAll` · `size`

- Append-only: **no `removeEdge`**. `pruneSession` drops edges whose endpoints left the retained set.
- Self-edge (`from === to`) → `InvalidEdgeError`.
- Same `(from, to, kind)` in a session is silently deduped.
- Session-scoped Maps. No cross-session edges. Query via `edgesForSession`.
- Every edge is scoped to an explicit named thought `SessionId`. There is no default graph session, and retired `__global__` is invalid.

## GRAPHVIEW

Read-only. Returns **ids only**. Live / uncached (no snapshot).

- Isolated thoughts are **invisible** when nodes come only from edges (`depthFromRoots` → `undefined`). A store `nodesForSession` (the strategy projection) makes those ids visible.
- `chronological` is BFS from roots. Neighbors follow `outgoing` order (`createdAt`), not a pure timestamp sort.
- `branchThoughts` follows `kind === 'branch'` only (includes root).
- `descendants` / `ancestors` / `depthFromRoots` follow **all** kinds.
- `depthFromRoots`: 0 at a root; `undefined` if unreachable or isolated. Used by ToT `depthCap` (default 8).
- `leaves` = nodes with no outgoing. Empty store → `[]`.
- `topological` = Kahn; leftover nodes → `CycleDetectedError`.

## EDGEEMITTER

`dagEdges` gates **writes here only**. `EdgeStore` is always in DI.

Emit order: branch → merge → verifies → critiques → derives_from → revises → tool_invocation; else sequence from previous history thought.

`_addEdgeIfValid`: missing endpoint → false. `addEdge` failures (incl. `InvalidEdgeError`) are **caught**, logged at **info**, return **false**. Do not document “don’t swallow” — current code swallows.

Relational intent without a successful add still suppresses the sequence fallback.
