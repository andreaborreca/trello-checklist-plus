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
  var ICON = new URL('./img/icon.svg?v=1.7.3', window.location.href).href;

  // White variant for dark board headers.
  var ICON_LIGHT = new URL('./img/icon-white.svg?v=1.7.3', window.location.href).href;

  TrelloPowerUp.initialize({
    /**
     * Button in the board header (next to the other Power-Up buttons):
     * exports every Checklist+ of the board to CSV.
     */
    'board-buttons': function () {
      return [{
        icon: { dark: ICON_LIGHT, light: ICON },
        text: 'Export Checklist+',
        callback: function (t) {
          return t.popup({ title: 'Esporta Checklist+', url: './export.html', height: 250 });
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
          url: t.signUrl('./section.html?v=1.7.3'),
          height: 140
        }
      };
    },

    /**
     * Badges on the front of the card: one per Checklist+ list
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

        // Overall summary when there is more than one list.
        if (lists.length > 1) {
          var all = calc.cardTotals(state);
          badges.push({
            text: 'Totale ' + all.done + '/' + all.total + ' · ' + calc.fmtNumber(all.effort) + ' gg' +
              (lists.length > MAX_LIST_BADGES ? ' (+' + (lists.length - MAX_LIST_BADGES) + ' checklist)' : ''),
            color: all.done === all.total ? 'green' : null
          });
        }
        return badges;
      });
    }
  });
})();
