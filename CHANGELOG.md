# Changelog

## [0.2.5] - Unreleased

### Added

- A framework-agnostic browser sign-in sheet at `ace-id-sdk/ui`, with provider buttons, branding and theme options, loading/success/cancellation/error states, keyboard focus management, and mobile redirect defaults.
- A runnable extension of the existing `examples/popup` demo covering popup and full-page redirect sign-in, callback recovery, session restoration, and sign-out.
- Conditional ESM and CommonJS declaration targets for every public package subpath.

### Improved

- Popup sign-in opens synchronously from a user gesture, validates callback origin/path/state and optional OIDC `iss`, and exchanges the authorization code only in the opener after a source- and origin-checked handshake.
- Popup closure, opener loss, provider cancellation, refresh/navigation, timeout, and late callback races now have explicit cleanup and recovery behavior.
- Package checks cover standalone ESM/CommonJS entry points, SSR imports, NodeNext declarations, installed-tarball behavior, and tree-shaking.
- The Vitest test runner was updated to 4.1.12, and the declared Node.js runtime floor is now 20+ for the global Web Crypto API. The release workflow verifies the packed npm artifact rather than relying only on repository imports and a dry run.

### Security

- Updated the development bundler dependency to esbuild 0.28.2 across tsup, Vite, and the tarball checker, clearing the low-severity Windows development-server advisory.
- Reject duplicate OAuth response parameters and callback-supplied `redirect_uri` values; unknown query parameters are not treated as token/session inputs.
- Do not relay tokens between the popup and opener. A popup with a missing/severed opener reports recovery guidance and does not exchange its callback code.
- Cancellation, timeout, sign-out, and superseding-flow checks prevent late token responses from creating a session or clearing newer transaction state.
