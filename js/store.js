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
          w: effort(it.w)
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
          return o;
        });
        return out;
      })
    };
  }

  function encode(state) {
    return LZ.compressToBase64(JSON.stringify(compact(state)));
  }

  function decode(encoded) {
    if (typeof encoded !== 'string' || !encoded) return emptyState();
    try {
      var json = LZ.decompressFromBase64(encoded);
      return sanitize(json ? JSON.parse(json) : null);
    } catch (e) {
      return emptyState();
    }
  }

  /** Size as Trello will count it (stringified shared blob). */
  function sizeOf(state) {
    var o = {};
    o[KEY] = encode(state);
    return JSON.stringify(o).length;
  }

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
    return load(t).then(function (state) {
      mutate(state);
      var clean = sanitize(state);
      var size = sizeOf(clean);
      if (size > SAFE_LIMIT) throw new SizeError(size);
      return t.set('card', 'shared', KEY, encode(clean)).then(function () {
        return clean;
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
