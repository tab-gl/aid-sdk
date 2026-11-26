import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import {
  AceIDProvider,
  AuthProvider,
  ProtectedRoute,
  useAceID,
  useAceIDActions,
  useAceIDSession,
} from '../src/react/index.js';
import { AID } from '../src/browser/client.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { AIDError } from '../src/core/errors.js';
import type { AIDSession } from '../src/core/types.js';

const ISSUER = 'https://identity.example.test';
const REDIRECT = 'https://app.example.test/cb';

function session(): AIDSession {
  return {
    user: { sub: 'user-1', email: 'user@example.test', name: 'Test User' },
    tokens: {
      accessToken: 'access-1',
      tokenType: 'Bearer',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: Date.now(),
    },
  };
}

function clientWithSession(): AID {
  const storage = new MemoryStorage();
  storage.set('aid:session', JSON.stringify(session()));
  return new AID({ issuer: ISSUER, clientId: 'c', redirectUri: REDIRECT, storage });
}

function Probe(): ReturnType<typeof createElement> {
  const { status, isAuthenticated, isLoading, user } = useAceIDSession();
  return createElement('span', null, `${status}|${String(isAuthenticated)}|${String(isLoading)}|${user?.email ?? 'none'}`);
}

describe('React adapter', () => {
  let clientRoot: Root | undefined;

  async function renderClient(node: ReactNode): Promise<HTMLElement> {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const container = window.document.getElementById('root');
    if (!container) throw new Error('React test root was not created');
    clientRoot = createRoot(container);
    await act(async () => {
      clientRoot?.render(node);
    });
    return container;
  }

  async function unmountClient(): Promise<void> {
    if (clientRoot) await act(async () => clientRoot?.unmount());
    clientRoot = undefined;
  }

  afterEach(async () => {
    await unmountClient();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws a clear error when the hook is used outside the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderToString(createElement(Probe))).toThrow(AIDError);
    consoleError.mockRestore();
  });

  it('reports a loading state during server rendering', () => {
    const client = clientWithSession();
    const html = renderToString(
      createElement(AceIDProvider, { client }, createElement(Probe)),
    );
    expect(html).toContain('loading');
  });

  it('hydrates the session on mount and exposes the user', async () => {
    const client = clientWithSession();
    const container = await renderClient(
      createElement(AceIDProvider, { client }, createElement(Probe)),
    );
    expect(container.textContent).toContain('authenticated');
    expect(container.textContent).toContain('user@example.test');
  });

  it('updates when the session changes outside React', async () => {
    const client = clientWithSession();
    vi.stubGlobal('location', { href: REDIRECT, assign: vi.fn() });
    // signOut consults discovery for a provider logout endpoint; keep it local.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const container = await renderClient(
      createElement(AuthProvider, { client }, createElement(Probe)),
    );
    expect(container.textContent).toContain('authenticated');

    await act(async () => {
      await client.signOut();
    });
    expect(container.textContent).toContain('unauthenticated');
  });

  it('exposes actions from useAceIDActions', async () => {
    const client = clientWithSession();
    let actions: ReturnType<typeof useAceIDActions> | undefined;
    function ActionsProbe(): ReturnType<typeof createElement> {
      actions = useAceIDActions();
      return createElement('span', null, 'ready');
    }
    await renderClient(createElement(AceIDProvider, { client }, createElement(ActionsProbe)));
    expect(typeof actions?.signIn).toBe('function');
    expect(typeof actions?.signInWithPopup).toBe('function');
    expect(typeof actions?.handlePopupCallback).toBe('function');
    expect(typeof actions?.signOut).toBe('function');
    expect(actions?.logout).toBe(actions?.signOut);
    expect(typeof actions?.refresh).toBe('function');
    expect(typeof actions?.fetchProfile).toBe('function');
  });

  it('gates children behind authentication', async () => {
    const authed = clientWithSession();
    const authenticatedContainer = await renderClient(
      createElement(AceIDProvider, { client: authed },
        createElement(ProtectedRoute, { fallback: createElement('span', null, 'denied') },
          createElement('span', null, 'secret'))),
    );
    expect(authenticatedContainer.textContent).toContain('secret');

    await unmountClient();
    const anonymous = new AID({
      issuer: ISSUER, clientId: 'c', redirectUri: REDIRECT, storage: new MemoryStorage(),
    });
    const anonymousContainer = await renderClient(
      createElement(AceIDProvider, { client: anonymous },
        createElement(ProtectedRoute, { fallback: createElement('span', null, 'denied') },
          createElement('span', null, 'secret'))),
    );
    expect(anonymousContainer.textContent).toContain('denied');
  });

  it('surfaces the precise SDK state', async () => {
    const storage = new MemoryStorage();
    storage.set('aid:session', JSON.stringify({
      ...session(),
      tokens: { ...session().tokens, expiresAt: Date.now() - 1_000 },
    }));
    const client = new AID({ issuer: ISSUER, clientId: 'c', redirectUri: REDIRECT, storage });

    let state: string | undefined;
    function StateProbe(): ReturnType<typeof createElement> {
      state = useAceID().authState?.status;
      return createElement('span', null, state ?? 'none');
    }
    await renderClient(createElement(AceIDProvider, { client }, createElement(StateProbe)));
    expect(state).toBe('expired');
  });
});
