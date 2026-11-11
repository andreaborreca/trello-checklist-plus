/**
 * Checklist+ - follows Trello's own color mode.
 *
 * Trello's client library (TrelloPowerUp.iframe()) sets and keeps updated a
 * data-color-mode="light|dark" attribute on <html> of every Power-Up iframe,
 * popovers included. That attribute is the source of truth: whenever it is
 * present, our data-theme attribute (which the stylesheet uses) mirrors it.
 * Our own detection in the pages only acts as a fallback when it is absent.
 */
(function () {
  'use strict';

  var html = document.documentElement;

  function sync() {
    var mode = html.getAttribute('data-color-mode');
    if ((mode === 'dark' || mode === 'light') && html.getAttribute('data-theme') !== mode) {
      html.setAttribute('data-theme', mode);
    }
  }

  sync();
  if (typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(html, { attributes: true, attributeFilter: ['data-color-mode', 'data-theme'] });
  }
})();
