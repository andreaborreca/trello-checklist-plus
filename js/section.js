/**
 * Checklist+ - card back section UI, styled after Trello's native checklist.
 *
 * Item row: checkbox, text, deadline chip, member avatar, "..." menu, and a
 * second line with start, end, deviation and worked days. Dates, members,
 * client, menus and confirmations open as panels inside the section
 * (panels.js), so the card never scrolls.
 *
 * Saving: every change is an operation (ops.js) applied at once to the local
 * state (optimistic UI) and written by a queue that merges quick changes into
 * one write and keeps a journal, because Trello reloads this iframe after
 * every t.set(). UI state (open editor, drafts) also survives the reload.
 *
 * Security notes:
 * - User text is only ever written via textContent / input.value; innerHTML
 *   is never used with data. Icons are built from fixed SVG paths.
 * - Stored data is sanitized by CP.store before rendering.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  // The app key enables t.getRestApi(), used only to import native checklists.
  var cfg = window.CP.config || {};
  var t = cfg.appKey ? TrelloPowerUp.iframe({ appKey: cfg.appKey, appName: cfg.appName }) : TrelloPowerUp.iframe();
  var store = window.CP.store;
  var calc = window.CP.calc;
  var wd = window.CP.workdays;
  var ops = window.CP.ops;
  var people = window.CP.people;

  var context = {};
  try { context = t.getContext() || {}; } catch (e) { context = {}; }
  var cardId = context.card || '';

  var state = store.emptyState();
  var teamAreas = {};      // member id -> area key (for the member picker)
  var boardClients = [];   // client list of the board (for detection and the new-checklist form)
  var members = [];
  var natives = [];        // native Trello checklists of this card (for the import)
  var nativeBadgeCount = 0; // native checklist items according to the card badges
  var nativesFromApi = false; // items read through the REST API (with completion dates)
  // Custom holidays (patron saint, company days): configurable in a later phase.
  var holidays = new Set();

  var listsEl = document.getElementById('cp-lists');
  var newListEl = document.getElementById('cp-new-list');
  var errorEl = document.getElementById('cp-error');
  var sizeEl = document.getElementById('cp-size');
  var rootEl = document.getElementById('cp-root');

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                        */
  /* ------------------------------------------------------------------ */

  function el(tag, opts, children) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) node.className = opts.cls;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (k) {
        if (opts.attrs[k] !== null && opts.attrs[k] !== undefined) node.setAttribute(k, opts.attrs[k]);
      });
    }
    if (opts.value !== undefined) node.value = opts.value;
    if (opts.on) {
      Object.keys(opts.on).forEach(function (evt) { node.addEventListener(evt, opts.on[evt]); });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // Fixed icon paths (24x24 viewBox). Never built from user data.
  var ICONS = {
    person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z',
    dots: 'M6 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zm6 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zm6 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z'
  };
  var STROKE_ICONS = {
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 6l6 6-6 6',
    clock: 'M12 3.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 1 0 0-16.5zM12 7.5V12l3 2'
  };

  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'cp-icon cp-icon-' + name);
    var path = document.createElementNS(ns, 'path');
    if (STROKE_ICONS[name]) {
      path.setAttribute('d', STROKE_ICONS[name]);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    } else {
      path.setAttribute('d', ICONS[name]);
      path.setAttribute('fill', 'currentColor');
    }
    svg.appendChild(path);
    return svg;
  }

  /* ------------------------------------------------------------------ */
  /* Storage helpers and per-viewer preferences                         */
  /* ------------------------------------------------------------------ */

  function readStore(storage, key, fallback) {
    try {
      var raw = window[storage].getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeStore(storage, key, value) {
    try {
      if (value === null) window[storage].removeItem(key);
      else window[storage].setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable */ }
  }

  function readLocal(key, fallback) { return readStore('localStorage', key, fallback); }
  function writeLocal(key, value) { writeStore('localStorage', key, value); }

  function toggleIn(key, id, force) {
    var list = readLocal(key, []);
    var idx = list.indexOf(id);
    var on = force === undefined ? idx < 0 : force;
    if (on && idx < 0) list.push(id);
    if (!on && idx >= 0) list.splice(idx, 1);
    writeLocal(key, list);
  }

  // Collapsed checklists and hidden completed items: personal, this browser only.
  function collapsedKey() { return 'cp-collapsed-' + cardId; }
  function isCollapsed(listId) { return readLocal(collapsedKey(), []).indexOf(listId) >= 0; }
  function toggleCollapsed(listId) { toggleIn(collapsedKey(), listId); render(); }

  function hiddenKey() { return 'cp-hide-done-' + cardId; }
  function isHidingDone(listId) { return readLocal(hiddenKey(), []).indexOf(listId) >= 0 && !forceShow[listId]; }
  function toggleHidingDone(listId) { delete forceShow[listId]; toggleIn(hiddenKey(), listId); render(); }
  var forceShow = {}; // lists temporarily showing done items (task opened from "I miei task")

  /* ------------------------------------------------------------------ */
  /* UI state: one active editor at a time, drafts, kept across reloads */
  /* ------------------------------------------------------------------ */

  // active: null | {k:'item', i} | {k:'title', l} | {k:'add', l} | {k:'newList'}
  var ui = readStore('sessionStorage', 'cp-ui-' + cardId, null) || {};
  var active = ui.active || null;
  var drafts = ui.drafts || {};
  var activeEditor = null; // { key, box, hidden: [nodes] } of the rendered editor

  function editorKey(a) { return a ? a.k + ':' + (a.i || a.l || '') : ''; }
  function isActive(k, id) { return !!active && active.k === k && (active.i === id || active.l === id || (!active.i && !active.l && !id)); }

  function persistUi() {
    var keep = {};
    Object.keys(drafts).forEach(function (k) { if (drafts[k]) keep[k] = drafts[k]; });
    writeStore('sessionStorage', 'cp-ui-' + cardId, { active: active, drafts: keep });
  }

  function setActive(a) {
    active = a;
    persistUi();
    render();
  }

  /** Closes the open editor without rebuilding the section (the draft is kept). */
  function closeEditorInPlace() {
    if (!activeEditor) return;
    activeEditor.box.remove();
    activeEditor.hidden.forEach(function (n) { n.style.display = ''; });
    activeEditor = null;
    active = null;
    persistUi();
    resize();
  }

  // A click outside the open editor closes it, before the clicked control
  // reacts: so a click on another element opens that one at the first try.
  document.addEventListener('click', function (ev) {
    if (suppressClick) { suppressClick = false; ev.stopPropagation(); ev.preventDefault(); return; }
    if (!activeEditor || !ev.target || !ev.target.closest) return;
    if (activeEditor.box.contains(ev.target) || ev.target.closest('.cp-pop')) return;
    closeEditorInPlace();
  }, true);

  /**
   * Inline editor with Salva/Annulla, like Trello's. Drafts survive a click
   * outside and the iframe reload; Annulla and Esc discard them.
   */
  function inlineEditor(a, value, maxLength, onSave, opts) {
    opts = opts || {};
    var key = editorKey(a);
    var area = el('textarea', {
      cls: 'cp-edit-text',
      value: drafts.hasOwnProperty(key) ? drafts[key] : value,
      attrs: { maxlength: String(maxLength), rows: '2', placeholder: opts.placeholder || null, 'data-fkey': 'editor' }
    });
    function cancel() { delete drafts[key]; setActive(null); }
    function submit() {
      var v = area.value.replace(/\s+/g, ' ').trim();
      delete drafts[key];
      if (!v) { setActive(opts.keepOpen ? a : null); return; }
      onSave(v);
    }
    area.addEventListener('input', function () { drafts[key] = area.value; persistUi(); });
    area.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); }
    });
    var box = el('div', { cls: 'cp-edit' }, [
      area,
      opts.extra || null,
      el('div', { cls: 'cp-edit-actions' }, [
        el('button', { cls: 'cp-btn cp-btn-primary', text: opts.saveText || 'Salva', attrs: { type: 'button' }, on: { click: submit } }),
        el('button', { cls: 'cp-btn cp-btn-subtle', text: 'Annulla', attrs: { type: 'button' }, on: { click: cancel } })
      ])
    ]);
    return box;
  }

  /** Shows `box` in place of `hidden` nodes and registers it as the open editor. */
  function mountEditor(box, before, hidden) {
    hidden.forEach(function (n) { if (n) n.style.display = 'none'; });
    before.parentNode.insertBefore(box, before);
    activeEditor = { key: editorKey(active), box: box, hidden: hidden.filter(Boolean) };
  }

  /* ------------------------------------------------------------------ */
  /* Persistence: operations + save queue (ops.js)                      */
  /* ------------------------------------------------------------------ */

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
    resize();
  }

  function reportError(err) {
    if (err && err.name === 'SizeError') showError(err.message + ' Elimina qualche elemento o accorcia i testi.');
    else showError('Salvataggio non riuscito: le ultime modifiche non sono state salvate. Riprova tra qualche secondo.');
    if (window.console) console.error('[Checklist+]', err);
  }

  var lastRendered = '';
  var queue = ops.createQueue({
    load: function () { return store.load(t); },
    write: function (mutate) { return store.update(t, mutate); },
    journal: {
      read: function () { return readStore('sessionStorage', 'cp-journal-' + cardId, []); },
      write: function (entries) { writeStore('sessionStorage', 'cp-journal-' + cardId, entries.length ? entries : null); }
    },
    onChange: function (s) {
      state = store.sanitize(s);
      // Re-render only when something visible changed (e.g. another user's edit).
      if (JSON.stringify(state) !== lastRendered) render();
    },
    onError: function (err) { reportError(err); }
  });

  /** Applies a change immediately on screen and queues it for saving. */
  function apply(op) {
    showError('');
    var next = store.sanitize(ops.apply(JSON.parse(JSON.stringify(state)), op));
    var size = store.sizeOf(next);
    if (size > store.SAFE_LIMIT && size > store.sizeOf(state)) {
      reportError(new store.SizeError(size));
      return false;
    }
    queue.push(op);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Panels inside the section (see panels.js)                          */
  /* ------------------------------------------------------------------ */

  var panelsApi = window.CP.panels;
  var panels = panelsApi.create(rootEl, function () { resize(); });

  var DATE_TITLES = { s: 'Data di inizio', dl: 'Deadline', e: 'Data di fine' };

  function anchorOf(ev) { return ev && ev.currentTarget ? ev.currentTarget : null; }

  function setField(item, field, value) {
    var f = {};
    f[field] = value;
    apply({ k: 'set', i: item.i, f: f });
  }

  function openDates(ev, item, field) {
    panels.open(anchorOf(ev), DATE_TITLES[field], function (body, ctl) {
      panelsApi.calendar(body, ctl, {
        field: field,
        label: DATE_TITLES[field],
        current: { s: item.s, dl: item.dl, e: item.e },
        holidays: holidays,
        onSave: function (iso) { panels.close(); setField(item, field, iso); },
        onRemove: function () { panels.close(); setField(item, field, ''); }
      });
    });
  }

  function openMembers(ev, item) {
    panels.open(anchorOf(ev), 'Assegna', function (body, ctl) {
      panelsApi.memberPicker(body, ctl, {
        members: members,
        areas: teamAreas,
        assigned: item.m || '',
        onPick: function (memberId) { panels.close(); setField(item, 'm', memberId); }
      });
    });
  }

  function confirmDelete(ev, title, message, op) {
    panels.open(anchorOf(ev), title, function (body, ctl) {
      panelsApi.confirm(body, ctl, {
        message: message,
        confirmText: 'Elimina',
        onConfirm: function () { panels.close(); apply(op); }
      });
    });
  }

  function moveItemBy(list, item, delta) {
    var idx = list.x.indexOf(item);
    var to = idx + delta;
    if (idx < 0 || to < 0 || to >= list.x.length) return;
    apply({ k: 'moveItem', i: item.i, to: list.i, index: to });
    focusAfterRender = 'text:' + item.i;
  }

  function moveListBy(list, delta) {
    var idx = state.l.indexOf(list);
    var to = idx + delta;
    if (idx < 0 || to < 0 || to >= state.l.length) return;
    apply({ k: 'moveList', l: list.i, index: to });
    focusAfterRender = 'title:' + list.i;
  }

  function openItemMenu(ev, list, item) {
    var idx = list.x.indexOf(item);
    var others = state.l.filter(function (l) { return l.i !== list.i; });
    panels.open(anchorOf(ev), 'Azioni elemento', function (body, ctl) {
      panelsApi.menu(body, ctl, [
        { text: 'Data di inizio...', action: function () { openDates(null, item, 's'); } },
        { text: 'Deadline...', action: function () { openDates(null, item, 'dl'); } },
        { text: 'Data di fine...', action: function () { openDates(null, item, 'e'); } },
        { text: 'Assegna...', action: function () { openMembers(null, item); } },
        idx > 0 ? { text: 'Sposta su', action: function () { panels.close(); moveItemBy(list, item, -1); } } : null,
        idx < list.x.length - 1 ? { text: 'Sposta giù', action: function () { panels.close(); moveItemBy(list, item, 1); } } : null,
        others.length ? {
          text: 'Sposta in un\'altra checklist...',
          action: function () {
            panels.open(null, 'Sposta in', function (b, c) {
              panelsApi.menu(b, c, others.map(function (l) {
                return { text: l.n, action: function () { panels.close(); apply({ k: 'moveItem', i: item.i, to: l.i, index: l.x.length }); } };
              }));
            });
          }
        } : null,
        {
          text: 'Elimina', danger: true,
          action: function () { confirmDelete(null, 'Eliminare l\'elemento?', 'L\'eliminazione non si può annullare.', { k: 'delItem', i: item.i }); }
        }
      ].filter(Boolean));
    });
  }

  function openClient(ev, list) {
    panels.open(anchorOf(ev), 'Cliente', function (body, ctl) {
      panelsApi.clientPicker(body, ctl, {
        title: list.n,
        clients: boardClients,
        value: list.c || '',
        onSave: function (value) { panels.close(); apply({ k: 'list', l: list.i, f: { c: value } }); }
      });
    });
  }

  /** Native checklists -> Checklist+ (one-off conversion, nothing is deleted in Trello). */
  function openImport(ev) {
    var names = state.l.map(function (l) { return calc.normalizeLabel(l.n); });
    panels.open(anchorOf(ev), 'Importa checklist native', function (body, ctl) {
      panelsApi.importer(body, ctl, {
        natives: natives,
        badgeItems: nativeBadgeCount,
        canFetch: window.CP.trelloapi.isConfigured(),
        fromApi: nativesFromApi,
        onFetch: function () {
          return window.CP.trelloapi.readNativeChecklists(t, cardId).then(function (lists) {
            natives = lists.filter(function (c) { return c && c.name; });
            nativesFromApi = true;
            openImport(null); // reopen the panel, now with the items
          });
        },
        existing: names,
        onImport: function (ids, endFor) {
          var chosen = natives.filter(function (n) { return ids.indexOf(n.id) >= 0; });
          var lists = ops.convertNative(chosen, { newId: store.newId, endFor: endFor, today: wd.todayIso() });
          var op = { k: 'import', lists: lists };
          var next = store.sanitize(ops.apply(JSON.parse(JSON.stringify(state)), op));
          var size = store.sizeOf(next);
          if (size > store.SAFE_LIMIT) {
            return 'Non c\'è spazio sufficiente su questa card (' + Math.round(size / store.LIMIT * 100) +
              '% del limite). Importa meno checklist alla volta, oppure accorcia i testi.';
          }
          panels.close();
          apply(op);
          var count = lists.reduce(function (n, l) { return n + l.x.length; }, 0);
          showNotice('Importate ' + lists.length + ' checklist (' + count + ' elementi). Le checklist native sono rimaste su Trello: eliminale quando hai verificato.');
          return '';
        }
      });
    });
  }

  var noticeEl = null;
  function showNotice(text) {
    if (noticeEl) noticeEl.remove();
    noticeEl = el('div', { cls: 'cp-notice', attrs: { role: 'status' } }, [
      el('span', { text: text }),
      el('button', { cls: 'cp-pop-close', text: '×', attrs: { type: 'button', 'aria-label': 'Chiudi' }, on: { click: function () { noticeEl.remove(); noticeEl = null; resize(); } } })
    ]);
    rootEl.insertBefore(noticeEl, listsEl);
    resize();
  }

  /* ------------------------------------------------------------------ */
  /* Height                                                             */
  /* ------------------------------------------------------------------ */

  // Trello sizes the frame to the content up to 1500px. Below that the
  // section never shows a scrollbar; above it, it scrolls with the wheel
  // but the scrollbar stays hidden (a fade marks that there is more).
  var MAX_SECTION_HEIGHT = 1500;
  document.documentElement.classList.add('cp-section');

  function contentHeight() { return Math.ceil(rootEl.getBoundingClientRect().height); }

  function resize() {
    var h = contentHeight();
    var tall = h > MAX_SECTION_HEIGHT;
    document.documentElement.classList.toggle('is-tall', tall);
    if (!tall) window.scrollTo(0, 0);
    updateFade();
    // An explicit height avoids the few pixels of difference that the selector
    // form can leave between the frame and the content.
    t.sizeTo(Math.min(h, MAX_SECTION_HEIGHT)).catch(function () { /* iframe not ready yet */ });
  }

  function updateFade() {
    var tall = document.documentElement.classList.contains('is-tall');
    var atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    document.documentElement.classList.toggle('has-more', tall && !atEnd);
  }
  window.addEventListener('scroll', updateFade, { passive: true });

  (function watchHeight() {
    var pending = null;
    function later() { if (pending) clearTimeout(pending); pending = setTimeout(resize, 30); }
    if (typeof ResizeObserver === 'function') new ResizeObserver(later).observe(rootEl);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(later);
    window.addEventListener('load', later);
  })();

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  var initials = people.initials;
  var avatarUrl = people.avatarUrl;
  var avatarColor = people.avatarColor;

  /** Worked days in the meta line: "Lavorati 1 gg" with -/+ shown on hover. */
  function effortField(item) {
    function step(delta) {
      var w = (item.w || 0) + delta;
      if (w < 0) return;
      apply({ k: 'effort', i: item.i, w: w, today: wd.todayIso() });
    }
    return el('span', { cls: 'cp-meta cp-effort' }, [
      el('span', { cls: 'cp-meta-label', text: 'Lavorati' }),
      el('span', { cls: 'cp-meta-value', text: calc.fmtNumber(item.w || 0) + ' gg', attrs: { 'aria-live': 'polite' } }),
      el('button', { cls: 'cp-step', text: '−', attrs: { type: 'button', title: 'Togli mezza giornata', 'aria-label': 'Togli mezza giornata', 'data-fkey': 'minus:' + item.i }, on: { click: function () { step(-0.5); } } }),
      el('button', { cls: 'cp-step', text: '+', attrs: { type: 'button', title: 'Aggiungi mezza giornata', 'aria-label': 'Aggiungi mezza giornata', 'data-fkey': 'plus:' + item.i }, on: { click: function () { step(0.5); } } })
    ]);
  }

  function metaDates(item, metrics) {
    function field(label, iso, key) {
      return el('button', {
        cls: 'cp-meta cp-meta-link',
        attrs: { type: 'button', title: 'Modifica: ' + label.toLowerCase() },
        on: { click: function (ev) { openDates(ev, item, key); } }
      }, [
        el('span', { cls: 'cp-meta-label', text: label }),
        el('span', { cls: 'cp-meta-value' + (iso ? '' : ' is-empty'), text: iso ? calc.fmtChipDate(iso) : '—' })
      ]);
    }
    var nodes = [field('Inizio', item.s, 's'), field('Fine', item.e, 'e')];
    if (metrics.deviation !== null) {
      nodes.push(el('span', {
        cls: 'cp-meta cp-deviation ' + (metrics.deviation > 0 ? 'is-late' : 'is-done'),
        text: calc.fmtDeviation(metrics.deviation)
      }));
    }
    return nodes;
  }

  function deadlineChip(item) {
    var status = calc.dueStatus(item, wd.todayIso(), holidays);
    var btn = el('button', {
      cls: 'cp-due' + (status ? ' is-' + status : '') + (item.dl ? '' : ' is-empty'),
      attrs: { type: 'button', title: item.dl ? 'Deadline ' + calc.fmtShortDate(item.dl) : 'Imposta la deadline', 'aria-label': item.dl ? 'Deadline ' + calc.fmtChipDate(item.dl) : 'Imposta la deadline' },
      on: { click: function (ev) { openDates(ev, item, 'dl'); } }
    }, [icon('clock')]);
    if (item.dl) btn.appendChild(el('span', { text: calc.fmtChipDate(item.dl) }));
    return btn;
  }

  function avatarButton(item) {
    var member = members.filter(function (m) { return m.id === item.m; })[0];
    var btn = el('button', {
      cls: 'cp-avatar' + (member ? '' : ' is-empty'),
      attrs: { type: 'button', title: member ? (member.fullName || member.username) : 'Assegna', 'aria-label': member ? 'Assegnato a ' + (member.fullName || member.username) : 'Assegna' },
      on: { click: function (ev) { openMembers(ev, item); } }
    });
    if (member) {
      var photo = avatarUrl(member);
      if (photo) {
        btn.appendChild(el('img', { cls: 'cp-avatar-img', attrs: { src: photo, alt: '', referrerpolicy: 'no-referrer' } }));
      } else {
        btn.textContent = member.initials ? String(member.initials).slice(0, 3).toUpperCase() : initials(member.fullName || member.username);
        btn.style.backgroundColor = avatarColor(member.id);
      }
    } else {
      btn.appendChild(icon('person'));
    }
    return btn;
  }

  /** Alt+Up / Alt+Down moves the focused item or checklist (keyboard alternative to dragging). */
  function moveKeys(ev, move) {
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return false;
    ev.preventDefault();
    move(ev.key === 'ArrowUp' ? -1 : 1);
    return true;
  }

  function renderItem(list, item, index) {
    var metrics = calc.itemMetrics(item, holidays);
    var editingThis = isActive('item', item.i);

    var checkbox = el('input', {
      cls: 'cp-check',
      attrs: { type: 'checkbox', 'aria-label': 'Completato', 'data-fkey': 'check:' + item.i },
      on: {
        change: function () {
          // Completing an item without an end date sets it to today (editable).
          apply({ k: 'check', i: item.i, d: checkbox.checked, today: wd.todayIso() });
        }
      }
    });
    checkbox.checked = !!item.d;

    function edit() { setActive({ k: 'item', i: item.i }); }

    var main = el('div', { cls: 'cp-item-main' }, [
      el('div', {
        cls: 'cp-item-text',
        text: item.t,
        attrs: { role: 'button', tabindex: '0', title: 'Clicca per modificare, trascina per spostare (Alt+frecce da tastiera)', 'data-fkey': 'text:' + item.i },
        on: {
          click: edit,
          keydown: function (ev) {
            if (moveKeys(ev, function (d) { moveItemBy(list, item, d); })) return;
            if (ev.key === 'Enter') edit();
          }
        }
      }),
      el('div', { cls: 'cp-item-actions' }, [
        deadlineChip(item),
        avatarButton(item),
        el('button', {
          cls: 'cp-more',
          attrs: { type: 'button', title: 'Azioni', 'aria-label': 'Azioni elemento' },
          on: { click: function (ev) { openItemMenu(ev, list, item); } }
        }, [icon('dots')])
      ])
    ]);

    var meta = el('div', { cls: 'cp-item-meta' }, metaDates(item, metrics).concat([
      effortField(item),
      metrics.warnings.length
        ? el('span', { cls: 'cp-meta cp-warn', text: '! da verificare', attrs: { title: metrics.warnings.join('\n') } })
        : null
    ]));

    var content = el('div', { cls: 'cp-item-content' }, [main, meta]);
    var row = el('div', {
      cls: 'cp-item' + (item.d ? ' is-done' : ''),
      attrs: { 'data-item': item.i, 'data-list': list.i, 'data-index': String(index) }
    }, [el('div', { cls: 'cp-gutter' }, [checkbox]), content]);

    if (editingThis) {
      var box = inlineEditor(active, item.t, 500, function (v) {
        if (apply({ k: 'set', i: item.i, f: { t: v } })) setActive(null);
      });
      mountEditor(box, main, [main, meta]);
      row.classList.add('is-editing');
    }
    return row;
  }

  function renderList(list) {
    var tot = calc.checklistTotals(list, holidays);
    var hiding = isHidingDone(list.i);
    var pct = tot.total ? Math.round((tot.done / tot.total) * 100) : 0;
    var client = calc.resolveClient(list);
    var collapsed = isCollapsed(list.i);

    var summaryTip = [];
    if (tot.start) summaryTip.push('Inizio ' + calc.fmtShortDate(tot.start));
    if (tot.end) summaryTip.push('Fine ' + calc.fmtShortDate(tot.end));
    if (tot.deadline) summaryTip.push('Deadline più lontana ' + calc.fmtShortDate(tot.deadline));

    function rename() { setActive({ k: 'title', l: list.i }); }

    var titleNode = el('h3', {
      cls: 'cp-list-title',
      text: list.n,
      attrs: { role: 'button', tabindex: '0', title: 'Clicca per rinominare, trascina per spostare (Alt+frecce da tastiera)', 'data-fkey': 'title:' + list.i },
      on: {
        click: rename,
        keydown: function (ev) {
          if (moveKeys(ev, function (d) { moveListBy(list, d); })) return;
          if (ev.key === 'Enter') rename();
        }
      }
    });

    var headerRight = el('div', { cls: 'cp-list-actions' }, [
      !collapsed && tot.done > 0 ? el('button', {
        cls: 'cp-btn',
        text: hiding ? 'Mostra gli elementi selezionati (' + tot.done + ')' : 'Nascondi gli elementi selezionati',
        attrs: { type: 'button' },
        on: { click: function () { toggleHidingDone(list.i); } }
      }) : null,
      el('button', {
        cls: 'cp-btn',
        text: 'Elimina',
        attrs: { type: 'button' },
        on: {
          click: function (ev) {
            confirmDelete(ev, 'Eliminare ' + list.n.slice(0, 40) + '?', 'La checklist e i suoi elementi verranno eliminati definitivamente.', { k: 'delList', l: list.i });
          }
        }
      })
    ]);

    var collapseBtn = el('button', {
      cls: 'cp-collapse',
      attrs: { type: 'button', title: collapsed ? 'Espandi la checklist' : 'Comprimi la checklist', 'aria-label': collapsed ? 'Espandi la checklist' : 'Comprimi la checklist', 'aria-expanded': String(!collapsed) },
      on: { click: function () { toggleCollapsed(list.i); } }
    }, [icon(collapsed ? 'chevronRight' : 'chevronDown')]);

    var head = el('div', { cls: 'cp-list-head' }, [collapseBtn, titleNode, headerRight]);
    var header = el('div', { cls: 'cp-row cp-list-header' }, [head]);

    var fill = el('div', { cls: 'cp-progress-fill' + (pct === 100 ? ' is-complete' : '') });
    fill.style.width = pct + '%';
    var progress = el('div', { cls: 'cp-row cp-progress' }, [
      el('div', { cls: 'cp-progress-track', attrs: { role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' } }, [fill]),
      el('div', { cls: 'cp-summary', attrs: { title: summaryTip.join(' · ') } }, [
        el('span', { cls: 'cp-progress-pct', text: pct + '%' }),
        el('button', {
          cls: 'cp-client' + (client.derived ? ' is-derived' : ''),
          text: client.value || (list.c === calc.NO_CLIENT ? 'Interno' : 'Cliente?'),
          attrs: { type: 'button', title: 'Cliente per l\'export' + (client.derived ? ' (dedotto dal titolo)' : '') },
          on: { click: function (ev) { openClient(ev, list); } }
        }),
        tot.effort ? el('span', { text: calc.fmtNumber(tot.effort) + ' gg' }) : null,
        tot.deviation !== null
          ? el('span', { cls: 'cp-deviation ' + (tot.deviation > 0 ? 'is-late' : 'is-done'), text: calc.fmtDeviation(tot.deviation) })
          : null,
        tot.warnings ? el('span', { cls: 'cp-warn', text: '! ' + tot.warnings, attrs: { title: tot.warnings + ' elementi da verificare' } }) : null
      ])
    ]);

    var section = el('section', { cls: 'cp-list' + (collapsed ? ' is-collapsed' : ''), attrs: { 'data-list': list.i } }, [header, progress]);

    if (isActive('title', list.i)) {
      var box = inlineEditor(active, list.n, 200, function (v) {
        if (apply({ k: 'list', l: list.i, f: { n: v } })) setActive(null);
      });
      mountEditor(box, collapseBtn, [collapseBtn, titleNode, headerRight]);
    }

    if (collapsed) return section;
    list.x.forEach(function (item, index) {
      if (hiding && item.d) return;
      section.appendChild(renderItem(list, item, index));
    });
    var addSlot = el('div', { cls: 'cp-item-content' }, [renderAddItem(list)]);
    section.appendChild(el('div', { cls: 'cp-row cp-add-row' }, [el('div', { cls: 'cp-gutter' }), addSlot]));
    return section;
  }

  function renderAddItem(list) {
    var a = { k: 'add', l: list.i };
    var btn = el('button', {
      cls: 'cp-btn cp-add-btn',
      text: 'Aggiungi un elemento',
      attrs: { type: 'button', 'data-fkey': 'add:' + list.i },
      on: { click: function () { setActive(a); } }
    });
    var wrap = el('div', {}, [btn]);
    if (isActive('add', list.i)) {
      // The form stays open after adding, ready for the next item, as in Trello.
      var box = inlineEditor(active, '', 500, function (v) {
        if (apply({ k: 'addItem', l: list.i, item: { i: store.newId(), t: v, d: false, m: '', s: '', dl: '', e: '', w: 0 } })) render();
      },{ saveText: 'Aggiungi', placeholder: 'Aggiungi un elemento', keepOpen: true });
      box.classList.add('cp-add-form');
      mountEditor(box, btn, [btn]);
    }
    return wrap;
  }

  function renderNewList() {
    newListEl.textContent = '';
    var a = { k: 'newList' };
    var addBtn = el('button', {
      cls: 'cp-btn cp-new-list-btn',
      text: '+ Checklist',
      attrs: { type: 'button', 'data-fkey': 'newlist' },
      on: { click: function () { setActive(a); } }
    });
    // Shown whenever the card has native checklists, also when their names are
    // already used in Checklist+ (the panel marks them) or Trello did not send
    // their items (the panel explains it).
    var nativeCount = natives.length || nativeBadgeCount;
    var importBtn = nativeCount ? el('button', {
      cls: 'cp-btn cp-btn-subtle',
      text: 'Importa checklist native' + (natives.length ? ' (' + natives.length + ')' : ''),
      attrs: { type: 'button', title: 'Converte le checklist native di questa card in Checklist+' },
      on: { click: openImport }
    }) : null;
    var bar = el('div', { cls: 'cp-new-list-bar' }, [addBtn, importBtn]);
    newListEl.appendChild(bar);
    if (!isActive('newList')) return;

    // Client choice right in the creation form: automatic, none, or one client
    // of the board (several clients can be set later from the client panel).
    var clientSelect = el('select', { cls: 'cp-new-list-client', attrs: { 'aria-label': 'Cliente' } }, [
      el('option', { text: 'Cliente: automatico dal titolo', value: '' }),
      el('option', { text: 'Nessun cliente (attività interna)', value: calc.NO_CLIENT })
    ]);
    boardClients.forEach(function (c) { clientSelect.appendChild(el('option', { text: c, value: c })); });

    var box = inlineEditor(active, '', 200, function (v) {
      if (apply({ k: 'addList', list: { i: store.newId(), n: v, c: clientSelect.value, x: [] } })) setActive(null);
    },{ saveText: 'Aggiungi', placeholder: 'Titolo, es. NEXI - SVILUPPO BACKEND', extra: clientSelect });
    mountEditor(box, bar, [bar]);
  }

  function renderSize() {
    var size = store.sizeOf(state);
    var pct = Math.round((size / store.LIMIT) * 100);
    sizeEl.hidden = pct < 60;
    sizeEl.textContent = 'Spazio usato su questa card: ' + pct + '%';
    sizeEl.classList.toggle('is-warn', pct >= 80);
  }

  var releaseTimer = null;
  var focusAfterRender = null;
  var flashItem = null;

  function render() {
    if (drag) cancelDrag();
    // Keep focus and caret across the rebuild.
    var focused = document.activeElement;
    var fkey = focusAfterRender || (focused && focused.getAttribute && focused.getAttribute('data-fkey'));
    var caret = fkey === 'editor' && focused ? [focused.selectionStart, focused.selectionEnd] : null;
    focusAfterRender = null;

    // Keep the current height while the content is rebuilt: without this the
    // section collapses for an instant and Trello scrolls the card.
    if (panels.isOpen()) panels.close();
    rootEl.style.minHeight = rootEl.offsetHeight + 'px';
    activeEditor = null;
    listsEl.textContent = '';
    state.l.forEach(function (list) { listsEl.appendChild(renderList(list)); });
    renderNewList();
    renderSize();
    lastRendered = JSON.stringify(state);

    // An editor whose target no longer exists (e.g. deleted by someone else) is dropped.
    if (active && !activeEditor) { active = null; persistUi(); }

    var target = activeEditor ? activeEditor.box.querySelector('textarea') : (fkey ? listsEl.querySelector('[data-fkey="' + fkey + '"]') || newListEl.querySelector('[data-fkey="' + fkey + '"]') : null);
    if (target) {
      target.focus({ preventScroll: true });
      if (target.tagName === 'TEXTAREA') {
        var end = target.value.length;
        target.setSelectionRange(caret ? caret[0] : end, caret ? caret[1] : end);
      }
    }

    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(function () {
      rootEl.style.minHeight = panels.minHeight() ? panels.minHeight() + 'px' : '';
      resize();
      try { if (cardId) window.localStorage.setItem('cp-h-' + cardId, String(Math.min(contentHeight(), MAX_SECTION_HEIGHT))); } catch (e) { /* storage unavailable */ }
      if (flashItem) highlight(flashItem);
    }, 60);
    resize();
  }

  /* ------------------------------------------------------------------ */
  /* Task opened from "I miei task" (board button)                      */
  /* ------------------------------------------------------------------ */

  /** Reads the request left by the "I miei task" popover, if it targets this card. */
  function takeFocusRequest() {
    var req = readLocal('cp-focus', null);
    if (!req || req.c !== cardId || Date.now() - (req.at || 0) > 60000) return null;
    writeLocal('cp-focus', null);
    return req.i;
  }

  function prepareFocus(itemId) {
    var hit = ops.locate(state, itemId);
    if (!hit) return;
    toggleIn(collapsedKey(), hit.list.i, false); // expand its checklist
    forceShow[hit.list.i] = true;                // show it even if completed items are hidden
    flashItem = itemId;
  }

  function highlight(itemId) {
    flashItem = null;
    var row = listsEl.querySelector('[data-item="' + itemId + '"]');
    if (!row) return;
    row.classList.add('is-flash');
    // Scrolls Trello's card to the row when the browser allows it from an iframe.
    try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* not allowed */ }
    setTimeout(function () { row.classList.remove('is-flash'); }, 2600);
  }

  /* ------------------------------------------------------------------ */
  /* Drag and drop (items, also across checklists, and checklists)      */
  /* ------------------------------------------------------------------ */

  var DRAG_THRESHOLD = 6;
  var press = null;       // pointer pressed, not dragging yet
  var drag = null;        // current drag
  var suppressClick = false;

  function rel(rect) {
    var r = rootEl.getBoundingClientRect();
    return { top: rect.top - r.top, bottom: rect.bottom - r.top, left: rect.left - r.left, width: rect.width };
  }

  rootEl.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0 || !ev.isPrimary || panels.isOpen()) return;
    var target = ev.target;
    if (target.closest('button, input, textarea, select, a, .cp-edit, .cp-pop')) return;
    var row = target.closest('.cp-item');
    var head = !row && target.closest('.cp-list-header');
    if (row && !row.classList.contains('is-editing')) press = { type: 'item', node: row, x: ev.clientX, y: ev.clientY };
    else if (head) press = { type: 'list', node: head.closest('.cp-list'), x: ev.clientX, y: ev.clientY };
  });

  document.addEventListener('pointermove', function (ev) {
    if (press && !drag) {
      if (Math.abs(ev.clientX - press.x) + Math.abs(ev.clientY - press.y) < DRAG_THRESHOLD) return;
      startDrag(press, ev);
      press = null;
    }
    if (drag) { ev.preventDefault(); moveDrag(ev); }
  });

  document.addEventListener('pointerup', function () {
    press = null;
    if (drag) endDrag();
  });

  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && drag) cancelDrag(); });

  function startDrag(p, ev) {
    if (activeEditor) closeEditorInPlace();
    try { window.getSelection().removeAllRanges(); } catch (e) { /* no selection API */ }
    var rect = rel(p.node.getBoundingClientRect());
    var ghost = p.node.cloneNode(true);
    ghost.classList.add('cp-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    var line = el('div', { cls: 'cp-drop-line' });
    rootEl.appendChild(ghost);
    rootEl.appendChild(line);
    p.node.classList.add('is-dragging');
    document.documentElement.classList.add('is-dragging');
    drag = {
      type: p.type, node: p.node, ghost: ghost, line: line,
      offset: ev.clientY - p.node.getBoundingClientRect().top,
      id: p.type === 'item' ? p.node.getAttribute('data-item') : p.node.getAttribute('data-list'),
      target: null
    };
    moveDrag(ev);
  }

  function showLine(top, left, width) {
    drag.line.style.top = Math.round(top - 1) + 'px';
    drag.line.style.left = left + 'px';
    drag.line.style.width = width + 'px';
    drag.line.hidden = false;
  }

  function moveDrag(ev) {
    var rootTop = rootEl.getBoundingClientRect().top;
    drag.ghost.style.top = (ev.clientY - rootTop - drag.offset) + 'px';
    var y = ev.clientY;
    var sections = Array.prototype.slice.call(listsEl.querySelectorAll('.cp-list'));
    drag.target = null;
    drag.line.hidden = true;
    if (!sections.length) return;

    if (drag.type === 'list') {
      var others = sections.filter(function (s) { return s !== drag.node; });
      var before = others.filter(function (s) { var r = s.getBoundingClientRect(); return r.top + r.height / 2 < y; });
      var index = before.length;
      var lineTop = before.length ? rel(before[before.length - 1].getBoundingClientRect()).bottom + 8
        : rel((others[0] || drag.node).getBoundingClientRect()).top - 4;
      drag.target = { index: index };
      showLine(lineTop, 0, rootEl.clientWidth);
      return;
    }

    // Item: the checklist under the pointer (or the nearest one), then the gap between rows.
    var section = sections.filter(function (s) { var r = s.getBoundingClientRect(); return y >= r.top && y <= r.bottom; })[0];
    if (!section) section = y < sections[0].getBoundingClientRect().top ? sections[0] : sections[sections.length - 1];
    var listId = section.getAttribute('data-list');
    var list = state.l.filter(function (l) { return l.i === listId; })[0];
    if (!list) return;
    var srect = rel(section.getBoundingClientRect());
    if (section.classList.contains('is-collapsed')) {
      drag.target = { list: listId, index: list.x.length };
      showLine(srect.bottom - 6, 0, rootEl.clientWidth);
      return;
    }
    var rows = Array.prototype.slice.call(section.querySelectorAll('.cp-item')).filter(function (r) { return r !== drag.node; });
    var next = rows.filter(function (r) { var b = r.getBoundingClientRect(); return b.top + b.height / 2 > y; })[0];
    var realIndex;
    var top;
    if (next) {
      realIndex = +next.getAttribute('data-index');
      top = rel(next.getBoundingClientRect()).top;
    } else {
      realIndex = list.x.length;
      var last = rows[rows.length - 1];
      top = last ? rel(last.getBoundingClientRect()).bottom : rel(section.querySelector('.cp-progress').getBoundingClientRect()).bottom + 4;
    }
    // Index after removing the dragged item from its current position.
    var from = drag.node.getAttribute('data-list') === listId ? +drag.node.getAttribute('data-index') : -1;
    if (from >= 0 && from < realIndex) realIndex--;
    drag.target = { list: listId, index: realIndex, from: from };
    var gutter = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cp-gutter'), 10) || 28;
    showLine(top, gutter, rootEl.clientWidth - gutter);
  }

  function cleanupDrag() {
    if (!drag) return;
    drag.ghost.remove();
    drag.line.remove();
    drag.node.classList.remove('is-dragging');
    document.documentElement.classList.remove('is-dragging');
    drag = null;
  }

  function cancelDrag() { cleanupDrag(); }

  function endDrag() {
    var d = drag;
    cleanupDrag();
    suppressClick = true; // the click that ends a drag must not open an editor
    setTimeout(function () { suppressClick = false; }, 0);
    if (!d || !d.target) return;
    if (d.type === 'list') {
      var current = state.l.map(function (l) { return l.i; }).indexOf(d.id);
      if (current !== d.target.index) apply({ k: 'moveList', l: d.id, index: d.target.index });
      return;
    }
    if (d.target.from >= 0 && d.target.from === d.target.index) return; // same place
    apply({ k: 'moveItem', i: d.id, to: d.target.list, index: d.target.index });
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme) {
    var current = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', current);
    try { window.localStorage.setItem('cp-theme', current); } catch (e) { /* storage unavailable */ }
  }

  applyTheme(context.theme || context.initialTheme);
  try { if (typeof t.subscribeToThemeChanges === 'function') t.subscribeToThemeChanges(applyTheme); } catch (e) { /* older client */ }

  // Write pending changes at once if the card is closed during the short wait.
  window.addEventListener('pagehide', function () { queue.flush(); });

  /**
   * Native checklists of the card. Asks for "checklists" and "badges"; when
   * the badges count native items but the checklists arrive without them,
   * retries with t.card('all'). Logs only the shape (no task text) so a
   * problem on real Trello can be diagnosed from the console.
   */
  function loadNatives() {
    function itemsOf(lists) { return lists.reduce(function (n, c) { return n + ((c && c.checkItems) || []).length; }, 0); }
    return t.card('checklists', 'badges').catch(function (err) {
      if (window.console) console.warn('[Checklist+] t.card(checklists) failed', err);
      return {};
    }).then(function (card) {
      var lists = (card && card.checklists) || [];
      nativeBadgeCount = (card && card.badges && card.badges.checkItems) || 0;
      if (itemsOf(lists) || !nativeBadgeCount) return lists;
      return t.card('all').then(function (all) { return (all && all.checklists) || lists; }, function () { return lists; });
    }).then(function (lists) {
      if (nativesFromApi) return; // keep the complete data read through the API
      natives = lists.filter(function (c) { return c && c.name; });
      if (window.console) {
        console.info('[Checklist+] native checklists', {
          lists: natives.length,
          items: itemsOf(natives),
          badgeItems: nativeBadgeCount,
          itemFields: Object.keys((natives[0] && (natives[0].checkItems || [])[0]) || {})
        });
      }
    });
  }

  var started = false;
  t.render(function () {
    var firstRun = !started;
    started = true;
    return Promise.all([
      // Board client list first: it drives the automatic client detection.
      people.loadClients(t).then(function (c) { boardClients = c; calc.setClients(c); }),
      t.board('members').catch(function () { return { members: [] }; }),
      people.loadAreas(t),
      loadNatives()
    ]).then(function (res) {
      members = (res[1].members || []).slice().sort(function (a, b) {
        return String(a.fullName || '').localeCompare(String(b.fullName || ''));
      });
      teamAreas = res[2] || {};
      // The queue loads the stored state and replays changes interrupted by a reload.
      return firstRun ? queue.start() : queue.refresh();
    }).then(function (s) {
      state = store.sanitize(s);
      if (firstRun) {
        var focusId = takeFocusRequest();
        if (focusId) prepareFocus(focusId);
      }
      render();
    }).catch(function (err) {
      showError('Impossibile caricare i dati della card.');
      if (window.console) console.error('[Checklist+]', err);
    });
  });
})();
