/**
 * Checklist+ - working days utilities.
 * Pure functions, no DOM access: shared by the browser (window.CP.workdays)
 * and by the Node test suite (module.exports).
 *
 * All dates are ISO strings "YYYY-MM-DD" and are handled in UTC to avoid
 * daylight-saving shifts when adding days.
 */
(function (root) {
  'use strict';

  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  var DAY_MS = 86400000;

  // Cache of national holidays per year (Set of ISO strings).
  var holidayCache = {};

  /** Returns true when the value is a well-formed ISO date string. */
  function isIso(value) {
    if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
    var d = toDate(value);
    return toIso(d) === value; // rejects impossible dates like 2026-02-31
  }

  /** ISO string -> UTC Date. */
  function toDate(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  /** UTC Date -> ISO string. */
  function toIso(date) {
    return date.toISOString().slice(0, 10);
  }

  /** Adds n days to an ISO date. */
  function addDays(iso, n) {
    return toIso(new Date(toDate(iso).getTime() + n * DAY_MS));
  }

  /** Today's date in the user's local timezone, as ISO. */
  function todayIso() {
    var now = new Date();
    var m = String(now.getMonth() + 1).padStart(2, '0');
    var d = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + m + '-' + d;
  }

  /**
   * Easter Sunday (Gregorian calendar), anonymous Gregorian algorithm
   * (Meeus/Jones/Butcher).
   */
  function easterSunday(year) {
    var a = year % 19;
    var b = Math.floor(year / 100);
    var c = year % 100;
    var d = Math.floor(b / 4);
    var e = b % 4;
    var f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4);
    var k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31);
    var day = ((h + l - 7 * m + 114) % 31) + 1;
    return toIso(new Date(Date.UTC(year, month - 1, day)));
  }

  /**
   * Italian national non-working holidays for a given year.
   * Includes 4 October (San Francesco), national holiday since 2026
   * (Legge 8 ottobre 2025, n. 151).
   */
  function nationalHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    var y = String(year);
    var list = [
      y + '-01-01', // Capodanno
      y + '-01-06', // Epifania
      addDays(easterSunday(year), 1), // Lunedi dell'Angelo (Pasquetta)
      y + '-04-25', // Liberazione
      y + '-05-01', // Festa dei lavoratori
      y + '-06-02', // Festa della Repubblica
      y + '-08-15', // Ferragosto
      y + '-11-01', // Ognissanti
      y + '-12-08', // Immacolata
      y + '-12-25', // Natale
      y + '-12-26'  // Santo Stefano
    ];
    if (year >= 2026) list.push(y + '-10-04'); // San Francesco
    holidayCache[year] = new Set(list);
    return holidayCache[year];
  }

  /**
   * True when the date is a working day: not Saturday/Sunday, not a national
   * holiday, not in the optional custom holiday set (patron saint, company days).
   */
  function isWorkday(iso, customHolidays) {
    var dow = toDate(iso).getUTCDay();
    if (dow === 0 || dow === 6) return false;
    if (nationalHolidays(+iso.slice(0, 4)).has(iso)) return false;
    if (customHolidays && customHolidays.has(iso)) return false;
    return true;
  }

  /**
   * Counts working days in the half-open interval (fromIso, toIso].
   * Returns 0 when toIso <= fromIso. Capped at ~10 years for safety.
   */
  function countWorkdaysAfter(fromIso, toIso, customHolidays) {
    if (toIso <= fromIso) return 0;
    var count = 0;
    var cursor = addDays(fromIso, 1);
    var guard = 0;
    while (cursor <= toIso && guard < 3700) {
      if (isWorkday(cursor, customHolidays)) count++;
      cursor = addDays(cursor, 1);
      guard++;
    }
    return count;
  }

  /** Working days in the closed interval [startIso, endIso]. */
  function countWorkdaysBetween(startIso, endIso, customHolidays) {
    return countWorkdaysAfter(addDays(startIso, -1), endIso, customHolidays);
  }

  /**
   * Deviation between actual end date and deadline, in working days.
   * Negative = finished early, positive = late, 0 = on time.
   * Returns null when either date is missing.
   */
  function deviation(deadlineIso, endIso, customHolidays) {
    if (!isIso(deadlineIso) || !isIso(endIso)) return null;
    if (endIso === deadlineIso) return 0;
    if (endIso > deadlineIso) return countWorkdaysAfter(deadlineIso, endIso, customHolidays);
    // "0 - n" instead of "-n" avoids returning -0 (which would render as "early")
    return 0 - countWorkdaysAfter(endIso, deadlineIso, customHolidays);
  }

  var api = {
    isIso: isIso,
    addDays: addDays,
    todayIso: todayIso,
    easterSunday: easterSunday,
    nationalHolidays: nationalHolidays,
    isWorkday: isWorkday,
    countWorkdaysAfter: countWorkdaysAfter,
    countWorkdaysBetween: countWorkdaysBetween,
    deviation: deviation
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.CP = root.CP || {};
    root.CP.workdays = api;
  }
})(typeof window !== 'undefined' ? window : this);
