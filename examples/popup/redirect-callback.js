'use strict';

(() => {
  const status = document.getElementById('status');
  const returnLink = document.getElementById('return-link');
  const config = window.ACE_ID_DEMO_CONFIG;
  returnLink.href = config?.appUri || './index.html';

  if (!config || !window.AceID) {
    status.textContent = 'Demo setup is missing. Return to the app and follow the setup guide.';
    returnLink.hidden = false;
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
    status.textContent = error instanceof Error ? error.message : 'Could not initialize the redirect callback.';
    returnLink.hidden = false;
    return;
  }

  void client.handleCallback()
    .then((result) => window.location.replace(result.returnTo || config.appUri))
    .catch((error) => {
      console.error('Ace ID redirect callback failed', error);
      status.textContent = error instanceof Error
        ? error.message
        : 'Redirect sign-in failed. Return to the app and try again.';
      returnLink.hidden = false;
    });
})();
