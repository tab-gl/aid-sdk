import type { AIDAuthorizationOptions } from '../core/types.js';
import { AUTH_SHEET_STYLES } from './styles.js';
import type {
  AuthSheetCancelReason,
  AuthSheetController,
  AuthSheetOptions,
  AuthSheetProvider,
  AuthSheetProviderIcon,
  AuthSheetState,
  AuthSheetTheme,
  CreateAuthSheetOptions,
} from './types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BUILT_IN_ICONS = new Set(['google', 'apple', 'microsoft', 'github', 'email', 'key']);
const DEFAULT_FOOTER = 'Sign-in is completed by your identity provider. This sheet never asks for your password.';
let nextSheetId = 0;

const SCROLL_LOCKS = new WeakMap<Document, { count: number; previousOverflow: string }>();

const STATIC_MARKUP = `
  <style>${AUTH_SHEET_STYLES}</style>
  <div class="backdrop" data-backdrop>
    <section class="frame" data-dialog role="dialog" aria-modal="true" tabindex="-1">
      <div class="surface">
        <header class="header">
          <div class="brand-row">
            <span class="brand-mark" data-brand-mark aria-hidden="true">
              <span class="brand-mark__pixels"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
            </span>
            <span class="brand-copy">
              <span class="brand-name" data-brand-name></span>
              <span class="brand-eyebrow" data-brand-eyebrow></span>
            </span>
          </div>
          <span class="secure-chip" aria-hidden="true"><span class="secure-chip__dot"></span>Secure access</span>
          <button class="close-button" data-close type="button" aria-label="Close sign-in">×</button>
          <p class="kicker">IDENTITY ACCESS / 01</p>
          <h1 data-title></h1>
          <p class="description" data-description></p>
        </header>
        <div class="provider-heading" aria-hidden="true"><span>Choose a provider</span><span class="provider-heading__line"></span><span data-provider-count></span></div>
        <div class="providers" data-providers></div>
        <div class="feedback" data-feedback role="status" aria-live="polite" tabindex="-1" hidden>
          <span class="feedback__icon" data-feedback-icon aria-hidden="true"></span>
          <p class="feedback__text" data-feedback-text></p>
        </div>
        <div class="error-message" data-error role="alert" hidden>
          <span class="feedback__icon" aria-hidden="true">!</span>
          <p class="error-message__text" data-error-text></p>
        </div>
        <button class="cancel-button" data-cancel type="button" hidden>Cancel sign-in</button>
        <button class="done-button" data-done type="button" hidden>Done</button>
        <div class="trust-note">
          <span class="trust-note__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5 19 6v5.7c0 4.2-2.7 7.2-7 9.1-4.3-1.9-7-4.9-7-9.1V6l7-2.5Z" stroke="currentColor" stroke-width="1.7"/><path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="square"/></svg>
          </span>
          <p data-trust></p>
        </div>
        <footer class="footer" data-footer></footer>
      </div>
    </section>
  </div>
`;

const BUILT_IN_ICON_PATHS: Record<string, string> = {
  apple: 'M16.9 12.9c0-2 1.6-3 1.7-3.1-.9-1.3-2.3-1.5-2.8-1.5-1.2-.1-2.3.7-2.9.7-.6 0-1.5-.7-2.5-.7-1.3 0-2.5.8-3.2 1.9-1.4 2.3-.4 5.7 1 7.6.6.9 1.4 1.9 2.4 1.9 1 0 1.3-.6 2.5-.6s1.5.6 2.5.6 1.7-.9 2.3-1.8c.7-1 1-2.1 1.1-2.2-.1 0-2.1-.8-2.1-2.8ZM15 6.8c.5-.6.9-1.5.8-2.3-.8 0-1.7.5-2.2 1.1-.5.5-.9 1.4-.8 2.2.8.1 1.7-.4 2.2-1Z',
  github: 'M12 .9a11.1 11.1 0 0 0-3.5 21.6c.6.1.8-.2.8-.5v-2c-3.1.7-3.8-1.3-3.8-1.3-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 .1.7 2.1 3.9 1.5.1-.7.4-1.2.7-1.5-2.5-.3-5.1-1.2-5.1-5.5 0-1.2.4-2.1 1.1-2.9-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10.3 10.3 0 0 1 5.5 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.7 1.1 2.9 0 4.3-2.6 5.2-5.1 5.5.4.3.8 1 .8 2v3c0 .3.2.6.8.5A11.1 11.1 0 0 0 12 .9Z',
};

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Auth sheet markup is missing ${selector}`);
  return element as T;
}

function cloneAuthorizationOptions(options?: AIDAuthorizationOptions): AIDAuthorizationOptions | undefined {
  if (!options) return undefined;
  return {
    ...(options.prompt !== undefined ? { prompt: Array.isArray(options.prompt) ? [...options.prompt] : options.prompt } : {}),
    ...(options.loginHint !== undefined ? { loginHint: options.loginHint } : {}),
    ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
    ...(options.acrValues !== undefined ? { acrValues: [...options.acrValues] } : {}),
    ...(options.uiLocales !== undefined ? { uiLocales: [...options.uiLocales] } : {}),
    ...(options.additionalParameters !== undefined
      ? { additionalParameters: { ...options.additionalParameters } }
      : {}),
  };
}

function normalizeProviders(providers: readonly AuthSheetProvider[]): AuthSheetProvider[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new TypeError('Auth sheet requires at least one provider button');
  }
  const seen = new Set<string>();
  return providers.map((provider, index) => {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError(`Auth sheet provider at index ${index} must be an object`);
    }
    const id = typeof provider.id === 'string' ? provider.id.trim() : '';
    const label = typeof provider.label === 'string' ? provider.label.trim() : '';
    if (!id || id.length > 100) throw new TypeError(`Auth sheet provider at index ${index} needs a short, non-empty id`);
    if (seen.has(id)) throw new TypeError(`Auth sheet provider id "${id}" is duplicated`);
    if (!label || label.length > 120) throw new TypeError(`Auth sheet provider "${id}" needs a short, non-empty label`);
    seen.add(id);
    return {
      id,
      label,
      ...(provider.icon !== undefined ? { icon: provider.icon } : {}),
      ...(provider.authorizationOptions
        ? { authorizationOptions: cloneAuthorizationOptions(provider.authorizationOptions) }
        : {}),
    };
  });
}

function validateColor(value: string, name: string, documentRef: Document): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || /[;{}<>]/.test(normalized)) {
    throw new TypeError(`Auth sheet theme "${name}" must be a CSS color`);
  }
  const css = documentRef.defaultView?.CSS;
  if (css?.supports && !css.supports('color', normalized)) {
    throw new TypeError(`Auth sheet theme "${name}" is not a supported CSS color`);
  }
  if (!css?.supports && !(
    /^#[\da-f]{3,8}$/i.test(normalized) ||
    /^(?:transparent|currentcolor|[a-z]{1,24})$/i.test(normalized) ||
    /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([\w\s,.%+\-/]+\)$/i.test(normalized) ||
    /^var\(--[\w-]+\)$/i.test(normalized)
  )) {
    throw new TypeError(`Auth sheet theme "${name}" must be a CSS color`);
  }
  return normalized;
}

function applyTheme(host: HTMLElement, theme: AuthSheetTheme | undefined, documentRef: Document): void {
  if (theme?.colorScheme !== undefined && theme.colorScheme !== 'light' && theme.colorScheme !== 'dark') {
    throw new TypeError('Auth sheet theme colorScheme must be "light" or "dark"');
  }
  host.dataset.scheme = theme?.colorScheme ?? 'light';
  const variables: Array<[keyof AuthSheetTheme, string]> = [
    ['accent', '--aid-accent'],
    ['accentForeground', '--aid-accent-text'],
    ['background', '--aid-surface'],
    ['foreground', '--aid-text'],
    ['muted', '--aid-muted'],
    ['border', '--aid-border'],
    ['subtleBorder', '--aid-border-soft'],
    ['danger', '--aid-danger'],
    ['success', '--aid-success'],
    ['focus', '--aid-focus'],
  ];
  for (const [option, variable] of variables) {
    const value = theme?.[option];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new TypeError(`Auth sheet theme "${option}" must be a CSS color`);
    host.style.setProperty(variable, validateColor(value, option, documentRef));
  }
}

function safeImageUrl(source: string, documentRef: Document, label: string): string {
  if (typeof source !== 'string' || source.length === 0 || source.length > 2048) {
    throw new TypeError(`${label} URL must be between 1 and 2048 characters`);
  }
  let url: URL;
  try {
    url = new URL(source, documentRef.baseURI);
  } catch {
    throw new TypeError(`${label} URL is invalid`);
  }
  const pageOrigin = documentRef.location?.origin;
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && url.origin === pageOrigin);
  if (!secure || url.username || url.password) {
    throw new TypeError(`${label} URL must use HTTPS or be a same-origin HTTP URL`);
  }
  return url.toString();
}

function iconForProvider(provider: AuthSheetProvider): AuthSheetProviderIcon {
  if (provider.icon !== undefined) return provider.icon;
  const inferred = provider.id.toLowerCase();
  if (BUILT_IN_ICONS.has(inferred)) return inferred as AuthSheetProviderIcon;
  const first = provider.label.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?';
  return { text: first.toUpperCase() };
}

function appendSvgIcon(container: HTMLElement, name: string, documentRef: Document): void {
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  if (name === 'google') {
    const text = documentRef.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '3');
    text.setAttribute('y', '20');
    text.setAttribute('font-size', '22');
    text.setAttribute('font-family', 'Arial, sans-serif');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', '#4285F4');
    text.textContent = 'G';
    svg.append(text);
  } else if (name === 'microsoft') {
    const colors = ['#f25022', '#7fba00', '#00a4ef', '#ffb900'];
    const positions = [[2, 2], [13, 2], [2, 13], [13, 13]];
    for (let index = 0; index < positions.length; index += 1) {
      const [x, y] = positions[index] as [number, number];
      const square = documentRef.createElementNS(SVG_NS, 'rect');
      square.setAttribute('x', String(x));
      square.setAttribute('y', String(y));
      square.setAttribute('width', '9');
      square.setAttribute('height', '9');
      square.setAttribute('fill', colors[index] as string);
      svg.append(square);
    }
  } else if (name === 'email') {
    const path = documentRef.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M3 5.5h18v13H3zM3.5 6l8.5 7 8.5-7');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'miter');
    svg.append(path);
  } else if (name === 'key') {
    const path = documentRef.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M14.5 4a5.5 5.5 0 1 0 4.9 8l2.6 2.6v2.9h-3v-2h-2v-2h-1.8A5.5 5.5 0 0 0 14.5 4Zm-7 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z');
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  } else {
    const path = documentRef.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', BUILT_IN_ICON_PATHS[name] ?? '');
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  container.append(svg);
}

function appendProviderIcon(
  container: HTMLElement,
  icon: AuthSheetProviderIcon,
  documentRef: Document,
): void {
  if (typeof icon === 'string') {
    if (!BUILT_IN_ICONS.has(icon)) throw new TypeError(`Unsupported built-in provider icon "${icon}"`);
    appendSvgIcon(container, icon, documentRef);
    return;
  }
  if (!icon || typeof icon !== 'object') throw new TypeError('Provider icon must be a built-in name, text mark, or image URL');
  if ('text' in icon) {
    if (typeof icon.text !== 'string') throw new TypeError('Text provider icons must be strings');
    const mark = documentRef.createElement('span');
    mark.className = 'provider-button__text-mark';
    mark.textContent = icon.text.trim().slice(0, 3) || '?';
    container.append(mark);
    return;
  }
  if ('src' in icon && typeof icon.src === 'string') {
    const image = documentRef.createElement('img');
    image.src = safeImageUrl(icon.src, documentRef, 'Provider icon');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    container.append(image);
    return;
  }
  throw new TypeError('Provider icon must be a built-in name, text mark, or image URL');
}

function errorFields(error: unknown): { code?: string; reason?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { code?: unknown; details?: unknown };
  const details = value.details && typeof value.details === 'object'
    ? value.details as { reason?: unknown }
    : undefined;
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof details?.reason === 'string' ? { reason: details.reason } : {}),
  };
}

function friendlyError(error: unknown): string {
  const { code } = errorFields(error);
  if (code === 'DISCOVERY_ERROR') return 'We could not reach your identity provider. Check your connection and try again.';
  if (code === 'NETWORK_ERROR') return 'Your connection was interrupted. Check your network and try again.';
  if (code === 'CALLBACK_ERROR' || code === 'TOKEN_ERROR') {
    return 'The sign-in response could not be verified. Please try again or contact your administrator.';
  }
  if (code === 'CONFIGURATION_ERROR') return 'This sign-in method is not available right now. Please contact your administrator.';
  return 'We could not complete sign-in. Please try again or choose another provider.';
}

function invokeSafely<Args extends unknown[]>(
  callback: ((...args: Args) => unknown) | undefined,
  ...args: Args
): void {
  if (!callback) return;
  try {
    const result = callback(...args);
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch { /* application callbacks must not corrupt the SDK flow */ }
}

function lockBodyScroll(documentRef: Document): void {
  const body = documentRef.body;
  if (!body) return;
  const existing = SCROLL_LOCKS.get(documentRef);
  if (existing) {
    existing.count += 1;
    return;
  }
  SCROLL_LOCKS.set(documentRef, { count: 1, previousOverflow: body.style.overflow });
  body.style.overflow = 'hidden';
}

function unlockBodyScroll(documentRef: Document): void {
  const lock = SCROLL_LOCKS.get(documentRef);
  if (!lock) return;
  lock.count -= 1;
  if (lock.count > 0) return;
  const body = documentRef.body;
  if (body) body.style.overflow = lock.previousOverflow;
  SCROLL_LOCKS.delete(documentRef);
}

class AuthSheet implements AuthSheetController {
  private readonly documentRef: Document;
  private readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly dialog: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly doneButton: HTMLButtonElement;
  private readonly feedback: HTMLElement;
  private readonly feedbackIcon: HTMLElement;
  private readonly feedbackText: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly providerButtons: Array<{ provider: AuthSheetProvider; button: HTMLButtonElement }> = [];
  private readonly cleanups: Array<() => void> = [];
  private readonly options: AuthSheetOptions;
  private isOpen = false;
  private isDestroyed = false;
  private redirecting = false;
  private currentState: AuthSheetState = 'idle';
  private previousFocus: HTMLElement | null = null;

  constructor(options: CreateAuthSheetOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('createAuthSheet requires an options object');
    if (!options.client || typeof options.client.signInWithPopup !== 'function' ||
        typeof options.client.cancelPopupSignIn !== 'function') {
      throw new TypeError('Auth sheet client must be an AID popup client');
    }
    if (!options.redirectClient || typeof options.redirectClient.signIn !== 'function') {
      throw new TypeError('Auth sheet requires an AID redirect client');
    }
    this.documentRef = options.container?.ownerDocument ?? globalThis.document;
    if (!this.documentRef) throw new Error('createAuthSheet requires a browser document');
    this.options = {
      ...options,
      providers: normalizeProviders(options.providers),
    };

    this.host = this.documentRef.createElement('div');
    this.host.setAttribute('data-aid-auth-sheet', '');
    this.host.setAttribute('aria-hidden', 'true');
    this.host.hidden = true;
    applyTheme(this.host, options.theme, this.documentRef);
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = STATIC_MARKUP;

    this.dialog = query(this.shadow, '[data-dialog]');
    this.backdrop = query(this.shadow, '[data-backdrop]');
    this.closeButton = query(this.shadow, '[data-close]');
    this.cancelButton = query(this.shadow, '[data-cancel]');
    this.doneButton = query(this.shadow, '[data-done]');
    this.feedback = query(this.shadow, '[data-feedback]');
    this.feedbackIcon = query(this.shadow, '[data-feedback-icon]');
    this.feedbackText = query(this.shadow, '[data-feedback-text]');
    this.errorBox = query(this.shadow, '[data-error]');
    this.errorText = query(this.shadow, '[data-error-text]');

    const id = `aid-auth-sheet-${++nextSheetId}`;
    const title = query<HTMLElement>(this.shadow, '[data-title]');
    title.id = `${id}-title`;
    this.dialog.setAttribute('aria-labelledby', title.id);
    const description = query<HTMLElement>(this.shadow, '[data-description]');
    description.id = `${id}-description`;
    this.dialog.setAttribute('aria-describedby', description.id);
    title.textContent = options.title ?? 'Welcome back.';
    description.textContent = options.description ?? 'Choose a sign-in method to continue to your account.';
    this.configureBrand(options);
    this.configureProviders(this.options.providers);
    query<HTMLElement>(this.shadow, '[data-provider-count]').textContent = String(this.options.providers.length).padStart(2, '0');
    query<HTMLElement>(this.shadow, '[data-trust]').textContent =
      options.footerText === undefined ? DEFAULT_FOOTER : options.footerText;
    const footer = query<HTMLElement>(this.shadow, '[data-footer]');
    footer.textContent = 'SECURE AUTHENTICATION · PKCE PROTECTED';
    if (options.footerText === '') query(this.shadow, '.trust-note').setAttribute('hidden', '');

    this.register(this.closeButton, 'click', () => this.close());
    this.register(this.cancelButton, 'click', () => { this.options.client.cancelPopupSignIn(); });
    this.register(this.doneButton, 'click', () => this.close());
    this.register(this.backdrop, 'click', (event) => {
      if (event.target === this.backdrop && !this.redirecting) this.close();
    });

    const container = options.container ?? this.documentRef.body ?? this.documentRef.documentElement;
    container.append(this.host);
    this.setState('idle');
  }

  get state(): AuthSheetState {
    return this.currentState;
  }

  open(): void {
    if (this.isDestroyed || this.isOpen) return;
    this.setState('idle');
    const activeElement = this.documentRef.activeElement as HTMLElement | null;
    this.previousFocus = activeElement && typeof activeElement.focus === 'function' ? activeElement : null;
    this.isOpen = true;
    this.host.hidden = false;
    this.host.setAttribute('aria-hidden', 'false');
    lockBodyScroll(this.documentRef);
    this.documentRef.addEventListener('keydown', this.onKeyDown, true);
    const firstProvider = this.providerButtons[0]?.button;
    (firstProvider ?? this.dialog).focus();
  }

  close(): void {
    if (!this.isOpen || this.redirecting) return;
    if (this.currentState === 'loading') this.options.client.cancelPopupSignIn();
    this.hide();
  }

  destroy(): void {
    if (this.isDestroyed) return;
    if (this.isOpen) {
      if (this.currentState === 'loading' && !this.redirecting) this.options.client.cancelPopupSignIn();
      this.hide();
    }
    this.isDestroyed = true;
    this.documentRef.removeEventListener('keydown', this.onKeyDown, true);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.host.remove();
  }

  private hide(): void {
    this.isOpen = false;
    this.host.hidden = true;
    this.host.setAttribute('aria-hidden', 'true');
    this.documentRef.removeEventListener('keydown', this.onKeyDown, true);
    unlockBodyScroll(this.documentRef);
    const target = this.previousFocus;
    this.previousFocus = null;
    if (target?.isConnected) target.focus();
  }

  private configureBrand(options: CreateAuthSheetOptions): void {
    const brandName = options.brand?.name?.trim() || 'Ace ID';
    query<HTMLElement>(this.shadow, '[data-brand-name]').textContent = brandName;
    query<HTMLElement>(this.shadow, '[data-brand-eyebrow]').textContent = options.brand?.eyebrow?.trim() || 'SECURE SIGN-IN';
    if (options.brand?.logoUrl) {
      const mark = query<HTMLElement>(this.shadow, '[data-brand-mark]');
      mark.replaceChildren();
      const image = this.documentRef.createElement('img');
      image.src = safeImageUrl(options.brand.logoUrl, this.documentRef, 'Brand logo');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      mark.append(image);
    }
  }

  private configureProviders(providers: readonly AuthSheetProvider[]): void {
    const list = query<HTMLElement>(this.shadow, '[data-providers]');
    for (const provider of providers) {
      const button = this.documentRef.createElement('button');
      button.className = 'provider-button';
      button.type = 'button';
      button.dataset.provider = provider.id;
      button.setAttribute('aria-label', provider.label);

      const icon = this.documentRef.createElement('span');
      icon.className = 'provider-button__icon';
      icon.setAttribute('aria-hidden', 'true');
      appendProviderIcon(icon, iconForProvider(provider), this.documentRef);
      const label = this.documentRef.createElement('span');
      label.className = 'provider-button__text';
      label.textContent = provider.label;
      const spinner = this.documentRef.createElement('span');
      spinner.className = 'provider-button__spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const arrow = this.documentRef.createElement('span');
      arrow.className = 'provider-button__arrow';
      arrow.textContent = '↗';
      arrow.setAttribute('aria-hidden', 'true');
      button.append(icon, label, spinner, arrow);
      list.append(button);
      this.providerButtons.push({ provider, button });
      this.register(button, 'click', () => { void this.signIn(provider); });
    }
  }

  private register<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    element.addEventListener(type, listener as EventListener);
    this.cleanups.push(() => element.removeEventListener(type, listener as EventListener));
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      if (this.redirecting) return;
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(this.dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      .filter((element) => !element.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      this.feedback.focus();
      return;
    }
    const active = this.shadow.activeElement;
    const first = focusable[0] as HTMLButtonElement;
    const last = focusable[focusable.length - 1] as HTMLButtonElement;
    if (event.shiftKey && (active === first || !focusable.includes(active as HTMLButtonElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !focusable.includes(active as HTMLButtonElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  private shouldRedirectOnMobile(): boolean {
    if (this.options.mobileAuth === 'popup') return false;
    const view = this.documentRef.defaultView;
    try {
      const query = view?.matchMedia?.('(max-width: 620px)');
      if (query) return query.matches;
    } catch { /* use the viewport fallback */ }
    return (view?.innerWidth ?? 1024) <= 620;
  }

  private async signIn(provider: AuthSheetProvider): Promise<void> {
    if (this.isDestroyed || this.currentState === 'loading' || this.currentState === 'success') return;
    const authorizationOptions = {
      ...(cloneAuthorizationOptions(provider.authorizationOptions) ?? {}),
      ...(this.options.returnTo !== undefined ? { returnTo: this.options.returnTo } : {}),
    };
    if (this.shouldRedirectOnMobile()) {
      await this.startRedirect(authorizationOptions, 'Opening sign-in securely in this tab…');
      return;
    }

    this.redirecting = false;
    this.setState('loading', 'Opening a secure sign-in window…', provider.id);
    try {
      const result = await this.options.client.signInWithPopup(authorizationOptions);
      if (this.isDestroyed) return;
      this.setState('success', 'You are signed in. Your account is ready.');
      invokeSafely(this.options.onSuccess, result);
    } catch (error) {
      if (this.isDestroyed) return;
      const { code, reason } = errorFields(error);
      const popupUnavailable = code === 'CONFIGURATION_ERROR' && reason === 'popup_unavailable';
      if ((code === 'AUTHENTICATION_ERROR' && reason === 'popup_blocked') || popupUnavailable) {
        await this.startRedirect(authorizationOptions, 'Pop-up blocked. Continuing securely in this tab…');
        return;
      }
      this.showFailure(error);
    }
  }

  private async startRedirect(
    authorizationOptions: AIDAuthorizationOptions & { returnTo?: string },
    status: string,
  ): Promise<void> {
    this.redirecting = true;
    this.setState('loading', status);
    try {
      await this.options.redirectClient.signIn(authorizationOptions);
    } catch (error) {
      if (this.isDestroyed) return;
      this.redirecting = false;
      this.showFailure(error);
    }
  }

  private showFailure(error: unknown): void {
    const { code, reason } = errorFields(error);
    this.redirecting = false;
    const cancelledByUser = code === 'AUTHENTICATION_ERROR' &&
      (reason === 'popup_closed' || reason === 'user_cancelled');
    const cancelledAtProvider = code === 'CALLBACK_ERROR' && reason === 'provider_cancelled';
    if (cancelledByUser || cancelledAtProvider) {
      const message = reason === 'popup_closed'
        ? 'Sign-in was cancelled. Close the sign-in window or try again whenever you are ready.'
        : reason === 'provider_cancelled'
          ? 'Sign-in was cancelled by your provider. You can try again whenever you are ready.'
          : 'Sign-in was cancelled. You can try again whenever you are ready.';
      this.setState('cancelled', message);
      invokeSafely(this.options.onCancel, reason as AuthSheetCancelReason);
      return;
    }
    this.setState('error', friendlyError(error));
    invokeSafely(this.options.onError, error);
  }

  private setState(state: AuthSheetState, message?: string, selectedProvider?: string): void {
    this.currentState = state;
    this.dialog.dataset.state = state;
    const hasFeedback = state === 'loading' || state === 'success' || state === 'cancelled';
    this.feedback.hidden = !hasFeedback;
    this.errorBox.hidden = state !== 'error';
    this.cancelButton.hidden = state !== 'loading' || this.redirecting;
    this.doneButton.hidden = state !== 'success';
    this.closeButton.disabled = state === 'loading' && this.redirecting;
    this.closeButton.setAttribute(
      'aria-label',
      state === 'loading' && !this.redirecting ? 'Close sign-in and cancel' : 'Close sign-in',
    );
    this.feedback.dataset.tone = state;
    this.feedbackText.textContent = message ?? '';
    this.errorText.textContent = state === 'error' ? message ?? '' : '';
    this.feedbackIcon.textContent = state === 'success' ? '✓' : state === 'cancelled' ? '↺' : '';
    for (const { provider, button } of this.providerButtons) {
      button.disabled = state === 'loading' || state === 'success';
      button.setAttribute('aria-busy', String(state === 'loading' && provider.id === selectedProvider));
      button.dataset.pending = String(state === 'loading' && provider.id === selectedProvider);
    }
    if (state === 'loading' && this.redirecting) this.feedback.focus();
    else if (state === 'success') this.doneButton.focus();
  }
}

/**
 * Mount the framework-agnostic Ace ID authentication sheet.
 *
 * The UI calls only the existing AID client's popup and redirect APIs; it never
 * collects a password or handles authorization codes or tokens itself.
 */
export function createAuthSheet(options: CreateAuthSheetOptions): AuthSheetController {
  return new AuthSheet(options);
}
