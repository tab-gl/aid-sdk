import { FIGTREE_LATIN_EXT_FONT, FIGTREE_LATIN_FONT } from './figtree-font.js';

export const AUTH_SHEET_STYLES = `
@font-face {
  font-family: "Figtree";
  font-style: normal;
  font-display: swap;
  font-weight: 300 900;
  src: url("${FIGTREE_LATIN_EXT_FONT}") format("woff2");
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: "Figtree";
  font-style: normal;
  font-display: swap;
  font-weight: 300 900;
  src: url("${FIGTREE_LATIN_FONT}") format("woff2");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}

:host {
  --aid-surface: #fbfaf6;
  --aid-surface-raised: #ffffff;
  --aid-text: #18212b;
  --aid-muted: #5d6874;
  --aid-border: #202833;
  --aid-border-soft: #d7d9d2;
  --aid-accent: #c9f36b;
  --aid-accent-text: #19220e;
  --aid-danger: #aa3434;
  --aid-success: #26704b;
  --aid-focus: #4c6fff;
  position: fixed;
  z-index: 2147483000;
  inset: 0;
  display: block;
  color: var(--aid-text);
  color-scheme: light;
  font-family: "Figtree", "Avenir Next", Avenir, "Segoe UI", sans-serif;
  font-size: 15px;
  font-weight: 450;
  line-height: 1.5;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
:host([data-scheme="dark"]) {
  --aid-surface: #151b23;
  --aid-surface-raised: #1d2631;
  --aid-text: #f3f4ee;
  --aid-muted: #aab4c0;
  --aid-border: #d8e0d2;
  --aid-border-soft: #3a4653;
  --aid-accent: #c9f36b;
  --aid-accent-text: #19220e;
  --aid-danger: #ff9292;
  --aid-success: #93e0b4;
  --aid-focus: #a9c0ff;
  color-scheme: dark;
}
:host([hidden]), [hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; }
button:focus-visible, [tabindex]:focus-visible {
  outline: 3px solid var(--aid-focus);
  outline-offset: 3px;
}

.backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  background:
    radial-gradient(ellipse at 15% 12%, rgba(201, 243, 107, .15), transparent 34%),
    radial-gradient(ellipse at 86% 82%, rgba(104, 144, 255, .15), transparent 37%),
    rgba(12, 17, 25, .74);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
.frame {
  width: min(100%, 492px);
  padding: 2px;
  background: var(--aid-border);
  filter: drop-shadow(9px 9px 0 rgba(0, 0, 0, .24));
  clip-path: polygon(
    0 18px, 4px 18px, 4px 12px, 10px 12px, 10px 6px, 16px 6px, 16px 0,
    calc(100% - 16px) 0, calc(100% - 16px) 6px, calc(100% - 10px) 6px,
    calc(100% - 10px) 12px, calc(100% - 4px) 12px, calc(100% - 4px) 18px, 100% 18px,
    100% calc(100% - 18px), calc(100% - 4px) calc(100% - 18px),
    calc(100% - 4px) calc(100% - 12px), calc(100% - 10px) calc(100% - 12px),
    calc(100% - 10px) calc(100% - 6px), calc(100% - 16px) calc(100% - 6px),
    calc(100% - 16px) 100%, 16px 100%, 16px calc(100% - 6px), 10px calc(100% - 6px),
    10px calc(100% - 12px), 4px calc(100% - 12px), 4px calc(100% - 18px), 0 calc(100% - 18px)
  );
}
.surface {
  max-height: min(88vh, 800px);
  max-height: min(88dvh, 800px);
  overflow: auto;
  padding: clamp(24px, 5vw, 38px);
  background: var(--aid-surface);
  clip-path: polygon(
    0 16px, 4px 16px, 4px 10px, 10px 10px, 10px 4px, 16px 4px, 16px 0,
    calc(100% - 16px) 0, calc(100% - 16px) 4px, calc(100% - 10px) 4px,
    calc(100% - 10px) 10px, calc(100% - 4px) 10px, calc(100% - 4px) 16px, 100% 16px,
    100% calc(100% - 16px), calc(100% - 4px) calc(100% - 16px),
    calc(100% - 4px) calc(100% - 10px), calc(100% - 10px) calc(100% - 10px),
    calc(100% - 10px) calc(100% - 4px), calc(100% - 16px) calc(100% - 4px),
    calc(100% - 16px) 100%, 16px 100%, 16px calc(100% - 4px), 10px calc(100% - 4px),
    10px calc(100% - 10px), 4px calc(100% - 10px), 4px calc(100% - 16px), 0 calc(100% - 16px)
  );
}
.header { position: relative; padding-right: 46px; }
.brand-row { display: flex; align-items: center; gap: 12px; min-height: 42px; margin-bottom: 30px; }
.brand-mark {
  position: relative;
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  place-items: center;
  border: 1px solid var(--aid-border);
  background: var(--aid-accent);
  clip-path: polygon(0 8px, 4px 8px, 4px 4px, 8px 4px, 8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 4px) calc(100% - 8px), calc(100% - 4px) 100%, 0 100%);
}
.brand-mark img { width: 100%; height: 100%; object-fit: contain; padding: 4px; }
.brand-mark__pixels { display: grid; grid-template-columns: repeat(3, 6px); grid-template-rows: repeat(3, 6px); gap: 2px; transform: rotate(-7deg); }
.brand-mark__pixels i { display: block; background: var(--aid-accent-text); }
.brand-mark__pixels i:nth-child(1), .brand-mark__pixels i:nth-child(5), .brand-mark__pixels i:nth-child(9) { opacity: .28; }
.brand-mark__pixels i:nth-child(2), .brand-mark__pixels i:nth-child(4), .brand-mark__pixels i:nth-child(6), .brand-mark__pixels i:nth-child(8) { opacity: .68; }
.brand-copy { min-width: 0; }
.brand-name { display: block; overflow: hidden; max-width: 250px; color: var(--aid-text); font-size: 15px; font-weight: 740; letter-spacing: -.02em; text-overflow: ellipsis; white-space: nowrap; }
.brand-eyebrow { display: block; margin-top: 1px; color: var(--aid-muted); font-size: 10px; font-weight: 700; letter-spacing: .15em; line-height: 1.25; text-transform: uppercase; }
.secure-chip {
  position: absolute;
  top: 2px;
  right: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid var(--aid-border-soft);
  color: var(--aid-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .12em;
  line-height: 1;
  text-transform: uppercase;
}
.secure-chip__dot { width: 6px; height: 6px; background: var(--aid-success); }
.kicker {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 9px;
  color: var(--aid-muted);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.kicker::before { width: 18px; height: 3px; background: var(--aid-accent); content: ""; }
h1 { margin: 0; color: var(--aid-text); font-size: clamp(30px, 8vw, 38px); font-weight: 680; letter-spacing: -.055em; line-height: 1.08; }
.description { max-width: 36ch; margin: 11px 0 0; color: var(--aid-muted); font-size: 14px; line-height: 1.55; }
.close-button {
  position: absolute;
  top: -5px;
  right: -5px;
  display: grid;
  width: 36px;
  height: 36px;
  padding: 0;
  place-items: center;
  border: 1px solid var(--aid-border);
  background: var(--aid-surface);
  color: var(--aid-text);
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
}
.close-button:hover { background: var(--aid-accent); color: var(--aid-accent-text); }
.close-button:disabled { cursor: not-allowed; opacity: .48; }
.provider-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 27px 0 12px;
  color: var(--aid-muted);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.provider-heading__line { height: 1px; flex: 1; background: var(--aid-border-soft); }
.providers { display: grid; gap: 10px; }
.provider-button {
  position: relative;
  display: flex;
  min-height: 54px;
  width: 100%;
  align-items: center;
  gap: 13px;
  padding: 0 15px;
  border: 1px solid var(--aid-border);
  border-radius: 0;
  background: var(--aid-surface-raised);
  box-shadow: 3px 3px 0 var(--aid-border);
  color: var(--aid-text);
  cursor: pointer;
  text-align: left;
  transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
}
.provider-button:hover:not(:disabled) {
  transform: translate(-1px, -1px);
  box-shadow: 5px 5px 0 var(--aid-border);
  background: var(--aid-surface);
}
.provider-button:active:not(:disabled) { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--aid-border); }
.provider-button:disabled { cursor: wait; opacity: .68; }
.provider-button__icon { display: grid; width: 24px; height: 24px; flex: 0 0 24px; place-items: center; color: var(--aid-text); }
.provider-button__icon svg { display: block; width: 22px; height: 22px; }
.provider-button__icon img { display: block; width: 22px; height: 22px; object-fit: contain; }
.provider-button__text { flex: 1; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.provider-button__arrow { color: var(--aid-muted); font-size: 17px; line-height: 1; transition: transform 120ms ease; }
.provider-button:hover:not(:disabled) .provider-button__arrow { transform: translate(2px, -2px); color: var(--aid-text); }
.provider-button__spinner {
  display: none;
  width: 17px;
  height: 17px;
  border: 2px solid var(--aid-border-soft);
  border-top-color: var(--aid-text);
  animation: aid-spin 700ms linear infinite;
}
.provider-button[data-pending="true"] .provider-button__spinner { display: block; }
.provider-button[data-pending="true"] .provider-button__arrow { display: none; }
.provider-button__text-mark { display: grid; width: 22px; height: 22px; place-items: center; background: var(--aid-accent); color: var(--aid-accent-text); font-size: 11px; font-weight: 800; }
.feedback, .error-message {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 15px;
  padding: 12px 13px;
  border: 1px solid var(--aid-border-soft);
  font-size: 13px;
  line-height: 1.45;
}
.feedback { background: color-mix(in srgb, var(--aid-accent) 15%, var(--aid-surface)); color: var(--aid-text); }
.feedback[data-tone="success"] { background: color-mix(in srgb, var(--aid-success) 12%, var(--aid-surface)); }
.feedback[data-tone="cancelled"] { background: color-mix(in srgb, var(--aid-border-soft) 32%, var(--aid-surface)); }
.error-message { border-color: color-mix(in srgb, var(--aid-danger) 55%, transparent); background: color-mix(in srgb, var(--aid-danger) 8%, var(--aid-surface)); color: var(--aid-danger); }
.feedback__icon { display: grid; width: 19px; height: 19px; flex: 0 0 19px; place-items: center; font-weight: 800; }
.feedback[data-tone="loading"] .feedback__icon { border: 2px solid var(--aid-border-soft); border-top-color: var(--aid-text); border-radius: 50%; animation: aid-spin 700ms linear infinite; font-size: 0; }
.feedback[data-tone="success"] .feedback__icon { color: var(--aid-success); }
.feedback[data-tone="cancelled"] .feedback__icon { color: var(--aid-muted); }
.feedback__text, .error-message__text { margin: 0; }
.cancel-button, .done-button {
  min-height: 42px;
  margin-top: 10px;
  padding: 0 13px;
  border: 1px solid var(--aid-border);
  border-radius: 0;
  background: transparent;
  color: var(--aid-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
}
.cancel-button:hover { background: var(--aid-surface-raised); }
.done-button { border-color: var(--aid-text); background: var(--aid-text); color: var(--aid-surface); }
.done-button:hover { border-color: var(--aid-accent); background: var(--aid-accent); color: var(--aid-accent-text); }
.trust-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 26px;
  padding-top: 17px;
  border-top: 1px dashed var(--aid-border-soft);
  color: var(--aid-muted);
  font-size: 11px;
  line-height: 1.5;
}
.trust-note__mark { display: grid; width: 20px; height: 20px; flex: 0 0 20px; place-items: center; color: var(--aid-success); }
.trust-note__mark svg { width: 17px; height: 17px; }
.trust-note p { margin: 0; }
.footer { margin-top: 15px; color: var(--aid-muted); font-size: 10px; line-height: 1.5; text-align: center; }
.footer strong { color: var(--aid-text); font-weight: 650; }
@keyframes aid-spin { to { transform: rotate(360deg); } }

@media (max-width: 620px) {
  .backdrop {
    align-items: end;
    padding: max(10px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right))
      max(0px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
  }
  .frame { width: 100%; max-width: none; filter: drop-shadow(0 -6px 0 rgba(0, 0, 0, .14)); }
  .surface { max-height: min(91vh, 760px); max-height: min(91dvh, 760px); padding: 26px 22px max(24px, env(safe-area-inset-bottom)); }
  .brand-row { margin-bottom: 24px; }
  .provider-heading { margin-top: 23px; }
  .provider-button { min-height: 52px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
`;
