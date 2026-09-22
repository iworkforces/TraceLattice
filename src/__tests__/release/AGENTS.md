# RELEASE TESTS

**Parent:** ../AGENTS.md

## OVERVIEW

Policy locks for CI, CD, the packed CLI, and the SSE resurrection ban. These files do not exercise reasoning behavior.

## FILES

| File | Locks |
|------|-------|
| `CiWorkflow.test.ts` | Jobs `library`, `native-sqlite`, `packed-cli`, `required-gates`, advisory `advisory-audit`. Library Node 24.x and 26.x. Native and packed Node 26.x. Bun **1.4.2**. Actions are SHA-pinned. Required jobs are not `continue-on-error`. |
| `CdWorkflow.test.ts` | Publish does not rebuild. Shebang `#!/usr/bin/env bun`. Package `@iworkforces/tracelattice`, bin `./dist/cli.js`. |
| `LegacySseRemoval.test.ts` | No `SseTransport.ts` and no SSE identifiers on the frozen file list. Streamable HTTP default port stays `9007`. |
| `PackedCliArtifact.test.ts` | Shebang, pack contents, runtime contract. |
| `ReleaseGateScripts.test.ts` | `verify:packed` / `verify:release` / `prepublishOnly`. |
| `ReleaseReceiptValidator.test.ts` | Receipt schema CD consumes. |
| `VitestAuthority.test.ts` | Sole config is `vitest.config.ts`: floors, 30s timeouts, include list. |

## ANTI-PATTERNS

- Do not add `prepublish`, `prepare`, `prepack`, `postpack`, `publish`, or `postpublish`. `prepublishOnly` stays `verify:release`.
- Do not move `npm audit` into `required-gates`.
- Do not reintroduce SSE files or the banned identifiers (`text/event-stream`, `_sendSseEvent`, `notificationStreams`, `broadcastToSession`, `'sse'` on cli / lib / the transport contract).
- Do not add a second Vitest config.

## NOTES

- `scripts/current-contract.mjs` skips `src/__tests__/`, so negative fixtures in this directory do not trip the source scan.
