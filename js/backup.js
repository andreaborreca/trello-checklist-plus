/**
 * Checklist+ - "Backup e ripristino" popover.
 *
 * Backup: one JSON file with the Checklist+ data of every card of the board
 * (decoded, readable), plus the board client list and member areas.
 * Restore: reads such a file, matches each card by id (or, if the card was
 * recreated, by a unique name), shows what will be restored and writes the
 * selected cards back. Before writing, a backup of the current state is
 * downloaded automatically.
 *
 * Security: the file is untrusted input. It is size-limited, parsed as JSON,
 * every card state goes through the storage schema (CP.store.sanitize), and
 * data is written only to cards of this board. Text is shown via textContent.
 */
(function () {
  'use strict';

  var store = window.CP.store;
  var people = window.CP.people;
  var pop = window.CP.pop;
  var wd = window.CP.workdays;

  var APP = 'checklist-plus';
  var FORMAT_VERSION = 1;
  var MAX_FILE_BYTES = 5 * 1024 * 1024;

  var t = pop.start();
  if (!t) return;

  var statusEl = document.getElementById('cp-bk-status');
  var downloadEl = document.getElementById('cp-bk-download');
  var fileEl = document.getElementById('cp-bk-file');
  var restoreEl = document.getElementById('cp-bk-restore');
  var infoEl = document.getElementById('cp-bk-info');
  var cardsEl = document.getElementById('cp-bk-cards');
  var boardEl = document.getElementById('cp-bk-board');
  var runEl = document.getElementById('cp-bk-run');
  var resultEl = document.getElementById('cp-bk-result');
  var errorEl = document.getElementById('cp-popup-error');

  var board = { id: '', name: '' };
  var cards = [];     // every card of the board: {id, name}
  var plan = [];      // restore rows: {source, target, state, checkbox}
  var backupBoard = null;

  function resize() { t.sizeTo('#cp-backup').catch(function () {}); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function showError(msg) { errorEl.textContent = msg; errorEl.hidden = !msg; resize(); }

  function countTasks(state) { return state.l.reduce(function (n, l) { return n + l.x.length; }, 0); }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fileName(suffix) {
    var d = new Date();
    var stamp = wd.todayIso() + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
    var slug = String(board.name || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board';
    return 'checklist-plus-backup_' + slug + '_' + stamp + (suffix || '') + '.json';
  }

  /** Reads the current Checklist+ data of the whole board. */
  function snapshot() {
    return Promise.all([
      Promise.all(cards.map(function (c) {
        return t.get(c.id, 'shared', store.KEY).then(function (raw) {
          if (!raw) return null;
          var state = store.decodeStrict(raw);
          // An unreadable card is kept as raw text, so nothing is lost.
          return state ? { id: c.id, name: c.name, data: state } : { id: c.id, name: c.name, raw: String(raw) };
        });
      })),
      people.loadClients(t),
      people.loadAreas(t)
    ]).then(function (res) {
      return {
        app: APP,
        version: FORMAT_VERSION,
        created: new Date().toISOString(),
        board: { id: board.id, name: board.name },
        boardData: { clients: res[1], areas: res[2] },
        cards: res[0].filter(Boolean)
      };
    });
  }

  function download(obj, name) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  downloadEl.addEventListener('click', function () {
    downloadEl.disabled = true;
    snapshot().then(function (b) {
      download(b, fileName());
      statusEl.textContent = 'Backup scaricato: ' + b.cards.length + ' card, ' +
        b.cards.reduce(function (n, c) { return n + (c.data ? countTasks(c.data) : 0); }, 0) + ' task.';
    }, function (err) { pop.fail('Backup non riuscito', err); }).then(function () { downloadEl.disabled = false; resize(); });
  });

  /* ---------------- restore ---------------- */

  /** Validates a parsed backup file; returns an error message or ''. */
  function invalid(b) {
    if (!b || typeof b !== 'object' || b.app !== APP) return 'Il file non è un backup di Checklist+.';
    if (b.version !== FORMAT_VERSION) return 'Versione del backup non supportata.';
    if (!Array.isArray(b.cards)) return 'Il backup non contiene card.';
    return '';
  }

  /** Card of this board for a backed-up card: same id, or a unique card with the same name. */
  function matchCard(src) {
    var byId = cards.filter(function (c) { return c.id === src.id; })[0];
    if (byId) return { card: byId, how: '' };
    var byName = cards.filter(function (c) { return c.name === src.name; });
    if (byName.length === 1) return { card: byName[0], how: ' (stesso nome, card ricreata)' };
    return null;
  }

  function buildPlan(b) {
    plan = [];
    cardsEl.textContent = '';
    b.cards.slice(0, 2000).forEach(function (src) {
      if (!src || typeof src !== 'object') return;
      var name = String(src.name || src.id || '').slice(0, 200);
      var state = src.data ? store.sanitize(src.data) : null;
      var target = matchCard({ id: String(src.id || ''), name: name });
      var label = el('label', 'cp-export-month');
      var box = el('input');
      box.type = 'checkbox';
      var text;
      if (!state) {
        text = name + ': nel backup i dati non erano leggibili, non ripristinabile';
        box.disabled = true;
      } else if (!target) {
        text = name + ': card non trovata sulla bacheca, non ripristinabile';
        box.disabled = true;
      } else {
        text = name + target.how + ': ' + state.l.length + ' checklist, ' + countTasks(state) + ' task';
        box.checked = true;
        plan.push({ source: src, target: target.card, state: state, checkbox: box });
      }
      label.appendChild(box);
      label.appendChild(el('span', '', text));
      cardsEl.appendChild(label);
      box.addEventListener('change', updateRun);
    });
    backupBoard = b.boardData && typeof b.boardData === 'object' ? b.boardData : null;
    boardEl.parentNode.hidden = !backupBoard;
    var when = new Date(b.created);
    infoEl.textContent = 'Backup della bacheca "' + String((b.board && b.board.name) || '').slice(0, 100) + '" del ' +
      (isNaN(when.getTime()) ? 'data sconosciuta' : when.toLocaleString('it-IT')) + '. Le card selezionate tornano allo stato del backup; le altre non cambiano.' +
      (b.board && b.board.id && b.board.id !== board.id ? ' Attenzione: il backup è di un\'altra bacheca, le card sono abbinate per nome.' : '');
    restoreEl.hidden = false;
    updateRun();
  }

  function selected() { return plan.filter(function (p) { return p.checkbox.checked; }); }

  function updateRun() {
    var n = selected().length;
    runEl.textContent = n ? 'Ripristina ' + n + ' card' : 'Seleziona almeno una card';
    runEl.disabled = !n;
    resize();
  }

  fileEl.addEventListener('change', function () {
    var file = fileEl.files && fileEl.files[0];
    showError('');
    resultEl.hidden = true;
    restoreEl.hidden = true;
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { showError('Il file è troppo grande per essere un backup di Checklist+.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var b;
      try { b = JSON.parse(String(reader.result)); } catch (e) { showError('Il file non è un JSON valido.'); return; }
      var msg = invalid(b);
      if (msg) { showError(msg); return; }
      buildPlan(b);
    };
    reader.onerror = function () { showError('Impossibile leggere il file.'); };
    reader.readAsText(file);
  });

  /** Writes one card; resolves with '' or a short problem description. */
  function restoreOne(p) {
    var state = store.prune(store.sanitize(p.state));
    var size = store.sizeOf(state);
    if (size > store.SAFE_LIMIT) return Promise.resolve('troppo grande per la card');
    return t.set(p.target.id, 'shared', store.KEY, store.encode(state)).then(function () { return ''; }, function (err) {
      return 'errore di Trello' + (err && err.message ? ' (' + err.message + ')' : '');
    });
  }

  runEl.addEventListener('click', function () {
    var rows = selected();
    if (!rows.length) return;
    runEl.disabled = true;
    fileEl.disabled = true;
    showError('');
    statusEl.textContent = 'Backup dello stato attuale...';
    // Safety net: the current state is downloaded before anything is written.
    snapshot().then(function (current) {
      download(current, fileName('_prima-del-ripristino'));
      var problems = [];
      var done = 0;
      return rows.reduce(function (p, row, idx) {
        return p.then(function () {
          statusEl.textContent = 'Ripristino ' + (idx + 1) + '/' + rows.length + ': ' + row.target.name;
          return restoreOne(row).then(function (problem) {
            if (problem) problems.push(row.target.name + ': ' + problem); else done++;
          });
        });
      }, Promise.resolve()).then(function () {
        if (!boardEl.checked || !backupBoard) return;
        return Promise.all([
          people.saveClients(t, backupBoard.clients || []),
          people.saveAreas(t, backupBoard.areas || {})
        ]).catch(function () { problems.push('clienti e aree della bacheca: non ripristinati'); });
      }).then(function () {
        statusEl.textContent = 'Ripristino completato.';
        resultEl.textContent = done + ' card ripristinate' + (problems.length ? '. Non riuscite: ' + problems.join('; ') + '.' : '.') +
          ' Il backup dello stato precedente è stato scaricato.';
        resultEl.hidden = false;
      });
    }).catch(function (err) {
      pop.fail('Ripristino interrotto: nessuna card è stata modificata', err);
    }).then(function () {
      fileEl.disabled = false;
      updateRun();
    });
  });

  var loaded = false;
  t.render(function () {
    if (loaded) return;
    loaded = true;
    return Promise.all([t.board('id', 'name'), t.cards('id', 'name')]).then(function (res) {
      board = { id: res[0].id, name: res[0].name };
      cards = (res[1] || []).map(function (c) { return { id: c.id, name: c.name }; });
      return Promise.all(cards.map(function (c) {
        return t.get(c.id, 'shared', store.KEY).then(function (raw) { return raw ? 1 : 0; }, function () { return 0; });
      }));
    }).then(function (flags) {
      var n = flags.reduce(function (a, b) { return a + b; }, 0);
      statusEl.textContent = n + ' card della bacheca ' + (n === 1 ? 'ha' : 'hanno') + ' Checklist+.';
      downloadEl.disabled = false;
      resize();
    }).catch(function (err) { pop.fail('Impossibile leggere le card della bacheca', err); resize(); });
  });
})();
