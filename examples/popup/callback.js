'use strict';

(() => {
  const status = document.getElementById('status');
  const closeButton = document.getElementById('close-popup');
  const returnLink = document.getElementById('return-link');
  const config = window.ACE_ID_DEMO_CONFIG;
  returnLink.href = config?.appUri || './index.html';
  closeButton.addEventListener('click', () => {
    status.textContent = 'If this window stays open, close it manually and return to the original app tab.';
    window.close();
  });

  function showError(message) {
    status.textContent = message;
    closeButton.hidden = false;
    returnLink.hidden = false;
  }

  if (!config || !window.AceID) {
    showError('Demo setup is missing. Return to the app and follow the setup guide.');
    return;
  }

  let client;
  try {
    const { AID } = window.AceID;
    client = new AID({
      issuer: config.issuer,
      clientId: config.clientId,
      redirectUri: config.popupRedirectUri,
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Could not initialize the popup callback.');
    return;
  }

  // This route is popup-only. If COOP or browser policy severs the opener, show
  // the problem and let the user close this window and retry using redirect sign-in.
  void client.handlePopupCallback().catch((error) => {
    console.error('Ace ID popup callback failed', error);
    showError(error instanceof Error ? error.message : 'Popup sign-in failed.');
  });
})();
