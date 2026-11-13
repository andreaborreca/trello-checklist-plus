/**
 * Checklist+ - edit operations and save queue.
 *
 * Every change is described by a small serializable operation ("op") instead
 * of a closure, so that:
 * - several quick changes are merged into ONE write (Trello reloads the card
 *   section iframe after every t.set(), which used to kill queued saves);
 * - pending ops are kept in a journal (sessionStorage) and replayed when the
 *   section reloads, so a change is never lost;
 * - ops are idempotent: replaying one that was already saved changes nothing.
 *
 * Pure logic, shared by the browser (window.CP.ops) and the Node tests.
 */
(function (root) {
  'use strict';

  var ITEM_FIELDS = ['t', 'd', 'm', 's', 'dl', 'e', 'w'];
  var LIST_FIELDS = ['n', 'c'];
  var JOURNAL_MAX_AGE_MS = 10 * 60 * 1000;
  var MAX_ATTEMPTS = 3;

  function clone(state) { return JSON.parse(JSON.stringify(state)); }

  /** Finds an item by id in any checklist: { list, index, item } or null. */
  function locate(state, itemId) {
    var lists = state.l || [];
    for (var a = 0; a < lists.length; a++) {
      var x = lists[a].x || [];
      for (var b = 0; b < x.length; b++) if (x[b].i === itemId) return { list: lists[a], index: b, item: x[b] };
    }
    return null;
  }

  function findList(state, listId) {
    return (state.l || []).filter(function (l) { return l.i === listId; })[0] || null;
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n | 0)); }

  /**
   * Applies one op to a state (mutates it). Unknown ops and missing targets
   * are ignored, so a stale op never breaks the data.
   */
  function apply(state, op) {
    if (!op || typeof op !== 'object') return state;
    var hit, list;
    switch (op.k) {
      case 'set': // item fields
        hit = locate(state, op.i);
        if (hit) ITEM_FIELDS.forEach(function (f) { if (op.f && op.f.hasOwnProperty(f)) hit.item[f] = op.f[f]; });
        break;
      case 'check': // completion; an empty end date defaults to the day of the check
        hit = locate(state, op.i);
        if (hit) {
          hit.item.d = !!op.d;
          if (op.d && !hit.item.e && op.today) hit.item.e = op.today;
        }
        break;
      case 'effort': // absolute worked days; the first day logged sets an empty start date
        hit = locate(state, op.i);
        if (hit) {
          if (op.w > (hit.item.w || 0) && !hit.item.s && op.today) hit.item.s = op.today;
          hit.item.w = Math.max(0, op.w);
        }
        break;
      case 'list':
        list = findList(state, op.l);
        if (list) LIST_FIELDS.forEach(function (f) { if (op.f && op.f.hasOwnProperty(f)) list[f] = op.f[f]; });
        break;
      case 'addItem':
        list = findList(state, op.l);
        if (list && op.item && !locate(state, op.item.i)) list.x.push(clone(op.item));
        break;
      case 'addList':
        if (op.list && !findList(state, op.list.i)) state.l.push(clone(op.list));
        break;
      case 'import': // several checklists at once (native checklists conversion)
        (op.lists || []).forEach(function (l) { if (!findList(state, l.i)) state.l.push(clone(l)); });
        break;
      case 'delItem':
        hit = locate(state, op.i);
        if (hit) hit.list.x.splice(hit.index, 1);
        break;
      case 'delList':
        state.l = state.l.filter(function (l) { return l.i !== op.l; });
        break;
      case 'moveItem': // to checklist op.to, at position op.index (also across checklists)
        list = findList(state, op.to);
        hit = locate(state, op.i);
        if (list && hit) {
          hit.list.x.splice(hit.index, 1);
          list.x.splice(clamp(op.index, 0, list.x.length), 0, hit.item);
        }
        break;
      case 'moveList':
        list = findList(state, op.l);
        if (list) {
          state.l.splice(state.l.indexOf(list), 1);
          state.l.splice(clamp(op.index, 0, state.l.length), 0, list);
        }
        break;
    }
    return state;
  }

  function applyAll(state, ops) {
    ops.forEach(function (op) { apply(state, op); });
    return state;
  }

  /** Coalescing key: a newer op with the same key replaces the older pending one. */
  function coalesceKey(op) {
    if (op.k === 'effort' || op.k === 'check') return op.k + ':' + op.i;
    if (op.k === 'set' && op.f) return 'set:' + op.i + ':' + Object.keys(op.f).sort().join(',');
    if (op.k === 'list' && op.f) return 'list:' + op.l + ':' + Object.keys(op.f).sort().join(',');
    return '';
  }

  /**
   * Save queue for one card.
   *
   * @param {object} o
   *   load()          -> Promise<state>   freshest stored state
   *   write(mutate)   -> Promise<state>   read-modify-write (CP.store.update), resolves with the saved state
   *   journal         { read() -> array, write(array) }  survives iframe reloads
   *   onChange(state, base)   called when the optimistic state changes
   *   onError(err, dropped)   called when a batch could not be saved
   *   delay           ms to wait for more changes before writing (default 350)
   *   schedule(fn, ms), cancel(id)   timers (injectable for tests)
   */
  function createQueue(o) {
    var delay = o.delay === undefined ? 350 : o.delay;
    var schedule = o.schedule || function (fn, ms) { return setTimeout(fn, ms); };
    var cancel = o.cancel || function (id) { clearTimeout(id); };
    var base = null;        // last state known to be stored
    var pending = [];       // [{seq, op, at, n}] not yet written
    var inflight = [];      // batch being written
    var seq = 0;
    var timer = null;

    function entries() { return inflight.concat(pending); }

    function persist() {
      try { o.journal.write(entries()); } catch (e) { /* storage unavailable: ops still saved in memory */ }
    }

    function optimistic() {
      return applyAll(clone(base), entries().map(function (e) { return e.op; }));
    }

    function notify() { if (o.onChange) o.onChange(optimistic(), base); }

    function arm(ms) {
      if (timer) cancel(timer);
      timer = schedule(function () { timer = null; flush(); }, ms === undefined ? delay : ms);
    }

    /**
     * Starts the queue: loads the stored state and replays the journal left
     * by a previous (reloaded) instance of the section. Entries already
     * reflected in the stored state are dropped without writing.
     */
    function start() {
      return o.load().then(function (state) {
        base = state;
        var now = Date.now();
        var saved = [];
        try { saved = o.journal.read() || []; } catch (e) { saved = []; }
        saved = saved.filter(function (e) {
          return e && e.op && (now - (e.at || 0)) < JOURNAL_MAX_AGE_MS && (e.n || 0) < MAX_ATTEMPTS;
        });
        if (saved.length) {
          var replayed = applyAll(clone(base), saved.map(function (e) { return e.op; }));
          if (JSON.stringify(replayed) !== JSON.stringify(base)) {
            pending = saved.map(function (e) { return { seq: ++seq, op: e.op, at: e.at, n: (e.n || 0) + 1 }; });
          }
        }
        persist();
        if (pending.length) arm(0);
        return optimistic();
      });
    }

    /** Adds an op; returns the new optimistic state. */
    function push(op) {
      var key = coalesceKey(op);
      if (key) pending = pending.filter(function (e) { return coalesceKey(e.op) !== key; });
      pending.push({ seq: ++seq, op: op, at: Date.now(), n: 0 });
      persist();
      arm();
      var s = optimistic();
      if (o.onChange) o.onChange(s, base);
      return s;
    }

    /** Writes every pending op in one read-modify-write. */
    function flush() {
      if (timer) { cancel(timer); timer = null; }
      if (inflight.length || !pending.length) return Promise.resolve(base);
      inflight = pending;
      pending = [];
      persist();
      var batch = inflight.map(function (e) { return e.op; });
      return o.write(function (s) { applyAll(s, batch); }).then(function (fresh) {
        base = fresh;
        inflight = [];
        persist();
        notify();
        if (pending.length) arm(0);
        return fresh;
      }, function (err) {
        var dropped = inflight;
        inflight = [];
        // Size errors never succeed on retry: drop the batch. Other errors are
        // retried with the next write, up to MAX_ATTEMPTS per op.
        if (!(err && err.name === 'SizeError')) {
          var retry = dropped.filter(function (e) { return ++e.n < MAX_ATTEMPTS; });
          dropped = dropped.filter(function (e) { return retry.indexOf(e) < 0; });
          pending = retry.concat(pending);
          if (pending.length) arm(2000);
        }
        persist();
        // Re-read the stored state so the UI shows what is really saved.
        return o.load().then(function (state) { base = state; }, function () {}).then(function () {
          notify();
          if (o.onError) o.onError(err, dropped.map(function (e) { return e.op; }));
          return base;
        });
      });
    }

    /** Re-reads the stored state (e.g. Trello asked to re-render) while keeping unsaved ops on top. */
    function refresh() {
      if (inflight.length) return Promise.resolve(optimistic());
      return o.load().then(function (state) { base = state; notify(); return optimistic(); });
    }

    return {
      start: start,
      refresh: refresh,
      push: push,
      flush: flush,
      state: optimistic,
      base: function () { return base; },
      pendingCount: function () { return entries().length; }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Native checklists -> Checklist+ lists                              */
  /* ------------------------------------------------------------------ */

  var MEMBER_RE = /^[a-f0-9]{24}$/;

  function pad(n) { return String(n).padStart(2, '0'); }

  /** Trello due datetime (UTC) -> local calendar date "YYYY-MM-DD", or ''. */
  function localDate(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function byPos(a, b) { return (Number(a.pos) || 0) - (Number(b.pos) || 0); }

  /**
   * Converts native checklists (t.card('checklists')) into Checklist+ lists.
   * @param {Array} natives       checklists as returned by Trello
   * @param {object} opts         { newId(), endFor: 'empty'|'today'|'deadline', today }
   * Completed items get an end date only when asked: Trello does not expose
   * when an item was checked, so the default leaves it empty (to fill in).
   */
  function convertNative(natives, opts) {
    return (natives || []).slice().sort(byPos).map(function (cl) {
      var items = (cl.checkItems || []).slice().sort(byPos).map(function (ci) {
        var done = ci.state === 'complete';
        var dl = localDate(ci.due);
        var end = '';
        if (done && opts.endFor === 'today') end = opts.today;
        if (done && opts.endFor === 'deadline') end = dl;
        return {
          i: opts.newId(), t: String(ci.name || '').slice(0, 500), d: done,
          m: MEMBER_RE.test(ci.idMember) ? ci.idMember : '',
          s: '', dl: dl, e: end, w: 0
        };
      });
      return { i: opts.newId(), n: String(cl.name || 'Checklist').slice(0, 200), c: '', x: items };
    });
  }

  var api = {
    apply: apply, applyAll: applyAll, locate: locate, coalesceKey: coalesceKey,
    createQueue: createQueue, convertNative: convertNative, localDate: localDate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.ops = api; }
})(typeof window !== 'undefined' ? window : this);
