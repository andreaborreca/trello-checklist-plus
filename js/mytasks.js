/**
 * Checklist+ - "I miei task" popover: the Checklist+ tasks assigned to one
 * member (by default the current one) across every card of the board.
 *
 * Power-Ups cannot add filters to Trello's own filter menu, so this list is
 * the board-wide view: a click opens the card and highlights the task (the
 * request is passed to the card section through localStorage, same origin).
 * Read-only: nothing is written to Trello.
 */
(function () {
  'use strict';

  var store = window.CP.store;
  var calc = window.CP.calc;
  var wd = window.CP.workdays;
  var people = window.CP.people;
  var pop = window.CP.pop;

  var t = pop.start();
  if (!t) return;

  var memberEl = document.getElementById('cp-mt-member');
  var openEl = document.getElementById('cp-mt-open');
  var statusEl = document.getElementById('cp-mt-status');
  var listEl = document.getElementById('cp-mt-list');

  var cards = [];     // [{id, name, column, state}]
  var holidays = new Set();

  function resize() { t.sizeTo('#cp-mytasks').catch(function () {}); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Opens the card and asks its section to highlight the task. */
  function openTask(cardId, itemId) {
    try { window.localStorage.setItem('cp-focus', JSON.stringify({ c: cardId, i: itemId, at: Date.now() })); } catch (e) { /* storage unavailable: the card still opens */ }
    t.showCard(cardId);
    t.closePopup();
  }

  function draw() {
    var memberId = memberEl.value;
    var onlyOpen = openEl.checked;
    var today = wd.todayIso();
    var groups = [];
    var total = 0;
    var late = 0;

    cards.forEach(function (card) {
      var rows = [];
      card.state.l.forEach(function (list) {
        list.x.forEach(function (item) {
          if (item.m !== memberId || (onlyOpen && item.d)) return;
          rows.push({ list: list, item: item, status: calc.dueStatus(item, today, holidays) });
        });
      });
      if (!rows.length) return;
      // Earliest deadline first, tasks without deadline last.
      rows.sort(function (a, b) { return (a.item.dl || '9999') < (b.item.dl || '9999') ? -1 : (a.item.dl || '9999') > (b.item.dl || '9999') ? 1 : 0; });
      total += rows.length;
      late += rows.filter(function (r) { return !r.item.d && r.status === 'late'; }).length;
      groups.push({ card: card, rows: rows, first: rows[0].item.dl || '9999' });
    });
    groups.sort(function (a, b) { return a.first < b.first ? -1 : a.first > b.first ? 1 : 0; });

    statusEl.textContent = total
      ? total + ' task' + (onlyOpen ? ' da completare' : '') + (late ? ', ' + late + ' in ritardo' : '') + '. Clicca un task per aprire la card.'
      : 'Nessun task' + (onlyOpen ? ' da completare' : '') + ' assegnato a questo membro.';

    listEl.textContent = '';
    groups.forEach(function (g) {
      var head = el('div', 'cp-mt-card');
      head.appendChild(el('span', 'cp-mt-card-name', g.card.name));
      if (g.card.column) head.appendChild(el('span', 'cp-mt-card-col', g.card.column));
      listEl.appendChild(head);
      g.rows.forEach(function (r) {
        var b = el('button', 'cp-mt-row' + (r.item.d ? ' is-done' : ''));
        b.type = 'button';
        b.title = 'Apri la card e mostra il task';
        b.appendChild(el('span', 'cp-mt-state', r.item.d ? '✓' : ''));
        var text = el('span', 'cp-mt-text');
        text.appendChild(el('span', 'cp-mt-task', r.item.t));
        var client = calc.resolveClient(r.list).value;
        // The client is added only when the checklist title does not already contain it.
        var shown = client && calc.normalizeLabel(r.list.n).indexOf(client) < 0;
        text.appendChild(el('span', 'cp-mt-list', r.list.n + (shown ? ' · ' + client : '')));
        b.appendChild(text);
        if (r.item.dl) {
          var chip = el('span', 'cp-due' + (r.status ? ' is-' + r.status : ''), calc.fmtChipDate(r.item.dl));
          b.appendChild(chip);
        }
        b.addEventListener('click', function () { openTask(g.card.id, r.item.i); });
        listEl.appendChild(b);
      });
    });
    resize();
  }

  memberEl.addEventListener('change', draw);
  openEl.addEventListener('change', draw);

  var loaded = false;
  t.render(function () {
    if (loaded) return;
    var me = '';
    try { me = (t.getContext() || {}).member || ''; } catch (e) { me = ''; }

    return Promise.all([
      t.cards('id', 'name', 'idList'),
      t.board('members'),
      t.lists('id', 'name').catch(function () { return []; }),
      people.loadClients(t)
    ]).then(function (res) {
      loaded = true;
      calc.setClients(res[3] || []);
      var columns = {};
      (res[2] || []).forEach(function (l) { columns[l.id] = l.name; });
      var members = (res[1].members || []).slice().sort(function (a, b) {
        return people.displayName(a).localeCompare(people.displayName(b));
      });
      members.forEach(function (m) {
        var opt = el('option', '', people.displayName(m));
        opt.value = m.id;
        memberEl.appendChild(opt);
      });
      memberEl.value = members.some(function (m) { return m.id === me; }) ? me : (members[0] ? members[0].id : '');

      // A card that cannot be read is skipped, not fatal.
      return Promise.all((res[0] || []).map(function (c) {
        return t.get(c.id, 'shared', store.KEY)
          .then(function (blob) { return { id: c.id, name: c.name, column: columns[c.idList] || '', state: store.decode(blob) }; })
          .catch(function () { return { id: c.id, name: c.name, column: '', state: store.emptyState() }; });
      }));
    }).then(function (withData) {
      cards = withData || [];
      draw();
    }).catch(function (err) { pop.fail('Impossibile leggere le card della bacheca', err); statusEl.hidden = true; resize(); });
  });
})();
