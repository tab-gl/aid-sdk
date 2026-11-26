import { normalizeTokens, userFromClaims } from '../core/claims.js';
import {
  summarizeAIDChecks,
  validateAIDConfig,
  type AIDConfigCheck,
  type AIDConfigReport,
} from '../core/config.js';
import {
  DEFAULT_DISCOVERY_CACHE_TTL_MS,
  DiscoveryCache,
  normalizeIssuer,
  type OIDCDiscoveryDocument,
} from '../core/discovery.js';
import {
  AIDAuthenticationError,
  AIDCallbackError,
  AIDDiscoveryError,
  AIDError,
  AIDProfileError,
  AIDTokenError,
} from '../core/errors.js';
import {
  withRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ResponseSizeError,
  readBoundedText,
} from '../core/http.js';
import {
  DEFAULT_ALLOWED_SIGNING_ALGORITHMS,
  resolveSigningAlgorithms,
  verifyIdToken,
} from '../core/jwt.js';
import { createLogger, type AIDLogger } from '../core/logging.js';
import { fetchUserProfile as requestUserProfile } from '../core/profile.js';
import {
  assertCallbackUrl,
  isSecureUrl,
  normalizeReturnTo,
  validatePostLogoutRedirect,
} from '../core/redirect.js';
import { SessionStateEmitter, type AIDSessionListener, type AIDSessionState } from '../core/session-state.js';
import {
  DEFAULT_UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS,
  normalizeTokenResponse,
  shouldRefreshToken,
  type TokenResponse,
} from '../core/tokens.js';
import type {
  AIDConfig,
  AIDCallbackResult,
  AIDSession,
  AIDStorage,
  AIDTokens,
  AIDUser,
  AuthTransaction,
  AIDAuthorizationOptions,
} from '../core/types.js';
import { parseCallback } from './callback.js';
import { createCodeChallenge, createCodeVerifier, randomString } from './pkce.js';
import { SessionStorage } from './storage.js';

const DEFAULT_SCOPE = 'openid profile email';
const DEFAULT_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_LEEWAY_SECONDS = 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_STORAGE_PREFIX = 'aid';
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;
/**
 * Smallest delay an automatic refresh may use. Zero-delay timers would spin the
 * event loop when a provider reports an already-expired token.
 */
const MIN_AUTO_REFRESH_DELAY_MS = 1_000;
const MAX_POPUP_CALLBACK_URL_LENGTH = 8 * 1024;
const POPUP_CLOSE_POLL_MS = 200;
const POPUP_MESSAGE_PROTOCOL = 'ace-id-popup-v1';
const POPUP_MESSAGE_TYPES = new Set(['hello', 'challenge', 'callback', 'complete']);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface PopupWaitHandle {
  promise: Promise<AIDCallbackResult>;
  cancel(error: unknown): void;
}

interface PopupWireMessage {
  protocol: string;
  type: string;
  state: string;
  url?: unknown;
  ok?: unknown;
}

interface AuthorizationFlowLock {
  id: string;
  createdAt: number;
}

interface ResolvedAIDConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  storage: AIDStorage;
  transactionTtlMs: number;
  requestTimeoutMs: number;
  unknownExpiryRefreshIntervalMs: number;
  discoveryCacheTtlMs: number;
  autoRefresh: boolean;
  leewaySeconds: number;
  clockSkewSeconds: number;
  maxRetries: number;
  additionalRedirectOrigins: string[];
  allowedSigningAlgorithms: readonly string[];
  storageKeyPrefix: string;
}

export interface AIDProfileOptions {
  /** Reuse the claims already in the session instead of calling UserInfo. */
  useCachedSession?: boolean;
}

export interface AIDRefreshOptions {
  /** Seconds before expiry at which a token counts as expiring. */
  leewaySeconds?: number;
}

/**
 * Browser and Node entry point for the Ace ID SDK.
 *
 * Session handling is deliberately explicit: {@link AID#getAuthState} reports one
 * of four states, {@link AID#onAuthStateChange} streams changes, and
 * {@link AID#getValidAccessToken} refreshes on demand. Concurrent refreshes are
 * collapsed into one request, because a rotating refresh token can only be
 * redeemed once.
 */
export class AID {
  private readonly config: ResolvedAIDConfig;
  private readonly rawConfig: AIDConfig;
  private readonly discoveryCache: DiscoveryCache;
  private readonly logger: AIDLogger;
  private readonly state = new SessionStateEmitter();
  private readonly transactionKey: string;
  private readonly authorizationFlowLockKey: string;
  private readonly sessionKey: string;
  private refreshPromise?: Promise<AIDSession>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private autoRefreshActive: boolean;
  private readonly processingCallbackStates = new Set<string>();
  private popupSignInActive = false;
  private cancelPopupSignIn?: (error: unknown) => void;
  /**
   * Bumped whenever the session is cleared. An in-flight refresh compares it
   * after its network round trip so a logout cannot be undone by a late write.
   */
  private sessionEpoch = 0;

  constructor(config: AIDConfig) {
    if (!config || typeof config !== 'object') {
      throw new AIDError('CONFIGURATION_ERROR', 'AID constructor requires a configuration object');
    }
    // Issuer validity is reported as a discovery error so the failure names the
    // actual problem instead of a generic configuration complaint.
    const issuer = normalizeIssuer(config.issuer);
    // Everything else is checked in one pass so a developer fixes all problems
    // at once rather than one per restart.
    const report = validateAIDConfig(config);
    if (!report.ok) {
      const failures = report.checks.filter((item) => item.status === 'fail');
      throw new AIDError(
        'CONFIGURATION_ERROR',
        `Invalid Ace ID configuration — ${failures.map((item) => `${item.name}: ${item.message}`).join(' ')}`,
      );
    }

    const redirectUri = new URL(config.redirectUri).toString();
    const transactionTtlMs = config.transactionTtlMs ?? DEFAULT_TRANSACTION_TTL_MS;
    const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const unknownExpiryRefreshIntervalMs =
      config.unknownExpiryRefreshIntervalMs ?? DEFAULT_UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS;
    const discoveryCacheTtlMs = config.discoveryCacheTtlMs ?? DEFAULT_DISCOVERY_CACHE_TTL_MS;
    const leewaySeconds = config.leewaySeconds ?? DEFAULT_TOKEN_LEEWAY_SECONDS;
    const clockSkewSeconds = config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    const maxRetries = config.maxRetries ?? 2;

    this.config = {
      issuer,
      clientId: config.clientId,
      redirectUri,
      scope: config.scope ?? DEFAULT_SCOPE,
      storage: config.storage ?? new SessionStorage(),
      transactionTtlMs,
      requestTimeoutMs,
      unknownExpiryRefreshIntervalMs,
      discoveryCacheTtlMs,
      autoRefresh: config.autoRefresh === true,
      leewaySeconds,
      clockSkewSeconds,
      maxRetries,
      additionalRedirectOrigins: (config.additionalRedirectOrigins ?? []).map(
        (origin) => new URL(origin).origin,
      ),
      allowedSigningAlgorithms: config.allowedSigningAlgorithms ?? DEFAULT_ALLOWED_SIGNING_ALGORITHMS,
      storageKeyPrefix: config.storageKeyPrefix ?? DEFAULT_STORAGE_PREFIX,
    };
    this.rawConfig = config;
    this.logger = createLogger({
      debug: config.debug === true,
      ...(config.logger ? { logger: config.logger } : {}),
    });
    this.discoveryCache = new DiscoveryCache({
      ttlMs: discoveryCacheTtlMs,
      timeoutMs: requestTimeoutMs,
      retry: { maxRetries },
    });
    this.transactionKey = `${this.config.storageKeyPrefix}:transaction`;
    this.authorizationFlowLockKey = `${this.config.storageKeyPrefix}:authorization-flow-lock`;
    this.sessionKey = `${this.config.storageKeyPrefix}:session`;
    this.autoRefreshActive = this.config.autoRefresh;
    // Hydrate the observable state so a listener attached immediately after
    // construction already sees the persisted session.
    this.state.update(this.getSession(), { leewaySeconds: this.config.leewaySeconds });
  }

  private getDiscovery(options: { forceRefresh?: boolean } = {}): Promise<OIDCDiscoveryDocument> {
    return this.discoveryCache.get(this.config.issuer, options);
  }

  /** Drop the cached discovery document, forcing a refetch on the next call. */
  clearDiscoveryCache(): void {
    this.discoveryCache.clear();
  }

  private async createAuthorizationRequest(
    authorizationOptions: Record<string, string>,
    returnTo?: string,
    maxAgeSeconds?: number,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const discovery = await this.getDiscovery();
    const state = randomString(32);
    const nonce = randomString(32);
    const codeVerifier = createCodeVerifier();
    const codeChallenge = await createCodeChallenge(codeVerifier);
    const transaction: AuthTransaction = {
      state,
      nonce,
      codeVerifier,
      redirectUri: this.config.redirectUri,
      createdAt: Date.now(),
      ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}),
      ...(returnTo !== undefined ? { returnTo } : {}),
    };

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    for (const [key, value] of Object.entries(authorizationOptions)) params.set(key, value);
    // Preserve issuer-specific query parameters, but replace collisions with the
    // SDK-owned values and never append parameters after a URL fragment.
    for (const [key, value] of params) authorizationUrl.searchParams.set(key, value);

    try {
      this.config.storage.set(this.transactionKey, JSON.stringify(transaction));
    } catch (err) {
      throw new AIDError('STORAGE_ERROR', 'Failed to persist authorization transaction', err);
    }
    return { authorizationUrl: authorizationUrl.toString(), state };
  }

  async signIn(options: AIDAuthorizationOptions & { returnTo?: string } = {}): Promise<void> {
    if (this.popupSignInActive) {
      throw new AIDAuthenticationError('A popup sign-in is already in progress for this client');
    }
    const flowLockId = randomString(16);
    this.acquireAuthorizationFlowLock(flowLockId);
    try {
      const authorizationOptions = normalizeAuthorizationOptions(options);
      // Validate before navigating: an off-origin or malformed target must fail
      // here rather than be handed to the host app after a successful login.
      const returnTo = normalizeReturnTo(
        options.returnTo,
        this.config.redirectUri,
        this.config.additionalRedirectOrigins,
      );
      const request = await this.createAuthorizationRequest(
        authorizationOptions,
        returnTo,
        options.maxAge,
      );
      this.logger.info('signin.start', 'Starting authorization code flow with PKCE', {
        issuer: this.config.issuer,
        prompt: authorizationOptions.prompt,
        mode: 'redirect',
      });
      redirectTo(request.authorizationUrl);
    } finally {
      this.releaseAuthorizationFlowLock(flowLockId);
    }
  }

  /**
   * Start Authorization Code + PKCE in a separate browser window.
   *
   * The blank popup is opened synchronously, before discovery or Web Crypto work,
   * so browsers can associate it with the user's click. The registered callback
   * page must call {@link AID#handlePopupCallback}; the opener validates and
   * exchanges the callback itself, so tokens never cross the window boundary.
   */
  async signInWithPopup(
    options: AIDAuthorizationOptions & { returnTo?: string } = {},
  ): Promise<AIDCallbackResult> {
    if (this.popupSignInActive) {
      throw new AIDAuthenticationError('A popup sign-in is already in progress for this client');
    }
    const authorizationOptions = normalizeAuthorizationOptions(options);
    const returnTo = normalizeReturnTo(
      options.returnTo,
      this.config.redirectUri,
      this.config.additionalRedirectOrigins,
    );

    // This must happen before the first await or the browser may block the popup.
    const browserWindow = getBrowserWindow();
    const flowLockId = randomString(16);
    this.acquireAuthorizationFlowLock(flowLockId);
    let popup: Window;
    try {
      popup = openAuthenticationPopup(browserWindow);
    } catch (err) {
      this.releaseAuthorizationFlowLock(flowLockId);
      throw err;
    }
    const sessionEpoch = this.sessionEpoch;
    this.popupSignInActive = true;
    let state: string | undefined;
    let waitingForCallback = false;
    let pageHidden = false;
    let completion: PopupWaitHandle | undefined;
    const pageHideError = new AIDAuthenticationError(
      'Page was navigated or refreshed while popup sign-in was pending',
    );
    const onPageHide = (): void => {
      if (pageHidden) return;
      pageHidden = true;
      completion?.cancel(pageHideError);
      if (state) {
        try { this.clearTransactionForState(state); } catch { /* page teardown cleanup is best-effort */ }
      }
      closePopup(popup);
      // Do this synchronously; the old document may not reach its promise finally
      // block before a reload creates the next SDK instance in this tab.
      this.releaseAuthorizationFlowLock(flowLockId);
    };
    try {
      browserWindow.addEventListener('pagehide', onPageHide);
      const request = await this.createAuthorizationRequest(
        authorizationOptions,
        returnTo,
        options.maxAge,
      );
      state = request.state;
      if (pageHidden) throw pageHideError;
      if (this.sessionEpoch !== sessionEpoch) {
        throw new AIDAuthenticationError('Sign-out occurred while popup sign-in was being prepared');
      }
      this.logger.info('signin.start', 'Starting authorization code flow with PKCE', {
        issuer: this.config.issuer,
        prompt: authorizationOptions.prompt,
        mode: 'popup',
      });

      completion = this.waitForPopupCallback(popup, request.state, sessionEpoch);
      this.cancelPopupSignIn = completion.cancel;
      waitingForCallback = true;
      try {
        // Setting the cross-origin Location is allowed by the browser and keeps
        // the initially opened window handle available for the message handshake.
        popup.location.href = request.authorizationUrl;
      } catch (err) {
        completion.cancel(new AIDAuthenticationError(
          'Could not navigate the sign-in popup to the identity provider',
          err,
        ));
      }
      return await completion.promise;
    } catch (err) {
      if (state) {
        try { this.clearTransactionForState(state); } catch { /* preserve the original failure */ }
      }
      if (!waitingForCallback) closePopup(popup);
      throw err;
    } finally {
      try { browserWindow.removeEventListener('pagehide', onPageHide); } catch { /* best-effort listener cleanup */ }
      this.releaseAuthorizationFlowLock(flowLockId);
      this.cancelPopupSignIn = undefined;
      this.popupSignInActive = false;
    }
  }

  /**
   * Relay the current popup callback URL to the window that started
   * {@link AID#signInWithPopup}. Call this on the registered callback route in
   * the popup instead of {@link AID#handleCallback}.
   */
  async handlePopupCallback(url?: string): Promise<void> {
    const current = url ?? getCurrentUrl();
    if (current.length > MAX_POPUP_CALLBACK_URL_LENGTH) {
      throw new AIDCallbackError('Popup callback URL exceeds the accepted size limit');
    }
    const validated = assertCallbackUrl(current, this.config.redirectUri, {
      additionalOrigins: this.config.additionalRedirectOrigins,
    });
    const params = parseCallback(validated.toString());
    if (!params.state || (!params.code && !params.error)) {
      throw new AIDCallbackError('Popup callback is missing "state" or an authorization response');
    }

    const browserWindow = getBrowserWindow();
    const opener = browserWindow.opener;
    if (!opener || opener.closed) {
      throw new AIDAuthenticationError(
        'No live opener is available for this popup callback; use handleCallback() for redirect sign-in',
      );
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let challenged = false;
      let openerOrigin: string | undefined;
      const timeout = setTimeout(
        () => finish(new AIDAuthenticationError('Timed out waiting for the sign-in popup to finish')),
        cappedTimerDelay(this.config.transactionTtlMs),
      );

      const cleanup = (): void => {
        clearTimeout(timeout);
        try { browserWindow.removeEventListener('message', onMessage); } catch { /* best-effort listener cleanup */ }
      };
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        closePopup(browserWindow);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onMessage = (event: MessageEvent): void => {
        if (event.source !== opener) return;
        const message = readPopupMessage(event.data);
        if (!message || !params.state || !timingSafeEqual(message.state, params.state)) return;

        if (message.type === 'challenge') {
          if (challenged || !this.isAllowedPopupCallbackOrigin(event.origin)) return;
          challenged = true;
          openerOrigin = event.origin;
          try {
            opener.postMessage({
              protocol: POPUP_MESSAGE_PROTOCOL,
              type: 'callback',
              state: params.state,
              url: validated.toString(),
            }, openerOrigin);
          } catch (err) {
            finish(new AIDAuthenticationError('Could not send the popup callback to its opener', err));
          }
          return;
        }

        if (message.type === 'complete') {
          if (!this.isAllowedPopupCallbackOrigin(event.origin)) return;
          if (!challenged) {
            // A validated opener may reject an early state mismatch before it
            // sends the challenge; only a negative result is trusted pre-challenge.
            if (message.ok === false) {
              finish(new AIDCallbackError('Popup authentication failed in the opener'));
            }
            return;
          }
          if (event.origin !== openerOrigin) return;
          finish(message.ok === true
            ? undefined
            : new AIDCallbackError('Popup authentication failed in the opener'));
        }
      };

      try {
        browserWindow.addEventListener('message', onMessage);
      } catch (err) {
        finish(new AIDAuthenticationError('Could not listen for a response from the popup opener', err));
        return;
      }
      try {
        // The first message contains only state. The callback URL (and its
        // single-use code) is sent only after the opener answers this challenge
        // using an exact target origin.
        opener.postMessage({
          protocol: POPUP_MESSAGE_PROTOCOL,
          type: 'hello',
          state: params.state,
        }, '*');
      } catch (err) {
        finish(new AIDAuthenticationError('Could not contact the popup opener', err));
      }
    });
  }

  async handleCallback(url?: string): Promise<AIDCallbackResult> {
    return this.processCallback(url ?? getCurrentUrl());
  }

  private async processCallback(
    current: string,
    isCancelled?: () => boolean,
  ): Promise<AIDCallbackResult> {
    // Reject a code that arrived on the wrong origin or path before anything
    // else happens: exchanging it would send a foreign code to our token endpoint.
    const validated = assertCallbackUrl(current, this.config.redirectUri, {
      additionalOrigins: this.config.additionalRedirectOrigins,
    });
    const callbackIssuer = validated.searchParams.get('iss');
    if (callbackIssuer !== null) {
      let normalizedCallbackIssuer: string;
      try { normalizedCallbackIssuer = normalizeIssuer(callbackIssuer); }
      catch { throw new AIDCallbackError('Callback issuer does not match the configured issuer'); }
      if (normalizedCallbackIssuer !== this.config.issuer) {
        throw new AIDCallbackError('Callback issuer does not match the configured issuer');
      }
    }
    const params = parseCallback(validated.toString());
    if (params.error && params.code) {
      throw new AIDCallbackError('Callback contains both an "error" and a "code" parameter');
    }
    if (params.error) {
      const transaction = this.loadTransaction();
      if (!transaction) {
        throw new AIDCallbackError('No authorization transaction found for the provider error response');
      }
      if (!params.state || !timingSafeEqual(transaction.state, params.state)) {
        throw new AIDCallbackError('OAuth state mismatch in the provider error response');
      }
      this.clearTransactionForState(transaction.state);
      this.logger.warn('callback.provider_error', 'Authorization server returned an error', {
        error: params.error,
      });
      throw new AIDCallbackError(
        `Authorization error: ${params.error}` +
          (params.errorDescription ? ` — ${params.errorDescription}` : ''),
      );
    }
    if (!params.code || !params.state) {
      throw new AIDCallbackError('Callback is missing "code" or "state" parameter');
    }

    const transaction = this.loadTransaction();
    if (!transaction) {
      throw new AIDCallbackError(
        'No authorization transaction found — the flow may have expired or been tampered with',
      );
    }
    if (!Number.isFinite(transaction.createdAt) || transaction.createdAt > Date.now() ||
        Date.now() - transaction.createdAt > this.config.transactionTtlMs) {
      this.clearTransactionForState(transaction.state);
      throw new AIDCallbackError('Authorization transaction has expired or is invalid');
    }
    if (!transaction.state || !transaction.nonce || !transaction.codeVerifier || !transaction.redirectUri) {
      this.clearTransactionForState(transaction.state);
      throw new AIDCallbackError('OAuth state mismatch or invalid authorization transaction');
    }
    // A stale callback must never erase a different, newer transaction from
    // storage. Leave a state mismatch untouched so its active flow can finish.
    if (!timingSafeEqual(transaction.state, params.state)) {
      throw new AIDCallbackError('OAuth state mismatch or invalid authorization transaction');
    }
    // The transaction lives in application storage, which the SDK cannot sign.
    // Re-check that it still names this client's redirect URI before the code is
    // sent anywhere: a rewritten transaction must not redirect the exchange.
    if (transaction.redirectUri !== this.config.redirectUri) {
      this.clearTransactionForState(transaction.state);
      throw new AIDCallbackError('Authorization transaction redirect URI does not match this client');
    }
    if (this.processingCallbackStates.has(params.state)) {
      throw new AIDCallbackError('Authorization callback is already being processed');
    }
    this.processingCallbackStates.add(params.state);

    // The transaction is cleared below, so read the return target before the exchange.
    const returnTo = transaction.returnTo;
    const epoch = this.sessionEpoch;

    try {
      const discovery = await this.getDiscovery();
      const tokens = await exchangeCodeForTokens({
        tokenEndpoint: discovery.token_endpoint, clientId: this.config.clientId,
        code: params.code, redirectUri: transaction.redirectUri,
        codeVerifier: transaction.codeVerifier, timeoutMs: this.config.requestTimeoutMs,
      });
      if (!tokens.idToken) throw new AIDTokenError('Token response is missing "id_token"');
      if (!discovery.jwks_uri) {
        throw new AIDDiscoveryError('Discovery document is missing "jwks_uri" (required to verify the ID token)');
      }

      const claims = await verifyIdToken({
        idToken: tokens.idToken, jwksUri: discovery.jwks_uri,
        issuer: discovery.issuer, audience: this.config.clientId, nonce: transaction.nonce,
        clockToleranceSeconds: this.config.clockSkewSeconds,
        algorithms: resolveSigningAlgorithms(
          discovery.id_token_signing_alg_values_supported,
          this.config.allowedSigningAlgorithms,
        ),
        ...(transaction.maxAgeSeconds !== undefined ? { maxAgeSeconds: transaction.maxAgeSeconds } : {}),
      });
      // A timeout/cancel can settle the popup while its network exchange is
      // still pending. Never let that late callback create a session afterward.
      if (isCancelled?.() === true) {
        throw new AIDCallbackError('Popup sign-in was cancelled before the session could be saved');
      }
      // A sign-out that happened while the code exchange was in flight wins:
      // completing the callback must not create a session the user just ended.
      if (this.sessionEpoch !== epoch) {
        throw new AIDCallbackError('Sign-out occurred while the callback was being processed');
      }
      const session: AIDSession = {
        user: userFromClaims(claims as Record<string, unknown>),
        tokens, nonce: transaction.nonce,
      };
      // Persist the session without the navigation hint: returnTo belongs to
      // this one callback, not to the stored session lifetime.
      this.saveSession(session);
      this.logger.info('callback.completed', 'Authorization code exchanged and ID token verified', {
        subject: session.user.sub,
      });
      return returnTo === undefined ? session : { ...session, returnTo };
    } catch (err) {
      this.logger.warn('callback.failed', 'Authorization callback failed', { error: err });
      throw err;
    } finally {
      this.processingCallbackStates.delete(params.state);
      this.clearTransactionForState(params.state);
    }
  }

  getSession(): AIDSession | null {
    const raw = this.config.storage.get(this.sessionKey);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidSession(parsed)) {
        this.config.storage.remove(this.sessionKey);
        this.logger.warn('session.corrupt', 'Stored session failed validation and was discarded');
        return null;
      }
      return parsed;
    } catch {
      this.config.storage.remove(this.sessionKey);
      this.logger.warn('session.corrupt', 'Stored session was not valid JSON and was discarded');
      return null;
    }
  }

  /** Alias of {@link AID#getSession} matching the cross-platform API name. */
  currentSession(): AIDSession | null {
    return this.getSession();
  }

  /** Current session state, re-derived from storage before it is returned. */
  getAuthState(): AIDSessionState {
    return this.state.update(this.getSession(), { leewaySeconds: this.config.leewaySeconds });
  }

  /**
   * Subscribe to session-state changes.
   *
   * The listener is invoked once immediately with the current state, then on
   * every real change (sign-in, refresh, expiry, sign-out, failed refresh).
   * Returns an unsubscribe function.
   */
  onAuthStateChange(listener: AIDSessionListener): () => void {
    const unsubscribe = this.state.subscribe(listener);
    try {
      listener(this.getAuthState());
    } catch {
      // The initial synchronous call is best-effort, like later notifications.
    }
    return unsubscribe;
  }

  isAuthenticated(): boolean {
    const session = this.getSession();
    if (!session) return false;
    const expiresAt = session.tokens.expiresAt;
    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) &&
      expiresAt > 0 && Date.now() < expiresAt;
  }

  getUser(): AIDUser | null { return this.getSession()?.user ?? null; }

  /** Synchronous getter; does not perform a network request. */
  getAccessToken(): string | null { return this.getSession()?.tokens.accessToken ?? null; }

  /** Concurrent calls share the same refresh operation. */
  async refresh(): Promise<AIDSession> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh();
    try { return await this.refreshPromise; }
    finally { this.refreshPromise = undefined; }
  }

  /** Alias of {@link AID#refresh} matching the cross-platform API name. */
  async refreshSession(): Promise<AIDSession> {
    return this.refresh();
  }

  /**
   * Return a usable access token and refresh it when expired or near expiry.
   *
   * When the provider never reported `expires_in`, the token is not assumed to
   * be valid, but a token obtained within `unknownExpiryRefreshIntervalMs` is
   * reused instead of re-requested, so an unreported lifetime cannot trigger a
   * refresh on every call (which also breaks refresh-token rotation).
   */
  async getValidAccessToken(leewaySeconds = this.config.leewaySeconds): Promise<string | null> {
    if (!Number.isFinite(leewaySeconds) || leewaySeconds < 0) {
      throw new AIDError('CONFIGURATION_ERROR', 'leewaySeconds must be a non-negative finite number');
    }
    const session = this.getSession();
    if (!session) return null;
    const needsRefresh = shouldRefreshToken(session.tokens, {
      leewaySeconds,
      unknownExpiryRefreshIntervalMs: this.config.unknownExpiryRefreshIntervalMs,
    });
    if (!needsRefresh) return session.tokens.accessToken;
    if (!session.tokens.refreshToken) { this.clearSession(); return null; }
    try {
      return (await this.refresh()).tokens.accessToken;
    } catch (err) {
      this.reportRefreshFailure(err);
      throw err;
    }
  }

  /**
   * Fetch the account profile from the UserInfo endpoint.
   *
   * Pass `useCachedSession: true` to skip the network call and return the claims
   * already held in the session. The returned user is persisted in the session so
   * `getUser()` reflects it.
   */
  async fetchUserProfile(options: AIDProfileOptions = {}): Promise<AIDUser> {
    const session = this.getSession();
    if (!session) throw new AIDAuthenticationError('No authenticated session exists');
    if (options.useCachedSession === true) return session.user;

    const discovery = await this.getDiscovery();
    if (!discovery.userinfo_endpoint) {
      throw new AIDProfileError('The identity provider does not advertise a userinfo_endpoint');
    }
    const accessToken = await this.getValidAccessToken();
    if (!accessToken) throw new AIDAuthenticationError('No usable access token for the profile request');

    const profile = await requestUserProfile({
      userinfoEndpoint: discovery.userinfo_endpoint,
      accessToken,
      expectedSubject: session.user.sub,
      timeoutMs: this.config.requestTimeoutMs,
      retry: { maxRetries: this.config.maxRetries },
    });

    // Re-read the session: a concurrent refresh may have replaced it while the
    // profile request was in flight, and that newer session must win.
    const latest = this.getSession() ?? session;
    if (latest.user.sub !== profile.user.sub) {
      throw new AIDProfileError('Profile subject changed while the request was in flight');
    }
    this.saveSession({ ...latest, user: profile.user });
    this.logger.debug('profile.updated', 'Session user refreshed from UserInfo', {
      subject: profile.user.sub,
    });
    return profile.user;
  }

  async signOut(options: { redirectTo?: string } = {}): Promise<void> {
    const session = this.getSession();
    // clearSession() also advances the epoch, so a refresh already in flight
    // cannot re-persist the session after logout.
    this.clearSession();
    this.cancelPopupSignIn?.(new AIDAuthenticationError('Popup sign-in was cancelled by sign-out'));
    this.config.storage.remove(this.transactionKey);
    const safeRedirect = options.redirectTo
      ? validatePostLogoutRedirect(
        options.redirectTo,
        this.config.redirectUri,
        this.config.additionalRedirectOrigins,
      )
      : undefined;
    let endSession: string | undefined;

    try {
      const discovery = await this.getDiscovery();
      if (discovery.revocation_endpoint && session?.tokens.refreshToken) {
        try {
          await revokeToken({
            revocationEndpoint: discovery.revocation_endpoint,
            clientId: this.config.clientId, token: session.tokens.refreshToken,
            tokenTypeHint: 'refresh_token', timeoutMs: this.config.requestTimeoutMs,
          });
        } catch {
          // Local logout must not depend on remote revocation.
          this.logger.warn('logout.revoke_failed', 'Token revocation failed; local session already cleared');
        }
      }
      endSession = discovery.end_session_endpoint;
    } catch { endSession = undefined; }

    this.logger.info('logout.completed', 'Local session cleared', {
      providerLogout: Boolean(endSession),
    });

    if (endSession) {
      // Use URL API so an end_session_endpoint that already has a query string
      // keeps its parameters instead of getting a second '?' that swallows them.
      const url = new URL(endSession);
      if (session?.tokens.idToken) url.searchParams.set('id_token_hint', session.tokens.idToken);
      if (safeRedirect) url.searchParams.set('post_logout_redirect_uri', safeRedirect);
      redirectTo(url.toString());
      return;
    }
    if (safeRedirect) redirectTo(safeRedirect);
  }

  /** Alias of {@link AID#signOut} matching the cross-platform API name. */
  async logout(options: { redirectTo?: string } = {}): Promise<void> {
    return this.signOut(options);
  }

  /**
   * Start refreshing the access token shortly before it expires.
   *
   * Automatic refresh is opt-in (`autoRefresh: true` or this method) because a
   * timer in a server or test process is a side effect the host did not ask for.
   */
  startAutoRefresh(): void {
    this.autoRefreshActive = true;
    this.scheduleAutoRefresh();
  }

  /** Stop the automatic refresh timer. The session itself is untouched. */
  stopAutoRefresh(): void {
    this.autoRefreshActive = false;
    this.cancelAutoRefresh();
  }

  /**
   * Check configuration offline, then against the live issuer.
   *
   * Never throws: every problem is reported as a named check so the caller can
   * render it or log it.
   */
  async validateConfiguration(): Promise<AIDConfigReport> {
    const base = validateAIDConfig(this.rawConfig);
    const checks: AIDConfigCheck[] = [...base.checks];
    try {
      const discovery = await this.discoveryCache.get(this.config.issuer, { forceRefresh: true });
      checks.push({ name: 'discovery', status: 'pass', message: `Discovery succeeded for ${discovery.issuer}.` });
      const methods = Array.isArray(discovery.code_challenge_methods_supported)
        ? discovery.code_challenge_methods_supported
        : undefined;
      const pkceOk = methods === undefined || methods.includes('S256');
      checks.push({
        name: 'pkce-s256',
        status: pkceOk ? 'pass' : 'fail',
        message: pkceOk
          ? 'The provider supports the required S256 PKCE method (or does not restrict it).'
          : 'The provider does not advertise S256 PKCE, which this SDK requires.',
      });
      checks.push({
        name: 'jwks',
        status: discovery.jwks_uri ? 'pass' : 'fail',
        message: discovery.jwks_uri
          ? 'A JWKS endpoint is advertised, so ID tokens can be verified.'
          : 'No jwks_uri is advertised; ID tokens cannot be verified.',
      });
      try {
        resolveSigningAlgorithms(discovery.id_token_signing_alg_values_supported, this.config.allowedSigningAlgorithms);
        checks.push({ name: 'signing-algorithm', status: 'pass', message: 'The provider advertises an accepted asymmetric signing algorithm.' });
      } catch (err) {
        checks.push({ name: 'signing-algorithm', status: 'fail', message: (err as Error).message });
      }
      const grants = Array.isArray(discovery.grant_types_supported) ? discovery.grant_types_supported : undefined;
      const refreshOk = grants === undefined || grants.includes('refresh_token');
      checks.push({
        name: 'refresh-grant',
        status: refreshOk ? 'pass' : 'warn',
        message: refreshOk
          ? 'The provider advertises the refresh_token grant.'
          : 'The provider does not advertise the refresh_token grant; sessions will end at access-token expiry.',
      });
      checks.push({
        name: 'userinfo',
        status: discovery.userinfo_endpoint ? 'pass' : 'warn',
        message: discovery.userinfo_endpoint
          ? 'A UserInfo endpoint is advertised for profile retrieval.'
          : 'No UserInfo endpoint is advertised; fetchUserProfile() will fail.',
      });
      checks.push({
        name: 'provider-logout',
        status: discovery.end_session_endpoint ? 'pass' : 'warn',
        message: discovery.end_session_endpoint
          ? 'Provider logout is advertised; signOut() will also end the provider session.'
          : 'No end_session_endpoint is advertised; signOut() clears local state only.',
      });
    } catch (err) {
      checks.push({
        name: 'discovery',
        status: 'fail',
        message: `Discovery failed: ${(err as Error).message}`,
      });
    }
    return summarizeAIDChecks(checks);
  }

  private async performRefresh(): Promise<AIDSession> {
    const session = this.getSession();
    if (!session) throw new AIDAuthenticationError('No authenticated session exists');
    const epoch = this.sessionEpoch;
    if (!session.tokens.refreshToken) {
      this.clearSession();
      throw new AIDAuthenticationError('The current session does not contain a refresh token');
    }
    const discovery = await this.getDiscovery();
    // grant_types_supported is optional in OIDC Discovery / RFC 8414. Only reject
    // when the provider advertises the field and omits refresh_token.
    if (discovery.grant_types_supported && !discovery.grant_types_supported.includes('refresh_token')) {
      throw new AIDAuthenticationError('The identity provider does not advertise refresh_token support');
    }

    let tokens: AIDTokens;
    try {
      tokens = await refreshTokens({
        tokenEndpoint: discovery.token_endpoint, clientId: this.config.clientId,
        refreshToken: session.tokens.refreshToken, scope: session.tokens.scope,
        timeoutMs: this.config.requestTimeoutMs,
      });
    } catch (err) {
      if (isInvalidRefreshTokenError(err)) this.clearSession();
      throw err;
    }

    let user = session.user;
    if (tokens.idToken) {
      if (!discovery.jwks_uri) {
        throw new AIDDiscoveryError('Discovery document is missing "jwks_uri" required to verify the refreshed ID token');
      }
      const claims = await verifyIdToken({
        idToken: tokens.idToken, jwksUri: discovery.jwks_uri,
        issuer: discovery.issuer, audience: this.config.clientId,
        nonce: session.nonce, nonceRequired: false,
        clockToleranceSeconds: this.config.clockSkewSeconds,
        algorithms: resolveSigningAlgorithms(
          discovery.id_token_signing_alg_values_supported,
          this.config.allowedSigningAlgorithms,
        ),
      });
      if (typeof claims.sub !== 'string' || claims.sub !== session.user.sub) {
        throw new AIDTokenError('Refreshed ID token subject does not match the current session');
      }
      user = userFromClaims(claims as Record<string, unknown>);
    } else if (session.tokens.idToken) {
      tokens.idToken = session.tokens.idToken;
    }
    // Logout (or a callback that replaced the session) wins over this refresh:
    // never resurrect a session that was ended while the request was in flight.
    if (this.sessionEpoch !== epoch) {
      throw new AIDAuthenticationError('Session ended while the token refresh was in progress');
    }
    const refreshedSession: AIDSession = { user, tokens, nonce: session.nonce };
    this.saveSession(refreshedSession);
    this.logger.debug('token.refreshed', 'Access token refreshed', {
      expiresAt: tokens.expiresAt,
      rotated: Boolean(tokens.refreshToken),
    });
    return refreshedSession;
  }

  /** Emit a refresh failure without changing what is stored. */
  private reportRefreshFailure(err: unknown): void {
    const session = this.getSession();
    this.state.set({
      status: 'refresh-failed',
      error: err instanceof Error ? err : new Error('Token refresh failed'),
      ...(session ? { session } : {}),
    });
    // A failed automatic refresh stops the timer rather than retrying in a loop
    // against a provider that is rejecting us. The next explicit call restarts it.
    this.cancelAutoRefresh();
  }

  private saveSession(session: AIDSession): void {
    try { this.config.storage.set(this.sessionKey, JSON.stringify(session)); }
    catch (err) { throw new AIDError('STORAGE_ERROR', 'Failed to persist session', err); }
    this.state.update(session, { leewaySeconds: this.config.leewaySeconds });
    this.scheduleAutoRefresh();
  }

  private clearSession(): void {
    this.sessionEpoch += 1;
    this.config.storage.remove(this.sessionKey);
    this.cancelAutoRefresh();
    this.state.set({ status: 'unauthenticated' });
  }

  private scheduleAutoRefresh(): void {
    if (!this.autoRefreshActive) return;
    this.cancelAutoRefresh();
    const session = this.getSession();
    if (!session || !session.tokens.refreshToken) return;
    const expiresAt = session.tokens.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return;

    const delay = expiresAt - this.config.leewaySeconds * 1000 - Date.now();
    const timer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.runScheduledRefresh();
    }, Math.max(delay, MIN_AUTO_REFRESH_DELAY_MS));
    // A pending refresh must not keep a Node process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.refreshTimer = timer;
  }

  private async runScheduledRefresh(): Promise<void> {
    if (!this.autoRefreshActive) return;
    const session = this.getSession();
    if (!session?.tokens.refreshToken) return;
    try {
      await this.refresh();
    } catch (err) {
      this.reportRefreshFailure(err);
    }
  }

  private cancelAutoRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private acquireAuthorizationFlowLock(id: string): void {
    if (this.readActiveAuthorizationFlowLock()) {
      throw new AIDAuthenticationError('An authorization flow is already active for this storage');
    }
    try {
      this.config.storage.set(this.authorizationFlowLockKey, JSON.stringify({ id, createdAt: Date.now() }));
    } catch (err) {
      throw new AIDError('STORAGE_ERROR', 'Failed to claim the authorization-flow lock', err);
    }
  }

  private readActiveAuthorizationFlowLock(): AuthorizationFlowLock | null {
    let raw: string | null;
    try {
      raw = this.config.storage.get(this.authorizationFlowLockKey);
    } catch (err) {
      throw new AIDError('STORAGE_ERROR', 'Failed to read the authorization-flow lock', err);
    }
    if (!raw) return null;

    let lock: unknown;
    try { lock = JSON.parse(raw) as unknown; } catch { lock = null; }
    if (lock && typeof lock === 'object' && !Array.isArray(lock)) {
      const value = lock as Record<string, unknown>;
      const age = typeof value.createdAt === 'number' ? Date.now() - value.createdAt : Number.NaN;
      if (typeof value.id === 'string' && value.id.length > 0 && Number.isFinite(age) &&
          age >= 0 && age <= this.config.transactionTtlMs) {
        return { id: value.id, createdAt: value.createdAt as number };
      }
    }

    try { this.config.storage.remove(this.authorizationFlowLockKey); }
    catch (err) { throw new AIDError('STORAGE_ERROR', 'Failed to clear a stale authorization-flow lock', err); }
    return null;
  }

  private releaseAuthorizationFlowLock(id: string): void {
    try {
      const raw = this.config.storage.get(this.authorizationFlowLockKey);
      if (!raw) return;
      const lock: unknown = JSON.parse(raw);
      if (lock && typeof lock === 'object' && !Array.isArray(lock) &&
          (lock as Record<string, unknown>).id === id) {
        this.config.storage.remove(this.authorizationFlowLockKey);
      }
    } catch {
      // Lock cleanup is best-effort and must not mask the sign-in outcome.
    }
  }

  private waitForPopupCallback(popup: Window, state: string, sessionEpoch: number): PopupWaitHandle {
    const browserWindow = getBrowserWindow();
    let resolvePromise!: (result: AIDCallbackResult) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<AIDCallbackResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    let callbackOrigin: string | undefined;
    let callbackStarted = false;
    let callbackCancelled = false;
    let callbackProcessingSettled = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closePoll: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (closePoll !== undefined) clearInterval(closePoll);
      try { browserWindow.removeEventListener('message', onMessage); } catch { /* best-effort listener cleanup */ }
    };
    const sendCompletion = (ok: boolean, completionState = state): void => {
      if (!callbackOrigin) return;
      try {
        popup.postMessage({
          protocol: POPUP_MESSAGE_PROTOCOL,
          type: 'complete',
          state: completionState,
          ok,
        }, callbackOrigin);
      } catch {
        // A popup that has navigated or closed cannot receive its completion.
      }
    };
    const finish = (
      error?: unknown,
      result?: AIDCallbackResult,
      completionState = state,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        if (callbackStarted && !callbackProcessingSettled) {
          callbackCancelled = true;
        }
        sendCompletion(false, completionState);
        try { this.clearTransactionForState(state); } catch { /* preserve the original error */ }
        // Close from the opener even if the callback page has navigated away and
        // can no longer receive the completion message.
        closePopup(popup);
        rejectPromise(error);
        return;
      }
      sendCompletion(true);
      resolvePromise(result as AIDCallbackResult);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== popup) return;
      const message = readPopupMessage(event.data);
      if (!message) return;

      if (message.type === 'hello') {
        if (!this.isAllowedPopupCallbackOrigin(event.origin) ||
            (callbackOrigin !== undefined && callbackOrigin !== event.origin)) return;
        callbackOrigin = event.origin;
        if (!timingSafeEqual(message.state, state)) {
          finish(
            new AIDCallbackError('Popup callback state does not match the active transaction'),
            undefined,
            message.state,
          );
          return;
        }
        if (this.sessionEpoch !== sessionEpoch) {
          finish(new AIDAuthenticationError('Sign-out occurred while popup sign-in was in progress'));
          return;
        }
        const transaction = this.loadTransaction();
        if (!transaction || !timingSafeEqual(transaction.state, state)) {
          finish(new AIDCallbackError('No matching popup authorization transaction was found'));
          return;
        }
        try {
          // This challenge is sent only to the callback page's exact origin.
          popup.postMessage({
            protocol: POPUP_MESSAGE_PROTOCOL,
            type: 'challenge',
            state,
          }, callbackOrigin);
        } catch (err) {
          finish(new AIDAuthenticationError('Could not challenge the sign-in popup', err));
        }
        return;
      }

      if (!timingSafeEqual(message.state, state)) return;
      if (this.sessionEpoch !== sessionEpoch) {
        finish(new AIDAuthenticationError('Sign-out occurred while popup sign-in was in progress'));
        return;
      }
      if (message.type !== 'callback' || callbackStarted ||
          !callbackOrigin || event.origin !== callbackOrigin ||
          typeof message.url !== 'string') return;
      if (message.url.length > MAX_POPUP_CALLBACK_URL_LENGTH) {
        finish(new AIDCallbackError('Popup callback URL exceeds the accepted size limit'));
        return;
      }

      let callbackUrl: URL;
      try {
        callbackUrl = assertCallbackUrl(message.url, this.config.redirectUri, {
          additionalOrigins: this.config.additionalRedirectOrigins,
        });
        const params = parseCallback(callbackUrl.toString());
        if (!params.state || !timingSafeEqual(params.state, state)) {
          throw new AIDCallbackError('Popup callback state does not match the active transaction');
        }
        if (callbackUrl.origin !== event.origin) {
          throw new AIDCallbackError('Popup callback origin does not match the sending window');
        }
      } catch (err) {
        finish(err);
        return;
      }

      callbackStarted = true;
      void this.processCallback(callbackUrl.toString(), () => callbackCancelled).then(
        (result) => {
          callbackProcessingSettled = true;
          finish(undefined, result);
        },
        (err: unknown) => {
          callbackProcessingSettled = true;
          finish(err);
        },
      );
    };

    browserWindow.addEventListener('message', onMessage);
    timeout = setTimeout(
      () => finish(new AIDAuthenticationError('Sign-in popup timed out')),
      cappedTimerDelay(this.config.transactionTtlMs),
    );
    closePoll = setInterval(() => {
      try {
        if (popup.closed) {
          finish(new AIDAuthenticationError('Sign-in popup was closed before authentication completed'));
        }
      } catch {
        // Window.closed is cross-origin readable, but a broken proxy should not
        // cause a failed check; the transaction timeout remains the fallback.
      }
    }, POPUP_CLOSE_POLL_MS);

    return {
      promise,
      cancel: (error) => finish(error),
    };
  }

  private isAllowedPopupCallbackOrigin(origin: string): boolean {
    try {
      const parsed = new URL(origin);
      const registeredOrigin = new URL(this.config.redirectUri).origin;
      return parsed.origin === origin && isSecureUrl(parsed) &&
        (origin === registeredOrigin || this.config.additionalRedirectOrigins.includes(origin));
    } catch {
      return false;
    }
  }

  private loadTransaction(): AuthTransaction | null {
    const raw = this.config.storage.get(this.transactionKey);
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.clearTransaction(); return null;
      }
      const transaction = value as Record<string, unknown>;
      if (typeof transaction.state !== 'string' || !transaction.state ||
          typeof transaction.nonce !== 'string' || !transaction.nonce ||
          typeof transaction.codeVerifier !== 'string' || !transaction.codeVerifier ||
          typeof transaction.redirectUri !== 'string' || !transaction.redirectUri ||
          typeof transaction.createdAt !== 'number' || !Number.isFinite(transaction.createdAt) ||
          (transaction.maxAgeSeconds !== undefined &&
            (typeof transaction.maxAgeSeconds !== 'number' || !Number.isSafeInteger(transaction.maxAgeSeconds) || transaction.maxAgeSeconds < 0))) {
        this.clearTransaction(); return null;
      }
      // Re-validate a persisted return target: a poisoned transaction must not
      // become an open redirect handed back to the host application.
      if (transaction.returnTo !== undefined) {
        try {
          normalizeReturnTo(
            transaction.returnTo,
            transaction.redirectUri,
            this.config.additionalRedirectOrigins,
          );
        } catch {
          this.clearTransaction(); return null;
        }
      }
      return transaction as unknown as AuthTransaction;
    } catch { this.clearTransaction(); return null; }
  }

  private clearTransactionForState(state: string): void {
    const transaction = this.loadTransaction();
    if (transaction && timingSafeEqual(transaction.state, state)) this.clearTransaction();
  }

  private clearTransaction(): void { this.config.storage.remove(this.transactionKey); }
}

interface ExchangeOpts {
  tokenEndpoint: string; clientId: string; code: string;
  redirectUri: string; codeVerifier: string; timeoutMs: number;
}

async function exchangeCodeForTokens(opts: ExchangeOpts): Promise<AIDTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: opts.code,
    redirect_uri: opts.redirectUri, client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });
  // An authorization code is single-use: never retried, even on a 503.
  const { response, payload } = await postFormJson(
    opts.tokenEndpoint, body, 'Token endpoint request failed', opts.timeoutMs,
  );
  return parseTokenResponse(response, payload);
}

interface RefreshOpts {
  tokenEndpoint: string; clientId: string; refreshToken: string;
  scope?: string; timeoutMs: number;
}

async function refreshTokens(opts: RefreshOpts): Promise<AIDTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: opts.refreshToken, client_id: opts.clientId,
  });
  if (opts.scope) body.set('scope', opts.scope);
  // A rotating refresh token may already have been redeemed by the failed
  // attempt, so a retry could invalidate the whole session. No retries here.
  const { response, payload } = await postFormJson(
    opts.tokenEndpoint, body, 'Token refresh request failed', opts.timeoutMs,
  );
  return parseTokenResponse(response, payload, opts.refreshToken);
}

interface RevokeTokenOpts {
  revocationEndpoint: string; clientId: string; token: string;
  tokenTypeHint?: 'access_token' | 'refresh_token'; timeoutMs: number;
}

async function revokeToken(opts: RevokeTokenOpts): Promise<void> {
  const body = new URLSearchParams({ token: opts.token, client_id: opts.clientId });
  if (opts.tokenTypeHint) body.set('token_type_hint', opts.tokenTypeHint);
  const { response } = await postFormJson(
    opts.revocationEndpoint, body, 'Token revocation request failed', opts.timeoutMs,
  );
  if (!response.ok) throw new AIDTokenError(`Token revocation request failed: HTTP ${response.status}`);
}

async function postFormJson(
  url: string, body: URLSearchParams, errorMessage: string, timeoutMs: number,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const timeout = withRequestTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(), signal: timeout.signal, cache: 'no-store',
    });
    const payload = await readResponseJson(response);
    return { response, payload };
  } catch (err) {
    if (err instanceof AIDTokenError) throw err;
    throw new AIDTokenError(errorMessage, err);
  } finally { timeout.dispose(); }
}

async function readResponseJson(res: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBoundedText(res, MAX_TOKEN_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof ResponseSizeError) {
      throw new AIDTokenError(
        `Token endpoint response exceeds the ${MAX_TOKEN_RESPONSE_BYTES}-byte limit`,
      );
    }
    throw err;
  }
  let value: unknown = {};
  if (text.trim()) {
    try { value = JSON.parse(text) as unknown; }
    catch (err) {
      throw new AIDTokenError(`Token endpoint returned non-JSON response (HTTP ${res.status})`, err);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIDTokenError('Token endpoint response must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function isValidSession(value: unknown): value is AIDSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  if (!session.user || typeof session.user !== 'object' || Array.isArray(session.user)) return false;
  const user = session.user as Record<string, unknown>;
  if (typeof user.sub !== 'string' || !user.sub) return false;
  if (!session.tokens || typeof session.tokens !== 'object' || Array.isArray(session.tokens)) return false;
  const tokens = session.tokens as Record<string, unknown>;
  if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) return false;
  if (typeof tokens.tokenType !== 'string' || !tokens.tokenType) return false;
  if (tokens.expiresIn !== undefined && (
    typeof tokens.expiresIn !== 'number' || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn < 0
  )) return false;
  if (tokens.expiresAt !== undefined && (
    typeof tokens.expiresAt !== 'number' || !Number.isFinite(tokens.expiresAt)
  )) return false;
  if (tokens.obtainedAt !== undefined && (
    typeof tokens.obtainedAt !== 'number' || !Number.isFinite(tokens.obtainedAt)
  )) return false;
  if (tokens.refreshToken !== undefined && (
    typeof tokens.refreshToken !== 'string' || !tokens.refreshToken
  )) return false;
  if (tokens.idToken !== undefined && typeof tokens.idToken !== 'string') return false;
  if (tokens.scope !== undefined && typeof tokens.scope !== 'string') return false;
  return true;
}

function isInvalidRefreshTokenError(err: unknown): boolean {
  return err instanceof AIDTokenError && err.error === 'invalid_grant';
}

function parseTokenResponse(
  res: Response, json: Record<string, unknown>, previousRefreshToken?: string,
): AIDTokens {
  if (!res.ok) {
    const code = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    const desc = typeof json.error_description === 'string' ? ` — ${json.error_description}` : '';
    throw new AIDTokenError(
      `Token endpoint error: ${code}${desc}`, undefined,
      typeof json.error === 'string' ? json.error : undefined,
      { retryable: false },
    );
  }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new AIDTokenError('Token response did not contain a valid access_token');
  }
  try { return normalizeTokenResponse(json as unknown as TokenResponse, previousRefreshToken); }
  catch (err) {
    if (err instanceof AIDError) throw err;
    throw new AIDTokenError('Invalid token response', err);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCurrentUrl(): string {
  if (typeof globalThis.location === 'undefined') {
    throw new AIDCallbackError('handleCallback requires an explicit URL argument in non-browser environments');
  }
  return globalThis.location.href;
}

function redirectTo(url: string): void {
  if (typeof globalThis.location === 'undefined') {
    throw new AIDError('CONFIGURATION_ERROR', 'signIn/signOut require a browser environment (window.location)');
  }
  globalThis.location.assign(url);
}

function getBrowserWindow(): Window {
  if (typeof globalThis.window === 'undefined') {
    throw new AIDError('CONFIGURATION_ERROR', 'Popup authentication requires a browser window');
  }
  return globalThis.window;
}

function openAuthenticationPopup(browserWindow: Window = getBrowserWindow()): Window {
  if (typeof browserWindow.open !== 'function') {
    throw new AIDError('CONFIGURATION_ERROR', 'Popup authentication is not available in this browser');
  }
  const width = 520;
  const height = 680;
  const left = Math.max(0, Math.round(browserWindow.screenX + (browserWindow.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(browserWindow.screenY + (browserWindow.outerHeight - height) / 2));
  let popup: Window | null;
  try {
    // Do not use noopener: the callback needs a narrowly validated opener channel.
    popup = browserWindow.open(
      'about:blank',
      '_blank',
      `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    );
  } catch (err) {
    throw new AIDAuthenticationError('Could not open the sign-in popup', err);
  }
  if (!popup) {
    throw new AIDAuthenticationError(
      'Sign-in popup was blocked; allow popups for this site or use signIn() for redirect authentication',
    );
  }
  return popup;
}

function closePopup(popup: Window): void {
  try { popup.close(); } catch { /* best-effort cleanup */ }
}

function readPopupMessage(value: unknown): PopupWireMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.protocol !== POPUP_MESSAGE_PROTOCOL ||
      typeof message.type !== 'string' || !POPUP_MESSAGE_TYPES.has(message.type) ||
      typeof message.state !== 'string') return null;
  return message as unknown as PopupWireMessage;
}

function cappedTimerDelay(delayMs: number): number {
  return Math.min(delayMs, MAX_TIMER_DELAY_MS);
}

const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  'client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce',
  'code_challenge', 'code_challenge_method', 'code_verifier', 'grant_type',
  'request', 'request_uri', 'prompt', 'login_hint', 'max_age', 'acr_values', 'ui_locales',
]);

function normalizeAuthorizationOptions(options: AIDAuthorizationOptions): Record<string, string> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new AIDError('CONFIGURATION_ERROR', 'signIn options must be an object');
  }
  const normalized: Record<string, string> = {};
  const addTokenList = (key: string, value: string | string[] | undefined): void => {
    if (value === undefined) return;
    if (typeof value !== 'string' && !Array.isArray(value)) {
      throw new AIDError('CONFIGURATION_ERROR', `${key} must be a string or array of strings`);
    }
    const values = Array.isArray(value) ? value : value.trim().split(/\s+/);
    if (values.length === 0 || values.some(item =>
      typeof item !== 'string' || !item.trim() || /[\s\u0000-\u001f\u007f]/.test(item)
    )) {
      throw new AIDError('CONFIGURATION_ERROR', `${key} must contain non-empty space-free values`);
    }
    normalized[key] = values.join(' ');
  };
  addTokenList('prompt', options.prompt);
  if (options.loginHint !== undefined) {
    if (typeof options.loginHint !== 'string' || !options.loginHint.trim() ||
        /[\u0000-\u001f\u007f]/.test(options.loginHint)) {
      throw new AIDError('CONFIGURATION_ERROR', 'loginHint must be non-empty and contain no control characters');
    }
    normalized.login_hint = options.loginHint;
  }
  if (options.maxAge !== undefined) {
    if (!Number.isSafeInteger(options.maxAge) || options.maxAge < 0) {
      throw new AIDError('CONFIGURATION_ERROR', 'maxAge must be a non-negative safe integer in seconds');
    }
    normalized.max_age = String(options.maxAge);
  }
  addTokenList('acr_values', options.acrValues);
  addTokenList('ui_locales', options.uiLocales);
  if (options.additionalParameters !== undefined) {
    if (!options.additionalParameters || typeof options.additionalParameters !== 'object' || Array.isArray(options.additionalParameters)) {
      throw new AIDError('CONFIGURATION_ERROR', 'additionalParameters must be a string map');
    }
    for (const [key, value] of Object.entries(options.additionalParameters)) {
      if (!/^[a-z][a-z0-9_.:-]*$/i.test(key) || RESERVED_AUTHORIZATION_PARAMETERS.has(key.toLowerCase())) {
        throw new AIDError('CONFIGURATION_ERROR', `additionalParameters cannot override reserved parameter: ${key}`);
      }
      if (typeof value !== 'string' || !value.length || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new AIDError('CONFIGURATION_ERROR', `additionalParameters.${key} must be non-empty and contain no control characters`);
      }
      normalized[key] = value;
    }
  }
  return normalized;
}
