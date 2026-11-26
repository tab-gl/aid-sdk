# v0.2.5 release checklist

**Release state:** prepared on the active feature-freeze branch; not tagged or published. Do not publish this branch. The exact-release-commit gates below remain mandatory after merge to `main`.

## Candidate verification record — 2026-11-26

- [x] `npm test` on Node 22.22.3 with Vitest 4.1.12: **302 passed, 1 skipped** (the optional live-issuer discovery test is skipped without configuration).
- [x] `npm run typecheck` passed after updating the fake popup mock types for Vitest 4.
- [x] Minimum Node.js 20.20.2: typecheck, full test suite (**302 passed, 1 skipped**), build/bundle/package verification, and installed-tarball Web Crypto PKCE checks passed.
- [x] `npm run verify` passed: ESM and CommonJS entry points, NodeNext ESM/CJS declarations, SSR import/construction with explicit storage, and bundle budgets (UI entry: **40.9 kB gzip**).
- [x] On 2026-11-26, the v0.2.5 tarball was installed into a clean consumer: all six public subpaths loaded in ESM and CommonJS; explicit-storage SSR construction and Web Crypto PKCE generation passed in both on Node 20.20.2; NodeNext resolved `.d.ts`/`.d.cts` declarations for every subpath; and tree-shaking produced an **8,113 B** named `createCodeVerifier` bundle versus an **80,429 B** namespace bundle. Re-run this on the exact release commit.
- [x] Headless Chromium 158.0.8127.0 / Playwright 1.65.1 on Linux: keyboard focus/trap/restore, mobile viewport bounds, popup and redirect PKCE flows, session reload, provider cancellation, direct callback recovery, and COOP opener loss passed against the local OIDC fixture. This is not a live issuer or assistive-technology test.
- [x] All GitHub Actions workflows passed `actionlint`; YAML parsing and `bash -n` passed for all 43 `run:` blocks. Release-note generation preserved Markdown code spans, and the checksum manifest verified using paths relative to downloaded assets.
- [x] Dependency tree is consistent: `npm ci` and `npm ls` pass with one deduplicated esbuild **0.28.2** across tsup, Vite, and the checker; `@types/node`, `@types/react`, and linkedom are updated to compatible patches.
- [x] Full `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities**.
- [x] React adapter test warning removed by using the React DOM renderer for client-side tests; Node 20/22 test runs pass without the prior mixed-renderer warning.
- [ ] Run an authorization-code sign-in against a non-production live issuer/client. `ACE_ID_TEST_ISSUER` currently performs discovery only; it does not prove an interactive flow. Use a public client, no client secret, and do not put test-account credentials in this repository or chat.
- [ ] Run headed Chrome/Edge/Firefox/Safari checks and a real mobile/device + keyboard-only/screen-reader pass. Record browser/OS/version, origins, callback URIs, COOP/CSP, scenario, result, and date in `examples/popup/README.md`.

## Exact release commit gates

- [ ] Merge the candidate to `main`; record the full release commit SHA and verify the checkout is clean.
- [ ] Run the Node CI matrix and the release-build workflow on that exact SHA. Confirm typecheck, tests, build, package exports, bundle budgets, actual installed tarball, Android tests/AAR, and iOS Simulator tests all pass for the same commit.
- [ ] Re-run `npm audit` and `npm audit --omit=dev` on the exact release commit; require **0 vulnerabilities** or record maintainer approval for any newly disclosed advisory.
- [ ] Inspect the exact `.tgz` contents and verify the v0.2.5 tarball installs from the generated artifact; confirm ESM, CommonJS, types, SSR, and tree-shaking results.
- [ ] Confirm npm Trusted Publishing is configured for `tab-gl/aid-sdk` / `release.yml` with the required GitHub OIDC permissions. Do not add a long-lived npm token unless the maintainer intentionally uses the documented fallback.
- [ ] Confirm Android signing/Central deployment configuration in GitHub Actions. Upload the signed v0.2.5 bundle to the user-managed Central staging deployment; review its POM, AAR, signatures, and checksums before pressing **Publish** in Central Portal.
- [ ] Dispatch `.github/workflows/release.yml` from `main` at the same validated commit. Enable `publish_npm` and/or `publish_release` only after all release-build jobs pass; verify npm provenance, immutable `0.2.5` tag, release assets, and `SHA256SUMS`.
- [ ] Confirm the `0.2.5` tag's iOS workflow passes. The iOS deliverable is source-only; no binary framework is advertised.
- [ ] Replace the `Unreleased` changelog heading with the actual release date only when the release is approved, then preserve the release notes with the published artifacts.

Do not retarget or overwrite an existing version tag, reuse an npm version, or publish from a feature branch. The Android Maven Central upload is a separate user-managed publication even when the GitHub release includes the AAR.
