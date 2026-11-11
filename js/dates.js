/**
 * Checklist+ - single-date popover for one item field:
 *   f = "s" (start), "dl" (deadline) or "e" (end).
 * Modeled on Trello's native "Modifica scadenza" popover: month calendar,
 * date input, Salva / Rimuovi. Opened from the card section via t.popup().
 * Saves directly to the card pluginData; the section reloads by itself.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  var store = window.CP.store;
  var calc = window.CP.calc;
  var wd = window.CP.workdays;

  var ID_RE = /^[a-z0-9]{1,12}$/;
  var FIELDS = { s: 'Data di inizio', dl: 'Deadline', e: 'Data di fine' };
  var MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  var WEEKDAYS = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
  var holidays = new Set(); // custom holidays: phase 2

  var form = document.getElementById('cp-dates');
  var gridEl = document.getElementById('cp-cal-grid');
  var titleEl = document.getElementById('cp-cal-title');
  var inputEl = document.getElementById('cp-date-input');
  var infoEl = document.getElementById('cp-info');
  var errorEl = document.getElementById('cp-popup-error');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  // Theme first, without depending on Trello: OS preference as initial guess.
  applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  // Trello client. Any failure is shown in the popover instead of failing silently.
  var t, listId, itemId, field;
  try {
    t = TrelloPowerUp.iframe();
    listId = t.arg('l');
    itemId = t.arg('i');
    field = t.arg('f');
  } catch (err) {
    errorEl.textContent = 'Errore di inizializzazione: ' + (err && err.message ? err.message : String(err));
    errorEl.hidden = false;
    if (window.console) console.error('[Checklist+]', err);
    return;
  }

  var today = wd.todayIso();
  var selected = '';                 // ISO date currently chosen ('' = none)
  var viewYear = +today.slice(0, 4); // month shown in the calendar
  var viewMonth = +today.slice(5, 7) - 1;
  var current = { s: '', dl: '', e: '' }; // the item's stored dates

  function resize() { t.sizeTo('#cp-dates').catch(function () {}); }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
    resize();
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function toDisplay(isoDate) { return wd.isIso(isoDate) ? isoDate.slice(8, 10) + '/' + isoDate.slice(5, 7) + '/' + isoDate.slice(0, 4) : ''; }

  /** "10/11/2026", "10-11-26", "10.11.2026" -> ISO, or '' when invalid. */
  function parseDisplay(text) {
    var m = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\s*$/.exec(text || '');
    if (!m) return '';
    var y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    var out = y + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    return wd.isIso(out) ? out : '';
  }

  /** The item's dates with the pending choice applied. */
  function candidate() {
    var v = { s: current.s, dl: current.dl, e: current.e };
    v[field] = selected;
    return v;
  }

  function validate(v) {
    if (v.s && v.e && v.e < v.s) return 'La data di fine non può precedere la data di inizio (' + toDisplay(v.s) + ').';
    if (v.s && v.dl && v.dl < v.s) return 'La deadline non può precedere la data di inizio (' + toDisplay(v.s) + ').';
    return '';
  }

  function refreshInfo() {
    var v = candidate();
    var parts = [];
    if (wd.isIso(v.s) && wd.isIso(v.e) && v.e >= v.s) {
      parts.push('Giorni lavorativi tra inizio e fine: ' + wd.countWorkdaysBetween(v.s, v.e, holidays));
    }
    var dev = wd.deviation(v.dl, v.e, holidays);
    if (dev !== null) parts.push('Scostamento: ' + calc.fmtDeviation(dev));
    infoEl.textContent = parts.join('. ');
    infoEl.hidden = !parts.length;
  }

  function select(isoDate, keepInput) {
    selected = isoDate;
    if (!keepInput) inputEl.value = toDisplay(isoDate);
    if (isoDate) { viewYear = +isoDate.slice(0, 4); viewMonth = +isoDate.slice(5, 7) - 1; }
    showError('');
    refreshInfo();
    renderCalendar();
  }

  /** Month grid, Monday first, six weeks, with leading/trailing days dimmed. */
  function renderCalendar() {
    titleEl.textContent = MONTHS[viewMonth] + ' ' + viewYear;
    gridEl.textContent = '';
    WEEKDAYS.forEach(function (d) {
      var h = document.createElement('span');
      h.className = 'cp-cal-wd';
      h.textContent = d;
      gridEl.appendChild(h);
    });
    var first = new Date(Date.UTC(viewYear, viewMonth, 1));
    var offset = (first.getUTCDay() + 6) % 7; // Monday = 0
    for (var i = 0; i < 42; i++) {
      var d = new Date(Date.UTC(viewYear, viewMonth, 1 - offset + i));
      var dayIso = iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cp-cal-day' +
        (d.getUTCMonth() !== viewMonth ? ' is-out' : '') +
        (dayIso === today ? ' is-today' : '') +
        (dayIso === selected ? ' is-selected' : '');
      btn.textContent = String(d.getUTCDate());
      btn.setAttribute('aria-label', toDisplay(dayIso));
      if (dayIso === selected) btn.setAttribute('aria-pressed', 'true');
      btn.addEventListener('click', (function (value) { return function () { select(value); }; })(dayIso));
      gridEl.appendChild(btn);
    }
    resize();
  }

  function persist(value) {
    return store.update(t, function (s) {
      var list = (s.l || []).filter(function (l) { return l.i === listId; })[0];
      var item = list && list.x.filter(function (it) { return it.i === itemId; })[0];
      if (!item) throw new Error('Elemento non trovato');
      item[field] = value;
    }).then(function () { return t.closePopup(); }).catch(function (err) {
      showError(err instanceof store.SizeError ? err.message : 'Salvataggio non riuscito, riprova.');
      if (window.console) console.error('[Checklist+]', err);
    });
  }

  if (!ID_RE.test(listId || '') || !ID_RE.test(itemId || '') || !FIELDS.hasOwnProperty(field)) {
    showError('Elemento non valido.');
    return;
  }
  document.getElementById('cp-date-label').textContent = FIELDS[field];
  inputEl.setAttribute('aria-label', FIELDS[field]);

  Array.prototype.forEach.call(document.querySelectorAll('.cp-cal-navbtn'), function (b) {
    b.addEventListener('click', function () {
      var m = viewYear * 12 + viewMonth + parseInt(b.getAttribute('data-nav'), 10);
      viewYear = Math.floor(m / 12);
      viewMonth = m % 12;
      renderCalendar();
    });
  });

  // Typing a date moves the calendar as soon as it is valid.
  inputEl.addEventListener('input', function () {
    var parsed = parseDisplay(inputEl.value);
    if (parsed) select(parsed, true);
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (inputEl.value.trim() && !parseDisplay(inputEl.value)) { showError('Data non valida. Usa il formato G/M/AAAA.'); return; }
    if (inputEl.value.trim()) selected = parseDisplay(inputEl.value);
    if (!selected) { showError('Scegli una data, oppure usa Rimuovi.'); return; }
    var err = validate(candidate());
    if (err) { showError(err); return; }
    showError('');
    persist(selected);
  });

  document.getElementById('cp-clear').addEventListener('click', function () { persist(''); });

  t.render(function () {
    try {
      var passed = t.arg('th');
      var ctx = t.getContext() || {};
      if (passed === 'dark' || passed === 'light') applyTheme(passed);
      else if (ctx.theme || ctx.initialTheme) applyTheme(ctx.theme || ctx.initialTheme);
    } catch (e) { /* keep OS theme */ }

    return store.load(t).then(function (state) {
      var list = state.l.filter(function (l) { return l.i === listId; })[0];
      var item = list && list.x.filter(function (it) { return it.i === itemId; })[0];
      if (!item) { showError('Elemento non trovato, forse è stato eliminato.'); return; }
      current = { s: item.s, dl: item.dl, e: item.e };
      select(item[field] || '');
    }).catch(function (err) {
      showError('Impossibile leggere i dati della card: ' + (err && err.message ? err.message : String(err)));
      if (window.console) console.error('[Checklist+]', err);
    });
  });

  renderCalendar();
})();
