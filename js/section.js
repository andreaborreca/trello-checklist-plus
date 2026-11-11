/**
 * Checklist+ - card back section UI, styled after Trello's native checklist.
 *
 * Item row: checkbox, text, worked-days chip, deadline chip, member avatar,
 * "..." menu. Dates, members, client and delete confirmations open Trello's
 * own popovers (t.popup), so they look and behave like native Trello UI.
 *
 * Security notes:
 * - User text is only ever written via textContent / input.value; innerHTML
 *   is never used with data. Icons are built from fixed SVG paths.
 * - Stored data is sanitized by CP.store before rendering.
 *
 * Trello reloads this iframe after every t.set(), so the UI is always rebuilt
 * from the freshest stored state.
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  var t = TrelloPowerUp.iframe();
  var store = window.CP.store;
  var calc = window.CP.calc;
  var wd = window.CP.workdays;

  var state = store.emptyState();
  var currentTheme = 'light';
  var boardClients = [];   // client list of the board (for detection and the new-checklist form)
  var members = [];
  var cardId = '';
  // Custom holidays (patron saint, company days): configurable in phase 2.
  var holidays = new Set();

  // UI-only state for this render cycle.
  var editing = null;       // { type: 'item'|'title', l, i }
  var openForm = null;      // 'add-<listId>' | 'new-list'

  // Effort clicks are batched to avoid one save (and one iframe reload) per click.
  var pendingEffort = {};
  var flushTimer = null;
  var FLUSH_DELAY_MS = 800;

  var listsEl = document.getElementById('cp-lists');
  var newListEl = document.getElementById('cp-new-list');
  var errorEl = document.getElementById('cp-error');
  var sizeEl = document.getElementById('cp-size');

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
  // Filled icons.
  var ICONS = {
    person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z',
    dots: 'M6 10.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zm6 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zm6 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z'
  };
  // Outline icons (stroke), closer to Trello's own line icons.
  var STROKE_ICONS = {
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
  /* Per-viewer UI preferences (hide checked items), restored focus     */
  /* ------------------------------------------------------------------ */

  function readLocal(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeLocal(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  function hiddenKey() { return 'cp-hide-done-' + cardId; }
  function isHidingDone(listId) { return readLocal(hiddenKey(), []).indexOf(listId) >= 0; }

  function toggleHidingDone(listId) {
    var list = readLocal(hiddenKey(), []);
    var idx = list.indexOf(listId);
    if (idx >= 0) list.splice(idx, 1); else list.push(listId);
    writeLocal(hiddenKey(), list);
    render();
  }

  /** Keeps an "add" form open across the iframe reload that follows a save. */
  function rememberOpenForm(id) {
    try { window.sessionStorage.setItem('cp-open-form', id); } catch (e) { /* ignore */ }
  }

  function restoreOpenForm() {
    try {
      var id = window.sessionStorage.getItem('cp-open-form');
      window.sessionStorage.removeItem('cp-open-form');
      return id;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                        */
  /* ------------------------------------------------------------------ */

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
    resize();
  }

  function findList(s, listId) {
    return (s.l || []).filter(function (l) { return l.i === listId; })[0] || null;
  }

  function findItem(list, itemId) {
    return list ? (list.x || []).filter(function (it) { return it.i === itemId; })[0] || null : null;
  }

  function reportError(err) {
    if (err instanceof store.SizeError) {
      showError(err.message + ' Elimina qualche elemento o accorcia i testi.');
    } else {
      showError('Salvataggio non riuscito, riprova tra qualche secondo.');
    }
    if (window.console) console.error('[Checklist+]', err);
  }

  /**
   * Applies a mutation on the freshest stored state and saves it.
   * `ctx` lets popup callbacks save with their own Trello context.
   */
  function save(mutate, ctx) {
    showError('');
    return store.update(ctx || t, mutate).then(function (fresh) {
      if (!ctx) { state = fresh; render(); }
      return fresh;
    }).catch(function (err) { reportError(err); throw err; });
  }

  function saveItem(listId, itemId, apply, ctx) {
    return save(function (s) {
      var item = findItem(findList(s, listId), itemId);
      if (item) apply(item);
    }, ctx);
  }

  function scheduleEffortFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushEffort, FLUSH_DELAY_MS);
  }

  /** Persists the batched +/- clicks. */
  function flushEffort() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    var batch = pendingEffort;
    pendingEffort = {};
    var keys = Object.keys(batch);
    if (!keys.length) return;
    save(function (s) {
      keys.forEach(function (key) {
        var parts = key.split(':');
        var item = findItem(findList(s, parts[0]), parts[1]);
        if (!item) return;
        var delta = batch[key];
        item.w = Math.max(0, (item.w || 0) + delta);
        // First worked day logged: start date defaults to today.
        if (delta > 0 && !item.s) item.s = wd.todayIso();
      });
    }).catch(function () { /* already reported */ });
  }

  /* ------------------------------------------------------------------ */
  /* Trello popovers                                                    */
  /* ------------------------------------------------------------------ */

  /** Opens a Trello popover, anchoring it to the click when we have one. */
  function popup(ctx, opts, ev) {
    if (ev) opts.mouseEvent = ev;
    return ctx.popup(opts);
  }

  function closeWith(ctx) {
    return function () { return ctx.closePopup(); };
  }

  var DATE_TITLES = { s: 'Data di inizio', dl: 'Deadline', e: 'Data di fine' };

  /** Opens the calendar popover for one date field: 's', 'dl' or 'e'. */
  function openDates(ctx, ev, list, item, field) {
    return popup(ctx, {
      title: DATE_TITLES[field],
      // Versioned URL: the browser never reuses a cached copy of an older release.
      url: './dates.html?v=1.12.0',
      // The popover may not receive the theme from Trello: pass ours along.
      args: { l: list.i, i: item.i, f: field, th: currentTheme },
      height: 420
    }, ev);
  }

  /** Opens the member picker popover (Trello-like, grouped by work area). */
  function openMembers(ctx, ev, list, item) {
    return popup(ctx, {
      title: 'Assegna',
      url: './members.html?v=1.12.0',
      args: { l: list.i, i: item.i, th: currentTheme },
      height: 420
    }, ev);
  }

  function confirmDelete(ctx, ev, title, message, mutate) {
    return popup(ctx, {
      type: 'confirm',
      title: title,
      message: message,
      confirmText: 'Elimina',
      confirmStyle: 'danger',
      cancelText: 'Annulla',
      onConfirm: function (tt) {
        return save(mutate, tt).then(closeWith(tt));
      }
    }, ev);
  }

  function deleteItemMutation(listId, itemId) {
    return function (s) {
      var l = findList(s, listId);
      if (l) l.x = l.x.filter(function (it) { return it.i !== itemId; });
    };
  }

  function openItemMenu(ev, list, item) {
    return popup(t, {
      title: 'Azioni elemento',
      items: [
        { text: 'Data di inizio...', callback: function (tt) { return openDates(tt, null, list, item, 's'); } },
        { text: 'Deadline...', callback: function (tt) { return openDates(tt, null, list, item, 'dl'); } },
        { text: 'Data di fine...', callback: function (tt) { return openDates(tt, null, list, item, 'e'); } },
        { text: 'Assegna...', callback: function (tt) { return openMembers(tt, null, list, item); } },
        {
          text: 'Elimina',
          callback: function (tt) {
            return confirmDelete(tt, null, 'Eliminare l\'elemento?', 'L\'eliminazione non si può annullare.', deleteItemMutation(list.i, item.i));
          }
        }
      ]
    }, ev);
  }

  /** Opens the client popover of a checklist (automatic, none, or one or more clients). */
  function openClient(ev, list) {
    return popup(t, {
      title: 'Cliente',
      url: './clients.html?v=1.12.0',
      args: { l: list.i, th: currentTheme },
      height: 360
    }, ev);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function resize() {
    t.sizeTo('#cp-root').catch(function () { /* iframe not ready yet */ });
  }

  // Avatar helpers live in people.js (shared with the popovers).
  var initials = window.CP.people.initials;
  var avatarUrl = window.CP.people.avatarUrl;
  var avatarColor = window.CP.people.avatarColor;

  /** Inline editor with Salva/Annulla, like Trello's checklist item editing. */
  function inlineEditor(value, maxLength, onSave, onCancel) {
    var area = el('textarea', { cls: 'cp-edit-text', value: value, attrs: { maxlength: String(maxLength), rows: '2' } });
    function submit() {
      var v = area.value.replace(/\s+/g, ' ').trim();
      if (!v) { onCancel(); return; }
      onSave(v);
    }
    area.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
    });
    var box = el('div', { cls: 'cp-edit' }, [
      area,
      el('div', { cls: 'cp-edit-actions' }, [
        el('button', { cls: 'cp-btn cp-btn-primary', text: 'Salva', attrs: { type: 'button' }, on: { click: submit } }),
        el('button', { cls: 'cp-btn cp-btn-subtle', text: 'Annulla', attrs: { type: 'button' }, on: { click: onCancel } })
      ])
    ]);
    setTimeout(function () { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 0);
    return box;
  }

  /** Worked days in the meta line: "Lavorati 1 gg" with -/+ shown on hover. */
  function effortField(list, item) {
    var key = list.i + ':' + item.i;
    function current() { return Math.max(0, (item.w || 0) + (pendingEffort[key] || 0)); }

    var valueEl = el('span', { cls: 'cp-meta-value', attrs: { 'aria-live': 'polite' } });

    function paint() { valueEl.textContent = calc.fmtNumber(current()) + ' gg'; }

    function step(delta) {
      if (current() + delta < 0) return;
      pendingEffort[key] = (pendingEffort[key] || 0) + delta;
      paint();
      scheduleEffortFlush();
    }

    paint();
    return el('span', { cls: 'cp-meta cp-effort' }, [
      el('span', { cls: 'cp-meta-label', text: 'Lavorati' }),
      valueEl,
      el('button', { cls: 'cp-step', text: '−', attrs: { type: 'button', title: 'Togli mezza giornata', 'aria-label': 'Togli mezza giornata' }, on: { click: function () { step(-0.5); } } }),
      el('button', { cls: 'cp-step', text: '+', attrs: { type: 'button', title: 'Aggiungi mezza giornata', 'aria-label': 'Aggiungi mezza giornata' }, on: { click: function () { step(0.5); } } })
    ]);
  }

  /** Start / end dates and deviation in the meta line (plain text, clickable). */
  function metaDates(list, item, metrics) {
    function field(label, iso, key) {
      return el('button', {
        cls: 'cp-meta cp-meta-link',
        attrs: { type: 'button', title: 'Modifica: ' + label.toLowerCase() },
        on: { click: function (ev) { openDates(t, ev, list, item, key); } }
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

  /**
   * Deadline chip on the right of the row, identical in role and colors to
   * Trello's native checklist due chip (green done, red late, yellow soon).
   * Without a deadline it shows only a clock icon on hover.
   */
  function deadlineChip(list, item) {
    var status = calc.dueStatus(item, wd.todayIso(), holidays);
    var btn = el('button', {
      cls: 'cp-due' + (status ? ' is-' + status : '') + (item.dl ? '' : ' is-empty'),
      attrs: { type: 'button', title: item.dl ? 'Deadline ' + calc.fmtShortDate(item.dl) : 'Imposta le date', 'aria-label': item.dl ? 'Deadline ' + calc.fmtChipDate(item.dl) : 'Imposta le date' },
      on: { click: function (ev) { openDates(t, ev, list, item, 'dl'); } }
    }, [icon('clock')]);
    if (item.dl) btn.appendChild(el('span', { text: calc.fmtChipDate(item.dl) }));
    return btn;
  }

  function avatarButton(list, item) {
    var member = members.filter(function (m) { return m.id === item.m; })[0];
    var btn = el('button', {
      cls: 'cp-avatar' + (member ? '' : ' is-empty'),
      attrs: { type: 'button', title: member ? (member.fullName || member.username) : 'Assegna', 'aria-label': member ? 'Assegnato a ' + (member.fullName || member.username) : 'Assegna' },
      on: { click: function (ev) { openMembers(t, ev, list, item); } }
    });
    if (member) {
      var photo = avatarUrl(member);
      if (photo) {
        // Profile photo, as Trello shows it.
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

  /**
   * Item row, laid out like Trello's native checklist:
   * [gutter: checkbox] [text ............ deadline chip, avatar, ...]
   *                    [Inizio · Fine · deviation · Lavorati]
   */
  function renderItem(list, item) {
    var metrics = calc.itemMetrics(item, holidays);
    var isEditing = editing && editing.type === 'item' && editing.i === item.i;

    var checkbox = el('input', {
      cls: 'cp-check',
      attrs: { type: 'checkbox', 'aria-label': 'Completato' },
      on: {
        change: function () {
          var done = checkbox.checked;
          row.classList.toggle('is-done', done); // optimistic UI
          saveItem(list.i, item.i, function (it) {
            it.d = done;
            // Completing an item without an end date sets it to today (editable).
            if (done && !it.e) it.e = wd.todayIso();
          }).catch(function () { /* already reported */ });
        }
      }
    });
    checkbox.checked = !!item.d;

    var main;
    if (isEditing) {
      main = inlineEditor(item.t, 500, function (v) {
        editing = null;
        saveItem(list.i, item.i, function (it) { it.t = v; }).catch(function () {});
      }, function () { editing = null; render(); });
    } else {
      main = el('div', { cls: 'cp-item-main' }, [
        el('div', {
          cls: 'cp-item-text',
          text: item.t,
          attrs: { role: 'button', tabindex: '0', title: 'Clicca per modificare' },
          on: {
            click: function () { editing = { type: 'item', i: item.i }; render(); },
            keydown: function (ev) { if (ev.key === 'Enter') { editing = { type: 'item', i: item.i }; render(); } }
          }
        }),
        el('div', { cls: 'cp-item-actions' }, [
          deadlineChip(list, item),
          avatarButton(list, item),
          el('button', {
            cls: 'cp-more',
            attrs: { type: 'button', title: 'Azioni', 'aria-label': 'Azioni elemento' },
            on: { click: function (ev) { openItemMenu(ev, list, item); } }
          }, [icon('dots')])
        ])
      ]);
    }

    var meta = isEditing ? null : el('div', { cls: 'cp-item-meta' }, metaDates(list, item, metrics).concat([
      effortField(list, item),
      metrics.warnings.length
        ? el('span', { cls: 'cp-meta cp-warn', text: '! da verificare', attrs: { title: metrics.warnings.join('\n') } })
        : null
    ]));

    var row = el('div', { cls: 'cp-item' + (item.d ? ' is-done' : '') + (isEditing ? ' is-editing' : '') }, [
      el('div', { cls: 'cp-gutter' }, [checkbox]),
      el('div', { cls: 'cp-item-content' }, [main, meta])
    ]);
    return row;
  }

  /**
   * Checklist block, laid out like Trello's native one:
   * [gutter: icon] [title ...... client · total · Nascondi · Elimina]
   * [gutter: 50%]  [progress bar]
   */
  function renderList(list) {
    var tot = calc.checklistTotals(list, holidays);
    var hiding = isHidingDone(list.i);
    var isEditingTitle = editing && editing.type === 'title' && editing.l === list.i;
    var pct = tot.total ? Math.round((tot.done / tot.total) * 100) : 0;
    var client = calc.resolveClient(list);

    // The farthest item deadline is used for the overall deviation but not shown.
    var summaryTip = [];
    if (tot.start) summaryTip.push('Inizio ' + calc.fmtShortDate(tot.start));
    if (tot.end) summaryTip.push('Fine ' + calc.fmtShortDate(tot.end));
    if (tot.deadline) summaryTip.push('Deadline più lontana ' + calc.fmtShortDate(tot.deadline));

    var titleNode = isEditingTitle
      ? inlineEditor(list.n, 200, function (v) {
        editing = null;
        save(function (s) { var l = findList(s, list.i); if (l) l.n = v; }).catch(function () {});
      }, function () { editing = null; render(); })
      : el('h3', {
        cls: 'cp-list-title',
        text: list.n,
        attrs: { role: 'button', tabindex: '0', title: 'Clicca per rinominare' },
        on: {
          click: function () { editing = { type: 'title', l: list.i }; render(); },
          keydown: function (ev) { if (ev.key === 'Enter') { editing = { type: 'title', l: list.i }; render(); } }
        }
      });

    var headerRight = isEditingTitle ? null : el('div', { cls: 'cp-list-actions' }, [
      tot.done > 0 ? el('button', {
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
            confirmDelete(t, ev, 'Eliminare ' + list.n.slice(0, 40) + '?', 'La checklist e i suoi elementi verranno eliminati definitivamente.',
              function (s) { s.l = s.l.filter(function (l) { return l.i !== list.i; }); });
          }
        }
      })
    ]);

    // No left gutter: the section already sits where Trello starts its
    // content, so title and bar start at the very left edge.
    var header = el('div', { cls: 'cp-row cp-list-header' }, [
      el('div', { cls: 'cp-list-head' }, [titleNode, headerRight])
    ]);

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

    var section = el('section', { cls: 'cp-list' }, [header, progress]);
    list.x.forEach(function (item) {
      if (hiding && item.d) return;
      section.appendChild(renderItem(list, item));
    });
    section.appendChild(el('div', { cls: 'cp-row' }, [el('div', { cls: 'cp-gutter' }), el('div', { cls: 'cp-item-content' }, [renderAddItem(list)])]));
    return section;
  }

  function renderAddItem(list) {
    var formId = 'add-' + list.i;
    if (openForm !== formId) {
      return el('button', {
        cls: 'cp-btn cp-add-btn',
        text: 'Aggiungi un elemento',
        attrs: { type: 'button' },
        on: { click: function () { openForm = formId; editing = null; render(); } }
      });
    }
    var editor = inlineEditor('', 500, function (v) {
      rememberOpenForm(formId);
      save(function (s) {
        var l = findList(s, list.i);
        if (l) l.x.push({ i: store.newId(), t: v, d: false, m: '', s: '', dl: '', e: '', w: 0 });
      }).catch(function () {});
    }, function () { openForm = null; restoreOpenForm(); render(); });
    editor.classList.add('cp-add-form');
    editor.querySelector('.cp-btn-primary').textContent = 'Aggiungi';
    editor.querySelector('textarea').setAttribute('placeholder', 'Aggiungi un elemento');
    return editor;
  }

  function renderNewList() {
    newListEl.textContent = '';
    if (openForm !== 'new-list') {
      newListEl.appendChild(el('button', {
        cls: 'cp-btn cp-new-list-btn',
        text: '+ Checklist',
        attrs: { type: 'button' },
        on: { click: function () { openForm = 'new-list'; editing = null; render(); } }
      }));
      return;
    }
    // Client choice right in the creation form: automatic, none, or one client
    // of the board (several clients can be set later from the client popover).
    var clientSelect = el('select', { cls: 'cp-new-list-client', attrs: { 'aria-label': 'Cliente' } }, [
      el('option', { text: 'Cliente: automatico dal titolo', value: '' }),
      el('option', { text: 'Nessun cliente (attivit\u00e0 interna)', value: calc.NO_CLIENT })
    ]);
    boardClients.forEach(function (c) { clientSelect.appendChild(el('option', { text: c, value: c })); });

    var editor = inlineEditor('', 200, function (v) {
      var chosen = clientSelect.value;
      openForm = null;
      save(function (s) { s.l.push({ i: store.newId(), n: v, c: chosen, x: [] }); }).catch(function () {});
    }, function () { openForm = null; render(); });
    editor.querySelector('.cp-btn-primary').textContent = 'Aggiungi';
    editor.querySelector('textarea').setAttribute('placeholder', 'Titolo, es. NEXI - SVILUPPO BACKEND');
    editor.insertBefore(clientSelect, editor.querySelector('.cp-edit-actions'));
    newListEl.appendChild(editor);
  }

  function renderSize() {
    var size = store.sizeOf(state);
    var pct = Math.round((size / store.LIMIT) * 100);
    // Shown only when space starts to matter, to keep the UI clean.
    sizeEl.hidden = pct < 60;
    sizeEl.textContent = 'Spazio usato su questa card: ' + pct + '%';
    sizeEl.classList.toggle('is-warn', pct >= 80);
  }

  function render() {
    listsEl.textContent = '';
    state.l.forEach(function (list) { listsEl.appendChild(renderList(list)); });
    renderNewList();
    renderSize();
    resize();
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);
    // Shared with the popovers (same origin) as an extra way to know Trello's theme.
    try { window.localStorage.setItem('cp-theme', currentTheme); } catch (e) { /* storage unavailable */ }
  }

  try {
    var ctx = t.getContext() || {};
    applyTheme(ctx.theme || ctx.initialTheme);
    if (typeof t.subscribeToThemeChanges === 'function') t.subscribeToThemeChanges(applyTheme);
  } catch (e) { applyTheme('light'); }

  // Save pending clicks if the card is closed before the batch timer fires.
  window.addEventListener('pagehide', flushEffort);

  openForm = restoreOpenForm();

  t.render(function () {
    return Promise.all([
      // Board client list first: it drives the automatic client detection.
      window.CP.people.loadClients(t).then(function (c) { boardClients = c; calc.setClients(c); return store.load(t); }),
      t.board('members').catch(function () { return { members: [] }; }),
      t.card('id')
    ]).then(function (res) {
      state = res[0];
      members = (res[1].members || []).slice().sort(function (a, b) {
        return String(a.fullName || '').localeCompare(String(b.fullName || ''));
      });
      cardId = res[2].id;
      render();
    }).catch(function (err) {
      showError('Impossibile caricare i dati della card.');
      if (window.console) console.error('[Checklist+]', err);
    });
  });
})();
