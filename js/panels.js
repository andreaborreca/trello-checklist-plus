/**
 * Checklist+ - popovers drawn INSIDE the card section.
 *
 * Dates, member picker, client, item menu and delete confirmation used to be
 * Trello popovers (t.popup). Opening/closing those made Trello move the focus
 * and scroll the card. These panels live in the section's own iframe, so the
 * card never scrolls, and they always share the section's theme.
 *
 * Security: user text is only written with textContent / input.value.
 */
(function () {
  'use strict';

  var calc = window.CP.calc;
  var wd = window.CP.workdays;
  var people = window.CP.people;

  var PANEL_WIDTH = 304;
  var GAP = 4;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Creates the panel manager for a section.
   * @param {HTMLElement} rootEl   positioned container (#cp-root)
   * @param {function} onLayout    called when the section height may have changed
   */
  function create(rootEl, onLayout) {
    var panel = null;      // current panel element
    var anchor = null;     // { left, top, bottom } relative to rootEl
    var placedAbove = false;
    var minHeight = 0;     // extra section height needed to show the panel

    function close() {
      if (!panel) return;
      panel.remove();
      panel = null;
      minHeight = 0;
      rootEl.style.minHeight = '';
      onLayout();
    }

    /** Places the panel below its anchor, above it if there is no room, else grows the section. */
    function place(keepSide) {
      if (!panel) return;
      var rootW = rootEl.clientWidth;
      var width = Math.min(PANEL_WIDTH, rootW);
      panel.style.width = width + 'px';
      panel.style.left = Math.max(0, Math.min(anchor.left, rootW - width)) + 'px';
      var h = panel.offsetHeight;
      var below = anchor.bottom + GAP;
      var above = anchor.top - GAP - h;
      // Natural height of the section (the panel is absolutely positioned, so it does not count).
      rootEl.style.minHeight = '';
      var natural = rootEl.offsetHeight;
      if (!keepSide) placedAbove = below + h > natural && above >= 0;
      if (placedAbove && above < 0) placedAbove = false;
      panel.style.top = (placedAbove ? above : below) + 'px';
      var needed = placedAbove ? 0 : below + h + 8;
      minHeight = needed > natural ? needed : 0;
      rootEl.style.minHeight = minHeight ? minHeight + 'px' : '';
      onLayout();
    }

    /**
     * Opens a panel.
     * @param {HTMLElement|null} anchorEl  element to anchor to; null reuses the previous anchor
     * @param {string} title
     * @param {function(HTMLElement, object)} build  fills the body; receives { close, reflow }
     */
    function open(anchorEl, title, build) {
      var previous = anchor;
      if (panel) { panel.remove(); panel = null; }
      if (anchorEl) {
        var a = anchorEl.getBoundingClientRect();
        var r = rootEl.getBoundingClientRect();
        anchor = { left: a.left - r.left, top: a.top - r.top, bottom: a.bottom - r.top };
      } else {
        anchor = previous || { left: 0, top: 0, bottom: 0 };
      }
      minHeight = 0;
      rootEl.style.minHeight = '';

      panel = el('div', 'cp-pop');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', title);
      var head = el('div', 'cp-pop-head');
      head.appendChild(el('span', 'cp-pop-title', title));
      var x = button('cp-pop-close', '×', close);
      x.setAttribute('aria-label', 'Chiudi');
      head.appendChild(x);
      var body = el('div', 'cp-pop-body');
      panel.appendChild(head);
      panel.appendChild(body);
      rootEl.appendChild(panel);

      build(body, { close: close, reflow: function () { place(true); } });
      place(false);

      // Focus the first field without scrolling anything.
      var first = panel.querySelector('input, select, textarea, button:not(.cp-pop-close)');
      if (first) first.focus({ preventScroll: true });
    }

    // Close on Escape and on clicks outside the panel.
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && panel) { ev.stopPropagation(); close(); } });
    document.addEventListener('mousedown', function (ev) {
      if (panel && !panel.contains(ev.target)) close();
    });

    return {
      open: open,
      close: close,
      isOpen: function () { return !!panel; },
      minHeight: function () { return minHeight; }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Calendar for one date (like Trello's "Modifica scadenza")          */
  /* ------------------------------------------------------------------ */

  var MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  var WEEKDAYS = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];

  function pad(n) { return String(n).padStart(2, '0'); }
  function toDisplay(iso) { return wd.isIso(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : ''; }

  /** "10/11/2026", "10-11-26", "10.11.2026" -> ISO, or '' when invalid. */
  function parseDisplay(text) {
    var m = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\s*$/.exec(text || '');
    if (!m) return '';
    var y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    var out = y + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    return wd.isIso(out) ? out : '';
  }

  /**
   * @param {object} o  { field: 's'|'dl'|'e', label, current: {s,dl,e}, holidays, onSave(iso), onRemove() }
   */
  function calendar(body, ctl, o) {
    var today = wd.todayIso();
    var selected = o.current[o.field] || '';
    var base = selected || today;
    var viewYear = +base.slice(0, 4);
    var viewMonth = +base.slice(5, 7) - 1;

    var nav = el('div', 'cp-cal-nav');
    var title = el('span', 'cp-cal-title');
    title.setAttribute('aria-live', 'polite');
    function navBtn(text, delta, label) {
      var b = button('cp-cal-navbtn', text, function () {
        var m = viewYear * 12 + viewMonth + delta;
        viewYear = Math.floor(m / 12);
        viewMonth = m % 12;
        draw();
      });
      b.setAttribute('aria-label', label);
      return b;
    }
    nav.appendChild(navBtn('«', -12, 'Anno precedente'));
    nav.appendChild(navBtn('‹', -1, 'Mese precedente'));
    nav.appendChild(title);
    nav.appendChild(navBtn('›', 1, 'Mese successivo'));
    nav.appendChild(navBtn('»', 12, 'Anno successivo'));

    var grid = el('div', 'cp-cal-grid');
    var field = el('label', 'cp-popup-field');
    field.appendChild(el('span', '', o.label));
    var input = el('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = 'G/M/AAAA';
    input.maxLength = 10;
    input.value = toDisplay(selected);
    field.appendChild(input);
    var info = el('p', 'cp-popup-info');
    var error = el('p', 'cp-error');
    error.hidden = true;

    function candidate() {
      var v = { s: o.current.s, dl: o.current.dl, e: o.current.e };
      v[o.field] = selected;
      return v;
    }

    function validate(v) {
      if (v.s && v.e && v.e < v.s) return 'La data di fine non può precedere la data di inizio (' + toDisplay(v.s) + ').';
      if (v.s && v.dl && v.dl < v.s) return 'La deadline non può precedere la data di inizio (' + toDisplay(v.s) + ').';
      return '';
    }

    function showError(msg) { error.textContent = msg; error.hidden = !msg; ctl.reflow(); }

    function refreshInfo() {
      var v = candidate();
      var parts = [];
      if (wd.isIso(v.s) && wd.isIso(v.e) && v.e >= v.s) parts.push('Giorni lavorativi tra inizio e fine: ' + wd.countWorkdaysBetween(v.s, v.e, o.holidays));
      var dev = wd.deviation(v.dl, v.e, o.holidays);
      if (dev !== null) parts.push('Scostamento: ' + calc.fmtDeviation(dev));
      info.textContent = parts.join('. ');
      info.hidden = !parts.length;
    }

    function select(iso, keepInput) {
      selected = iso;
      if (!keepInput) input.value = toDisplay(iso);
      if (iso) { viewYear = +iso.slice(0, 4); viewMonth = +iso.slice(5, 7) - 1; }
      error.hidden = true;
      refreshInfo();
      draw();
    }

    /** Month grid, Monday first, six weeks, days of other months dimmed. */
    function draw() {
      title.textContent = MONTHS[viewMonth] + ' ' + viewYear;
      grid.textContent = '';
      WEEKDAYS.forEach(function (d) { grid.appendChild(el('span', 'cp-cal-wd', d)); });
      var offset = (new Date(Date.UTC(viewYear, viewMonth, 1)).getUTCDay() + 6) % 7; // Monday = 0
      for (var i = 0; i < 42; i++) {
        var d = new Date(Date.UTC(viewYear, viewMonth, 1 - offset + i));
        var dayIso = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
        var b = button('cp-cal-day' + (d.getUTCMonth() !== viewMonth ? ' is-out' : '') + (dayIso === today ? ' is-today' : '') + (dayIso === selected ? ' is-selected' : ''),
          String(d.getUTCDate()), (function (value) { return function () { select(value); }; })(dayIso));
        b.setAttribute('aria-label', toDisplay(dayIso));
        grid.appendChild(b);
      }
      ctl.reflow();
    }

    input.addEventListener('input', function () {
      var parsed = parseDisplay(input.value);
      if (parsed) select(parsed, true);
    });

    function submit() {
      if (input.value.trim() && !parseDisplay(input.value)) { showError('Data non valida. Usa il formato G/M/AAAA.'); return; }
      if (input.value.trim()) selected = parseDisplay(input.value);
      if (!selected) { showError('Scegli una data, oppure usa Rimuovi.'); return; }
      var err = validate(candidate());
      if (err) { showError(err); return; }
      o.onSave(selected);
    }
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });

    body.appendChild(nav);
    body.appendChild(grid);
    body.appendChild(field);
    body.appendChild(info);
    body.appendChild(error);
    body.appendChild(button('cp-btn cp-btn-primary cp-btn-block', 'Salva', submit));
    body.appendChild(button('cp-btn cp-btn-block', 'Rimuovi', function () { o.onRemove(); }));
    body.classList.add('cp-cal-popup');
    refreshInfo();
    draw();
  }

  /* ------------------------------------------------------------------ */
  /* Member picker (like Trello's "Assegna", grouped by work area)      */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} o  { members, areas: {memberId: areaKey}, assigned, onPick(memberId|'') }
   */
  function memberPicker(body, ctl, o) {
    var search = el('input', 'cp-member-search');
    search.type = 'text';
    search.placeholder = 'Cerca membri';
    search.setAttribute('aria-label', 'Cerca membri');
    var list = el('div', 'cp-member-list');

    function row(member) {
      var b = button('cp-member-row' + (member.id === o.assigned ? ' is-assigned' : ''), undefined, function () {
        // Clicking the assigned member again removes the assignment, as in Trello.
        o.onPick(member.id === o.assigned ? '' : member.id);
      });
      b.appendChild(people.avatarNode(member, 'cp-avatar cp-avatar-lg'));
      b.appendChild(el('span', 'cp-member-name', people.displayName(member)));
      if (member.id === o.assigned) {
        var check = el('span', 'cp-member-check', '✓');
        check.setAttribute('aria-label', 'Assegnato');
        b.appendChild(check);
      }
      return b;
    }

    function draw() {
      var query = search.value.trim().toLowerCase();
      var visible = o.members.filter(function (m) { return !query || people.displayName(m).toLowerCase().indexOf(query) >= 0; });
      list.textContent = '';
      if (!Object.keys(o.areas).length) {
        list.appendChild(el('div', 'cp-member-group', 'Membri della bacheca'));
        visible.forEach(function (m) { list.appendChild(row(m)); });
      } else {
        people.AREAS.forEach(function (a) {
          var group = visible.filter(function (m) { return o.areas[m.id] === a.k; });
          if (!group.length) return;
          list.appendChild(el('div', 'cp-member-group', a.n));
          group.forEach(function (m) { list.appendChild(row(m)); });
        });
        var rest = visible.filter(function (m) { return !o.areas[m.id]; });
        if (rest.length) {
          list.appendChild(el('div', 'cp-member-group', 'Altri membri'));
          rest.forEach(function (m) { list.appendChild(row(m)); });
        }
      }
      if (!visible.length) list.appendChild(el('p', 'cp-popup-info', 'Nessun membro trovato.'));
      ctl.reflow();
    }

    search.addEventListener('input', draw);
    body.appendChild(search);
    body.appendChild(list);
    if (o.assigned) {
      var remove = button('cp-btn cp-btn-block', 'Rimuovi membro', function () { o.onPick(''); });
      remove.id = 'cp-member-remove';
      body.appendChild(remove);
    }
    draw();
  }

  /* ------------------------------------------------------------------ */
  /* Client of a checklist                                              */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} o  { title, clients: string[], value: list.c, onSave(value) }
   */
  function clientPicker(body, ctl, o) {
    var clients = o.clients.slice();
    var selected = [];
    var mode = 'auto';
    if (o.value === calc.NO_CLIENT) mode = 'none';
    else if (o.value) {
      mode = 'manual';
      selected = o.value.split(' + ').map(calc.normalizeLabel);
      // Keep explicit values no longer in the board list visible and selectable.
      selected.forEach(function (c) { if (c && clients.indexOf(c) < 0) clients.push(c); });
    }

    var radios = {};
    function option(key, text) {
      var label = el('label', 'cp-export-month');
      var input = el('input');
      input.type = 'radio';
      input.name = 'cp-client-mode';
      input.checked = mode === key;
      input.addEventListener('change', function () { mode = key; });
      radios[key] = input;
      label.appendChild(input);
      label.appendChild(el('span', '', text));
      return label;
    }

    var detected = calc.resolveClient({ n: o.title }).value;
    body.appendChild(option('auto', 'Automatico dal titolo: ' + (detected || 'nessun cliente riconosciuto')));
    body.appendChild(option('none', 'Nessun cliente (attività interna)'));
    body.appendChild(option('manual', 'Scelgo io (anche più di uno):'));

    var list = el('div', 'cp-client-list');
    clients.forEach(function (c) {
      var label = el('label', 'cp-export-month');
      var input = el('input');
      input.type = 'checkbox';
      input.value = c;
      input.checked = selected.indexOf(c) >= 0;
      input.addEventListener('change', function () { mode = 'manual'; radios.manual.checked = true; });
      label.appendChild(input);
      label.appendChild(el('span', '', c));
      list.appendChild(label);
    });
    body.appendChild(list);
    if (!clients.length) body.appendChild(el('p', 'cp-popup-info', 'L\'elenco dei clienti è vuoto: aggiungili dal pulsante Checklist+ della bacheca, voce "Clienti della bacheca".'));

    var error = el('p', 'cp-error');
    error.hidden = true;
    body.appendChild(error);
    body.appendChild(button('cp-btn cp-btn-primary cp-btn-block', 'Salva', function () {
      var value = '';
      if (mode === 'none') value = calc.NO_CLIENT;
      else if (mode === 'manual') {
        var picked = Array.prototype.map.call(list.querySelectorAll('input:checked'), function (i) { return i.value; });
        if (!picked.length) { error.textContent = 'Spunta almeno un cliente, oppure scegli un\'altra opzione.'; error.hidden = false; ctl.reflow(); return; }
        value = picked.join(' + ').slice(0, 60);
      }
      o.onSave(value);
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Small menu and confirmation                                        */
  /* ------------------------------------------------------------------ */

  /** @param {Array<{text:string, danger?:boolean, action:function}>} items */
  function menu(body, ctl, items) {
    items.forEach(function (it) {
      body.appendChild(button('cp-pop-item' + (it.danger ? ' is-danger' : ''), it.text, it.action));
    });
    body.classList.add('cp-pop-menu');
  }

  /** @param {object} o  { message, confirmText, onConfirm() } */
  function confirm(body, ctl, o) {
    body.appendChild(el('p', 'cp-pop-message', o.message));
    body.appendChild(button('cp-btn cp-btn-danger cp-btn-block', o.confirmText, o.onConfirm));
    body.appendChild(button('cp-btn cp-btn-block', 'Annulla', ctl.close));
  }

  /* ------------------------------------------------------------------ */
  /* Import of native checklists                                        */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} o  { natives, existing: normalized names already in Checklist+,
   *                      onImport(ids, endFor) -> '' on success or an error message }
   */
  function importer(body, ctl, o) {
    var available = o.natives.reduce(function (n, c) { return n + (c.checkItems || []).length; }, 0);
    if (!available) {
      // Trello sent the checklists without their items (or no checklists at all).
      body.appendChild(el('p', 'cp-pop-message', o.natives.length
        ? 'Trello ha indicato ' + o.natives.length + ' checklist native, ma non ha fornito i loro elementi al Power-Up.'
        : 'Trello non ha fornito al Power-Up le checklist native di questa card' + (o.badgeItems ? ' (' + o.badgeItems + ' elementi secondo il badge).' : '.')));
      if (!o.canFetch) {
        body.appendChild(el('p', 'cp-popup-info', 'Per importarle serve la lettura tramite API di Trello: manca la API key del Power-Up in js/config.js.'));
        return;
      }
      body.appendChild(el('p', 'cp-popup-info', 'Si possono leggere con l\'API di Trello: si apre la finestra di autorizzazione di Trello, con accesso in sola lettura che scade dopo un\'ora. L\'autorizzazione viene eliminata subito dopo la lettura.'));
      var fetchError = el('p', 'cp-error');
      fetchError.hidden = true;
      var fetchBtn = button('cp-btn cp-btn-primary cp-btn-block', 'Autorizza e leggi da Trello', function () {
        fetchBtn.disabled = true;
        fetchBtn.textContent = 'Lettura in corso...';
        fetchError.hidden = true;
        o.onFetch().catch(function (err) {
          fetchBtn.disabled = false;
          fetchBtn.textContent = 'Autorizza e leggi da Trello';
          var denied = err && /denied|deny|negat/i.test(String(err.name || '') + String(err.message || ''));
          fetchError.textContent = denied ? 'Autorizzazione annullata.' : 'Lettura non riuscita' + (err && err.message ? ': ' + err.message : '') + '.';
          fetchError.hidden = false;
          ctl.reflow();
          if (window.console) console.error('[Checklist+]', err);
        });
      });
      body.appendChild(fetchError);
      body.appendChild(fetchBtn);
      return;
    }
    body.appendChild(el('p', 'cp-popup-info', 'Le checklist scelte diventano Checklist+ con testo, stato, membro e deadline degli elementi. Su Trello non viene eliminato nulla.'));

    var list = el('div', 'cp-client-list cp-import-list');
    o.natives.forEach(function (n) {
      var items = n.checkItems || [];
      var done = items.filter(function (ci) { return ci.state === 'complete'; }).length;
      var present = o.existing.indexOf(calc.normalizeLabel(n.name)) >= 0;
      var label = el('label', 'cp-export-month');
      var input = el('input');
      input.type = 'checkbox';
      input.value = n.id;
      input.checked = !present; // a checklist with the same name is probably already imported
      label.appendChild(input);
      label.appendChild(el('span', '', n.name + ' (' + done + '/' + items.length + ')' + (present ? ', stesso nome di una Checklist+: spuntala per importarla comunque' : '')));
      list.appendChild(label);
    });
    body.appendChild(list);

    var field = el('label', 'cp-popup-field');
    field.appendChild(el('span', '', 'Data di fine degli elementi già completati'));
    var select = el('select');
    var options = [['empty', 'Vuota, la compilo io'], ['deadline', 'Uguale alla deadline'], ['today', 'Oggi']];
    if (o.fromApi) options.unshift(['checked', 'Data in cui è stato spuntato (da Trello)']);
    options.forEach(function (p) {
      var opt = el('option', '', p[1]);
      opt.value = p[0];
      select.appendChild(opt);
    });
    field.appendChild(select);
    body.appendChild(field);
    body.appendChild(el('p', 'cp-popup-info', (o.fromApi ? 'La data della spunta viene dalla cronologia della card; se manca, la fine resta vuota.' : 'Trello non indica al Power-Up quando un elemento è stato spuntato.') + ' Da qui in poi, la spunta in Checklist+ imposta la data di fine a oggi.'));

    var error = el('p', 'cp-error');
    error.hidden = true;
    body.appendChild(error);
    body.appendChild(button('cp-btn cp-btn-primary cp-btn-block', 'Importa', function () {
      var ids = Array.prototype.map.call(list.querySelectorAll('input:checked'), function (i) { return i.value; });
      var msg = ids.length ? o.onImport(ids, select.value) : 'Seleziona almeno una checklist.';
      if (msg) { error.textContent = msg; error.hidden = false; ctl.reflow(); }
    }));
  }

  window.CP.panels = {
    create: create, calendar: calendar, memberPicker: memberPicker,
    clientPicker: clientPicker, menu: menu, confirm: confirm, importer: importer
  };
})();
