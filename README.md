# Ace ID SDK

JavaScript/TypeScript, Android, and iOS SDKs for authenticating users with Ace ID through OpenID Connect (OIDC) Authorization Code + PKCE.

**Documentation:** [docs.ace-base.cc/projects/ace-id-sdk](https://docs.ace-base.cc/projects/ace-id-sdk)  
**Source:** [tab-gl/aid-sdk](https://github.com/tab-gl/aid-sdk)

## Release status

| Platform | Version | Status |
| --- | --- | --- |
| JavaScript / TypeScript | `0.2.4` | Published on [npm](https://www.npmjs.com/package/ace-id-sdk) |
| Android | `0.2.4` | Published on [Maven Central](https://central.sonatype.com/artifact/cc.ace-base/ace-id-android) |
| iOS (Swift Package) | `0.2.4` | Source only; no tagged release yet |

## JavaScript / TypeScript

```bash
npm install ace-id-sdk
```

Basic browser setup:

```ts
import { AID } from "ace-id-sdk";

const aid = new AID({
  issuer: "https://identity.ace-base.cc",
  clientId: "your-public-client-id",
  redirectUri: "https://app.example.com/callback",
});

await aid.signIn();

// Call on the registered callback route.
const session = await aid.handleCallback();
console.log(session.user);
```

### Popup sign-in

`signInWithPopup()` uses the same Authorization Code + PKCE flow while leaving the current page open. It opens a blank popup synchronously (call it directly from a user click), then navigates it to the issuer. Keep popup relay and top-level redirect exchange on separate callback routes. Because each `AID` client has one `redirectUri`, configure one client per route:

```ts
const common = { issuer: "https://identity.example.com", clientId: "your-public-client-id" };
const popupClient = new AID({
  ...common,
  redirectUri: "https://app.example.com/auth/popup-callback",
});
const redirectClient = new AID({
  ...common,
  redirectUri: "https://app.example.com/auth/redirect-callback",
});

// In the app's sign-in button:
const session = await popupClient.signInWithPopup({ prompt: "select_account" });
console.log(session.user);

// On the popup-only callback route:
await popupClient.handlePopupCallback();

// If popups are blocked, offer this explicit redirect fallback instead:
await redirectClient.signIn({ returnTo: "/dashboard" });

// On the redirect-only callback route:
const redirectedSession = await redirectClient.handleCallback();
```

Use the same storage configuration for both clients so the app reads the session produced by either flow. The opener validates the callback origin/path, state and optional OIDC `iss` response parameter, exchanges the code once, verifies the ID token, and stores the session. The popup relays only the callback URL through a source- and origin-checked `postMessage` handshake; tokens are never sent between windows. `handlePopupCallback()` closes the popup after the opener reports completion. Keep each callback page on its registered origin/path and avoid stripping its query before the SDK handles it. Refreshing or navigating the opener while a popup is pending cancels the attempt and closes the popup. Popups are not a good mobile default, and browser `Cross-Origin-Opener-Policy` settings can sever the opener connection. A runnable static [popup demo, setup guide and browser test record](examples/popup/README.md) are included.

Ace ID provides the authentication flow, not provider-specific UI: the issuer controls account selection, consent and social-provider buttons. Pass supported OIDC hints such as `prompt` or `loginHint` through the shared authorization options; if your issuer documents a provider-selection parameter, pass it with `additionalParameters` (there is no universal OIDC `provider` parameter). The React adapter exposes `signInWithPopup()` and `handlePopupCallback()` through `useAceIDActions()` as well.

Session state, refresh and profile:

```ts
const stop = aid.onAuthStateChange((state) => {
  switch (state.status) {
    case "authenticated": return renderDashboard(state.session.user);
    case "expired": return refreshOrPrompt();
    case "refresh-failed": return showRetry(state.error);
    case "unauthenticated": return renderSignIn();
  }
});

const token = await aid.getValidAccessToken();  // refreshes when needed
const user = await aid.fetchUserProfile();      // UserInfo, subject-checked
```

Entry points: `ace-id-sdk` (browser/Node), `ace-id-sdk/react`,
`ace-id-sdk/server`, `ace-id-sdk/diagnostics`, `ace-id-sdk/testing`. Each is
independently tree-shakeable with a size budget enforced in CI. Use
`ace-id-sdk/server` only in trusted server runtimes. Never expose a client secret
in browser or mobile code.

More: [API reference](https://docs.ace-base.cc/projects/ace-id-sdk-api) · [React](https://docs.ace-base.cc/projects/ace-id-sdk-react) ·
[Server and SSR](https://docs.ace-base.cc/projects/ace-id-sdk-server) · [Errors](https://docs.ace-base.cc/projects/ace-id-sdk-errors) ·
[Examples](https://docs.ace-base.cc/projects/ace-id-sdk-examples) · [Changelog](https://docs.ace-base.cc/projects/ace-id-sdk-changelog) ·
[Migrating to 0.2.4](https://docs.ace-base.cc/projects/ace-id-sdk-migration)

## Post-login redirects

`signIn({ returnTo })` accepts a path (`/dashboard`) or an absolute URL on the registered redirect URI origin. The SDK validates the value before redirecting to the provider, keeps it in the authorization transaction, and returns it from `handleCallback()` — also exposed as `useAuth().returnTo` by the React adapter. The SDK never navigates after the callback: routing stays with the host application. Off-origin, protocol-relative, credentialed or non-HTTP values are rejected with a `CONFIGURATION_ERROR`.

## Token and session behaviour

`expires_in` is only RECOMMENDED by RFC 6749 §5.1, so the SDK never invents a lifetime. A token response without `expires_in` keeps `expiresAt` undefined and records `obtainedAt` instead. `getValidAccessToken()` then reuses that token for `unknownExpiryRefreshIntervalMs` (default 60 seconds) before requesting a new one, which bounds refreshes to one per interval instead of one per call and keeps refresh-token rotation intact. `isAuthenticated()` stays conservative and reports `false` when the expiry is unknown.

ID token verification keeps one remote JWK set per `jwks_uri` for the life of the process, so repeated verifications no longer re-fetch the issuer's keys. Rotated signing keys are picked up after a 5-second refetch cooldown; call `clearJwksCache()` to drop the cache explicitly.

Discovery documents (512 KiB) and token responses (1 MiB) are read with a size limit and rejected when exceeded. A refresh or callback that completes after `signOut()` does not recreate the session.

Discovery documents are cached per client for five minutes with issuer isolation and single-flight misses. Retries with exponential backoff apply to idempotent requests only — never to an authorization-code exchange or a refresh, where a retry can burn a single-use code or invalidate a rotating token. Callback URLs must match the registered origin **and** path, and duplicated authorization parameters are refused.

## Diagnostics and logging

```ts
const report = await aid.validateConfiguration();
if (!report.ok) console.table(report.checks.filter((c) => c.status !== "pass"));

const aid = new AID({ ...config, logger: (entry) => telemetry(entry.event, entry.context) });
```

`validateConfiguration()` checks the issuer, redirect URI, PKCE, JWKS, signing
algorithms, refresh grant, UserInfo and logout, without throwing. Log entries are
redacted: tokens, codes, secrets, nonces and JWT-shaped strings never reach a
sink. Without a `logger` or `debug: true`, the SDK logs nothing.

## Android (Maven Central)

Available once the Maven Central publication is released:

```kotlin
dependencies {
    implementation("cc.ace-base:ace-id-android:0.2.4")
}
```

## Android quick start

```kotlin
val aceID = AceID(
    issuer = "https://identity.ace-base.cc",
    clientId = "your-public-client-id",
    redirectUri = "com.example.app:/oauth/callback",
)

aceID.authState.collect { state ->
    when (state) {
        is AidSessionState.Authenticated -> showDashboard(state.account)
        AidSessionState.Unauthenticated -> showSignIn()
        AidSessionState.Expired -> refreshOrPrompt()
        is AidSessionState.RefreshFailed -> showRetry(state.error)
    }
}
```

`login()` suspends until the callback returns, the transaction survives process
death (`hasPendingAuthorization()`), refreshes are single-flight, and
`AidNetworkPolicy` bounds timeouts and retries. Optional biometric session unlock
is available through `androidx.biometric`. Full guide:
[Android guide](https://docs.ace-base.cc/projects/ace-id-sdk-android).

## Native SDKs

- [Android SDK guide](https://docs.ace-base.cc/projects/ace-id-sdk-android)
- [iOS Swift Package](https://docs.ace-base.cc/projects/ace-id-sdk#install)
- [React guide](https://docs.ace-base.cc/projects/ace-id-sdk-react)
- [Server, Next.js, and SSR guide](https://docs.ace-base.cc/projects/ace-id-sdk-server)

## Security

The SDK uses Authorization Code with PKCE S256 and validates the authorization transaction. Step-up parameters are requests to the identity provider, not proof of MFA or a risk decision. Enforce permissions and sensitive actions on the server.

### Step-up authentication

Request stronger or fresher authentication by passing OIDC parameters to `signIn()`:

```ts
await aid.signIn({ maxAge: 0, returnTo: "/settings/security" }); // force re-authentication
// On the callback route:
const { returnTo } = await aid.handleCallback();
```

What the SDK does and does not do:

- `maxAge` and `acrValues` are sent to the identity provider as `max_age` and `acr_values`. The provider performs the authentication.
- When `maxAge` is set, `handleCallback()` additionally rejects an ID token whose `auth_time` is missing or older than `maxAge` (plus clock skew) with an `AIDTokenError`. This is the only step-up check the SDK enforces locally.
- `acr_values` is a request. The SDK does not verify an `acr` or `amr` claim, and whether a given Ace ID deployment honors `acr_values` is not verified by this SDK.
- Android accepts `maxAgeSeconds` and `acrValues` on its authorization request. Swift accepts `max_age` through `additionalParameters` and enforces `auth_time` the same way.
- A successful step-up is not authorization. Your backend must authorize every sensitive operation (security settings, payments, privileged actions) itself; never rely on client state.

For installation, API details, AIDC configuration, token refresh, logout, troubleshooting, and release status, use the [full SDK documentation](https://docs.ace-base.cc/projects/ace-id-sdk).

## License

MIT
