/**
 * Checklist+ - read native checklists through Trello's REST API.
 *
 * Used only when the Power-Up client library sends the card's checklists
 * without their items. Flow, started by a click in the import panel:
 * 1. t.getRestApi().authorize(): Trello's consent popup, read-only scope,
 *    token valid for 1 hour;
 * 2. GET the card's checklists with their items, and the card's
 *    "check item completed" actions (to know when each item was checked);
 * 3. the stored token is cleared right away (clearToken).
 * The token travels in the Authorization header, never in the URL.
 */
(function () {
  'use strict';

  var API = 'https://api.trello.com/1';

  function isConfigured() {
    return !!(window.CP.config && window.CP.config.appKey);
  }

  function get(path, key, token) {
    return fetch(API + path, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Authorization: 'OAuth oauth_consumer_key="' + key + '", oauth_token="' + token + '"' }
    }).then(function (res) {
      if (!res.ok) throw new Error('Trello API ' + res.status);
      return res.json();
    });
  }

  /**
   * Latest completion date of every item, from the card's actions:
   * { checkItemId: ISO datetime }. Only the last state change counts, so an
   * item checked, unchecked and checked again gets its final date.
   */
  function completionDates(actions) {
    var out = {};
    (actions || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (a) {
      var ci = a && a.data && a.data.checkItem;
      if (!ci || !ci.id) return;
      if (ci.state === 'complete') out[ci.id] = a.date;
      else delete out[ci.id];
    });
    return out;
  }

  /**
   * @param {object} t      Trello iframe client created with appKey/appName
   * @param {string} cardId
   * @returns {Promise<Array>} checklists shaped like t.card('checklists'),
   *          items with an extra `completedAt` (ISO datetime or undefined)
   */
  function readNativeChecklists(t, cardId) {
    if (!isConfigured()) return Promise.reject(new Error('API key del Power-Up non configurata (js/config.js).'));
    var key = window.CP.config.appKey;
    var api;
    return t.getRestApi().then(function (client) {
      api = client;
      return client.authorize({ scope: 'read', expiration: '1hour' });
    }).then(function (token) {
      if (!token) throw new Error('Autorizzazione non concessa.');
      var id = encodeURIComponent(cardId);
      return Promise.all([
        get('/cards/' + id + '/checklists?fields=name,pos&checkItems=all&checkItem_fields=name,state,pos,due,idMember', key, token),
        get('/cards/' + id + '/actions?filter=updateCheckItemStateOnCard&limit=1000&fields=date,data', key, token)
          .catch(function () { return []; }) // completion dates are optional
      ]);
    }).then(function (res) {
      var done = completionDates(res[1]);
      return (res[0] || []).map(function (cl) {
        return {
          id: cl.id, name: cl.name, pos: cl.pos,
          checkItems: (cl.checkItems || []).map(function (ci) {
            return { id: ci.id, name: ci.name, state: ci.state, pos: ci.pos, due: ci.due, idMember: ci.idMember, completedAt: done[ci.id] };
          })
        };
      });
    }).then(function (lists) {
      return clear(api).then(function () { return lists; });
    }, function (err) {
      return clear(api).then(function () { throw err; });
    });
  }

  /** Removes the stored token; never fails the import. */
  function clear(api) {
    if (!api || typeof api.clearToken !== 'function') return Promise.resolve();
    return Promise.resolve(api.clearToken()).catch(function () {});
  }

  window.CP.trelloapi = { isConfigured: isConfigured, readNativeChecklists: readNativeChecklists, completionDates: completionDates };
})();
