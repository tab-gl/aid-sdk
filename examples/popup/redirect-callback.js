'use strict';

(() => {
  const status = document.getElementById('status');
  const help = document.getElementById('help');
  const errorDetails = document.getElementById('error-details');
  const errorDetail = document.getElementById('error-detail');
  const returnLink = document.getElementById('return-link');
  const config = window.ACE_ID_DEMO_CONFIG;
  returnLink.href = config?.appUri || './index.html';

  function showError(message, nextStep, detail = '') {
    status.textContent = message;
    help.textContent = nextStep;
    help.hidden = !nextStep;
    errorDetails.hidden = !detail;
    errorDetail.textContent = detail;
    returnLink.hidden = false;
  }

  if (!config || !window.AceID) {
    showError(
      'Demo setup is incomplete.',
      'Return to the app, finish the setup guide, and start redirect sign-in again.',
    );
    return;
  }

  let client;
  try {
    const { AID } = window.AceID;
    client = new AID({
      issuer: config.issuer,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Could not initialize the redirect callback.';
    showError('We could not initialize redirect sign-in.', 'Check the demo setup and try again.', detail);
    return;
  }

  void client.handleCallback()
    .then((result) => window.location.replace(result.returnTo || config.appUri))
    .catch((error) => {
      console.error('Ace ID redirect callback failed', error);
      const detail = error instanceof Error ? error.message : 'Redirect sign-in failed.';
      const lower = detail.toLowerCase();
      if (lower.includes('access_denied') || lower.includes('cancel')) {
        showError('Sign-in was cancelled.', 'Return to the app and choose a sign-in method whenever you are ready.', detail);
        return;
      }
      showError(
        'We could not verify this sign-in response.',
        'Return to the app and try again. If the problem continues, check the callback URI and provider setup.',
        detail,
      );
    });
})();
