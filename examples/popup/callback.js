'use strict';

(() => {
  const status = document.getElementById('status');
  const help = document.getElementById('help');
  const errorDetails = document.getElementById('error-details');
  const errorDetail = document.getElementById('error-detail');
  const closeButton = document.getElementById('close-popup');
  const returnLink = document.getElementById('return-link');
  const config = window.ACE_ID_DEMO_CONFIG;
  returnLink.href = config?.appUri || './index.html';
  closeButton.addEventListener('click', () => {
    status.textContent = 'If this window stays open, close it manually and return to the original app tab.';
    window.close();
  });

  function showError(message, nextStep, detail = '') {
    status.textContent = message;
    help.textContent = nextStep;
    help.hidden = !nextStep;
    errorDetails.hidden = !detail;
    errorDetail.textContent = detail;
    closeButton.hidden = false;
    returnLink.hidden = false;
  }

  if (!config || !window.AceID) {
    showError(
      'Demo setup is incomplete.',
      'Close this window, configure the demo, and start sign-in from the app page.',
    );
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
    const detail = error instanceof Error ? error.message : 'Could not initialize the popup callback.';
    showError('This sign-in window could not be initialized.', 'Close it and check the demo setup.', detail);
    return;
  }

  // This route is popup-only. If COOP or browser policy severs the opener, show
  // the problem and let the user close this window and retry using redirect sign-in.
  void client.handlePopupCallback().catch((error) => {
    console.error('Ace ID popup callback failed', error);
    const detail = error instanceof Error ? error.message : 'Popup sign-in failed.';
    const lower = detail.toLowerCase();
    if (lower.includes('no live opener') || lower.includes('opener') || lower.includes('timed out')) {
      showError(
        'This window could not reconnect to the app.',
        'Close it, return to the original tab, and choose full-page redirect. A browser isolation policy may have interrupted the popup.',
        detail,
      );
      return;
    }
    showError(
      'We could not finish sign-in in this window.',
      'Close it and retry from the app. If popup sign-in fails again, use full-page redirect.',
      detail,
    );
  });
})();
