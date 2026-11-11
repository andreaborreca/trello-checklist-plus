/**
 * Checklist+ - CSV export builder (pure functions, shared by browser and tests).
 *
 * Output hierarchy, one row per level:
 *   CARD       -> totals of the card
 *   CHECKLIST  -> totals of the checklist (count of worked days, dates, deviation)
 *   TASK       -> the single item
 *
 * Format tuned for Italian Excel: ";" separator, decimal comma, dd/mm/yyyy.
 */
(function (root) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var calc = isNode ? require('./calc.js') : root.CP.calc;
  var wd = isNode ? require('./workdays.js') : root.CP.workdays;

  var HEADER = [
    'Livello', 'Card', 'Checklist', 'Cliente', 'Task', 'Assegnato a', 'Completato',
    'Inizio', 'Deadline', 'Fine', 'Giorni lavorati', 'Scostamento (gg lavorativi)',
    'Task completati', 'Task totali'
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

  /**
   * Builds the export.
   * @param {Array<{name:string, state:object}>} cards  cards with their Checklist+ state
   * @param {Object<string,string>} memberNames         member id -> full name
   * @param {Set<string>} holidays                      custom holidays
   * @returns {{csv:string, stats:{cards:number, lists:number, tasks:number, effort:number}}}
   */
  function build(cards, memberNames, holidays) {
    var lines = [row(HEADER)];
    var stats = { cards: 0, lists: 0, tasks: 0, effort: 0 };

    cards.forEach(function (card) {
      var lists = (card.state && card.state.l || []).filter(function (l) { return (l.x || []).length > 0; });
      if (!lists.length) return;
      stats.cards++;

      // Card totals = aggregate of all its checklists.
      var all = { x: [] };
      lists.forEach(function (l) { all.x = all.x.concat(l.x); });
      var ct = calc.checklistTotals(all, holidays);
      lines.push(row(['CARD', card.name, '', '', '', '', '', fmtDate(ct.start), fmtDate(ct.deadline), fmtDate(ct.end),
        num(ct.effort), num(ct.deviation), num(ct.done), num(ct.total)]));

      lists.forEach(function (list) {
        stats.lists++;
        var client = calc.resolveClient(list).value;
        var lt = calc.checklistTotals(list, holidays);
        lines.push(row(['CHECKLIST', card.name, list.n, client, '', '', '', fmtDate(lt.start), fmtDate(lt.deadline), fmtDate(lt.end),
          num(lt.effort), num(lt.deviation), num(lt.done), num(lt.total)]));

        list.x.forEach(function (item) {
          stats.tasks++;
          stats.effort += item.w || 0;
          var m = calc.itemMetrics(item, holidays);
          lines.push(row(['TASK', card.name, list.n, client, item.t, memberNames[item.m] || '', item.d ? 'Sì' : 'No',
            fmtDate(item.s), fmtDate(item.dl), fmtDate(item.e), num(item.w || 0), num(m.deviation), '', '']));
        });
      });
    });

    stats.effort = Math.round(stats.effort * 2) / 2;
    // BOM so Excel reads UTF-8 accents correctly; CRLF line endings.
    return { csv: '﻿' + lines.join('\r\n') + '\r\n', stats: stats };
  }

  var api = { build: build, cell: cell, HEADER: HEADER };
  if (isNode) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.exportcsv = api; }
})(typeof window !== 'undefined' ? window : this);
