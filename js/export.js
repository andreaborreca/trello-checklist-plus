/**
 * Checklist+ - export popover. Reads the Checklist+ data of every card on the
 * board and offers it as a CSV download (with a copy-to-clipboard fallback),
 * for all months or only the selected ones.
 * Read-only: nothing is written to Trello and nothing leaves the browser.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  var store = window.CP.store;
  var calc = window.CP.calc;
  var exportcsv = window.CP.exportcsv;

  var MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

  var statusEl = document.getElementById('cp-export-status');
  var errorEl = document.getElementById('cp-popup-error');
  var downloadEl = document.getElementById('cp-export-download');
  var copyEl = document.getElementById('cp-export-copy');
  var monthsEl = document.getElementById('cp-export-months');
  var selectEl = document.getElementById('cp-month-select');
  var clientsEl = document.getElementById('cp-export-clients');
  var clientSelectEl = document.getElementById('cp-client-select');

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

  var data = [];        // [{name, state}] for every card
  var names = {};       // member id -> name
  var memberAreas = {}; // member id -> area name
  var boardName = '';
  var currentCsv = '';
  var blobUrl = '';

  function resize() { t.sizeTo('#cp-export').catch(function () {}); }

  function monthLabel(key) {
    return key === exportcsv.NO_MONTH ? 'Senza data' : MONTHS[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4);
  }

  /** Selected month as a one-element Set, or null for "Tutti i mesi". */
  function selection() {
    return selectEl.value ? new Set([selectEl.value]) : null;
  }

  /** File name like "checklist-plus_board_2026-11.csv" (date of export when all months). */
  function fileName(sel) {
    var slug = String(boardName || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board';
    var suffix = sel && sel.size ? Array.from(sel).sort().join('_') : window.CP.workdays.todayIso();
    if (clientSelectEl.value) suffix = clientSelectEl.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '_' + suffix;
    return 'checklist-plus_' + slug + '_' + suffix + '.csv';
  }

  /** Rebuilds the CSV for the current month selection and refreshes the buttons. */
  function refresh() {
    var sel = selection();
    var out = exportcsv.build(data, names, new Set(), sel, memberAreas, clientSelectEl.value);
    var has = out.stats.tasks > 0;
    statusEl.textContent = has
      ? out.stats.cards + ' card, ' + out.stats.lists + ' checklist, ' + out.stats.tasks + ' task, ' + calc.fmtNumber(out.stats.effort) + ' giorni lavorati.'
      : (sel || clientSelectEl.value ? 'Nessun task con i filtri selezionati.' : 'Nessuna Checklist+ con elementi su questa bacheca.');

    currentCsv = out.csv;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv;charset=utf-8' }));
    downloadEl.href = blobUrl;
    downloadEl.download = fileName(sel);
    downloadEl.hidden = !has;
    copyEl.hidden = !has;
    copyEl.textContent = 'Copia negli appunti';
    resize();
  }

  /** Fills the month select: most recent month first, "Senza data" last. */
  function renderMonths() {
    var months = exportcsv.listMonths(data);
    if (!months.length) return;
    monthsEl.hidden = false;
    var dated = months.filter(function (m) { return m.key !== exportcsv.NO_MONTH; }).reverse();
    var undated = months.filter(function (m) { return m.key === exportcsv.NO_MONTH; });
    dated.concat(undated).forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = monthLabel(m.key) + ' (' + m.count + ' task)';
      selectEl.appendChild(opt);
    });
  }

  /** Fills the client select with the clients found in the data. */
  function renderClients() {
    var clients = exportcsv.listClients(data);
    if (!clients.length) return;
    clientsEl.hidden = false;
    clients.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.key;
      opt.textContent = c.key + ' (' + c.count + ' checklist)';
      clientSelectEl.appendChild(opt);
    });
  }

  selectEl.addEventListener('change', refresh);
  clientSelectEl.addEventListener('change', refresh);

  copyEl.addEventListener('click', function () {
    navigator.clipboard.writeText(currentCsv.replace(/^﻿/, '')).then(function () {
      copyEl.textContent = 'Copiato';
    }).catch(function (err) { fail('Copia non riuscita', err); resize(); });
  });

  t.render(function () {
    applyTheme(window.CP.pop.detectTheme(t));

    return Promise.all([
      t.cards('id', 'name'),
      t.board('name', 'members'),
      window.CP.people.loadAreas(t),
      window.CP.people.loadClients(t)
    ]).then(function (res) {
      calc.setClients(res[3] || []);
      var areaKeys = res[2] || {};
      Object.keys(areaKeys).forEach(function (id) { memberAreas[id] = window.CP.people.areaName(areaKeys[id]); });
      var cards = res[0] || [];
      var board = res[1] || {};
      boardName = board.name || '';
      (board.members || []).forEach(function (m) { names[m.id] = m.fullName || m.username || ''; });

      // Read each card's shared Checklist+ data; a failing card is skipped, not fatal.
      return Promise.all(cards.map(function (c) {
        return t.get(c.id, 'shared', store.KEY)
          .then(function (blob) { return { name: c.name, state: store.decode(blob) }; })
          .catch(function () { return { name: c.name, state: store.emptyState() }; });
      })).then(function (withData) {
        data = withData;
        renderMonths();
        renderClients();
        refresh();
      });
    }).catch(function (err) { fail('Impossibile leggere le card della bacheca', err); resize(); });
  });
})();
