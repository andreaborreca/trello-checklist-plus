/**
 * Checklist+ - dates popover (start, deadline, end) for a single item.
 * Opened from the card back section via t.popup({ url: './dates.html', args }).
 * Saves directly to the card pluginData; the section reloads by itself.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  var t = TrelloPowerUp.iframe();
  var store = window.CP.store;
  var calc = window.CP.calc;
  var wd = window.CP.workdays;

  var ID_RE = /^[a-z0-9]{1,12}$/;
  var listId = t.arg('l');
  var itemId = t.arg('i');
  var holidays = new Set(); // custom holidays: phase 2

  var form = document.getElementById('cp-dates');
  var inputs = { s: document.getElementById('cp-s'), dl: document.getElementById('cp-dl'), e: document.getElementById('cp-e') };
  var infoEl = document.getElementById('cp-info');
  var errorEl = document.getElementById('cp-popup-error');

  function resize() { t.sizeTo('#cp-dates').catch(function () {}); }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
    resize();
  }

  function values() {
    return { s: inputs.s.value, dl: inputs.dl.value, e: inputs.e.value };
  }

  /** Validation messages for inconsistent dates (empty = valid). */
  function validate(v) {
    if (v.s && v.e && v.e < v.s) return 'La data di fine non può precedere la data di inizio.';
    if (v.s && v.dl && v.dl < v.s) return 'La deadline non può precedere la data di inizio.';
    return '';
  }

  /** Live summary: working days between start and end, deviation from deadline. */
  function refreshInfo() {
    var v = values();
    var parts = [];
    if (wd.isIso(v.s) && wd.isIso(v.e) && v.e >= v.s) {
      parts.push('Giorni lavorativi tra inizio e fine: ' + wd.countWorkdaysBetween(v.s, v.e, holidays));
    }
    var dev = wd.deviation(v.dl, v.e, holidays);
    if (dev !== null) parts.push('Scostamento: ' + calc.fmtDeviation(dev));
    infoEl.textContent = parts.join('. ');
    infoEl.hidden = !parts.length;
    resize();
  }

  function persist(v) {
    return store.update(t, function (s) {
      var list = (s.l || []).filter(function (l) { return l.i === listId; })[0];
      var item = list && list.x.filter(function (it) { return it.i === itemId; })[0];
      if (!item) throw new Error('Elemento non trovato');
      item.s = v.s;
      item.dl = v.dl;
      item.e = v.e;
    }).then(function () { return t.closePopup(); }).catch(function (err) {
      showError(err instanceof store.SizeError ? err.message : 'Salvataggio non riuscito, riprova.');
      if (window.console) console.error('[Checklist+]', err);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  try {
    var ctx = t.getContext() || {};
    applyTheme(ctx.theme || ctx.initialTheme);
  } catch (e) { applyTheme('light'); }

  if (!ID_RE.test(listId || '') || !ID_RE.test(itemId || '')) {
    showError('Elemento non valido.');
    return;
  }

  Object.keys(inputs).forEach(function (k) { inputs[k].addEventListener('change', refreshInfo); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = values();
    var err = validate(v);
    if (err) { showError(err); return; }
    showError('');
    persist(v);
  });

  document.getElementById('cp-clear').addEventListener('click', function () {
    persist({ s: '', dl: '', e: '' });
  });

  t.render(function () {
    return store.load(t).then(function (state) {
      var list = state.l.filter(function (l) { return l.i === listId; })[0];
      var item = list && list.x.filter(function (it) { return it.i === itemId; })[0];
      if (!item) { showError('Elemento non trovato, forse è stato eliminato.'); return; }
      inputs.s.value = item.s;
      inputs.dl.value = item.dl;
      inputs.e.value = item.e;
      refreshInfo();
    });
  });
})();
