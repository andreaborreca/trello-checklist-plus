/**
 * Checklist+ - "Aree del team" popover: assigns each board member to a work
 * area (Backend, Frontend, Data, CTO, PM). Saved in the board's shared
 * pluginData, used to group the member picker and the export totals.
 */
(function () {
  'use strict';

  var people = window.CP.people;
  var pop = window.CP.pop;

  var t = pop.start();
  if (!t) return;

  var listEl = document.getElementById('cp-areas-list');
  function resize() { t.sizeTo('#cp-areas').catch(function () {}); }

  function row(member, current) {
    var wrap = document.createElement('label');
    wrap.className = 'cp-area-row';
    wrap.appendChild(people.avatarNode(member, 'cp-avatar cp-avatar-lg'));
    var name = document.createElement('span');
    name.className = 'cp-member-name';
    name.textContent = people.displayName(member);
    wrap.appendChild(name);

    var select = document.createElement('select');
    select.setAttribute('aria-label', 'Area di ' + people.displayName(member));
    [{ k: '', n: '—' }].concat(people.AREAS).forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.k;
      opt.textContent = a.n;
      select.appendChild(opt);
    });
    select.value = current || '';
    select.addEventListener('change', function () {
      select.disabled = true;
      people.setArea(t, member.id, select.value)
        .catch(function (err) { pop.fail('Salvataggio non riuscito', err); resize(); })
        .then(function () { select.disabled = false; });
    });
    wrap.appendChild(select);
    return wrap;
  }

  var rendered = false;
  t.render(function () {
    if (rendered) return; // keep the selects stable while saving
    return Promise.all([t.board('members'), people.loadAreas(t)]).then(function (res) {
      rendered = true;
      listEl.textContent = '';
      (res[0].members || []).slice().sort(function (a, b) {
        return people.displayName(a).localeCompare(people.displayName(b));
      }).forEach(function (m) { listEl.appendChild(row(m, res[1][m.id])); });
      resize();
    }).catch(function (err) { pop.fail('Impossibile leggere i membri', err); resize(); });
  });
})();
