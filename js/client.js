/**
 * Checklist+ - Power-Up connector.
 * Loaded by Trello in a hidden iframe (index.html). Declares the capabilities
 * the Power-Up provides; each capability must also be enabled in the
 * Power-Up admin portal (trello.com/power-ups/admin).
 */
/* global TrelloPowerUp */
(function () {
  'use strict';

  var store = window.CP.store;
  var calc = window.CP.calc;

  // Absolute URL of the gray icon (Trello requires gray icons on the card back).
  var ICON = new URL('./img/icon.svg?v=1.16.1', window.location.href).href;

  // White variant for dark board headers.
  var ICON_LIGHT = new URL('./img/icon-white.svg?v=1.16.1', window.location.href).href;

  // Check-square icon for the overall badge (same idea as Trello's checklist badge).
  var ICON_CHECK = new URL('./img/icon-check.svg?v=1.16.1', window.location.href).href;

  // Person icon for the badge with the viewer's own open tasks.
  var ICON_PERSON = new URL('./img/icon-person.svg?v=1.16.1', window.location.href).href;

  /**
   * Height the section had the last time this card was open (saved by the
   * section itself). Starting from it avoids a jump while the card loads.
   */
  function rememberedHeight(t) {
    try {
      var cardId = (t.getContext() || {}).card;
      var h = parseInt(window.localStorage.getItem('cp-h-' + cardId), 10);
      if (h >= 60 && h <= 1500) return h;
    } catch (e) { /* storage unavailable */ }
    return 140;
  }

  TrelloPowerUp.initialize({
    /**
     * "Checklist+" button in the board header: a menu with the export and the
     * board-level settings (client list, team areas).
     */
    'board-buttons': function () {
      return [{
        icon: { dark: ICON_LIGHT, light: ICON },
        text: 'Checklist+',
        callback: function (t) {
          var theme = '';
          try {
            var ctxTheme = (t.getContext() || {}).theme;
            if (ctxTheme === 'dark' || ctxTheme === 'light') theme = ctxTheme;
          } catch (e) { /* unknown: the popover falls back to its other sources */ }
          function page(title, url, height) {
            return function (tt) { return tt.popup({ title: title, url: url, args: { th: theme }, height: height }); };
          }
          return t.popup({
            title: 'Checklist+',
            items: [
              { text: 'I miei task...', callback: page('I miei task', './mytasks.html?v=1.16.1', 480) },
              { text: 'Esporta...',callback: page('Esporta Checklist+', './export.html?v=1.16.1', 330) },
              { text: 'Clienti della bacheca...', callback: page('Clienti', './clientlist.html?v=1.16.1', 340) },
              { text: 'Aree del team...', callback: page('Aree del team', './areas.html?v=1.16.1', 380) }
            ]
          });
        }
      }];
    },

    /**
     * Section on the back of the card hosting the whole Checklist+ UI.
     * Max height enforced by Trello: 1500px.
     */
    'card-back-section': function (t) {
      return {
        title: 'Checklist+',
        icon: ICON,
        content: {
          type: 'iframe',
          // Version in the URL so browsers never serve a stale cached page after an update.
          url: t.signUrl('./section.html?v=1.16.1'),
          height: rememberedHeight(t)
        }
      };
    },

    /**
     * Badges on the front of the card: the overall count first, then the
     * viewer's own open tasks, then one per Checklist+ list
     * ("NAME done/total · days gg"), so the breakdown is visible without
     * opening the card. Green = all done, red = something overdue.
     * Pending lists come first; with many lists, the first six are shown
     * plus a summary badge.
     */
    'card-badges': function (t) {
      return store.load(t).then(function (state) {
        var MAX_LIST_BADGES = 6;
        var today = window.CP.workdays.todayIso();
        var lists = state.l.filter(function (l) { return l.x.length > 0; });
        if (!lists.length) return [];

        // Pending lists first (overdue ones on top), completed lists last;
        // the original order is kept within each group.
        function rank(list) {
          var tot = calc.checklistTotals(list, new Set());
          if (tot.done === tot.total) return 2;
          return list.x.some(function (it) { return calc.dueStatus(it, today, new Set()) === 'late'; }) ? 0 : 1;
        }
        var ordered = lists.map(function (l, i) { return { l: l, i: i, r: rank(l) }; })
          .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
          .map(function (o) { return o.l; });

        var badges = ordered.slice(0, MAX_LIST_BADGES).map(function (list) {
          var tot = calc.checklistTotals(list, new Set());
          var late = list.x.some(function (it) { return calc.dueStatus(it, today, new Set()) === 'late'; });
          var name = list.n.length > 22 ? list.n.slice(0, 21) + '…' : list.n;
          return {
            icon: ICON,
            text: name + ' ' + tot.done + '/' + tot.total + ' · ' + calc.fmtNumber(tot.effort) + ' gg',
            color: tot.done === tot.total ? 'green' : (late ? 'red' : null)
          };
        });

        // First badge: overall count, like Trello's native checklist badge
        // (check icon, "done/total", green when everything is done).
        var all = calc.cardTotals(state);
        var total = {
          icon: ICON_CHECK,
          text: all.done + '/' + all.total + ' · ' + calc.fmtNumber(all.effort) + ' gg' +
            (lists.length > MAX_LIST_BADGES ? ' (+' + (lists.length - MAX_LIST_BADGES) + ' checklist)' : ''),
          color: all.done === all.total ? 'green' : null
        };
        // Second badge, only for the viewer: their own open tasks on this card
        // (red when one is overdue). Power-Ups cannot add filters to Trello's
        // filter menu, so this marks "my" cards on the board at a glance.
        var me = '';
        try { me = (t.getContext() || {}).member || ''; } catch (e) { me = ''; }
        var mine = [];
        state.l.forEach(function (l) { l.x.forEach(function (it) { if (me && it.m === me && !it.d) mine.push(it); }); });
        var personal = mine.length ? [{
          icon: ICON_PERSON,
          text: 'Tuoi: ' + mine.length,
          color: mine.some(function (it) { return calc.dueStatus(it, today, new Set()) === 'late'; }) ? 'red' : 'blue'
        }] : [];

        return [total].concat(personal, badges);
      });
    }
  });
})();
