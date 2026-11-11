/**
 * Checklist+ - "Clienti" popover: edits the board's client list, one name per
 * line. The list is saved in the board's shared pluginData and drives the
 * automatic client detection on checklist titles and the export totals.
 */
(function () {
  'use strict';

  var people = window.CP.people;
  var pop = window.CP.pop;

  var t = pop.start();
  if (!t) return;

  var textEl = document.getElementById('cp-client-text');
  var savedEl = document.getElementById('cp-clientlist-saved');
  function resize() { t.sizeTo('#cp-clientlist').catch(function () {}); }

  document.getElementById('cp-clientlist').addEventListener('submit', function (ev) {
    ev.preventDefault();
    people.saveClients(t, textEl.value.split('\n')).then(function (clean) {
      textEl.value = clean.join('\n'); // show the cleaned list (upper case, no duplicates)
      savedEl.textContent = clean.length + (clean.length === 1 ? ' cliente salvato.' : ' clienti salvati.');
      savedEl.hidden = false;
      resize();
    }).catch(function (err) { pop.fail('Salvataggio non riuscito', err); resize(); });
  });

  textEl.addEventListener('input', function () { savedEl.hidden = true; });

  var loaded = false;
  t.render(function () {
    if (loaded) return; // do not overwrite what the user is typing
    return people.loadClients(t).then(function (clients) {
      loaded = true;
      textEl.value = clients.join('\n');
      resize();
    }).catch(function (err) { pop.fail('Impossibile leggere l\'elenco', err); resize(); });
  });
})();
