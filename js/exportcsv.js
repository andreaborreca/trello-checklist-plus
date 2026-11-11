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

  function half(n) { return Math.round(n * 2) / 2; }

  /**
   * Collects the export data as a tree, after applying the filters:
   *   clients[] -> cards[] -> lists[] -> items[]
   * each level with its worked days and done/total counts, plus totals by
   * work area and by month. Both the CSV and the Excel export are built from it.
   *
   * @param {Array<{name:string, state:object}>} cards  cards with their Checklist+ state
   * @param {Object<string,string>} memberNames         member id -> full name
   * @param {Set<string>} holidays                      custom holidays
   * @param {Set<string>|null} months                   month keys to include (null = all)
   * @param {Object<string,string>} [memberAreas]       member id -> area name (from the assignee)
   * @param {string} [onlyClient]                       single client to include ('' = all)
   * @param {string} [today]                            ISO date used to flag overdue open tasks
   */
  function collect(cards, memberNames, holidays, months, memberAreas, onlyClient, today) {
    cards = filterByClient(cards, onlyClient || '');
    cards = filterByMonths(cards, months || null);
    memberAreas = memberAreas || {};
    memberNames = memberNames || {};
    today = today || wd.todayIso();

    var groups = {};
    var stats = { cards: 0, lists: 0, tasks: 0, effort: 0, done: 0 };
    var byArea = {};
    var byMonth = {};

    function bump(map, key, item) {
      var a = map[key] || (map[key] = { effort: 0, done: 0, total: 0 });
      a.effort = half(a.effort + (item.w || 0)); a.total++; if (item.d) a.done++;
    }

    cards.forEach(function (card) {
      var used = false;
      (card.state && card.state.l || []).forEach(function (list) {
        if (!(list.x || []).length) return;
        used = true;
        stats.lists++;
        var label = calc.resolveClient(list).value || NO_CLIENT_LABEL;
        var g = groups[label] || (groups[label] = { label: label, effort: 0, done: 0, total: 0, cards: [] });
        var c = g.cards[g.cards.length - 1];
        if (!c || c.source !== card) { c = { source: card, name: card.name, effort: 0, done: 0, total: 0, lists: [] }; g.cards.push(c); }
        var l = { name: list.n, effort: 0, done: 0, total: 0, items: [] };
        list.x.forEach(function (item) {
          var m = calc.itemMetrics(item, holidays);
          var area = memberAreas[item.m] || NO_AREA;
          var month = monthOf(item);
          l.items.push({
            text: item.t, member: memberNames[item.m] || '', area: area === NO_AREA ? '' : area,
            done: !!item.d, s: item.s, dl: item.dl, e: item.e, w: item.w || 0, deviation: m.deviation,
            month: month === NO_MONTH ? '' : month,
            // Open task past its deadline.
            overdue: !item.d && wd.isIso(item.dl) && today > item.dl
          });
          [l, c, g].forEach(function (lvl) { lvl.effort = half(lvl.effort + (item.w || 0)); lvl.total++; if (item.d) lvl.done++; });
          stats.tasks++; stats.effort = half(stats.effort + (item.w || 0)); if (item.d) stats.done++;
          bump(byArea, area, item);
          bump(byMonth, month, item);
        });
        c.lists.push(l);
      });
      if (used) stats.cards++;
    });

    var labels = Object.keys(groups).filter(function (k) { return k !== NO_CLIENT_LABEL; }).sort();
    if (groups[NO_CLIENT_LABEL]) labels.push(NO_CLIENT_LABEL);

    function ordered(map, lastKey) {
      var keys = Object.keys(map).filter(function (k) { return k !== lastKey; }).sort();
      if (map[lastKey]) keys.push(lastKey);
      return keys.map(function (k) { return { key: k, effort: map[k].effort, done: map[k].done, total: map[k].total }; });
    }

    return {
      clients: labels.map(function (k) { return groups[k]; }),
      areas: ordered(byArea, NO_AREA),
      months: ordered(byMonth, NO_MONTH),
      stats: stats
    };
  }

  /**
   * CSV export: a flat table, one complete row per task, read left to right
   * as Cliente -> Card -> Checklist -> Task, each followed by the worked days
   * of that level; summary rows follow at the end.
   * Same parameters as collect().
   * @returns {{csv:string, stats:{cards:number, lists:number, tasks:number, effort:number}}}
   */
  function build(cards, memberNames, holidays, months, memberAreas, onlyClient) {
    var data = collect(cards, memberNames, holidays, months, memberAreas, onlyClient);
    var lines = [row(HEADER)];

    data.clients.forEach(function (g) {
      g.cards.forEach(function (c) {
        c.lists.forEach(function (l) {
          l.items.forEach(function (it) {
            lines.push(row([
              g.label, num(g.effort), c.name, num(c.effort), l.name, num(l.effort), it.text, num(it.w),
              it.member, it.area, it.done ? 'Sì' : 'No',
              fmtDate(it.s), fmtDate(it.dl), fmtDate(it.e), num(it.deviation),
              it.month ? it.month.slice(5, 7) + '/' + it.month.slice(0, 4) : ''
            ]));
          });
        });
      });
    });

    // Summary: label in the first column, days in the second.
    lines.push('');
    lines.push(row(['TOTALE', num(data.stats.effort), data.stats.tasks + ' task, ' + data.stats.done + ' completati']));
    var real = data.clients.filter(function (g) { return g.label !== NO_CLIENT_LABEL; });
    if (real.length) {
      data.clients.forEach(function (g) {
        lines.push(row([g.label === NO_CLIENT_LABEL ? 'TOTALE SENZA CLIENTE' : 'TOTALE CLIENTE ' + g.label, num(g.effort)]));
      });
    }
    if (data.areas.some(function (a) { return a.key !== NO_AREA; })) {
      data.areas.forEach(function (a) {
        lines.push(row([a.key === NO_AREA ? 'TOTALE SENZA AREA' : 'TOTALE AREA ' + a.key.toUpperCase(), num(a.effort)]));
      });
    }
    var s = data.stats;
    // BOM so Excel reads UTF-8 accents correctly; CRLF line endings.
    return { csv: '﻿' + lines.join('\r\n') + '\r\n', stats: { cards: s.cards, lists: s.lists, tasks: s.tasks, effort: s.effort } };
  }

  var api = { build: build, collect: collect, cell: cell, HEADER: HEADER, monthOf: monthOf, listMonths: listMonths, NO_MONTH: NO_MONTH, listClients: listClients, NO_CLIENT_LABEL: NO_CLIENT_LABEL };
  if (isNode) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.exportcsv = api; }
})(typeof window !== 'undefined' ? window : this);
