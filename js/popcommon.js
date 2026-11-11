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
   * Starts the popover. Returns the Trello client, or null after showing the
   * error in #cp-popup-error.
   */
  function start() {
    // OS preference first, so the page is readable even before Trello answers.
    applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    try {
      var t = TrelloPowerUp.iframe();
      try {
        var passed = t.arg('th');
        var ctx = t.getContext() || {};
        if (passed === 'dark' || passed === 'light') applyTheme(passed);
        else if (ctx.theme || ctx.initialTheme) applyTheme(ctx.theme || ctx.initialTheme);
      } catch (e) { /* keep OS theme */ }
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
  window.CP.pop = { start: start, fail: fail, applyTheme: applyTheme };
})();
