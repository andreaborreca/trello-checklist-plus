/**
 * Checklist+ - derived metrics (totals, deviations, warnings, client
 * resolution). Pure functions shared by browser and Node tests.
 */
(function (root) {
  'use strict';

  var wd = (typeof module !== 'undefined' && module.exports)
    ? require('./workdays.js')
    : root.CP.workdays;

  /** Normalizes a client label: trimmed, single spaces, upper case. */
  function normalizeLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
  }

  /**
   * Client of a checklist.
   * - list.c === NO_CLIENT ("-"): explicitly no client (internal work).
   * - list.c set: the explicit value (one client, or several joined by " + ").
   * - otherwise: detected from the title, as every known client of the board
   *   whose name appears in it as a whole word (e.g. "NEXI - SVILUPPO BACKEND").
   *   Titles without a known client (e.g. "CI/CD") resolve to no client.
   * Returns { value, derived } so the UI can show when it is a suggestion.
   */
  var NO_CLIENT = '-';
  var knownClients = [];

  /** Sets the board's client list used for automatic detection. */
  function setClients(list) {
    knownClients = (list || []).map(normalizeLabel).filter(Boolean);
  }

  function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** Known clients named in a title, in the order of the board's list. */
  function clientsInTitle(title) {
    var t = normalizeLabel(title);
    return knownClients.filter(function (c) {
      return new RegExp('(^|[^A-Z0-9])' + escapeRe(c) + '($|[^A-Z0-9])').test(t);
    });
  }

  function resolveClient(list) {
    if (list.c === NO_CLIENT) return { value: '', derived: false };
    if (list.c) return { value: normalizeLabel(list.c), derived: false };
    return { value: clientsInTitle(list.n).join(' + '), derived: true };
  }

  /**
   * Per-item metrics: deviation (working days), available working days
   * between start and end, and data-consistency warnings (Italian labels).
   */
  function itemMetrics(item, holidays) {
    var warnings = [];
    var dev = wd.deviation(item.dl, item.e, holidays);
    var available = null;

    if (wd.isIso(item.s) && wd.isIso(item.e)) {
      if (item.e < item.s) {
        warnings.push('La data di fine è precedente alla data di inizio');
      } else {
        available = wd.countWorkdaysBetween(item.s, item.e, holidays);
        if ((item.w || 0) > available) {
          warnings.push('Giorni lavorati (' + fmtNumber(item.w) + ') oltre i giorni lavorativi tra inizio e fine (' + available + ')');
        }
      }
    }
    if (wd.isIso(item.s) && wd.isIso(item.dl) && item.dl < item.s) {
      warnings.push('La deadline è precedente alla data di inizio');
    }
    if (item.d && !wd.isIso(item.e)) {
      warnings.push('Completato senza data di fine');
    }
    return { deviation: dev, available: available, warnings: warnings };
  }

  /** Min/max helpers that ignore empty values. */
  function minIso(a, b) { return !a ? b : (!b ? a : (a < b ? a : b)); }
  function maxIso(a, b) { return !a ? b : (!b ? a : (a > b ? a : b)); }

  /**
   * Totals for one checklist: done/total, summed effort, earliest start,
   * latest deadline, latest end, overall deviation and warning count.
   */
  function checklistTotals(list, holidays) {
    var res = { done: 0, total: 0, effort: 0, start: '', deadline: '', end: '', deviation: null, warnings: 0 };
    (list.x || []).forEach(function (item) {
      res.total++;
      if (item.d) res.done++;
      res.effort += item.w || 0;
      res.start = minIso(res.start, item.s);
      res.deadline = maxIso(res.deadline, item.dl);
      res.end = maxIso(res.end, item.e);
      res.warnings += itemMetrics(item, holidays).warnings.length;
    });
    // Overall deviation only makes sense once every item is completed.
    if (res.total > 0 && res.done === res.total) {
      res.deviation = wd.deviation(res.deadline, res.end, holidays);
    }
    res.effort = Math.round(res.effort * 2) / 2;
    return res;
  }

  /** Totals for the whole card (used by the card badge). */
  function cardTotals(state) {
    var res = { done: 0, total: 0, effort: 0 };
    (state.l || []).forEach(function (list) {
      (list.x || []).forEach(function (item) {
        res.total++;
        if (item.d) res.done++;
        res.effort += item.w || 0;
      });
    });
    res.effort = Math.round(res.effort * 2) / 2;
    return res;
  }

  /** 2.5 -> "2,5", 3 -> "3". */
  function fmtNumber(n) {
    return String(Math.round((n || 0) * 2) / 2).replace('.', ',');
  }

  /** "2026-11-09" -> "09/11". */
  function fmtShortDate(iso) {
    return wd.isIso(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';
  }

  /** Deviation label: "-1 g (anticipo)", "+2 gg (ritardo)", "in tempo". */
  function fmtDeviation(dev) {
    if (dev === null || dev === undefined) return '';
    if (dev === 0) return 'in tempo';
    var abs = Math.abs(dev);
    var unit = abs === 1 ? 'g' : 'gg';
    return (dev > 0 ? '+' : '-') + abs + ' ' + unit + (dev > 0 ? ' ritardo' : ' anticipo');
  }

  var MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  /** "2026-11-10" -> "10 nov" (same style as Trello's due date chip). */
  function fmtChipDate(iso) {
    return wd.isIso(iso) ? String(+iso.slice(8, 10)) + ' ' + MONTHS[+iso.slice(5, 7) - 1] : '';
  }

  /**
   * Status of the deadline chip, mirroring Trello's colors:
   * - "done"    completed on time or early (green)
   * - "late"    completed late, or open and past the deadline (red)
   * - "soon"    open and due today or on the next calendar day (yellow)
   * - "normal"  open, deadline further away (neutral)
   * - ""        no deadline
   */
  function dueStatus(item, todayIso, holidays) {
    if (!wd.isIso(item.dl)) return '';
    if (item.d) {
      var dev = wd.deviation(item.dl, item.e, holidays);
      return dev !== null && dev > 0 ? 'late' : 'done';
    }
    if (todayIso > item.dl) return 'late';
    if (wd.addDays(todayIso, 1) >= item.dl) return 'soon';
    return 'normal';
  }

  var api = {
    fmtChipDate: fmtChipDate,
    dueStatus: dueStatus,
    normalizeLabel: normalizeLabel,
    resolveClient: resolveClient,
    setClients: setClients,
    NO_CLIENT: NO_CLIENT,
    itemMetrics: itemMetrics,
    checklistTotals: checklistTotals,
    cardTotals: cardTotals,
    fmtNumber: fmtNumber,
    fmtShortDate: fmtShortDate,
    fmtDeviation: fmtDeviation
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.CP = root.CP || {};
    root.CP.calc = api;
  }
})(typeof window !== 'undefined' ? window : this);
