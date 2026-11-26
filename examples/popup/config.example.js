// Example output for a local static server. Prefer configure.mjs so the
// generated config.local.js stays out of Git and your client ID is not hardcoded
// into another shared reference file.
window.ACE_ID_DEMO_CONFIG = Object.freeze({
  issuer: 'https://your-issuer.example',
  clientId: 'your-public-client-id',
  popupRedirectUri: 'http://localhost:8000/examples/popup/callback.html',
  redirectUri: 'http://localhost:8000/examples/popup/redirect-callback.html',
  appUri: 'http://localhost:8000/examples/popup/index.html',
});
