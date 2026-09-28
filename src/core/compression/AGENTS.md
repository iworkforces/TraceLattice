# COMPRESSION

**Parent:** ../AGENTS.md

## OVERVIEW

Deterministic branch rollup. No LLM. `compression` gates whether the processor receives `CompressionService` (the service does not read the flag). `ISummaryStore` stays in DI.

## STRUCTURE

```
compression/
├── Summary.ts              # Summary + SummarySchema
├── InMemorySummaryStore.ts # ISummaryStore
├── CompressionService.ts   # branch → Summary
└── DehydrationPolicy.ts    # keepLastK on main history
```

## ISUMMARYSTORE

`add` · `get` · `forSession` · `forBranch` · `clearSession`

Not `listForBranch`. Also `clearAll` / `size` on the contract.

## SUMMARY

- `id` is a **string** in practice (`SummarySchema` = bounded string).
- `CompressionService` ids via `generateUlid()` — **not** `generateSummaryId()`.
- `createdAt` **is** used (store buckets sort by it).
- Closed fields: `id`, `sessionId`, `branchId?`, `rootThoughtId`, `coveredIds`, `coveredRange`, `topics`, `aggregateConfidence`, `createdAt`, `meta?`.

## COMPRESSIONSERVICE

`compressBranch(sessionId, branchId, rootThoughtId)`:

- **Idempotent** on `(branchId, rootThoughtId)` — existing summary returned unchanged.
- **Additive**: writes a `Summary`; does **not** dehydrate or mutate history. Caller dehydrates.
- Covered set = root + `GraphView.descendants` (all edge kinds).
- Lookup is `historyManager.inspectSession()` — main history first, then branch copies. Branch-only nodes can be covered.

Deterministic reducers:

- Topics: unigrams, `len ≥ 4`, stopwords stripped, top-3 by freq (first-occurrence tiebreak).
- `aggregateConfidence`: arithmetic mean of `calibrated_confidence ?? confidence ?? 0`.

## DEHYDRATIONPOLICY

`keepLastK` (default **50**) over the **main history array** — not frontier distance.

- Last K thoughts stay verbatim.
- Cold prefix: thoughts whose `id` is in a summary `coveredIds` collapse to one `SummaryRef` per summary. Match by **id**, not `coveredRange`.
- Uncovered cold thoughts stay verbatim. Non-mutating. `Date.now()` is not a policy input.
