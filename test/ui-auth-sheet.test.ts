import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AIDAuthenticationError } from '../src/core/errors.js';
import type { AIDAuthorizationOptions, AIDCallbackResult } from '../src/core/types.js';
import { createAuthSheet } from '../src/ui/index.js';
import type { AuthSheetOptions } from '../src/ui/types.js';

const result: AIDCallbackResult = {
  user: { sub: 'user-123', name: 'Ada Example', email: 'ada@example.test' },
  tokens: { accessToken: 'sdk-access-token', tokenType: 'Bearer' },
};

function createEnvironment() {
  const { window, document } = parseHTML(
    '<html><head><base href="https://app.example.test/"></head><body><button id="trigger">Sign in</button></body></html>',
  );
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const signInWithPopup = vi.fn<(options: AIDAuthorizationOptions & { returnTo?: string }) => Promise<AIDCallbackResult>>(
    async () => result,
  );
  const cancelPopupSignIn = vi.fn<() => boolean>(() => true);
  const popupClient = { signInWithPopup, cancelPopupSignIn } as unknown as AuthSheetOptions['client'];
  const redirectSignIn = vi.fn<(options?: AIDAuthorizationOptions & { returnTo?: string }) => Promise<void>>(
    async () => undefined,
  );
  const redirectClient = { signIn: redirectSignIn } as unknown as AuthSheetOptions['redirectClient'];
  return { window, document, signInWithPopup, cancelPopupSignIn, redirectSignIn, popupClient, redirectClient };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function getButton(document: Document, selector: string): HTMLButtonElement {
  const host = document.querySelector<HTMLElement>('[data-aid-auth-sheet]');
  const button = host?.shadowRoot?.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Could not find auth sheet button ${selector}`);
  return button;
}

const providers: AuthSheetOptions['providers'] = [
  {
    id: 'google',
    label: 'Continue with Google',
    icon: 'google',
    authorizationOptions: { additionalParameters: { kc_idp_hint: 'google' } },
  },
  { id: 'company', label: 'Continue with company SSO', icon: { text: 'SSO' } },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('framework-agnostic authentication sheet', () => {
  it('mounts an accessible Figtree sheet with configurable branding, providers, and theme', () => {
    const env = createEnvironment();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      container: env.document.body as unknown as HTMLElement,
      brand: { name: 'Northstar', eyebrow: 'WORKSPACE' },
      title: 'Sign in to Northstar',
      description: 'Continue to your team workspace.',
      theme: { accent: '#c9f36b', colorScheme: 'dark' },
    });
    const host = env.document.querySelector<HTMLElement>('[data-aid-auth-sheet]');
    const root = host?.shadowRoot;
    expect(root).toBeTruthy();
    expect(host?.hidden).toBe(true);
    expect(host?.dataset.scheme).toBe('dark');
    expect(root?.querySelector('style')?.textContent).toContain('font-family: "Figtree"');
    expect(root?.querySelector('[data-brand-name]')?.textContent).toBe('Northstar');
    expect(root?.querySelector('[data-title]')?.textContent).toBe('Sign in to Northstar');
    expect(root?.querySelectorAll('[data-providers] button')).toHaveLength(2);
    expect(root?.querySelector('input')).toBeNull();
    expect(sheet.state).toBe('idle');

    sheet.open();
    expect(host?.hidden).toBe(false);
    expect(env.document.body.style.overflow).toBe('hidden');
    sheet.close();
    expect(host?.hidden).toBe(true);
    expect(env.document.body.style.overflow).not.toBe('hidden');
    sheet.destroy();
    expect(env.document.querySelector('[data-aid-auth-sheet]')).toBeNull();
  });

  it('uses the SDK popup flow, forwards issuer hints, and exposes the success state', async () => {
    const env = createEnvironment();
    const onSuccess = vi.fn();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      returnTo: '/dashboard',
      container: env.document.body as unknown as HTMLElement,
      onSuccess,
    });
    sheet.open();
    getButton(env.document, '[data-provider="google"]').click();
    await flushAsyncWork();

    expect(env.signInWithPopup).toHaveBeenCalledWith({
      additionalParameters: { kc_idp_hint: 'google' },
      returnTo: '/dashboard',
    });
    expect(env.redirectSignIn).not.toHaveBeenCalled();
    expect(sheet.state).toBe('success');
    expect(onSuccess).toHaveBeenCalledWith(result);
    expect(getButton(env.document, '[data-done]').hidden).toBe(false);
    sheet.destroy();
  });

  it('falls back to the redirect client when the SDK reports a blocked popup', async () => {
    const env = createEnvironment();
    const blocked = new AIDAuthenticationError(
      'Popup blocked',
      undefined,
      { details: { reason: 'popup_blocked' } },
    );
    env.signInWithPopup.mockRejectedValue(blocked);
    let finishRedirect!: () => void;
    env.redirectSignIn.mockImplementation(() => new Promise<void>((resolve) => { finishRedirect = resolve; }));
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      returnTo: '/after-login',
      container: env.document.body as unknown as HTMLElement,
    });
    sheet.open();
    getButton(env.document, '[data-provider="google"]').click();
    await flushAsyncWork();

    expect(env.redirectSignIn).toHaveBeenCalledWith({
      additionalParameters: { kc_idp_hint: 'google' },
      returnTo: '/after-login',
    });
    expect(sheet.state).toBe('loading');
    expect(getButton(env.document, '[data-close]').disabled).toBe(true);
    finishRedirect();
    sheet.destroy();
  });

  it('uses redirect authentication on narrow mobile viewports by default', async () => {
    const env = createEnvironment();
    Object.defineProperty(env.window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      container: env.document.body as unknown as HTMLElement,
    });
    sheet.open();
    getButton(env.document, '[data-provider="company"]').click();
    await flushAsyncWork();

    expect(env.redirectSignIn).toHaveBeenCalledWith({});
    expect(env.signInWithPopup).not.toHaveBeenCalled();
    expect(sheet.state).toBe('loading');
    sheet.destroy();
  });

  it('renders a non-sensitive error state and allows retry', async () => {
    const env = createEnvironment();
    const networkError = Object.assign(new Error('private transport detail'), { code: 'NETWORK_ERROR' });
    env.signInWithPopup.mockRejectedValueOnce(networkError).mockResolvedValue(result);
    const onError = vi.fn();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      container: env.document.body as unknown as HTMLElement,
      onError,
    });
    sheet.open();
    const providerButton = getButton(env.document, '[data-provider="google"]');
    providerButton.click();
    await flushAsyncWork();

    expect(sheet.state).toBe('error');
    expect(getButton(env.document, '[data-error]').hidden).toBe(false);
    expect(env.document.querySelector('[data-aid-auth-sheet]')?.shadowRoot?.querySelector('[data-error-text]')?.textContent)
      .toContain('connection was interrupted');
    expect(env.document.querySelector('[data-aid-auth-sheet]')?.shadowRoot?.querySelector('[data-error-text]')?.textContent)
      .not.toContain('private transport detail');
    expect(onError).toHaveBeenCalledWith(networkError);
    expect(providerButton.disabled).toBe(false);

    providerButton.click();
    await flushAsyncWork();
    expect(sheet.state).toBe('success');
    sheet.destroy();
  });

  it('surfaces cancellation and allows another provider attempt', async () => {
    const env = createEnvironment();
    let rejectPopup!: (reason: unknown) => void;
    env.signInWithPopup.mockImplementation(() => new Promise<AIDCallbackResult>((_resolve, reject) => {
      rejectPopup = reject;
    }));
    env.cancelPopupSignIn.mockImplementation(() => {
      rejectPopup(new AIDAuthenticationError(
        'Cancelled',
        undefined,
        { details: { reason: 'user_cancelled' } },
      ));
      return true;
    });
    const onCancel = vi.fn();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      container: env.document.body as unknown as HTMLElement,
      onCancel,
    });
    sheet.open();
    getButton(env.document, '[data-provider="google"]').click();
    expect(sheet.state).toBe('loading');
    getButton(env.document, '[data-cancel]').click();
    await flushAsyncWork();

    expect(sheet.state).toBe('cancelled');
    expect(onCancel).toHaveBeenCalledWith('user_cancelled');
    expect(env.document.querySelector('[data-aid-auth-sheet]')?.shadowRoot?.querySelector('[data-feedback-text]')?.textContent)
      .toContain('Sign-in was cancelled');
    expect(getButton(env.document, '[data-provider="company"]').disabled).toBe(false);
    sheet.destroy();
  });

  it('renders an issuer access-denied response as a cancellation state', async () => {
    const env = createEnvironment();
    const accessDenied = Object.assign(new Error('issuer access denied'), {
      code: 'CALLBACK_ERROR',
      details: { reason: 'provider_cancelled' },
    });
    env.signInWithPopup.mockRejectedValue(accessDenied);
    const onCancel = vi.fn();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      container: env.document.body as unknown as HTMLElement,
      onCancel,
    });
    sheet.open();
    getButton(env.document, '[data-provider="google"]').click();
    await flushAsyncWork();

    expect(sheet.state).toBe('cancelled');
    expect(onCancel).toHaveBeenCalledWith('provider_cancelled');
    expect(env.document.querySelector('[data-aid-auth-sheet]')?.shadowRoot?.querySelector('[data-feedback-text]')?.textContent)
      .toContain('cancelled by your provider');
    sheet.destroy();
  });

  it('cancels an active popup when the sheet is closed and releases document scroll', async () => {
    const env = createEnvironment();
    let rejectPopup!: (reason: unknown) => void;
    env.signInWithPopup.mockImplementation(() => new Promise<AIDCallbackResult>((_resolve, reject) => {
      rejectPopup = reject;
    }));
    const onCancel = vi.fn();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      container: env.document.body as unknown as HTMLElement,
      onCancel,
    });
    sheet.open();
    getButton(env.document, '[data-provider="google"]').click();
    expect(env.document.body.style.overflow).toBe('hidden');
    sheet.close();
    expect(env.cancelPopupSignIn).toHaveBeenCalledTimes(1);
    expect(env.document.body.style.overflow).not.toBe('hidden');
    expect(env.document.querySelector<HTMLElement>('[data-aid-auth-sheet]')?.hidden).toBe(true);
    rejectPopup(new AIDAuthenticationError('Cancelled', undefined, { details: { reason: 'user_cancelled' } }));
    await flushAsyncWork();
    expect(onCancel).toHaveBeenCalledWith('user_cancelled');
    sheet.destroy();
  });

  it('uses textContent for user-provided copy and rejects unsafe image URLs and theme values', () => {
    const env = createEnvironment();
    const sheet = createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers: [{ id: 'custom', label: '<img src=x onerror=alert(1)>', icon: { text: '<b>' } }],
      container: env.document.body as unknown as HTMLElement,
    });
    const root = env.document.querySelector<HTMLElement>('[data-aid-auth-sheet]')?.shadowRoot;
    expect(root?.querySelector('[data-providers] img')).toBeNull();
    expect(root?.querySelector('[data-providers] button')?.textContent).toContain('<img src=x onerror=alert(1)>');
    sheet.destroy();

    expect(() => createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers: [{ id: 'custom', label: 'Continue', icon: { src: 'javascript:alert(1)' } }],
      container: env.document.body as unknown as HTMLElement,
    })).toThrow(/must use HTTPS|same-origin HTTP/);

    expect(() => createAuthSheet({
      client: env.popupClient,
      redirectClient: env.redirectClient,
      providers,
      theme: { accent: 'red; background: url(https://example.test)' },
      container: env.document.body as unknown as HTMLElement,
    })).toThrow(/CSS color/);
  });
});
