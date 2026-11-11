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
  var ICON = new URL('./img/icon.svg?v=1.5.1', window.location.href).href;

  // White variant for dark board headers.
  var ICON_LIGHT = new URL('./img/icon-white.svg?v=1.5.1', window.location.href).href;

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
          return t.popup({ title: 'Esporta Checklist+', url: './export.html', height: 190 });
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
          url: t.signUrl('./section.html?v=1.5.1'),
          height: 140
        }
      };
    },

    /**
     * Badge on the front of the card: "done/total · effort gg".
     * Hidden when the card has no Checklist+ items.
     */
    'card-badges': function (t) {
      return store.load(t).then(function (state) {
        var tot = calc.cardTotals(state);
        if (tot.total === 0) return [];
        return [{
          icon: ICON,
          text: tot.done + '/' + tot.total + ' · ' + calc.fmtNumber(tot.effort) + ' gg',
          color: tot.done === tot.total ? 'green' : null
        }];
      });
    }
  });
})();
