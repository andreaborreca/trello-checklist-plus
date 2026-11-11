/**
 * Checklist+ - Excel export (.xlsx), built with ExcelJS from the tree
 * produced by CP.exportcsv.collect().
 *
 * Workbook layout:
 *   "Riepilogo"      totals by client, by area and by month
 *   one sheet per client (shared checklists and "Senza cliente" have their
 *                    own sheet): card band -> checklist band -> task rows
 *   "Tutti i task"   flat table, one complete row per task, with filters
 *
 * Completed tasks are marked by color (green row and check), overdue open
 * tasks in red, instead of a Yes/No column.
 */
(function (root) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var ExcelJS = isNode ? require('exceljs') : root.ExcelJS;
  var wd = isNode ? require('./workdays.js') : root.CP.workdays;

  var MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  var NO_CLIENT_LABEL = 'Senza cliente';

  // Palette (ARGB).
  var C = {
    headerBg: 'FF1F2A44', headerFg: 'FFFFFFFF',
    cardBg: 'FFD6E4F7', listBg: 'FFEEF2F7',
    doneBg: 'FFE3F4E4', doneFg: 'FF1F6F3A',
    lateBg: 'FFFDE2E0', lateFg: 'FFAE2E24',
    muted: 'FF626F86', border: 'FFD0D4DB', totalBg: 'FFF4F5F7'
  };

  function fill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } }; }
  var thin = { style: 'thin', color: { argb: C.border } };
  var boxBorder = { top: thin, left: thin, bottom: thin, right: thin };

  /** ISO date -> Date at UTC midnight (Excel shows it as a plain date), or null. */
  function toDate(iso) {
    return wd.isIso(iso) ? new Date(iso + 'T00:00:00Z') : null;
  }

  function monthLabel(key) {
    return key && /^\d{4}-\d{2}$/.test(key) ? MONTHS[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4) : 'Senza data';
  }

  /** Excel sheet names: max 31 chars, none of []:*?/\ , unique. */
  function sheetName(label, used) {
    var base = String(label).replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Foglio';
    var name = base;
    var n = 2;
    while (used[name.toLowerCase()]) { name = base.slice(0, 31 - String(n).length - 1) + ' ' + n; n++; }
    used[name.toLowerCase()] = true;
    return name;
  }

  /**
   * Text cells starting with = + - @ are prefixed with an apostrophe so no
   * spreadsheet app can treat exported text as a formula.
   */
  function safe(text) {
    var s = text === null || text === undefined ? '' : String(text);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function styleHeader(rowObj) {
    rowObj.eachCell(function (cell) {
      cell.font = { bold: true, color: { argb: C.headerFg } };
      cell.fill = fill(C.headerBg);
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.border = boxBorder;
    });
    rowObj.height = 22;
  }

  function pct(done, total) { return total ? done / total : 0; }

  /* ---------------- Riepilogo ---------------- */

  function summarySheet(wb, data, meta, used) {
    var ws = wb.addWorksheet(sheetName('Riepilogo', used), { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 34 }, { width: 17 }, { width: 17 }, { width: 14 }, { width: 17 }];

    ws.addRow(['Checklist+ · ' + safe(meta.board || 'Bacheca')]).font = { bold: true, size: 16 };
    ws.addRow(['Esportato il ' + meta.exportedOn + ' · Mese: ' + meta.monthLabel + ' · Cliente: ' + meta.clientLabel]).font = { color: { argb: C.muted } };
    ws.addRow([]);

    var s = data.stats;
    var kpi = ws.addRow(['Giorni lavorati', s.effort, 'Task completati', s.done, 'su ' + s.tasks]);
    kpi.font = { bold: true, size: 12 };
    ws.addRow([]);

    function table(title, firstCol, rows) {
      if (!rows.length) return;
      ws.addRow([title]).font = { bold: true, size: 12 };
      styleHeader(ws.addRow([firstCol, 'Giorni lavorati', 'Task completati', 'Task totali', 'Completamento']));
      rows.forEach(function (r) {
        var row = ws.addRow([safe(r.name), r.effort, r.done, r.total, pct(r.done, r.total)]);
        row.getCell(5).numFmt = '0%';
        row.eachCell(function (cell) { cell.border = boxBorder; });
      });
      var tot = ws.addRow(['Totale', s.effort, s.done, s.tasks, pct(s.done, s.tasks)]);
      tot.getCell(5).numFmt = '0%';
      tot.eachCell(function (cell) { cell.font = { bold: true }; cell.fill = fill(C.totalBg); cell.border = boxBorder; });
      ws.addRow([]);
    }

    table('Per cliente', 'Cliente', data.clients.map(function (g) { return { name: g.label, effort: g.effort, done: g.done, total: g.total }; }));
    table('Per area', 'Area', data.areas.map(function (a) { return { name: a.key, effort: a.effort, done: a.done, total: a.total }; }));
    table('Per mese', 'Mese', data.months.map(function (m) { return { name: monthLabel(m.key), effort: m.effort, done: m.done, total: m.total }; }));

    ws.addRow(['Legenda']).font = { bold: true };
    var l1 = ws.addRow(['Task completato']); l1.getCell(1).fill = fill(C.doneBg); l1.getCell(1).font = { color: { argb: C.doneFg } };
    var l2 = ws.addRow(['Task aperto oltre la deadline, o chiuso in ritardo']); l2.getCell(1).fill = fill(C.lateBg); l2.getCell(1).font = { color: { argb: C.lateFg } };
    ws.addRow(['Un task conta nel mese della sua data di fine (o di inizio, o della deadline).']).font = { color: { argb: C.muted }, italic: true };
    ws.addRow(['Scostamento: giorni lavorativi tra deadline e fine (negativo = anticipo).']).font = { color: { argb: C.muted }, italic: true };
  }

  /* ---------------- Client sheets ---------------- */

  var TASK_HEADER = ['Task', 'Stato', 'Assegnato a', 'Area', 'Inizio', 'Deadline', 'Fine', 'Giorni lavorati', 'Scostamento (gg)'];
  var TASK_WIDTHS = [58, 13, 22, 12, 12, 12, 12, 16, 18];

  /** Applies date format and the done/late colors to a task row. */
  function paintTaskRow(row, it, firstDateCol, statusCol, devCol) {
    for (var i = 0; i < 3; i++) row.getCell(firstDateCol + i).numFmt = 'dd/mm/yyyy';
    row.eachCell({ includeEmpty: true }, function (cell) { cell.border = boxBorder; cell.alignment = { vertical: 'top', wrapText: true }; });
    var status = row.getCell(statusCol);
    if (it.done) {
      row.eachCell({ includeEmpty: true }, function (cell) { cell.fill = fill(C.doneBg); });
      status.font = { bold: true, color: { argb: C.doneFg } };
    } else if (it.overdue) {
      status.fill = fill(C.lateBg);
      status.font = { bold: true, color: { argb: C.lateFg } };
    }
    var dev = row.getCell(devCol);
    if (typeof it.deviation === 'number' && it.deviation !== 0) {
      dev.font = { bold: true, color: { argb: it.deviation > 0 ? C.lateFg : C.doneFg } };
      if (it.deviation > 0) dev.fill = fill(C.lateBg);
    }
  }

  function statusText(it) {
    return it.done ? '✓ Fatto' : (it.overdue ? 'In ritardo' : 'Aperto');
  }

  function band(ws, text, effort, done, total, bg, bold) {
    var row = ws.addRow([safe(text), done + '/' + total, '', '', '', '', '', effort, '']);
    row.eachCell({ includeEmpty: true }, function (cell) {
      cell.fill = fill(bg);
      cell.font = { bold: true, size: bold ? 12 : 11 };
      cell.border = boxBorder;
    });
    ws.mergeCells(row.number, 3, row.number, 7);
    return row;
  }

  function clientSheet(wb, g, used) {
    var ws = wb.addWorksheet(sheetName(g.label, used), {
      views: [{ state: 'frozen', ySplit: 4, showGridLines: false }]
    });
    ws.columns = TASK_WIDTHS.map(function (w) { return { width: w }; });

    ws.addRow([safe(g.label)]).font = { bold: true, size: 16 };
    ws.addRow([g.effort + ' giorni lavorati · ' + g.done + ' task completati su ' + g.total]).font = { color: { argb: C.muted } };
    ws.addRow([]);
    styleHeader(ws.addRow(TASK_HEADER));

    g.cards.forEach(function (c) {
      band(ws, c.name, c.effort, c.done, c.total, C.cardBg, true);
      c.lists.forEach(function (l) {
        band(ws, l.name, l.effort, l.done, l.total, C.listBg, false).getCell(1).alignment = { indent: 1 };
        l.items.forEach(function (it) {
          var row = ws.addRow([safe(it.text), statusText(it), safe(it.member), it.area, toDate(it.s), toDate(it.dl), toDate(it.e), it.w,
            typeof it.deviation === 'number' ? it.deviation : null]);
          paintTaskRow(row, it, 5, 2, 9);
          row.getCell(1).alignment = { indent: 2, vertical: 'top', wrapText: true };
        });
      });
    });

    var tot = ws.addRow(['Totale ' + safe(g.label), g.done + '/' + g.total, '', '', '', '', '', g.effort, '']);
    tot.eachCell({ includeEmpty: true }, function (cell) { cell.font = { bold: true }; cell.fill = fill(C.totalBg); cell.border = boxBorder; });
  }

  /* ---------------- Flat sheet ---------------- */

  function flatSheet(wb, data, used) {
    var header = ['Cliente', 'Card', 'Checklist', 'Task', 'Stato', 'Assegnato a', 'Area', 'Inizio', 'Deadline', 'Fine', 'Giorni lavorati', 'Scostamento (gg)', 'Mese'];
    var ws = wb.addWorksheet(sheetName('Tutti i task', used), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [18, 28, 30, 50, 13, 22, 12, 12, 12, 12, 16, 18, 16].map(function (w) { return { width: w }; });
    styleHeader(ws.addRow(header));
    var count = 0;
    data.clients.forEach(function (g) {
      g.cards.forEach(function (c) {
        c.lists.forEach(function (l) {
          l.items.forEach(function (it) {
            var row = ws.addRow([safe(g.label), safe(c.name), safe(l.name), safe(it.text), statusText(it), safe(it.member), it.area,
              toDate(it.s), toDate(it.dl), toDate(it.e), it.w, typeof it.deviation === 'number' ? it.deviation : null,
              it.month ? monthLabel(it.month) : '']);
            paintTaskRow(row, it, 8, 5, 12);
            count++;
          });
        });
      });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, count + 1), column: header.length } };
  }

  /**
   * Builds the workbook.
   * @param {object} data  result of CP.exportcsv.collect()
   * @param {{board:string, exportedOn:string, monthLabel:string, clientLabel:string}} meta
   * @returns {ExcelJS.Workbook}
   */
  function workbook(data, meta) {
    var wb = new ExcelJS.Workbook();
    wb.creator = 'Checklist+';
    wb.created = new Date();
    var used = {};
    summarySheet(wb, data, meta, used);
    data.clients.forEach(function (g) { clientSheet(wb, g, used); });
    flatSheet(wb, data, used);
    // Print setup: landscape, all columns on one page width.
    wb.worksheets.forEach(function (ws) {
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    });
    return wb;
  }

  /** Workbook as an ArrayBuffer/Buffer ready to be downloaded. */
  function toBuffer(data, meta) {
    return workbook(data, meta).xlsx.writeBuffer();
  }

  var api = { workbook: workbook, toBuffer: toBuffer, sheetName: sheetName, monthLabel: monthLabel, NO_CLIENT_LABEL: NO_CLIENT_LABEL };
  if (isNode) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.exportxlsx = api; }
})(typeof window !== 'undefined' ? window : this);
