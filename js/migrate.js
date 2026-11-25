/**
 * Checklist+ - "Formato compatto" popover.
 *
 * Shows how the board's cards are stored and switches the whole board
 * between the base64 format and the compact UTF-16 format (about 2.5 times
 * more content per card), converting every card in one go:
 * 1. sets the board flag, so every section writes the new format from now on;
 * 2. re-encodes each card (read, decode, encode, write), one at a time.
 * A card that cannot be read is skipped and never overwritten. If Trello
 * refuses the first UTF-16 value, the flag is put back and nothing else changes.
 */
(function () {
  'use strict';

  var store = window.CP.store;
  var pop = window.CP.pop;

  var t = pop.start();
  if (!t) return;

  var statusEl = document.getElementById('cp-mg-status');
  var actionsEl = document.getElementById('cp-mg-actions');
  var confirmEl = document.getElementById('cp-mg-confirm');
  var runEl = document.getElementById('cp-mg-run');
  var resultEl = document.getElementById('cp-mg-result');
  var testEl = document.getElementById('cp-mg-test');
  var testResultEl = document.getElementById('cp-mg-test-result');
  var testPassed = false;
  var allCards = [];  // every card of the board (the test uses one without Checklist+ data)

  var cards = [];   // [{id, name, raw}]
  var active = false;

  function resize() { t.sizeTo('#cp-migrate').catch(function () {}); }
  function pct(n) { return Math.round((n / store.LIMIT) * 100) + '%'; }

  /** Current situation of the board. */
  function survey() {
    var withData = cards.filter(function (c) { return c.raw; });
    var unreadable = withData.filter(function (c) { return !store.decodeStrict(c.raw); });
    var compact = withData.filter(function (c) { return store.isUtf16Value(c.raw) && unreadable.indexOf(c) < 0; });
    var maxNow = 0;
    var maxCompact = 0;
    var maxBase64 = 0;
    withData.forEach(function (c) {
      var s = store.decodeStrict(c.raw);
      if (!s) return;
      maxNow = Math.max(maxNow, JSON.stringify({ cp: c.raw }).length);
      maxCompact = Math.max(maxCompact, store.sizeOf(s, 'utf16'));
      maxBase64 = Math.max(maxBase64, store.sizeOf(s, 'base64'));
    });
    return { withData: withData, compact: compact, unreadable: unreadable, maxNow: maxNow, maxCompact: maxCompact, maxBase64: maxBase64 };
  }

  function draw() {
    var s = survey();
    var lines = [
      'Formato attivo sulla bacheca: ' + (active ? 'compatto' : 'precedente (base64)') + '.',
      s.withData.length + ' card con Checklist+, di cui ' + s.compact.length + ' già nel formato compatto.',
      'Card più piena: ' + pct(s.maxNow) + ' ora, ' + pct(s.maxCompact) + ' nel formato compatto.'
    ];
    if (s.unreadable.length) lines.push(s.unreadable.length + ' card non leggibili: verranno saltate.');
    statusEl.textContent = lines.join(' ');
    actionsEl.hidden = false;
    var todo = active ? s.compact.length : s.withData.length - s.compact.length - s.unreadable.length;
    runEl.textContent = active
      ? 'Torna al formato precedente' + (todo ? ' e riconverti ' + todo + ' card' : '')
      : 'Attiva il formato compatto' + (todo ? ' e converti ' + todo + ' card' : '');
    confirmEl.parentNode.hidden = active; // going back is always safe
    testEl.hidden = active;
    runEl.disabled = !active && !(confirmEl.checked && testPassed);
    resize();
  }

  confirmEl.addEventListener('change', draw);

  /*
   * Compatibility test, without touching the checklists: on a card with no
   * Checklist+ data, writes a test value under a separate key, reads it back,
   * compares it character by character and removes it.
   * The value is about 2000 compact characters (about 6000 bytes in UTF-8),
   * so it also tells whether Trello counts characters (accepted) or bytes
   * (refused, over 4096). It contains every kind of character the compact
   * format can produce, quotes and backslashes included.
   */
  var TEST_KEY = 'cpt';
  var TEST_LENGTH = 2000;

  function testValue() {
    var out = '~';
    for (var i = 0; i < TEST_LENGTH; i++) {
      // Spread over the whole range used by the compact format (32..32799).
      out += String.fromCharCode(32 + ((i * 7919) % 32768));
    }
    return out + '"\\';
  }

  function runTest() {
    var target = allCards.filter(function (c) { return !c.raw; })[0];
    if (!target) return Promise.reject(new Error('serve almeno una card senza Checklist+ sulla bacheca'));
    var value = testValue();
    return t.set(target.id, 'shared', TEST_KEY, value).then(function () {
      return t.get(target.id, 'shared', TEST_KEY);
    }).then(function (back) {
      var same = back === value;
      return t.remove(target.id, 'shared', TEST_KEY).catch(function () {}).then(function () {
        if (!same) throw new Error('Trello ha modificato il valore salvato');
        return target;
      });
    }, function (err) {
      return t.remove(target.id, 'shared', TEST_KEY).catch(function () {}).then(function () { throw err; });
    });
  }

  testEl.addEventListener('click', function () {
    testEl.disabled = true;
    testEl.textContent = 'Verifica in corso...';
    testResultEl.hidden = true;
    runTest().then(function (card) {
      testPassed = true;
      testResultEl.textContent = 'Verifica superata: Trello ha accettato e restituito intatto un valore di ' + TEST_LENGTH +
        ' caratteri compatti (circa ' + Math.round(TEST_LENGTH * 3 / 1000) + '.000 byte), quindi conta i caratteri. Prova fatta su "' + card.name + '" e già rimossa.';
    }, function (err) {
      testPassed = false;
      testResultEl.textContent = 'Verifica non superata: ' + (err && err.message ? err.message : err) + '. Il formato compatto non va attivato; le checklist non sono state toccate.';
      if (window.console) console.error('[Checklist+]', err);
    }).then(function () {
      testEl.disabled = false;
      testEl.textContent = testPassed ? 'Verifica superata' : '1. Verifica che Trello accetti il formato';
      testResultEl.hidden = false;
      draw();
    });
  });

  /** Re-encodes one card in the given format; resolves with a short outcome. */
  function convert(card, fmt) {
    return t.get(card.id, 'shared', store.KEY).then(function (raw) {
      if (!raw) return 'empty';
      var state = store.decodeStrict(raw);
      if (!state) return 'unreadable';             // never overwrite what cannot be read
      if ((fmt === 'utf16') === store.isUtf16Value(raw)) return 'same';
      if (store.sizeOf(state, fmt) > store.SAFE_LIMIT) return 'toobig';
      var value = store.encode(state, fmt);
      return t.set(card.id, 'shared', store.KEY, value).then(function () { card.raw = value; return 'done'; });
    });
  }

  function runAll(fmt) {
    var out = { done: 0, same: 0, empty: 0, unreadable: 0, toobig: 0, failed: [] };
    return cards.reduce(function (p, card, idx) {
      return p.then(function () {
        statusEl.textContent = 'Conversione ' + (idx + 1) + '/' + cards.length + ': ' + card.name;
        return convert(card, fmt).then(function (r) { out[r]++; }, function (err) {
          // Trello refused the very first compact value: stop and go back.
          if (fmt === 'utf16' && out.done === 0) throw err;
          out.failed.push(card.name);
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  runEl.addEventListener('click', function () {
    var target = active ? 'base64' : 'utf16';
    runEl.disabled = true;
    confirmEl.disabled = true;
    resultEl.hidden = true;
    t.set('board', 'shared', store.FORMAT_KEY, target === 'utf16' ? 'u16' : 'b64').then(function () {
      active = target === 'utf16';
      return runAll(target);
    }).then(function (out) {
      var parts = [out.done + ' card convertite'];
      if (out.unreadable) parts.push(out.unreadable + ' non leggibili, lasciate come sono');
      if (out.toobig) parts.push(out.toobig + ' troppo piene per il formato precedente, lasciate nel compatto');
      if (out.failed.length) parts.push('non riuscite: ' + out.failed.join(', ') + ' (riprova: le card già convertite vengono saltate)');
      resultEl.textContent = parts.join('; ') + '.';
      resultEl.hidden = false;
    }, function (err) {
      // The compact format was refused: put the board flag back.
      active = false;
      return t.set('board', 'shared', store.FORMAT_KEY, 'b64').catch(function () {}).then(function () {
        pop.fail('Trello ha rifiutato il formato compatto, la bacheca resta nel formato precedente', err);
      });
    }).then(function () {
      confirmEl.disabled = false;
      confirmEl.checked = false;
      draw();
    });
  });

  var loaded = false;
  t.render(function () {
    if (loaded) return;
    loaded = true;
    return Promise.all([
      t.cards('id', 'name'),
      t.get('board', 'shared', store.FORMAT_KEY).catch(function () { return ''; })
    ]).then(function (res) {
      active = res[1] === 'u16';
      return Promise.all((res[0] || []).map(function (c) {
        return t.get(c.id, 'shared', store.KEY)
          .then(function (raw) { return { id: c.id, name: c.name, raw: raw || '' }; })
          .catch(function () { return { id: c.id, name: c.name, raw: '' }; });
      }));
    }).then(function (list) {
      allCards = list;
      cards = list.filter(function (c) { return c.raw; });
      draw();
    }).catch(function (err) { pop.fail('Impossibile leggere le card della bacheca', err); statusEl.hidden = true; resize(); });
  });
})();
