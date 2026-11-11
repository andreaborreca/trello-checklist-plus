/**
 * Checklist+ - member picker popover, modeled on Trello's "Assegna":
 * search box, avatar + name rows grouped by work area, a check on the
 * assigned member, "Rimuovi membro" at the bottom.
 */
(function () {
  'use strict';

  var store = window.CP.store;
  var people = window.CP.people;
  var pop = window.CP.pop;

  var t = pop.start();
  if (!t) return;

  var ID_RE = /^[a-z0-9]{1,12}$/;
  var listId = t.arg('l');
  var itemId = t.arg('i');

  var searchEl = document.getElementById('cp-member-search');
  var listEl = document.getElementById('cp-member-list');
  var removeEl = document.getElementById('cp-member-remove');
  var areasEl = document.getElementById('cp-member-areas');

  var members = [];
  var areas = {};
  var assigned = '';

  function resize() { t.sizeTo('#cp-members').catch(function () {}); }

  function assign(memberId) {
    return store.update(t, function (s) {
      var list = (s.l || []).filter(function (l) { return l.i === listId; })[0];
      var item = list && list.x.filter(function (it) { return it.i === itemId; })[0];
      if (!item) throw new Error('Elemento non trovato');
      item.m = memberId;
    }).then(function () { return t.closePopup(); }).catch(function (err) { pop.fail('Salvataggio non riuscito', err); resize(); });
  }

  function row(member) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-member-row' + (member.id === assigned ? ' is-assigned' : '');
    btn.appendChild(people.avatarNode(member, 'cp-avatar cp-avatar-lg'));
    var name = document.createElement('span');
    name.className = 'cp-member-name';
    name.textContent = people.displayName(member);
    btn.appendChild(name);
    if (member.id === assigned) {
      var check = document.createElement('span');
      check.className = 'cp-member-check';
      check.textContent = '✓';
      check.setAttribute('aria-label', 'Assegnato');
      btn.appendChild(check);
    }
    // Clicking the assigned member again removes the assignment, as in Trello.
    btn.addEventListener('click', function () { assign(member.id === assigned ? '' : member.id); });
    return btn;
  }

  function header(text) {
    var h = document.createElement('div');
    h.className = 'cp-member-group';
    h.textContent = text;
    return h;
  }

  /** Members grouped by area (in the fixed area order), then those without area. */
  function render() {
    var query = searchEl.value.trim().toLowerCase();
    var visible = members.filter(function (m) { return !query || people.displayName(m).toLowerCase().indexOf(query) >= 0; });
    listEl.textContent = '';

    var hasAreas = Object.keys(areas).length > 0;
    if (!hasAreas) {
      listEl.appendChild(header('Membri della bacheca'));
      visible.forEach(function (m) { listEl.appendChild(row(m)); });
    } else {
      people.AREAS.forEach(function (a) {
        var group = visible.filter(function (m) { return areas[m.id] === a.k; });
        if (!group.length) return;
        listEl.appendChild(header(a.n));
        group.forEach(function (m) { listEl.appendChild(row(m)); });
      });
      var rest = visible.filter(function (m) { return !areas[m.id]; });
      if (rest.length) {
        listEl.appendChild(header('Altri membri'));
        rest.forEach(function (m) { listEl.appendChild(row(m)); });
      }
    }
    if (!visible.length) {
      var empty = document.createElement('p');
      empty.className = 'cp-popup-info';
      empty.textContent = 'Nessun membro trovato.';
      listEl.appendChild(empty);
    }
    removeEl.hidden = !assigned;
    resize();
  }

  if (!ID_RE.test(listId || '') || !ID_RE.test(itemId || '')) { pop.fail('Elemento non valido', null); return; }

  searchEl.addEventListener('input', render);
  removeEl.addEventListener('click', function () { assign(''); });
  areasEl.addEventListener('click', function () {
    t.popup({ title: 'Aree del team', url: './areas.html?v=1.13.0', args: { th: document.documentElement.getAttribute('data-theme') }, height: 380 });
  });

  t.render(function () {
    return Promise.all([store.load(t), t.board('members'), people.loadAreas(t)]).then(function (res) {
      var list = res[0].l.filter(function (l) { return l.i === listId; })[0];
      var item = list && list.x.filter(function (it) { return it.i === itemId; })[0];
      if (!item) { pop.fail('Elemento non trovato, forse è stato eliminato', null); return; }
      assigned = item.m || '';
      members = (res[1].members || []).slice().sort(function (a, b) {
        return people.displayName(a).localeCompare(people.displayName(b));
      });
      areas = res[2];
      render();
      searchEl.focus();
    }).catch(function (err) { pop.fail('Impossibile leggere i dati', err); resize(); });
  });
})();
