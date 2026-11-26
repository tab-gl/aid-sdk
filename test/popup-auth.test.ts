import { afterEach, describe, expect, it, vi } from 'vitest';
import { AID } from '../src/browser/client.js';
import { createCodeChallenge } from '../src/browser/pkce.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { AIDAuthenticationError, AIDCallbackError, AIDTokenError } from '../src/core/errors.js';
import { startOidcFixture, type OidcFixture } from './helpers/oidc-fixture.js';

const ISSUER = 'https://identity.example.test';
const REDIRECT = 'https://app.example.test/auth/callback';
const CLIENT_ID = 'popup-client';

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function discoveryDocument(): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    code_challenge_methods_supported: ['S256'],
  };
}

interface FakePopupEnvironment {
  parent: Window;
  popup: Window;
  parentLocation: { href: string; origin: string; assign: ReturnType<typeof vi.fn> };
  popupLocation: { href: string };
  open: ReturnType<typeof vi.fn>;
  popupPostMessage: ReturnType<typeof vi.fn>;
  parentPostMessage: ReturnType<typeof vi.fn>;
  dispatchToParent(source: Window, origin: string, data: unknown): void;
  dispatchToPopup(source: Window, origin: string, data: unknown): void;
  dispatchPageHide(): void;
  popupIsClosed(): boolean;
}

function createPopupEnvironment(blocked = false): FakePopupEnvironment {
  type Listener = (event: MessageEvent) => void;
  const parentListeners = new Set<Listener>();
  const popupListeners = new Set<Listener>();
  const pagehideListeners = new Set<(event: PageTransitionEvent) => void>();
  const parentLocation = {
    href: 'https://app.example.test/sign-in',
    origin: 'https://app.example.test',
    assign: vi.fn(),
  };
  const popupLocation = { href: 'about:blank' };
  let closed = false;
  let parent!: Window;
  let popup!: Window;

  const addListener = (listeners: Set<Listener>, type: string, listener: EventListenerOrEventListenerObject): void => {
    if (type === 'message' && typeof listener === 'function') listeners.add(listener as Listener);
  };
  const removeListener = (listeners: Set<Listener>, type: string, listener: EventListenerOrEventListenerObject): void => {
    if (type === 'message' && typeof listener === 'function') listeners.delete(listener as Listener);
  };
  const currentPopupOrigin = (): string => {
    try { return new URL(popupLocation.href).origin; } catch { return 'null'; }
  };

  const open = vi.fn(() => blocked ? null : popup);
  const dispatchToParent = (source: Window, origin: string, data: unknown): void => {
    const event = { source, origin, data } as MessageEvent;
    for (const listener of [...parentListeners]) listener(event);
  };
  const dispatchToPopup = (source: Window, origin: string, data: unknown): void => {
    const event = { source, origin, data } as MessageEvent;
    for (const listener of [...popupListeners]) listener(event);
  };
  const parentPostMessage = vi.fn((data: unknown, targetOrigin: string) => {
    if (targetOrigin !== '*' && targetOrigin !== parentLocation.origin) return;
    dispatchToParent(popup, currentPopupOrigin(), data);
  });
  parent = {
    location: parentLocation,
    opener: null,
    screenX: 20,
    screenY: 20,
    outerWidth: 1200,
    outerHeight: 900,
    open,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') {
        pagehideListeners.add(listener as (event: PageTransitionEvent) => void);
      } else {
        addListener(parentListeners, type, listener);
      }
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') {
        pagehideListeners.delete(listener as (event: PageTransitionEvent) => void);
      } else {
        removeListener(parentListeners, type, listener);
      }
    },
    postMessage: parentPostMessage,
  } as unknown as Window;

  const popupPostMessage = vi.fn((data: unknown, targetOrigin: string) => {
    if (targetOrigin !== currentPopupOrigin()) return;
    const event = {
      source: parent,
      origin: parentLocation.origin,
      data,
    } as MessageEvent;
    for (const listener of [...popupListeners]) listener(event);
  });
  const dispatchPageHide = (): void => {
    const event = { type: 'pagehide', persisted: false } as PageTransitionEvent;
    for (const listener of [...pagehideListeners]) listener(event);
  };
  popup = {
    get closed() { return closed; },
    location: popupLocation,
    opener: parent,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => addListener(popupListeners, type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => removeListener(popupListeners, type, listener),
    postMessage: popupPostMessage,
    close: vi.fn(() => { closed = true; }),
  } as unknown as Window;

  return {
    parent,
    popup,
    parentLocation,
    popupLocation,
    open,
    popupPostMessage,
    parentPostMessage,
    dispatchToParent,
    dispatchToPopup,
    dispatchPageHide,
    popupIsClosed: () => closed,
  };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe('popup authentication', () => {
  let fixture: OidcFixture | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fixture?.close();
    fixture = undefined;
  });

  it('opens synchronously and completes a real local OIDC exchange through the secure popup handshake', async () => {
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
    });
    const environment = createPopupEnvironment();
    const order: string[] = [];
    environment.open.mockImplementation(() => {
      order.push('open');
      return environment.popup;
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push('fetch');
      return originalFetch(input, init);
    });
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', fetchMock);

    const storage = new MemoryStorage();
    const client = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup({ returnTo: '/dashboard', prompt: 'select_account' });
    expect(environment.open).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('open');

    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    expect(order[1]).toBe('fetch');
    const authorizationUrl = new URL(environment.popupLocation.href);
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('prompt')).toBe('select_account');

    const transaction = JSON.parse(storage.get('aid:transaction') as string) as {
      state: string; nonce: string; codeVerifier: string;
    };
    expect(authorizationUrl.searchParams.get('state')).toBe(transaction.state);
    expect(authorizationUrl.searchParams.get('nonce')).toBe(transaction.nonce);
    const codeChallenge = authorizationUrl.searchParams.get('code_challenge');
    expect(codeChallenge).toBe(await createCodeChallenge(transaction.codeVerifier));
    fixture.setCodeChallenge(codeChallenge as string);

    const forgedHello = { protocol: 'ace-id-popup-v1', type: 'hello', state: transaction.state };
    const forgedCallback = {
      protocol: 'ace-id-popup-v1',
      type: 'callback',
      state: transaction.state,
      url: `${REDIRECT}?code=forged-code&state=${encodeURIComponent(transaction.state)}`,
    };
    environment.dispatchToParent({} as Window, 'https://app.example.test', forgedHello);
    environment.dispatchToParent(environment.popup, 'https://evil.example.test', forgedHello);
    environment.dispatchToParent(environment.popup, 'https://app.example.test', {
      protocol: 'wrong-protocol', type: 'hello', state: transaction.state,
    });
    environment.dispatchToParent(environment.popup, 'https://app.example.test', {
      protocol: 'ace-id-popup-v1', type: 'unknown', state: transaction.state,
    });
    environment.dispatchToParent(environment.popup, 'https://app.example.test', {
      protocol: 'ace-id-popup-v1', type: 'hello', state: 42,
    });
    environment.dispatchToParent({} as Window, 'https://app.example.test', forgedCallback);
    environment.dispatchToParent(environment.popup, 'https://evil.example.test', forgedCallback);
    expect(environment.popupPostMessage).not.toHaveBeenCalled();
    expect(fixture.tokenRequests()).toBe(0);

    const authorizationResponse = await fetchMock(authorizationUrl.toString(), { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const callbackUrl = authorizationResponse.headers.get('location');
    expect(callbackUrl).toBeTruthy();
    const callbackParameters = new URL(callbackUrl as string);
    expect(callbackParameters.origin + callbackParameters.pathname).toBe(REDIRECT);
    expect(callbackParameters.searchParams.get('state')).toBe(transaction.state);
    environment.popupLocation.href = callbackUrl as string;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);
    // Popup sessionStorage is separate from the opener's; relaying needs only
    // the callback URL and must not depend on the transaction being copied.
    const popupClient = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: new MemoryStorage() });

    const popupCallback = popupClient.handlePopupCallback();
    // Replay the exact callback message while the first token exchange is pending.
    const callbackMessage = environment.parentPostMessage.mock.calls
      .map(([data]) => data as Record<string, unknown>)
      .find((message) => message.type === 'callback');
    expect(callbackMessage).toBeDefined();
    environment.dispatchToParent(environment.popup, 'https://app.example.test', callbackMessage);

    const [session] = await Promise.all([signIn, popupCallback]);
    expect(session.user.sub).toBe('user-1');
    expect(session.tokens.accessToken).toBe('access-token-1');
    expect(session.returnTo).toBe('https://app.example.test/dashboard');
    expect(client.getSession()).toMatchObject({
      user: session.user,
      tokens: { accessToken: session.tokens.accessToken, refreshToken: session.tokens.refreshToken },
    });
    expect(fixture.tokenRequests()).toBe(1);
    expect(fixture.jwksFetches()).toBe(1);

    const tokenBody = fixture.requests.find((request) => request.path === '/token')?.body;
    expect(new URLSearchParams(tokenBody ?? '').get('grant_type')).toBe('authorization_code');
    expect(new URLSearchParams(tokenBody ?? '').get('code')).toBe(callbackParameters.searchParams.get('code'));
    expect(new URLSearchParams(tokenBody ?? '').get('code_verifier')).toBe(transaction.codeVerifier);
    expect(storage.get('aid:transaction')).toBeNull();
    expect(environment.popupIsClosed()).toBe(true);
    expect(environment.popupPostMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(environment.popupPostMessage.mock.calls.every(([, targetOrigin]) => targetOrigin === 'https://app.example.test'))
      .toBe(true);
    expect(environment.parentPostMessage.mock.calls.map(([, targetOrigin]) => targetOrigin))
      .toEqual(['*', 'https://app.example.test']);
  });

  it('allows separate tabs with isolated storage to authenticate at the same time', async () => {
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
    });
    const firstTab = createPopupEnvironment();
    const secondTab = createPopupEnvironment();
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const firstClient = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: firstStorage });
    const secondClient = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: secondStorage });

    vi.stubGlobal('window', firstTab.parent);
    vi.stubGlobal('location', firstTab.parentLocation);
    const firstSignIn = firstClient.signInWithPopup();
    await waitFor(() => firstTab.popupLocation.href.includes('/authorize?'), 'the first authorization URL');

    vi.stubGlobal('window', secondTab.parent);
    vi.stubGlobal('location', secondTab.parentLocation);
    const secondSignIn = secondClient.signInWithPopup();
    await waitFor(() => secondTab.popupLocation.href.includes('/authorize?'), 'the second authorization URL');
    expect(JSON.parse(firstStorage.get('aid:transaction') as string).state)
      .not.toBe(JSON.parse(secondStorage.get('aid:transaction') as string).state);

    const [firstAuthorization, secondAuthorization] = await Promise.all([
      fetch(firstTab.popupLocation.href, { redirect: 'manual' }),
      fetch(secondTab.popupLocation.href, { redirect: 'manual' }),
    ]);
    expect(firstAuthorization.status).toBe(302);
    expect(secondAuthorization.status).toBe(302);
    firstTab.popupLocation.href = firstAuthorization.headers.get('location') as string;
    secondTab.popupLocation.href = secondAuthorization.headers.get('location') as string;

    vi.stubGlobal('window', firstTab.popup);
    vi.stubGlobal('location', firstTab.popupLocation);
    const firstPopupClient = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
    });
    const firstPopupCallback = firstPopupClient.handlePopupCallback();

    vi.stubGlobal('window', secondTab.popup);
    vi.stubGlobal('location', secondTab.popupLocation);
    const secondPopupClient = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
    });
    const secondPopupCallback = secondPopupClient.handlePopupCallback();

    const [firstSession, secondSession] = await Promise.all([firstSignIn, secondSignIn]);
    await Promise.all([firstPopupCallback, secondPopupCallback]);
    expect(firstSession.user.sub).toBe('user-1');
    expect(secondSession.user.sub).toBe('user-1');
    expect(firstStorage.get('aid:session')).not.toBeNull();
    expect(secondStorage.get('aid:session')).not.toBeNull();
    expect(firstTab.popupIsClosed()).toBe(true);
    expect(secondTab.popupIsClosed()).toBe(true);
  });

  it('rejects replay of an authorization code while preserving the existing verified session', async () => {
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
    });
    const storage = new MemoryStorage();
    const client = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });

    const runPopup = async (environment: FakePopupEnvironment, replayCode?: string) => {
      vi.stubGlobal('window', environment.parent);
      vi.stubGlobal('location', environment.parentLocation);
      const signIn = client.signInWithPopup();
      await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
      const authorizationUrl = new URL(environment.popupLocation.href);
      const transaction = JSON.parse(storage.get('aid:transaction') as string) as {
        state: string; nonce: string; codeVerifier: string;
      };
      const challenge = authorizationUrl.searchParams.get('code_challenge');
      expect(challenge).toBe(await createCodeChallenge(transaction.codeVerifier));
      fixture?.setCodeChallenge(challenge as string);

      const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' });
      expect(authorizationResponse.status).toBe(302);
      const callbackLocation = authorizationResponse.headers.get('location');
      expect(callbackLocation).toBeTruthy();
      const callbackUrl = new URL(callbackLocation as string);
      expect(callbackUrl.searchParams.get('state')).toBe(transaction.state);
      if (replayCode !== undefined) callbackUrl.searchParams.set('code', replayCode);
      environment.popupLocation.href = callbackUrl.toString();
      vi.stubGlobal('window', environment.popup);
      vi.stubGlobal('location', environment.popupLocation);
      const popupClient = new AID({
        issuer: fixture!.issuer,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        storage: new MemoryStorage(),
      });
      const callback = popupClient.handlePopupCallback();
      return { signIn, callback, code: callbackUrl.searchParams.get('code') as string };
    };

    const firstEnvironment = createPopupEnvironment();
    const firstAttempt = await runPopup(firstEnvironment);
    const [verifiedSession] = await Promise.all([firstAttempt.signIn, firstAttempt.callback]);
    expect(verifiedSession.tokens.accessToken).toBe('access-token-1');
    expect(fixture.tokenRequests()).toBe(1);
    expect(firstEnvironment.popupIsClosed()).toBe(true);

    const replayEnvironment = createPopupEnvironment();
    const replayAttempt = await runPopup(replayEnvironment, firstAttempt.code);
    const [signInResult, callbackResult] = await Promise.allSettled([
      replayAttempt.signIn,
      replayAttempt.callback,
    ]);
    expect(signInResult.status).toBe('rejected');
    if (signInResult.status === 'rejected') {
      expect(signInResult.reason).toBeInstanceOf(AIDTokenError);
      expect((signInResult.reason as AIDTokenError).error).toBe('invalid_grant');
    }
    expect(callbackResult.status).toBe('rejected');
    expect(fixture.tokenRequests()).toBe(2);
    expect(client.getSession()).toMatchObject({
      user: verifiedSession.user,
      tokens: { accessToken: verifiedSession.tokens.accessToken },
    });
    expect(storage.get('aid:transaction')).toBeNull();
    expect(replayEnvironment.popupIsClosed()).toBe(true);
  });

  it('rejects expired authorization codes without creating a session', async () => {
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
      authorizationCodeLifetimeMs: -1_000,
    });
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);

    const storage = new MemoryStorage();
    const client = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    const authorizationUrl = new URL(environment.popupLocation.href);
    const transaction = JSON.parse(storage.get('aid:transaction') as string) as {
      state: string; codeVerifier: string;
    };
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    expect(challenge).toBe(await createCodeChallenge(transaction.codeVerifier));
    fixture.setCodeChallenge(challenge as string);

    const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const callbackUrl = authorizationResponse.headers.get('location');
    expect(callbackUrl).toBeTruthy();
    expect(new URL(callbackUrl as string).searchParams.get('state')).toBe(transaction.state);
    environment.popupLocation.href = callbackUrl as string;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);
    const popupClient = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: new MemoryStorage() });
    const callback = popupClient.handlePopupCallback();

    const [signInResult, callbackResult] = await Promise.allSettled([signIn, callback]);
    expect(signInResult.status).toBe('rejected');
    if (signInResult.status === 'rejected') {
      expect(signInResult.reason).toBeInstanceOf(AIDTokenError);
      expect((signInResult.reason as AIDTokenError).error).toBe('invalid_grant');
    }
    expect(callbackResult.status).toBe('rejected');
    expect(client.getSession()).toBeNull();
    expect(storage.get('aid:session')).toBeNull();
    expect(storage.get('aid:transaction')).toBeNull();
    expect(fixture.tokenRequests()).toBe(1);
    expect(environment.popupIsClosed()).toBe(true);
  });

  it('does not persist tokens when ID-token verification fails after code exchange', async () => {
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
    });
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);

    const storage = new MemoryStorage();
    const client = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    const authorizationUrl = new URL(environment.popupLocation.href);
    const transaction = JSON.parse(storage.get('aid:transaction') as string) as {
      state: string; nonce: string; codeVerifier: string;
    };
    expect(transaction.nonce).not.toBe('deliberately-wrong-nonce');
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    expect(challenge).toBe(await createCodeChallenge(transaction.codeVerifier));
    fixture.setCodeChallenge(challenge as string);
    fixture.setNonce('deliberately-wrong-nonce');

    const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const callbackUrl = authorizationResponse.headers.get('location');
    expect(callbackUrl).toBeTruthy();
    expect(new URL(callbackUrl as string).searchParams.get('state')).toBe(transaction.state);
    environment.popupLocation.href = callbackUrl as string;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);
    const popupClient = new AID({ issuer: fixture.issuer, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: new MemoryStorage() });
    const callback = popupClient.handlePopupCallback();

    const [signInResult, callbackResult] = await Promise.allSettled([signIn, callback]);
    expect(signInResult.status).toBe('rejected');
    if (signInResult.status === 'rejected') {
      expect(signInResult.reason).toBeInstanceOf(AIDTokenError);
      expect((signInResult.reason as Error).message).toMatch(/nonce mismatch/i);
    }
    expect(callbackResult.status).toBe('rejected');
    expect(fixture.tokenRequests()).toBe(1);
    expect(client.getSession()).toBeNull();
    expect(storage.get('aid:session')).toBeNull();
    expect(storage.get('aid:transaction')).toBeNull();
    expect(environment.popupIsClosed()).toBe(true);
  });

  it('rejects a popup callback with a tampered state instead of leaving the window pending', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: new MemoryStorage() });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');

    environment.popupLocation.href = `${REDIRECT}?code=one-time-code&state=forged-state`;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);
    const popupClient = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: new MemoryStorage() });
    const callback = popupClient.handlePopupCallback();

    const [signInResult, callbackResult] = await Promise.allSettled([signIn, callback]);
    expect(signInResult.status).toBe('rejected');
    expect(signInResult.status === 'rejected' && signInResult.reason).toBeInstanceOf(AIDCallbackError);
    expect(callbackResult.status).toBe('rejected');
    expect(callbackResult.status === 'rejected' && callbackResult.reason).toBeInstanceOf(AIDCallbackError);
    expect(environment.popupIsClosed()).toBe(true);
  });

  it('cancels an in-flight popup when signOut() runs', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const storage = new MemoryStorage();
    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');

    await client.signOut();
    await expect(signIn).rejects.toThrow(/cancelled by sign-out/i);
    expect(environment.popupIsClosed()).toBe(true);
    expect(storage.get('aid:transaction')).toBeNull();
  });

  it('reports a blocked popup without starting discovery', async () => {
    const environment = createPopupEnvironment(true);
    const fetchMock = vi.fn(async () => json(discoveryDocument()));
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', fetchMock);

    const storage = new MemoryStorage();
    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    await expect(client.signInWithPopup()).rejects.toBeInstanceOf(AIDAuthenticationError);
    expect(environment.open).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();

    // Popup fallback is explicit: the caller can retry with the redirect API.
    await client.signIn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(environment.parentLocation.assign).toHaveBeenCalledTimes(1);
    expect(new URL(environment.parentLocation.assign.mock.calls[0]?.[0]).searchParams.get('response_type'))
      .toBe('code');
    expect(storage.get('aid:transaction')).not.toBeNull();
  });

  it('prevents simultaneous popup and redirect attempts across clients sharing storage', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const storage = new MemoryStorage();
    const config = { issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage };
    const client = new AID(config);
    const secondClient = new AID(config);
    const firstSignIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    const transactionBefore = storage.get('aid:transaction');

    await expect(client.signInWithPopup()).rejects.toBeInstanceOf(AIDAuthenticationError);
    await expect(client.signIn()).rejects.toBeInstanceOf(AIDAuthenticationError);
    await expect(secondClient.signInWithPopup()).rejects.toBeInstanceOf(AIDAuthenticationError);
    await expect(secondClient.signIn()).rejects.toBeInstanceOf(AIDAuthenticationError);
    expect(environment.open).toHaveBeenCalledTimes(1);
    expect(storage.get('aid:transaction')).toBe(transactionBefore);

    environment.popup.close();
    await expect(firstSignIn).rejects.toThrow(/closed before authentication/i);
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();
  });

  it('cancels the pending flow and clears its lock on page refresh or navigation', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const storage = new MemoryStorage();
    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');

    environment.dispatchPageHide();
    await expect(signIn).rejects.toThrow(/navigated or refreshed/i);
    expect(environment.popupIsClosed()).toBe(true);
    expect(storage.get('aid:transaction')).toBeNull();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();
  });

  it('also handles navigation while discovery is still preparing the popup', async () => {
    const environment = createPopupEnvironment();
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const fetchMock = vi.fn(async () => {
      await discoveryGate;
      return json(discoveryDocument());
    });
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', fetchMock);

    const storage = new MemoryStorage();
    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup();
    expect(environment.open).toHaveBeenCalledTimes(1);
    environment.dispatchPageHide();
    expect(environment.popupIsClosed()).toBe(true);
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();

    releaseDiscovery();
    await expect(signIn).rejects.toThrow(/navigated or refreshed/i);
    expect(storage.get('aid:transaction')).toBeNull();
  });

  it('does not let a redirect preparation race a popup into overwriting its transaction', async () => {
    const environment = createPopupEnvironment();
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const fetchMock = vi.fn(async () => {
      await discoveryGate;
      return json(discoveryDocument());
    });
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', fetchMock);

    const storage = new MemoryStorage();
    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const redirectAttempt = client.signIn();
    await expect(client.signIn()).rejects.toBeInstanceOf(AIDAuthenticationError);
    await expect(client.signInWithPopup()).rejects.toBeInstanceOf(AIDAuthenticationError);
    expect(environment.open).not.toHaveBeenCalled();
    expect(storage.get('aid:transaction')).toBeNull();

    releaseDiscovery();
    await redirectAttempt;
    expect(environment.parentLocation.assign).toHaveBeenCalledTimes(1);
    expect(storage.get('aid:transaction')).not.toBeNull();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();
  });

  it('rejects when the user closes the popup before authentication completes', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const storage = new MemoryStorage();
    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');

    environment.popup.close();
    await expect(signIn).rejects.toThrow(/closed before authentication/i);
    expect(storage.get('aid:transaction')).toBeNull();
  });

  it('times out an abandoned popup and releases its transaction and lock', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const storage = new MemoryStorage();
    const client = new AID({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage,
      transactionTtlMs: 40,
    });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');

    await expect(signIn).rejects.toThrow(/timed out/i);
    expect(environment.popupIsClosed()).toBe(true);
    expect(storage.get('aid:transaction')).toBeNull();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();
  });

  it('closes the popup on timeout even if the callback page stopped listening', async () => {
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);
    vi.stubGlobal('fetch', vi.fn(async () => json(discoveryDocument())));

    const storage = new MemoryStorage();
    const client = new AID({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage,
      transactionTtlMs: 200,
    });
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    const transaction = JSON.parse(storage.get('aid:transaction') as string) as { state: string };

    environment.popupLocation.href = `${REDIRECT}?code=unused&state=${transaction.state}`;
    environment.dispatchToParent(environment.popup, 'https://app.example.test', {
      protocol: 'ace-id-popup-v1',
      type: 'hello',
      state: transaction.state,
    });
    // No callback listener is installed to answer the challenge or completion.
    await expect(signIn).rejects.toThrow(/timed out/i);
    expect(environment.popupIsClosed()).toBe(true);
    expect(storage.get('aid:transaction')).toBeNull();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();
  });

  it('prevents a late callback from saving a session or clearing a newer transaction after timeout', async () => {
    let releaseTokenExchange!: () => void;
    const tokenGate = new Promise<void>((resolve) => { releaseTokenExchange = resolve; });
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
      tokenGate,
    });
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);

    const storage = new MemoryStorage();
    const client = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage,
      transactionTtlMs: 250,
      requestTimeoutMs: 2_000,
    });
    const callbackHandler = vi.spyOn(client as unknown as {
      processCallback(current: string, isCancelled?: () => boolean): Promise<unknown>;
    }, 'processCallback');
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    const authorizationUrl = new URL(environment.popupLocation.href);
    const transaction = JSON.parse(storage.get('aid:transaction') as string) as {
      state: string; codeVerifier: string;
    };
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    expect(challenge).toBe(await createCodeChallenge(transaction.codeVerifier));

    const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    const callbackUrl = authorizationResponse.headers.get('location');
    expect(authorizationResponse.status).toBe(302);
    expect(callbackUrl).toBeTruthy();
    environment.popupLocation.href = callbackUrl as string;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);
    const popupClient = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
    });
    const popupCallback = popupClient.handlePopupCallback();
    await waitFor(() => fixture?.tokenRequests() === 1, 'the pending code exchange');

    const [signInResult, popupResult] = await Promise.allSettled([signIn, popupCallback]);
    expect(signInResult.status).toBe('rejected');
    expect(popupResult.status).toBe('rejected');
    const lateExchange = callbackHandler.mock.results[0]?.value as Promise<unknown> | undefined;
    expect(lateExchange).toBeDefined();

    const retryEnvironment = createPopupEnvironment();
    vi.stubGlobal('window', retryEnvironment.parent);
    vi.stubGlobal('location', retryEnvironment.parentLocation);
    const retrySignIn = client.signInWithPopup();
    await waitFor(() => retryEnvironment.popupLocation.href.includes('/authorize?'), 'the retry authorization URL');
    const retryTransaction = storage.get('aid:transaction');
    expect(retryTransaction).not.toBeNull();
    expect(JSON.parse(retryTransaction as string).state).not.toBe(transaction.state);

    releaseTokenExchange();
    await expect(lateExchange as Promise<unknown>).rejects.toThrow(/cancelled before the session/i);
    expect(storage.get('aid:transaction')).toBe(retryTransaction);
    expect(client.getSession()).toBeNull();

    const retryAuthorization = await fetch(retryEnvironment.popupLocation.href, { redirect: 'manual' });
    expect(retryAuthorization.status).toBe(302);
    retryEnvironment.popupLocation.href = retryAuthorization.headers.get('location') as string;
    vi.stubGlobal('window', retryEnvironment.popup);
    vi.stubGlobal('location', retryEnvironment.popupLocation);
    const retryPopupClient = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
    });
    const retryCallback = retryPopupClient.handlePopupCallback();
    const [retrySession] = await Promise.all([retrySignIn, retryCallback]);
    expect(retrySession.tokens.accessToken).toBe('access-token-2');
    expect(client.getSession()?.tokens.accessToken).toBe('access-token-2');
    expect(storage.get('aid:transaction')).toBeNull();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();
  });

  it('cancels callback processing if the popup closes during code exchange', async () => {
    let releaseTokenExchange!: () => void;
    const tokenGate = new Promise<void>((resolve) => { releaseTokenExchange = resolve; });
    fixture = await startOidcFixture({
      clientId: CLIENT_ID,
      requireAuthorizationCodeRegistration: true,
      tokenGate,
    });
    const environment = createPopupEnvironment();
    vi.stubGlobal('window', environment.parent);
    vi.stubGlobal('location', environment.parentLocation);

    const storage = new MemoryStorage();
    const client = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage,
      requestTimeoutMs: 2_000,
    });
    const callbackHandler = vi.spyOn(client as unknown as {
      processCallback(current: string, isCancelled?: () => boolean): Promise<unknown>;
    }, 'processCallback');
    const signIn = client.signInWithPopup();
    await waitFor(() => environment.popupLocation.href.includes('/authorize?'), 'the authorization URL');
    const authorizationUrl = new URL(environment.popupLocation.href);
    const transaction = JSON.parse(storage.get('aid:transaction') as string) as { codeVerifier: string };
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    expect(challenge).toBe(await createCodeChallenge(transaction.codeVerifier));
    fixture.setCodeChallenge(challenge as string);

    const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    environment.popupLocation.href = authorizationResponse.headers.get('location') as string;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);
    const popupClient = new AID({
      issuer: fixture.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
    });
    const popupCallback = popupClient.handlePopupCallback();
    await waitFor(() => fixture?.tokenRequests() === 1, 'the pending code exchange');

    environment.popup.close();
    const [signInResult, popupResult] = await Promise.allSettled([signIn, popupCallback]);
    expect(signInResult.status).toBe('rejected');
    expect(signInResult.status === 'rejected' && signInResult.reason).toBeInstanceOf(AIDAuthenticationError);
    expect(signInResult.status === 'rejected' && (signInResult.reason as Error).message)
      .toMatch(/closed before authentication/i);
    expect(popupResult.status).toBe('rejected');
    expect(storage.get('aid:transaction')).toBeNull();
    expect(storage.get('aid:authorization-flow-lock')).toBeNull();

    const lateExchange = callbackHandler.mock.results[0]?.value as Promise<unknown> | undefined;
    expect(lateExchange).toBeDefined();
    releaseTokenExchange();
    await expect(lateExchange as Promise<unknown>).rejects.toThrow(/cancelled before the session/i);
    expect(client.getSession()).toBeNull();
    expect(storage.get('aid:session')).toBeNull();
  });

  it('does not relay a callback URL to an unregistered HTTPS opener origin', async () => {
    const environment = createPopupEnvironment();
    const state = 'callback-state';
    environment.popupLocation.href = `${REDIRECT}?code=one-time-code&state=${state}`;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);

    const client = new AID({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
      transactionTtlMs: 30,
    });
    const callback = client.handlePopupCallback();
    environment.dispatchToPopup(environment.parent, 'https://evil.example.test', {
      protocol: 'ace-id-popup-v1',
      type: 'challenge',
      state,
    });

    await expect(callback).rejects.toThrow(/timed out/i);
    const messageTypes = environment.parentPostMessage.mock.calls
      .map(([data]) => (data as Record<string, unknown>).type);
    expect(messageTypes).toEqual(['hello']);
    expect(environment.popupIsClosed()).toBe(true);
  });

  it('ignores an opener completion message until the callback URL has been challenged', async () => {
    const environment = createPopupEnvironment();
    const state = 'popup-callback-state';
    environment.popupLocation.href = `${REDIRECT}?code=code&state=${state}`;
    vi.stubGlobal('window', environment.popup);
    vi.stubGlobal('location', environment.popupLocation);

    const client = new AID({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage: new MemoryStorage(),
      transactionTtlMs: 30,
    });
    environment.parentPostMessage.mockImplementationOnce(() => {
      environment.popupPostMessage({
        protocol: 'ace-id-popup-v1',
        type: 'complete',
        state,
        ok: true,
      }, environment.parentLocation.origin);
    });

    await expect(client.handlePopupCallback()).rejects.toThrow(/timed out/i);
    expect(environment.popupIsClosed()).toBe(true);
  });

  it('rejects the popup callback route when opened directly without a live opener', async () => {
    const environment = createPopupEnvironment();
    const isolatedPopup = { ...environment.popup, opener: null } as unknown as Window;
    vi.stubGlobal('window', isolatedPopup);
    vi.stubGlobal('location', { href: `${REDIRECT}?code=code&state=state` });

    const client = new AID({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT, storage: new MemoryStorage() });
    await expect(client.handlePopupCallback()).rejects.toBeInstanceOf(AIDAuthenticationError);
  });
});
