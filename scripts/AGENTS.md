# PACKED-CLI RELEASE SCRIPTS

**Parent:** ../AGENTS.md

## OVERVIEW

Packed-CLI release pipeline. Not `src/`. Builds the publishable CLI artifact: Bun shebang, pack, runtime smoke, cleanup. CD publishes the CI tarball and does **not** rebuild.

## STRUCTURE

```
scripts/
├── postbuild-cli.mjs          # After rsbuild: inject shebang + chmod
├── verify-packed-cli.mjs      # npm run verify:packed entry
├── packed-cli-package.mjs     # npm pack + required-file / export / contract checks
├── current-contract.mjs       # Source/build/packed bans for retired or implicit contracts
├── packed-library-api.mjs     # Installed package-root runtime + declaration consumer
├── packed-cli-runtime.mjs     # Packed bin: named call + omitted/retired rejection + shutdown
└── packed-cli-cleanup.mjs     # PackedCliError + temp-root removal
```

## PIPELINE

1. `npm run build` → rslib + rsbuild + `node scripts/postbuild-cli.mjs`.
2. `postbuild-cli.mjs` injects `#!/usr/bin/env bun` (if missing) and `chmod 755 dist/cli.js`.
3. `verify-packed-cli.mjs` checks source/build contracts, packs and installs, checks the installed artifact, runs library and CLI runtime checks, then writes the receipt + `SHA256SUMS`.
4. Optional `--package-dir` / `TRACELATTICE_PACK_OUTPUT_DIR` preserves the tarball.

## CI / CD

- CI job `packed-cli`: Node **26** + Bun **1.4.2** asserted (`test "$(bun --version)" = "1.4.2"`).
- Uploads artifact `tracelattice-release-${{ github.sha }}` from `TRACELATTICE_PACK_OUTPUT_DIR`.
- CD downloads that tarball, checks `SHA256SUMS` + `verification.json`, publishes. No rebuild.

## TESTS

Live in `src/__tests__/release/` (not here):

- `PackedCliArtifact.test.ts` — shebang, pack contents, runtime contract.
- `ReleaseGateScripts.test.ts` — `verify:packed` / `verify:release` / `prepublishOnly` wiring.

## CONVENTIONS

- Do **not** change the shebang to `node`. Packed CLI is Bun.
- `postbuild-cli.mjs` is the only writer of `dist/cli.js` shebang. Do not bake it into rsbuild.
- Scripts are Node ESM (`.mjs`). Runtime under test is the packed Bun bin.
- `PackedCliError` carries `code` + stage flags (`packSucceeded`, `installSucceeded`). Cleanup failures append; they do not swallow the primary error.
- Required pack files: `dist/cli.js`, `dist/lib.js`, `dist/lib.d.ts`, `package.json`.
- Current-contract scans exclude source tests and scope camel-case thought-session patterns to thought APIs, so negative fixtures and transport/pool session contracts do not trip the gate.
- Source, build, and installed-package checks reject `GLOBAL_SESSION_ID`, optional public thought-session declarations, and implicit session fallbacks. The legitimate validator rejection of the `__global__` literal is proved behaviorally by the packed CLI.
- Packed library consumers call `processThought` with a required named session and `getBranches(sessionId)`. Packed CLI checks require the successful response to echo that session and require omitted / retired sessions to return errors.

## NOTES

- `verify:packed` is a hard release gate alongside `verify:library` and `verify:native`.
- Receipt schemaVersion 1: sourceSha, tarball, packedFiles, version checks, explicit-session protocol checks, and shutdown checks.
- Keep `packed-cli-*.mjs` free of `src/` imports. Tests reach them by filesystem path.
