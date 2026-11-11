/**
 * Checklist+ - team helpers shared by the section and the popovers:
 * member avatars/initials and the member -> work area mapping.
 *
 * Areas are stored in the board's shared pluginData (key "cpa") as
 * { memberId: areaKey }, so no personal data lives in the code.
 */
(function (root) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;

  var AREAS_KEY = 'cpa';
  var AREAS = [
    { k: 'BE', n: 'Backend' },
    { k: 'FE', n: 'Frontend' },
    { k: 'DA', n: 'Data' },
    { k: 'CTO', n: 'CTO' },
    { k: 'PM', n: 'PM' }
  ];
  var NO_AREA = 'Senza area';
  var MEMBER_RE = /^[a-f0-9]{24}$/;

  function areaName(key) {
    for (var i = 0; i < AREAS.length; i++) if (AREAS[i].k === key) return AREAS[i].n;
    return '';
  }

  /** Keeps only valid member ids and known area keys (stored data is untrusted). */
  function sanitizeAreas(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).slice(0, 500).forEach(function (id) {
      if (MEMBER_RE.test(id) && areaName(raw[id])) out[id] = raw[id];
    });
    return out;
  }

  function loadAreas(t) {
    return t.get('board', 'shared', AREAS_KEY).then(sanitizeAreas).catch(function () { return {}; });
  }

  /** Sets (or clears, with an empty key) the area of one member. Re-reads before writing. */
  function setArea(t, memberId, areaKey) {
    return t.get('board', 'shared', AREAS_KEY).then(function (raw) {
      var map = sanitizeAreas(raw);
      if (areaName(areaKey)) map[memberId] = areaKey; else delete map[memberId];
      return t.set('board', 'shared', AREAS_KEY, sanitizeAreas(map)).then(function () { return map; });
    });
  }

  /* ---- Board client list (key "cpk"): array of upper-case names ---- */

  var CLIENTS_KEY = 'cpk';

  /** Cleans a client list: trimmed, upper case, unique, at most 100 names of 40 chars. */
  function sanitizeClients(raw) {
    var seen = {};
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (c) {
      if (typeof c !== 'string') return;
      // "+" is reserved as the separator between several clients of one checklist.
      var name = c.replace(/[+]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 40);
      if (name && name !== '-' && !seen[name] && out.length < 100) { seen[name] = true; out.push(name); }
    });
    return out;
  }

  function loadClients(t) {
    return t.get('board', 'shared', CLIENTS_KEY).then(sanitizeClients).catch(function () { return []; });
  }

  function saveClients(t, list) {
    var clean = sanitizeClients(list);
    return t.set('board', 'shared', CLIENTS_KEY, clean).then(function () { return clean; });
  }

  function displayName(member) {
    return member.fullName || member.username || member.id;
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // Hosts Trello uses for member profile photos. Anything else is ignored.
  var AVATAR_HOSTS = ['trello-members.s3.amazonaws.com', '.trello.com', '.trellocdn.com', '.atl-paas.net'];

  /** Safe https URL of the member's profile photo, or '' when there is none. */
  function avatarUrl(member) {
    var raw = member && (member.avatar || member.avatarUrl);
    if (typeof raw !== 'string' || !raw) return '';
    try {
      var u = new URL(raw);
      var host = u.hostname;
      var allowed = u.protocol === 'https:' && AVATAR_HOSTS.some(function (h) {
        return h.charAt(0) === '.' ? host.slice(-h.length) === h : host === h;
      });
      if (!allowed) return '';
      // Base avatar URLs need a size suffix; full image URLs are used as they are.
      return /\.(png|jpe?g|gif|webp)$/i.test(u.pathname) ? u.href : u.href.replace(/\/$/, '') + '/50.png';
    } catch (e) { return ''; }
  }

  function avatarColor(id) {
    var palette = ['#ae2e24', '#a54800', '#7f5f01', '#216e4e', '#206a83', '#0055cc', '#5e4db2', '#943d73'];
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  /** Builds the round avatar element (photo, or initials on a colored disc). */
  function avatarNode(member, className) {
    var node = document.createElement('span');
    node.className = className || 'cp-avatar';
    var photo = avatarUrl(member);
    if (photo) {
      var img = document.createElement('img');
      img.className = 'cp-avatar-img';
      img.src = photo;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      node.appendChild(img);
    } else {
      node.textContent = member.initials ? String(member.initials).slice(0, 3).toUpperCase() : initials(displayName(member));
      node.style.backgroundColor = avatarColor(member.id);
    }
    return node;
  }

  var api = {
    AREAS: AREAS, NO_AREA: NO_AREA, areaName: areaName, sanitizeAreas: sanitizeAreas,
    loadAreas: loadAreas, setArea: setArea,
    sanitizeClients: sanitizeClients, loadClients: loadClients, saveClients: saveClients, displayName: displayName,
    initials: initials, avatarUrl: avatarUrl, avatarColor: avatarColor, avatarNode: avatarNode
  };
  if (isNode) module.exports = api;
  else { root.CP = root.CP || {}; root.CP.people = api; }
})(typeof window !== 'undefined' ? window : this);
