/**
 * Checklist+ - export popover. Reads the Checklist+ data of every card on the
 * board and offers it as a CSV download (with a copy-to-clipboard fallback).
 * Read-only: nothing is written to Trello and nothing leaves the browser.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  var store = window.CP.store;
  var calc = window.CP.calc;
  var exportcsv = window.CP.exportcsv;

  var statusEl = document.getElementById('cp-export-status');
  var errorEl = document.getElementById('cp-popup-error');
  var downloadEl = document.getElementById('cp-export-download');
  var copyEl = document.getElementById('cp-export-copy');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }
  applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function fail(prefix, err) {
    errorEl.textContent = prefix + (err && err.message ? ': ' + err.message : '');
    errorEl.hidden = false;
    statusEl.hidden = true;
    if (window.console) console.error('[Checklist+]', err);
  }

  var t;
  try { t = TrelloPowerUp.iframe(); } catch (err) { fail('Errore di inizializzazione', err); return; }

  function resize() { t.sizeTo('#cp-export').catch(function () {}); }

  /** File name like "checklist-plus_nome-board_2026-11-11.csv". */
  function fileName(boardName) {
    var slug = String(boardName || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board';
    return 'checklist-plus_' + slug + '_' + window.CP.workdays.todayIso() + '.csv';
  }

  t.render(function () {
    try {
      var ctx = t.getContext() || {};
      if (ctx.theme || ctx.initialTheme) applyTheme(ctx.theme || ctx.initialTheme);
    } catch (e) { /* keep OS theme */ }

    return Promise.all([
      t.cards('id', 'name'),
      t.board('name', 'members')
    ]).then(function (res) {
      var cards = res[0] || [];
      var board = res[1] || {};
      var names = {};
      (board.members || []).forEach(function (m) { names[m.id] = m.fullName || m.username || ''; });

      // Read each card's shared Checklist+ data; a failing card is skipped, not fatal.
      return Promise.all(cards.map(function (c) {
        return t.get(c.id, 'shared', store.KEY)
          .then(function (blob) { return { name: c.name, state: store.decode(blob) }; })
          .catch(function () { return { name: c.name, state: store.emptyState() }; });
      })).then(function (withData) {
        var out = exportcsv.build(withData, names, new Set());
        if (!out.stats.tasks) {
          statusEl.textContent = 'Nessuna Checklist+ con elementi su questa bacheca.';
          resize();
          return;
        }
        statusEl.textContent = out.stats.cards + ' card, ' + out.stats.lists + ' checklist, ' + out.stats.tasks +
          ' task, ' + calc.fmtNumber(out.stats.effort) + ' giorni lavorati.';

        var blob = new Blob([out.csv], { type: 'text/csv;charset=utf-8' });
        downloadEl.href = URL.createObjectURL(blob);
        downloadEl.download = fileName(board.name);
        downloadEl.hidden = false;

        copyEl.hidden = false;
        copyEl.addEventListener('click', function () {
          navigator.clipboard.writeText(out.csv.replace(/^﻿/, '')).then(function () {
            copyEl.textContent = 'Copiato';
          }).catch(function (err) { fail('Copia non riuscita', err); resize(); });
        });
        resize();
      });
    }).catch(function (err) { fail('Impossibile leggere le card della bacheca', err); resize(); });
  });
})();
