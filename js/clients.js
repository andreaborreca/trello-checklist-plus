/**
 * Checklist+ - client popover for one checklist.
 * Choose "Automatico" (detected from the title), "Nessun cliente", or tick
 * one or more clients of the board (e.g. two clients sharing a checklist).
 * The board's client list is edited in the same popover, one name per line.
 */
(function () {
  'use strict';

  var store = window.CP.store;
  var calc = window.CP.calc;
  var people = window.CP.people;
  var pop = window.CP.pop;

  var t = pop.start();
  if (!t) return;

  var ID_RE = /^[a-z0-9]{1,12}$/;
  var listId = t.arg('l');

  var autoEl = document.getElementById('cp-client-auto');
  var autoLabelEl = document.getElementById('cp-client-auto-label');
  var noneEl = document.getElementById('cp-client-none');
  var manualEl = document.getElementById('cp-client-manual');
  var listEl = document.getElementById('cp-client-list');
  var emptyEl = document.getElementById('cp-client-empty');
  var manageEl = document.getElementById('cp-client-manage');
  var editorEl = document.getElementById('cp-client-editor');
  var textEl = document.getElementById('cp-client-text');

  var clients = [];
  var title = '';

  function resize() { t.sizeTo('#cp-clients').catch(function () {}); }

  function checked() {
    return Array.prototype.map.call(listEl.querySelectorAll('input:checked'), function (i) { return i.value; });
  }

  function renderList(selected) {
    listEl.textContent = '';
    clients.forEach(function (c) {
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = c;
      input.checked = selected.indexOf(c) >= 0;
      input.addEventListener('change', function () { manualEl.checked = true; });
      var name = document.createElement('span');
      name.textContent = c;
      var label = document.createElement('label');
      label.className = 'cp-export-month';
      label.appendChild(input); label.appendChild(name);
      listEl.appendChild(label);
    });
    emptyEl.hidden = clients.length > 0;
    calc.setClients(clients);
    var detected = calc.resolveClient({ n: title }).value;
    autoLabelEl.textContent = 'Automatico dal titolo: ' + (detected || 'nessun cliente riconosciuto');
    resize();
  }

  function saveChoice() {
    var value = '';
    if (noneEl.checked) value = calc.NO_CLIENT;
    else if (manualEl.checked) {
      var picked = checked();
      if (!picked.length) { pop.fail('Spunta almeno un cliente, oppure scegli un\'altra opzione', null); resize(); return; }
      value = picked.join(' + ').slice(0, 60);
    }
    store.update(t, function (s) {
      var list = (s.l || []).filter(function (l) { return l.i === listId; })[0];
      if (!list) throw new Error('Checklist non trovata');
      list.c = value;
    }).then(function () { return t.closePopup(); }).catch(function (err) { pop.fail('Salvataggio non riuscito', err); resize(); });
  }

  if (!ID_RE.test(listId || '')) { pop.fail('Checklist non valida', null); return; }

  document.getElementById('cp-clients').addEventListener('submit', function (ev) { ev.preventDefault(); saveChoice(); });

  manageEl.addEventListener('click', function () {
    editorEl.hidden = !editorEl.hidden;
    textEl.value = clients.join('\n');
    resize();
  });

  document.getElementById('cp-client-save-list').addEventListener('click', function () {
    var keep = checked();
    people.saveClients(t, textEl.value.split('\n')).then(function (clean) {
      clients = clean;
      editorEl.hidden = true;
      renderList(keep.filter(function (c) { return clean.indexOf(c) >= 0; }));
    }).catch(function (err) { pop.fail('Salvataggio dell\'elenco non riuscito', err); resize(); });
  });

  var loaded = false;
  t.render(function () {
    if (loaded) return; // keep the form stable while the client list is being edited
    return Promise.all([store.load(t), people.loadClients(t)]).then(function (res) {
      var list = res[0].l.filter(function (l) { return l.i === listId; })[0];
      if (!list) { pop.fail('Checklist non trovata, forse è stata eliminata', null); return; }
      loaded = true;
      title = list.n;
      clients = res[1];
      var selected = [];
      if (list.c === calc.NO_CLIENT) noneEl.checked = true;
      else if (list.c) {
        manualEl.checked = true;
        selected = list.c.split(' + ').map(calc.normalizeLabel);
        // Keep explicit values that are no longer in the board list visible and selectable.
        selected.forEach(function (c) { if (c && clients.indexOf(c) < 0) clients.push(c); });
      } else autoEl.checked = true;
      renderList(selected);
    }).catch(function (err) { pop.fail('Impossibile leggere i dati', err); resize(); });
  });
})();
