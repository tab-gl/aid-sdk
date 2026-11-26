'use strict';

(() => {
  const status = document.getElementById('status');
  const statusCard = document.getElementById('status-card');
  const profile = document.getElementById('profile');
  const profileCard = document.getElementById('profile-card');
  const popupButton = document.getElementById('popup-sign-in');
  const redirectButton = document.getElementById('redirect-sign-in');
  const signOutButton = document.getElementById('sign-out');
  const config = window.ACE_ID_DEMO_CONFIG;

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state;
    statusCard.dataset.state = state;
  }

  if (!config || !window.AceID) {
    setStatus('Setup required: copy examples/popup/.env.example to examples/popup/.env, then run configure.mjs.', 'error');
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

  function setBusy(busy) {
    popupButton.disabled = busy;
    redirectButton.disabled = busy;
    signOutButton.disabled = busy;
  }

  function showError(error, prefix = 'Sign-in failed') {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    setStatus(`${prefix}: ${message}`, 'error');
  }

  function render(state) {
    const hasSession = state.status === 'authenticated' || state.status === 'expired' ||
      (state.status === 'refresh-failed' && Boolean(state.session));
    const label = {
      authenticated: 'Signed in securely',
      unauthenticated: 'No active session',
      expired: 'Your session has expired',
      'refresh-failed': 'Session refresh needs attention',
    }[state.status] || 'Session status updated';
    setStatus(label, state.status);
    popupButton.hidden = hasSession;
    redirectButton.hidden = hasSession;
    signOutButton.hidden = !hasSession;
    profileCard.hidden = !hasSession;
    profile.textContent = hasSession && state.session
      ? (state.session.user.name || state.session.user.email || state.session.user.sub)
      : '';
  }

  popupClient.onAuthStateChange(render);

  popupButton.addEventListener('click', async () => {
    setBusy(true);
    setStatus('Opening a secure window for your identity provider…', 'pending');
    try {
      await popupClient.signInWithPopup({
        prompt: 'select_account',
        returnTo: config.appUri,
      });
    } catch (error) {
      showError(error, 'Popup sign-in could not complete');
    } finally {
      setBusy(false);
    }
  });

  redirectButton.addEventListener('click', async () => {
    setBusy(true);
    setStatus('Redirecting to your identity provider…', 'pending');
    try {
      await redirectClient.signIn({ returnTo: config.appUri });
    } catch (error) {
      showError(error, 'Redirect sign-in could not start');
      setBusy(false);
    }
  });

  signOutButton.addEventListener('click', async () => {
    setBusy(true);
    setStatus('Signing out…', 'pending');
    try {
      await popupClient.signOut({ redirectTo: config.appUri });
    } catch (error) {
      showError(error, 'Sign-out could not complete');
    } finally {
      setBusy(false);
    }
  });

  void popupClient.validateConfiguration().then((report) => {
    if (!report.ok) {
      console.warn('Ace ID configuration checks failed', report.checks.filter((check) => check.status === 'fail'));
    }
  }).catch((error) => showError(error, 'Configuration check failed'));
})();
