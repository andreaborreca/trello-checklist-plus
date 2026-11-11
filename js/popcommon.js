/**
 * Checklist+ - bootstrap shared by the small popover pages: theme handling
 * and Trello client start-up with visible error reporting.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  /**
   * Theme for a popover, each source read on its own so that one failing
   * call cannot hide the others: 1) the theme passed by the opener in the
   * popover args, 2) Trello's context, 3) the theme last seen by the card
   * section, 4) the OS preference. Popovers also paint their own background,
   * so a wrong guess is still readable.
   */
  function detectTheme(t) {
    try {
      var passed = t.arg('th');
      if (passed === 'dark' || passed === 'light') return passed;
    } catch (e) { /* no args */ }
    try {
      var ctx = t.getContext() || {};
      var fromCtx = ctx.theme || ctx.initialTheme;
      if (fromCtx === 'dark' || fromCtx === 'light') return fromCtx;
    } catch (e) { /* no context */ }
    try {
      var stored = window.localStorage.getItem('cp-theme');
      if (stored === 'dark' || stored === 'light') return stored;
    } catch (e) { /* storage unavailable */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /**
   * Starts the popover. Returns the Trello client, or null after showing the
   * error in #cp-popup-error.
   */
  function start() {
    // OS preference first, so the page is readable even before Trello answers.
    applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    try {
      var t = TrelloPowerUp.iframe();
      applyTheme(detectTheme(t));
      return t;
    } catch (err) {
      fail('Errore di inizializzazione', err);
      return null;
    }
  }

  function fail(prefix, err) {
    var el = document.getElementById('cp-popup-error');
    if (el) {
      el.textContent = prefix + (err && err.message ? ': ' + err.message : '');
      el.hidden = false;
    }
    if (window.console) console.error('[Checklist+]', err);
  }

  window.CP = window.CP || {};
  window.CP.pop = { start: start, fail: fail, applyTheme: applyTheme, detectTheme: detectTheme };
})();
