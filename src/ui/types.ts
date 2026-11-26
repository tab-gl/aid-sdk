import type { AID } from '../browser/client.js';
import type { AIDAuthorizationOptions, AIDCallbackResult } from '../core/types.js';

/** A built-in icon, a small text mark, or a URL for a custom provider image. */
export type AuthSheetProviderIcon =
  | 'google'
  | 'apple'
  | 'microsoft'
  | 'github'
  | 'email'
  | 'key'
  | { text: string }
  | { src: string };

/** One identity-provider choice rendered as a sharp-edged sheet button. */
export interface AuthSheetProvider {
  /** Stable, unique provider key (for example, `google` or `company-sso`). */
  id: string;
  /** Visible button label. Use action-oriented copy such as `Continue with Google`. */
  label: string;
  /** Defaults to a built-in icon matching `id`, or a text mark from the label. */
  icon?: AuthSheetProviderIcon;
  /** OIDC hints forwarded unchanged to the SDK; provider-specific hints belong in `additionalParameters`. */
  authorizationOptions?: AIDAuthorizationOptions;
}

/** Color overrides for the built-in light or dark palette. Values should be CSS colors. */
export interface AuthSheetTheme {
  colorScheme?: 'light' | 'dark';
  accent?: string;
  accentForeground?: string;
  background?: string;
  foreground?: string;
  muted?: string;
  border?: string;
  subtleBorder?: string;
  danger?: string;
  success?: string;
  focus?: string;
}

/** Brand details shown above the provider choices. */
export interface AuthSheetBrand {
  name?: string;
  /** HTTPS or same-origin image URL. The image is decorative; text remains the accessible brand name. */
  logoUrl?: string;
  eyebrow?: string;
}

export type AuthSheetState = 'idle' | 'loading' | 'error' | 'cancelled' | 'success';
export type AuthSheetCancelReason = 'popup_closed' | 'user_cancelled' | 'provider_cancelled';

/** Framework-agnostic authentication sheet configuration. */
export interface AuthSheetOptions {
  /** Client registered with the popup callback route. */
  client: Pick<AID, 'signInWithPopup' | 'cancelPopupSignIn'>;
  /** Client registered with the top-level redirect callback route; share storage with `client`. */
  redirectClient: Pick<AID, 'signIn'>;
  providers: readonly AuthSheetProvider[];
  brand?: AuthSheetBrand;
  /** Sheet headline. Defaults to `Welcome back.` */
  title?: string;
  /** Supporting copy beneath the headline. */
  description?: string;
  /** Validated by the SDK and returned from the callback; never navigated to by the sheet. */
  returnTo?: string;
  theme?: AuthSheetTheme;
  /** Mobile defaults to top-level redirect; desktop defaults to popup with blocked-popup fallback. */
  mobileAuth?: 'redirect' | 'popup';
  /** Small-print copy at the bottom of the sheet. */
  footerText?: string;
  onSuccess?: (result: AIDCallbackResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
  onCancel?: (reason: AuthSheetCancelReason) => void;
}

/** Handle returned by {@link createAuthSheet}. */
export interface AuthSheetController {
  /** Show the sheet and move focus into it. */
  open(): void;
  /** Hide the sheet and cancel an active popup. Closing is paused while a top-level redirect is starting. */
  close(): void;
  /** Unmount the sheet and release listeners and document scroll state. */
  destroy(): void;
  /** Current UI state. */
  readonly state: AuthSheetState;
}

export type AuthSheetContainer = HTMLElement;

/** Options accepted by {@link createAuthSheet}. */
export type CreateAuthSheetOptions = AuthSheetOptions & {
  /** Mount target. Defaults to the current document body. */
  container?: AuthSheetContainer;
};
