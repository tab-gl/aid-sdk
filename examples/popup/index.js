'use strict';

(() => {
  const status = document.getElementById('status');
  const statusHelp = document.getElementById('status-help');
  const statusDetails = document.getElementById('status-details');
  const statusDetail = document.getElementById('status-detail');
  const profile = document.getElementById('profile');
  const profileLabel = document.getElementById('profile-label');
  const profileCard = document.getElementById('profile-card');
  const popupButton = document.getElementById('popup-sign-in');
  const popupButtonLabel = document.getElementById('popup-button-label');
  const redirectButton = document.getElementById('redirect-sign-in');
  const redirectButtonLabel = document.getElementById('redirect-button-label');
  const signOutButton = document.getElementById('sign-out');
  const config = window.ACE_ID_DEMO_CONFIG;
  let busyMode = null;
  let userInteracted = false;
  let currentAuthStatus = 'unauthenticated';

  function setStatus(message, state, help = '', details = '') {
    status.textContent = message;
    status.dataset.state = state;
    document.getElementById('status-card').dataset.state = state;
    statusHelp.textContent = help;
    statusHelp.hidden = !help;
    statusDetails.hidden = !details;
    statusDetail.textContent = details;
  }

  function setBusy(mode) {
    busyMode = mode;
    const busy = Boolean(mode);
    popupButton.disabled = busy;
    redirectButton.disabled = busy;
    signOutButton.disabled = busy;
    popupButtonLabel.textContent = mode === 'popup' ? 'Waiting for sign-in…' : 'Continue with popup';
    redirectButtonLabel.textContent = mode === 'redirect'
      ? 'Opening your identity provider…'
      : 'Continue with full-page redirect';
    signOutButton.textContent = mode === 'signout' ? 'Signing out…' : 'Sign out';
  }

  function showError(error, context) {
    const detail = error instanceof Error ? error.message : String(error || 'Unknown error');
    const lower = detail.toLowerCase();
    let message;
    let help;

    if (context === 'config') {
      message = 'Sign-in setup needs attention.';
      help = 'Check the issuer, public client ID, and registered callback URIs in the setup guide.';
    } else if (context === 'redirect') {
      message = 'We could not start redirect sign-in.';
      help = 'Check the demo setup, then try again. Popup sign-in is also available.';
    } else if (context === 'signout') {
      message = 'We could not finish sign-out.';
      help = 'Your local session was cleared. You can return to sign-in or retry sign-out.';
    } else if (lower.includes('blocked')) {
      message = 'Your browser blocked the sign-in popup.';
      help = 'Allow popups for this site, or choose full-page redirect below.';
    } else if (lower.includes('closed before authentication')) {
      message = 'The sign-in window was closed before sign-in finished.';
      help = 'No session was created. Try again, or choose full-page redirect below.';
    } else if (lower.includes('timed out')) {
      message = 'Sign-in took too long to finish.';
      help = 'Close any sign-in window that is still open, then try again or use full-page redirect.';
    } else if (lower.includes('no live opener') || lower.includes('opener') || lower.includes('cross-origin')) {
      message = 'The sign-in window could not reconnect to this app.';
      help = 'A browser isolation policy may have interrupted the popup. Close it and use full-page redirect.';
    } else if (lower.includes('access_denied') || lower.includes('cancelled by sign-out')) {
      message = 'Sign-in was cancelled.';
      help = 'No session was created. You can try again whenever you are ready.';
    } else {
      message = 'We could not complete popup sign-in.';
      help = 'Try again, or choose full-page redirect below. Technical details are available here.';
    }

    setStatus(message, 'error', help, detail);
  }

  if (!config || !window.AceID) {
    setStatus(
      'Demo setup is incomplete.',
      'error',
      'Copy examples/popup/.env.example to examples/popup/.env, set your public OIDC client values, then run node examples/popup/configure.mjs from the repository root.',
    );
    popupButton.disabled = true;
    redirectButton.disabled = true;
    signOutButton.hidden = true;
    return;
  }

  const { AID } = window.AceID;
  const popupClient = new AID({
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.popupRedirectUri,
    autoRefresh: true,
  });
  const redirectClient = new AID({
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
  });

  function render(state) {
    currentAuthStatus = state.status;
    const hasSession = Boolean(state.session);
    const isAuthenticated = state.status === 'authenticated';
    const messages = {
      authenticated: ['You’re signed in.', 'Your app session is ready.'],
      unauthenticated: ['Ready to sign in.', 'Choose a sign-in method to continue.'],
      expired: ['Your session has expired.', 'Sign in again to continue, or sign out of this account.'],
      'refresh-failed': ['We could not refresh your session.', 'Sign in again or sign out. See technical details for the refresh error.'],
    };
    const [message, help] = messages[state.status] || messages.unauthenticated;
    const detail = state.status === 'refresh-failed' ? state.error.message : '';

    setStatus(message, state.status, help, detail);
    popupButton.hidden = isAuthenticated;
    redirectButton.hidden = isAuthenticated;
    signOutButton.hidden = !hasSession;
    profileCard.hidden = !hasSession;
    profileLabel.textContent = isAuthenticated ? 'Signed in as' : 'Last known account';
    profile.textContent = hasSession
      ? (state.session.user.name || state.session.user.email || state.session.user.sub)
      : '';
  }

  popupClient.onAuthStateChange(render);

  popupButton.addEventListener('click', async () => {
    userInteracted = true;
    setBusy('popup');
    setStatus(
      'Continue in the sign-in window.',
      'pending',
      'Finish there to return here. Close that window to cancel; this page will then let you retry or use redirect.',
    );
    try {
      await popupClient.signInWithPopup({
        prompt: 'select_account',
        returnTo: config.appUri,
      });
    } catch (error) {
      showError(error, 'popup');
    } finally {
      setBusy(null);
    }
  });

  redirectButton.addEventListener('click', async () => {
    userInteracted = true;
    setBusy('redirect');
    setStatus(
      'Opening your identity provider…',
      'pending',
      'This page will return after sign-in. Use this option on mobile or if popups are restricted.',
    );
    try {
      await redirectClient.signIn({ returnTo: config.appUri });
    } catch (error) {
      showError(error, 'redirect');
    } finally {
      setBusy(null);
    }
  });

  signOutButton.addEventListener('click', async () => {
    userInteracted = true;
    setBusy('signout');
    const signOut = popupClient.signOut({ redirectTo: config.appUri });
    setStatus('Signing you out…', 'pending', 'Your local app session is cleared first.');
    try {
      await signOut;
    } catch (error) {
      showError(error, 'signout');
    } finally {
      setBusy(null);
    }
  });

  void popupClient.validateConfiguration().then((report) => {
    if (!report.ok) {
      const failures = report.checks.filter((check) => check.status === 'fail');
      console.warn('Ace ID configuration checks failed', failures);
      if (!userInteracted && currentAuthStatus !== 'authenticated' && !busyMode) {
        setStatus(
          'Sign-in setup needs attention.',
          'error',
          'Check the issuer, public client ID, and both callback URIs in the setup guide.',
          failures.map((check) => `${check.name}: ${check.message}`).join('\n'),
        );
      }
    }
  }).catch((error) => {
    console.warn('Ace ID configuration check could not complete', error);
    if (!userInteracted && currentAuthStatus !== 'authenticated' && !busyMode) {
      showError(error, 'config');
    }
  });
})();
