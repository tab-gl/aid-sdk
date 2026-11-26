# Popup sign-in demo

A small static integration reference for browser sign-in. It uses the built IIFE bundle, a public OIDC client, and the SDK's Authorization Code + PKCE flow. The SDK relays no tokens between windows; the opener validates the callback and performs the code exchange.

## Prerequisites

- Node.js 18 or newer to build the SDK and generate the local config.
- A public OIDC client with Authorization Code + PKCE (`S256`) enabled. Do **not** create or use a client secret in browser code.
- A server that serves the repository root over `http://localhost` or HTTPS. Do not open the files as `file://` URLs.

## Configure and run

1. From the repository root, install dependencies and build the browser bundle:

   ```sh
   npm ci
   npm run build
   ```

2. Copy `examples/popup/.env.example` to `examples/popup/.env`, then set the issuer and public client ID:

   ```dotenv
   ACE_ID_ISSUER=https://your-issuer.example
   ACE_ID_CLIENT_ID=your-public-client-id
   ACE_ID_APP_ORIGIN=http://localhost:8000
   ```

   The generator reads this file; matching process environment variables override it. You can alternatively supply the variables directly to `node examples/popup/configure.mjs`. `ACE_ID_APP_ORIGIN` must be an origin only (no path/query). Run:

   ```sh
   node examples/popup/configure.mjs
   ```

   This creates the Git-ignored `config.local.js` and prints the exact callback URIs. With the example app origin, register both of these with the OIDC client:

   ```text
   http://localhost:8000/examples/popup/callback.html
   http://localhost:8000/examples/popup/redirect-callback.html
   ```

   `callback.html` is popup-only and calls `handlePopupCallback()`. `redirect-callback.html` is redirect-only and calls `handleCallback()`. Separate routes prevent a popup whose `window.opener` was severed by COOP from exchanging a code into the popup's own session. Because the demo's **Sign out** button returns to the app page, register the printed app URI as an RP-initiated post-logout URI too if your issuer requires it; this is separate from the two authorization callback URIs.

3. Serve the repository root:

   ```sh
   python3 -m http.server 8000 --bind 0.0.0.0
   ```

4. Open `http://localhost:8000/examples/popup/index.html`. Try **Continue with popup**, **Continue with full-page redirect**, and **Sign out**.

`ACE_ID_ISSUER` and `ACE_ID_CLIENT_ID` are public values and are delivered to the browser in `config.local.js`; they are not secrets. The generator does not read or embed client secrets. Never add a client secret to this demo, a `.env` file used by a frontend, or any browser bundle.

The two app clients share the default `sessionStorage` prefix. A single tab cannot run overlapping SDK sign-in flows against the same storage; attempts are rejected instead of overwriting transaction state. Separate tabs with isolated `sessionStorage` can authenticate independently. If an app deliberately uses shared `localStorage`, treat the SDK's flow lock as a same-runtime guard—not a cross-process atomic lock—and coordinate cross-tab sign-in in the host app.

## Expected behavior and troubleshooting

- **Popup blocked:** the SDK rejects the popup request and does not navigate the main page. The demo explains the fallback; enable popups for the app or choose **Continue with full-page redirect**.
- **Popup closed or cancelled:** the main page cancels the attempt, clears its transaction, and restores both sign-in choices. Try again or choose redirect. If the provider returns `access_denied`, the demo says sign-in was cancelled and no session was created.
- **Callback page opened directly:** `callback.html` reports that it has no live opener and does not exchange the code. Close the window and start sign-in from the demo; use the redirect button for a top-level callback.
- **COOP or opener severed:** `Cross-Origin-Opener-Policy: same-origin` can break the opener channel. The popup callback reports failure and leaves the code unexchanged; use redirect sign-in. If popup UX is required, test `same-origin-allow-popups` with the app and provider's response headers. Do not add `noopener` to the auth popup or relax state/origin/PKCE checks.
- **Refresh/navigation while pending:** the opener's `pagehide` handler cancels the attempt, closes the popup, and clears the matching transaction and flow lock. Start a new attempt after the page loads.
- **Redirect URI mismatch:** register both exact printed callback URIs, including scheme, host, port, and path. Do not register `config.local.js` or the app page as a callback.
- **CORS/discovery/token errors:** allow the app origin in the issuer's browser/CORS settings and confirm the issuer exposes discovery, token, and JWKS endpoints for this public client.
- **Mobile:** do not force popup sign-in on mobile. Use the explicit redirect action or the platform's system-browser authentication flow.

The opener verifies the callback origin/path and state, and if the OIDC `iss` response parameter is present it must match the configured issuer. The callback validator rejects duplicate `code`, `state`, `error`, or `iss` parameters and a callback-supplied `redirect_uri`. Unknown query keys are ignored for provider interoperability and are never used as token/session inputs; the SDK only consumes its documented OAuth response fields.

## Validation record

Recorded on 2026-11-26. Unit integration uses a real loopback HTTP OIDC fixture (`/authorize`, `/token`, `/jwks`) with fake `Window` objects. A separate real-engine run used the fixture in Chromium Headless Shell; neither substitutes for a live issuer, headed browser, or assistive-technology session.

| Browser/runtime and OS | Configuration | Scenario | Expected behavior | Actual result |
| --- | --- | --- | --- | --- |
| Vitest 4.1.12 / Node 22.22.3, Linux x86_64 (fake Window, not a browser) | Local loopback OIDC issuer; `popup-client`; registered callback `https://app.example.test/auth/callback`; `S256`; separate `MemoryStorage` per simulated tab | Callback route opened directly | Reject without an opener; do not exchange a code | PASS (`test/popup-auth.test.ts`) |
| Vitest 4.1.12 / Node 22.22.3, Linux x86_64 (fake Window, not a browser) | Same fixture; active popup transaction, including a gated token exchange | User closes popup before callback or while exchange is pending | Reject; clear transaction/lock; a late token response must not save a session | PASS for both close timings (`test/popup-auth.test.ts`) |
| Vitest 4.1.12 / Node 22.22.3, Linux x86_64 (fake Window, not a browser) | Same fixture; two independent storages, then shared storage | Two simultaneous tabs/clients | Isolated storages proceed independently; same-storage attempts do not overwrite the active transaction | PASS in the tab/storage simulation (`test/popup-auth.test.ts`) |
| Vitest 4.1.12 / Node 22.22.3, Linux x86_64 (fake Window, not a browser) | Same fixture; `pagehide` during discovery and callback wait | Refresh or top-level navigation while pending | Cancel, close popup, clear lock/transaction; no late session write | PASS (`test/popup-auth.test.ts`) |
| Chromium Headless Shell 158.0.8127.0 / Playwright 1.65.1 / Node 22.22.3, Linux x86_64 | Local app and OIDC fixture on separate loopback origins; `browser-client`, PKCE `S256`; fixture proxy adds CORS headers; browser web security remains enabled; app header set to `Cross-Origin-Opener-Policy: same-origin` for COOP case | Auth sheet focus/Tab wrap/visible focus/Escape restore and dialog semantics; 390×844 viewport bounds; popup + redirect authorization-code flow and session reload; provider `access_denied`; direct callback; COOP opener loss | Keep focus in the modal and restore it on close; exchange/verify successful codes once; cancellation, direct callback, and severed-opener cases create no session or token exchange and expose recovery UI | PASS — all 7 browser checks, 2026-11-26; two successful token exchanges total, none for the cancellation/direct-callback/COOP cases |
| Chrome, Edge, Firefox, Safari in headed user sessions; physical iOS/Android devices; screen readers | Configure `.env` and register both exact localhost callback URIs; record app/provider COOP/CSP headers and browser/OS versions | Direct callback, close, two tabs, pagehide, popup blocker, COOP, keyboard-only and screen-reader use | Behaviors listed above; redirect remains available if popup relay is severed; controls and announcements are usable with assistive technology | NOT RUN — the headless Chromium checks are not a headed browser/device or screen-reader sign-off. Run the production app with a real issuer before rollout. |

For each real-browser run, record **browser + version, OS, app origin, issuer, client type, both registered callback URIs, COOP/CSP headers, scenario, expected behavior, actual result, and date**. Do not mark a browser compatible based only on fake-window tests or a single headless Chromium build.
