/**
 * Checklist+ - public configuration.
 *
 * appKey: API key of the Power-Up (trello.com/power-ups/admin -> Checklist+ ->
 * API key). It is public by design: it identifies the app, it does not grant
 * access. Access needs a member token, requested only when importing native
 * checklists (read-only, 1 hour, deleted after the import).
 * The key's "Allowed origins" must include https://andreaborreca.github.io
 */
(function (root) {
  'use strict';
  root.CP = root.CP || {};
  root.CP.config = {
    appKey: '64ba0b3e708cdfb69724b71af4b18eb1',
    appName: 'Checklist+'
  };
})(window);
