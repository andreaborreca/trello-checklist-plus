/**
 * Checklist+ - persistence layer.
 *
 * Data lives in the card's Power-Up pluginData (scope "card", visibility
 * "shared"), so it stays inside Trello with the same permissions as the card.
 * Trello caps that blob at 4096 characters, so the JSON is compressed with
 * lz-string (Base64 output: ASCII only, safe for any server-side encoding).
 *
 * Everything read from storage is treated as untrusted and sanitized against
 * a strict schema before use.
 */
(function (root) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var LZ = isNode ? require('lz-string') : root.LZString;

  var KEY = 'cp';
  var LIMIT = 4096;       // Trello hard limit for card/shared pluginData
  var SAFE_LIMIT = 4000;  // keep a margin for Trello's own serialization
  var HISTORY_BUDGET = 3000; // worked-days history is trimmed above this (75%)

  var ID_RE = /^[a-z0-9]{1,12}$/;
  var MEMBER_RE = /^[a-f0-9]{24}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  var MAX_LISTS = 30;
  var MAX_ITEMS = 120;

  /** Error raised when the data would exceed Trello's storage limit. */
  function SizeError(size) {
    this.name = 'SizeError';
    this.size = size;
    this.message = 'Spazio esaurito su questa card (' + size + '/' + LIMIT + ' caratteri).';
  }
  SizeError.prototype = Object.create(Error.prototype);

  function emptyState() {
    return { v: 1, l: [] };
  }

  /** Cryptographically random short id (base36). */
  function newId() {
    var bytes = new Uint8Array(6);
    var c = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto
      : require('crypto').webcrypto;
    c.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] % 36).toString(36);
    return out;
  }

  function str(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function isoOrEmpty(value) {
    return typeof value === 'string' && ISO_RE.test(value) ? value : '';
  }

  /** Effort: number, multiple of 0.5, clamped to [0, 999]. */
  function effort(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(999, Math.round(n * 2) / 2);
  }

  // Last worked-days change: minutes since 1970 (UTC), within 2024-2100.
  var MIN_MINUTES = 28401120;
  var MAX_MINUTES = 68380000;
  function minutesOrZero(value) {
    var n = Number(value);
    return isFinite(n) && n >= MIN_MINUTES && n <= MAX_MINUTES ? Math.floor(n) : 0;
  }

  /*
   * Worked-days history of an item: [[at, from, to, by], ...], oldest first.
   * at: minutes since 1970 (UTC); from/to: worked days; by: member id or ''.
   * Stored entries omit `by` when it is the assignee. Items saved by 1.19-1.20
   * have a single last change (wa, wb, wp), converted here.
   */
  var MAX_HISTORY = 30;

  function history(it) {
    var raw = Array.isArray(it.h) ? it.h : (it.wa ? [[it.wa, it.wp, it.w, 'wb' in it ? it.wb : it.m]] : []);
    var out = [];
    raw.slice(-MAX_HISTORY).forEach(function (e) {
      if (!Array.isArray(e) || e.length < 3) return;
      var at = minutesOrZero(e[0]);
      if (!at) return;
      var by = e.length === 3 ? it.m : e[3];
      out.push([at, effort(e[1]), effort(e[2]), MEMBER_RE.test(by) ? by : '']);
    });
    return out;
  }

  /** Copy of the state without history (what the space indicator measures). */
  function withoutHistory(state) {
    var copy = JSON.parse(JSON.stringify(state));
    copy.l.forEach(function (l) { l.x.forEach(function (it) { it.h = []; }); });
    return copy;
  }

  /**
   * History never takes room from the checklists: while the card is over
   * HISTORY_BUDGET, the oldest entries are dropped, always keeping the last
   * change of every item. Mutates and returns the state.
   */
  function prune(state, fmt) {
    var budget = HISTORY_BUDGET;
    if (sizeOf(state, fmt) <= budget) return state;
    var entries = [];
    state.l.forEach(function (l) {
      l.x.forEach(function (it) {
        for (var k = 0; k < it.h.length - 1; k++) entries.push({ item: it, at: it.h[k][0] });
      });
    });
    entries.sort(function (a, b) { return a.at - b.at; });
    // Drop in chunks (oldest first) to limit the number of size checks.
    var step = Math.max(1, Math.ceil(entries.length / 20));
    for (var i = 0; i < entries.length && sizeOf(state, fmt) > budget; i += step) {
      entries.slice(i, i + step).forEach(function (e) { e.item.h.shift(); });
    }
    return state;
  }

  /** Strict schema validation: unknown fields are dropped, bad values reset. */
  function sanitize(raw) {
    var state = emptyState();
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.l)) return state;

    raw.l.slice(0, MAX_LISTS).forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      var list = {
        i: ID_RE.test(l.i) ? l.i : newId(),
        n: str(l.n, 200),
        c: str(l.c, 60),
        x: []
      };
      (Array.isArray(l.x) ? l.x : []).slice(0, MAX_ITEMS).forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        list.x.push({
          i: ID_RE.test(it.i) ? it.i : newId(),
          t: str(it.t, 500),
          d: it.d === true || it.d === 1,
          m: MEMBER_RE.test(it.m) ? it.m : '',
          s: isoOrEmpty(it.s),
          dl: isoOrEmpty(it.dl),
          e: isoOrEmpty(it.e),
          w: effort(it.w),
          h: history(it)
        });
      });
      state.l.push(list);
    });
    return state;
  }

  /** Removes empty fields to save space before compression. */
  function compact(state) {
    return {
      v: 1,
      l: state.l.map(function (list) {
        var out = { i: list.i, n: list.n, x: [] };
        if (list.c) out.c = list.c;
        out.x = list.x.map(function (it) {
          var o = { i: it.i, t: it.t };
          if (it.d) o.d = 1;
          if (it.m) o.m = it.m;
          if (it.s) o.s = it.s;
          if (it.dl) o.dl = it.dl;
          if (it.e) o.e = it.e;
          if (it.w) o.w = it.w;
          if (it.h.length) {
            // [at, from, to] when the editor is the assignee (the usual case),
            // [at, from, to, 0] when unknown, [at, from, to, member] otherwise.
            o.h = it.h.map(function (e) {
              if (e[3] === it.m && it.m) return [e[0], e[1], e[2]];
              return [e[0], e[1], e[2], e[3] || 0];
            });
          }
          return o;
        });
        return out;
      })
    };
  }

  /*
   * Encodings. Trello counts characters (verified on Trello on 2026-11-25),
   * so the compressed data is stored as UTF-16 (about 15 bits per character,
   * prefix "~") instead of base64 (6 bits per character): about 2.5 times
   * more content per card. Base64 data from earlier versions is still read.
   * If Trello ever refuses a UTF-16 value, this browser falls back to base64.
   */
  var UTF16_PREFIX = '~';
  var FALLBACK_KEY = 'cp-enc-base64';
  var useUtf16 = true;
  var refused = false;
  try { if (!isNode && root.localStorage.getItem(FALLBACK_KEY)) refused = true; } catch (e) { /* storage unavailable */ }

  function setFormat(format) { useUtf16 = format === 'utf16'; }
  function format() { return useUtf16 && !refused ? 'utf16' : 'base64'; }


  function encode(state, fmt) {
    var json = JSON.stringify(compact(state));
    var utf16 = (fmt || format()) === 'utf16';
    return utf16 ? UTF16_PREFIX + LZ.compressToUTF16(json) : LZ.compressToBase64(json);
  }

  /** Decoded state, or null when a non-empty value cannot be read. */
  function decodeStrict(encoded) {
    if (encoded === undefined || encoded === null || encoded === '') return emptyState();
    if (typeof encoded !== 'string') return null;
    try {
      var json = encoded.charAt(0) === UTF16_PREFIX
        ? LZ.decompressFromUTF16(encoded.slice(1))
        : LZ.decompressFromBase64(encoded);
      var parsed = json ? JSON.parse(json) : null;
      return parsed && Array.isArray(parsed.l) ? sanitize(parsed) : null;
    } catch (e) {
      return null;
    }
  }

  /** Lenient decode for read-only views (badges, export): unreadable -> empty. */
  function decode(encoded) {
    return decodeStrict(encoded) || emptyState();
  }

  /** Size as Trello will count it (stringified shared blob). */
  function sizeOf(state, fmt) {
    var o = {};
    o[KEY] = encode(state, fmt);
    return JSON.stringify(o).length;
  }

  function UnreadableError() {
    this.name = 'UnreadableError';
    this.message = 'I dati di Checklist+ su questa card non sono leggibili da questa versione: ricarica la pagina di Trello (Ctrl+Shift+R).';
  }
  UnreadableError.prototype = Object.create(Error.prototype);

  /** Reads the current card state via the Power-Up client library. */
  function load(t) {
    return t.get('card', 'shared', KEY).then(decode);
  }

  /**
   * Read-modify-write: always re-reads the freshest data right before saving,
   * applies the mutation and writes back. This narrows (but cannot remove)
   * the window for concurrent edits by two users on the same card.
   */
  function update(t, mutate) {
    return t.get('card', 'shared', KEY).then(function (raw) {
      // Never overwrite data this version cannot read (e.g. a newer format).
      var state = decodeStrict(raw);
      if (!state) throw new UnreadableError();
      mutate(state);
      var clean = prune(sanitize(state));
      var size = sizeOf(clean);
      if (size > SAFE_LIMIT) throw new SizeError(size);
      return t.set('card', 'shared', KEY, encode(clean)).then(function () {
        return clean;
      }, function (err) {
        // Fallback: Trello refused the UTF-16 value, write base64 from now on.
        if (format() !== 'utf16') throw err;
        refused = true;
        try { if (!isNode) root.localStorage.setItem(FALLBACK_KEY, '1'); } catch (e) { /* storage unavailable */ }
        if (root.console) root.console.warn('[Checklist+] UTF-16 value refused, using base64', err);
        if (sizeOf(clean) > SAFE_LIMIT) throw new SizeError(sizeOf(clean));
        return t.set('card', 'shared', KEY, encode(clean)).then(function () { return clean; });
      });
    });
  }

  var api = {
    KEY: KEY,
    LIMIT: LIMIT,
    SAFE_LIMIT: SAFE_LIMIT,
    SizeError: SizeError,
    emptyState: emptyState,
    newId: newId,
    sanitize: sanitize,
    encode: encode,
    decode: decode,
    decodeStrict: decodeStrict,
    setFormat: setFormat,
    format: format,
    prune: prune,
    withoutHistory: withoutHistory,
    HISTORY_BUDGET: HISTORY_BUDGET,
    isUtf16Value: function (v) { return typeof v === 'string' && v.charAt(0) === UTF16_PREFIX; },
    UnreadableError: UnreadableError,
    sizeOf: sizeOf,
    load: load,
    update: update
  };

  if (isNode) {
    module.exports = api;
  } else {
    root.CP = root.CP || {};
    root.CP.store = api;
  }
})(typeof window !== 'undefined' ? window : this);
