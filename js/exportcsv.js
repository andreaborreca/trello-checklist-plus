/**
 * Checklist+ - CSV export builder (pure functions, shared by browser and tests).
 *
 * Output: a staircase of rows (card -> checklist -> task), each with the
 * worked days of its own level, and a final TOTALE row for the whole board.
 *
 * Format tuned for Italian Excel: ";" separator, decimal comma, dd/mm/yyyy.
 */
(function (root) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var calc = isNode ? require('./calc.js') : root.CP.calc;
  var wd = isNode ? require('./workdays.js') : root.CP.workdays;

  var HEADER = [
    'Card', 'Checklist', 'Task', 'Cliente', 'Assegnato a', 'Completato',
    'Inizio', 'Deadline', 'Fine', 'Giorni lavorati', 'Scostamento (gg lavorativi)',
    'Task completati', 'Task totali', 'Mese'
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

  /**
   * Builds the export as a "staircase": the card name appears only on the
   * card row (column 1), the checklist name only on its row (column 2), the
   * task only on its row (column 3). Each row carries the worked days of its
   * own level; a final TOTALE row sums the whole board.
   * @param {Array<{name:string, state:object}>} cards  cards with their Checklist+ state
   * @param {Object<string,string>} memberNames         member id -> full name
   * @param {Set<string>} holidays                      custom holidays
   * @param {Set<string>|null} months                   month keys to include (null = all)
   * @returns {{csv:string, stats:{cards:number, lists:number, tasks:number, effort:number}}}
   */
  function build(cards, memberNames, holidays, months) {
    cards = filterByMonths(cards, months || null);
    var lines = [row(HEADER)];
    var stats = { cards: 0, lists: 0, tasks: 0, effort: 0 };
    var doneAll = 0;

    cards.forEach(function (card) {
      var lists = (card.state && card.state.l || []).filter(function (l) { return (l.x || []).length > 0; });
      if (!lists.length) return;
      stats.cards++;

      // Card totals = aggregate of all its checklists.
      var all = { x: [] };
      lists.forEach(function (l) { all.x = all.x.concat(l.x); });
      var ct = calc.checklistTotals(all, holidays);
      doneAll += ct.done;
      lines.push(row([card.name, '', '', '', '', '', fmtDate(ct.start), fmtDate(ct.deadline), fmtDate(ct.end),
        num(ct.effort), num(ct.deviation), num(ct.done), num(ct.total)]));

      lists.forEach(function (list) {
        stats.lists++;
        var lt = calc.checklistTotals(list, holidays);
        lines.push(row(['', list.n, '', calc.resolveClient(list).value, '', '', fmtDate(lt.start), fmtDate(lt.deadline), fmtDate(lt.end),
          num(lt.effort), num(lt.deviation), num(lt.done), num(lt.total)]));

        list.x.forEach(function (item) {
          stats.tasks++;
          stats.effort += item.w || 0;
          var m = calc.itemMetrics(item, holidays);
          lines.push(row(['', '', item.t, '', memberNames[item.m] || '', item.d ? 'Sì' : 'No',
            fmtDate(item.s), fmtDate(item.dl), fmtDate(item.e), num(item.w || 0), num(m.deviation), '', '', monthOf(item) === NO_MONTH ? '' : monthOf(item).slice(5, 7) + '/' + monthOf(item).slice(0, 4)]));
        });
      });
    });

    stats.effort = Math.round(stats.effort * 2) / 2;
    lines.push(row(['TOTALE', '', '', '', '', '', '', '', '', num(stats.effort), '', num(doneAll), num(stats.tasks)]));
    // BOM so Excel reads UTF-8 accents correctly; CRLF line endings.
    return { csv: '﻿' + lines.join('\r\n') + '\r\n', stats: stats };
  }

  var api = { build: build, cell: cell, HEADER: HEADER, monthOf: monthOf, listMonths: listMonths, NO_MONTH: NO_MONTH };
  if (isNode) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.exportcsv = api; }
})(typeof window !== 'undefined' ? window : this);
