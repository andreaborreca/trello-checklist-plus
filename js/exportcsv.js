/**
 * Checklist+ - CSV export builder (pure functions, shared by browser and tests).
 *
 * Output: one complete row per task (client -> card -> checklist -> task,
 * each with its worked days), followed by summary rows.
 *
 * Format tuned for Italian Excel: ";" separator, decimal comma, dd/mm/yyyy.
 */
(function (root) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var calc = isNode ? require('./calc.js') : root.CP.calc;
  var wd = isNode ? require('./workdays.js') : root.CP.workdays;

  var HEADER = [
    'Cliente', 'Giorni cliente', 'Card', 'Giorni card', 'Checklist', 'Giorni checklist', 'Task', 'Giorni task',
    'Assegnato a', 'Area', 'Completato', 'Inizio', 'Deadline', 'Fine', 'Scostamento (gg lavorativi)', 'Mese'
  ];

  /** "2026-11-09" -> "09/11/2026". */
  function fmtDate(iso) {
    return wd.isIso(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '';
  }

  function fmtNum(n) {
    return n === null || n === undefined ? '' : String(n).replace('.', ',');
  }

  /**
   * Escapes one CSV cell. Cells starting with = + - @ (or tab/CR) are prefixed
   * with an apostrophe so spreadsheet apps never run them as formulas
   * (CSV injection). Numeric cells are passed with raw=true and skip this.
   */
  function cell(value, raw) {
    var s = value === null || value === undefined ? '' : String(value);
    if (!raw && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function row(cells) {
    return cells.map(function (c) {
      return (c && typeof c === 'object') ? cell(c.v, true) : cell(c);
    }).join(';');
  }

  function num(n) { return { v: fmtNum(n) }; }

  var NO_MONTH = 'none';
  var NO_AREA = 'Senza area';
  var NO_CLIENT_LABEL = 'Senza cliente';

  /**
   * Month a task is attributed to ("YYYY-MM"): the month of its end date,
   * else of its start date, else of its deadline; NO_MONTH when it has no
   * dates. One month per task, so worked days are never counted twice.
   */
  function monthOf(item) {
    var d = wd.isIso(item.e) ? item.e : (wd.isIso(item.s) ? item.s : (wd.isIso(item.dl) ? item.dl : ''));
    return d ? d.slice(0, 7) : NO_MONTH;
  }

  /** Months present in the data, sorted, with task counts: [{key, count}]. */
  function listMonths(cards) {
    var counts = {};
    cards.forEach(function (card) {
      (card.state && card.state.l || []).forEach(function (l) {
        (l.x || []).forEach(function (it) { var k = monthOf(it); counts[k] = (counts[k] || 0) + 1; });
      });
    });
    return Object.keys(counts).sort().map(function (k) { return { key: k, count: counts[k] }; });
  }

  /** Copy of the cards keeping only tasks whose month is in `months` (null = all). */
  function filterByMonths(cards, months) {
    if (!months) return cards;
    return cards.map(function (card) {
      return {
        name: card.name,
        state: { l: (card.state && card.state.l || []).map(function (l) {
          return { i: l.i, n: l.n, c: l.c, x: (l.x || []).filter(function (it) { return months.has(monthOf(it)); }) };
        }) }
      };
    });
  }

  /** Single client names of a checklist (a shared checklist has several); [] = none. */
  function clientsOf(list) {
    var value = calc.resolveClient(list).value;
    return value ? value.split(' + ') : [];
  }

  /** Clients present in the data, sorted, with checklist counts; "Senza cliente" last. */
  function listClients(cards) {
    var counts = {};
    cards.forEach(function (card) {
      (card.state && card.state.l || []).forEach(function (l) {
        if (!(l.x || []).length) return;
        var names = clientsOf(l);
        (names.length ? names : [NO_CLIENT_LABEL]).forEach(function (n) { counts[n] = (counts[n] || 0) + 1; });
      });
    });
    return Object.keys(counts).filter(function (k) { return k !== NO_CLIENT_LABEL; }).sort()
      .concat(counts[NO_CLIENT_LABEL] ? [NO_CLIENT_LABEL] : [])
      .map(function (k) { return { key: k, count: counts[k] }; });
  }

  /**
   * Keeps only the checklists of one client ('' = all). A checklist shared by
   * several clients is kept for each of them. NO_CLIENT_LABEL selects the
   * checklists without a client.
   */
  function filterByClient(cards, client) {
    if (!client) return cards;
    return cards.map(function (card) {
      return {
        name: card.name,
        state: { l: (card.state && card.state.l || []).filter(function (l) {
          var names = clientsOf(l);
          return client === NO_CLIENT_LABEL ? names.length === 0 : names.indexOf(client) >= 0;
        }) }
      };
    });
  }

  /**
   * Builds the export as a flat table: one row per task, read left to right
   * as Cliente -> Card -> Checklist -> Task, each followed by the worked days
   * of that level. Every row is complete (no blank "staircase" cells), so the
   * file can also be filtered or pivoted. Summary rows follow at the end.
   *
   * "Giorni card" is the card's total for the client of that row: a card can
   * hold checklists of different clients.
   *
   * @param {Array<{name:string, state:object}>} cards  cards with their Checklist+ state
   * @param {Object<string,string>} memberNames         member id -> full name
   * @param {Set<string>} holidays                      custom holidays
   * @param {Set<string>|null} months                   month keys to include (null = all)
   * @param {Object<string,string>} [memberAreas]       member id -> area name (from the assignee)
   * @param {string} [onlyClient]                       single client to include ('' = all)
   * @returns {{csv:string, stats:{cards:number, lists:number, tasks:number, effort:number}}}
   */
  function build(cards, memberNames, holidays, months, memberAreas, onlyClient) {
    cards = filterByClient(cards, onlyClient || '');
    cards = filterByMonths(cards, months || null);
    memberAreas = memberAreas || {};

    function half(n) { return Math.round(n * 2) / 2; }
    function sum(items) { return half(items.reduce(function (a, it) { return a + (it.w || 0); }, 0)); }

    // Group: client -> card -> checklist, keeping the board order inside each client.
    var groups = {};      // client label -> { effort, cards: [{ name, effort, lists: [list] }] }
    var stats = { cards: 0, lists: 0, tasks: 0, effort: 0 };
    var byArea = {};
    var doneAll = 0;

    cards.forEach(function (card) {
      var used = false;
      (card.state && card.state.l || []).forEach(function (list) {
        if (!(list.x || []).length) return;
        used = true;
        stats.lists++;
        var label = calc.resolveClient(list).value || NO_CLIENT_LABEL;
        var g = groups[label] || (groups[label] = { effort: 0, cards: [] });
        var c = g.cards[g.cards.length - 1];
        if (!c || c.card !== card) { c = { card: card, name: card.name, effort: 0, lists: [] }; g.cards.push(c); }
        var e = sum(list.x);
        c.lists.push(list);
        c.effort = half(c.effort + e);
        g.effort = half(g.effort + e);
      });
      if (used) stats.cards++;
    });

    var labels = Object.keys(groups).filter(function (k) { return k !== NO_CLIENT_LABEL; }).sort();
    if (groups[NO_CLIENT_LABEL]) labels.push(NO_CLIENT_LABEL);

    var lines = [row(HEADER)];
    labels.forEach(function (label) {
      var g = groups[label];
      g.cards.forEach(function (c) {
        c.lists.forEach(function (list) {
          var listEffort = sum(list.x);
          list.x.forEach(function (item) {
            stats.tasks++;
            stats.effort += item.w || 0;
            if (item.d) doneAll++;
            var m = calc.itemMetrics(item, holidays);
            var area = memberAreas[item.m] || NO_AREA;
            var agg = byArea[area] || (byArea[area] = { effort: 0 });
            agg.effort += item.w || 0;
            var month = monthOf(item);
            lines.push(row([
              label, num(g.effort), c.name, num(c.effort), list.n, num(listEffort), item.t, num(item.w || 0),
              memberNames[item.m] || '', area === NO_AREA ? '' : area, item.d ? 'Sì' : 'No',
              fmtDate(item.s), fmtDate(item.dl), fmtDate(item.e), num(m.deviation),
              month === NO_MONTH ? '' : month.slice(5, 7) + '/' + month.slice(0, 4)
            ]));
          });
        });
      });
    });

    stats.effort = half(stats.effort);

    // Summary: label in the first column, days in the second.
    lines.push('');
    lines.push(row(['TOTALE', num(stats.effort), stats.tasks + ' task, ' + doneAll + ' completati']));
    if (labels.length > 1 || (labels.length === 1 && labels[0] !== NO_CLIENT_LABEL)) {
      labels.forEach(function (label) {
        lines.push(row([label === NO_CLIENT_LABEL ? 'TOTALE SENZA CLIENTE' : 'TOTALE CLIENTE ' + label, num(groups[label].effort)]));
      });
    }
    var areaNames = Object.keys(byArea).filter(function (a) { return a !== NO_AREA; }).sort();
    if (areaNames.length) {
      if (byArea[NO_AREA]) areaNames.push(NO_AREA);
      areaNames.forEach(function (a) {
        lines.push(row([a === NO_AREA ? 'TOTALE SENZA AREA' : 'TOTALE AREA ' + a.toUpperCase(), num(half(byArea[a].effort))]));
      });
    }
    // BOM so Excel reads UTF-8 accents correctly; CRLF line endings.
    return { csv: '﻿' + lines.join('\r\n') + '\r\n', stats: stats };
  }

  var api = { build: build, cell: cell, HEADER: HEADER, monthOf: monthOf, listMonths: listMonths, NO_MONTH: NO_MONTH, listClients: listClients, NO_CLIENT_LABEL: NO_CLIENT_LABEL };
  if (isNode) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.exportcsv = api; }
})(typeof window !== 'undefined' ? window : this);
