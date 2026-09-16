/* The learning tracker client. One file, no dependencies, loaded by every app:
     <script src="/learning/track/v1/tracker.js"></script>

   const tracker = Tracker.init({ app: 'english-words', appVersion: '19' });
   const s = tracker.session({ exercise, unit, params });
   s.presented(seq, itemId, prompt);
   s.answered(seq, itemId, { response, result, judgedBy, score, maxScore, feedback });
   s.completed({ score, maxScore, correctFirstTry, correctEventually, itemCount });
   s.abandoned();

   Events queue in memory and in localStorage, and are posted in batches:
   two seconds after the last one, at once when twenty are waiting or a
   session ends, and with sendBeacon when the page is hidden or left. A batch
   that fails stays queued; the server ignores an event it has already seen,
   so resending is always safe. Nothing here can break the app: every entry
   point swallows its own errors. */
(function () {
  'use strict';

  var OUTBOX_KEY = 'tracker-outbox';
  var MAX_OUTBOX = 2000;
  var BATCH = 200;
  var FLUSH_AFTER_MS = 2000;
  var FLUSH_AT = 20;
  var BEACON_LIMIT = 60000;      // sendBeacon payloads must stay well under 64 KB
  var MAX_BACKOFF_MS = 60000;

  var instances = [];

  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {}
    var t = Date.now().toString(16);
    return t + '-' + Math.random().toString(16).slice(2, 10) + '-' + Math.random().toString(16).slice(2, 10);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function device() {
    var out = {};
    try { out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    try { out.lang = navigator.language; } catch (e) {}
    try { out.ua = String(navigator.userAgent).slice(0, 200); } catch (e) {}
    try { out.screen = window.screen.width + 'x' + window.screen.height; } catch (e) {}
    return out;
  }

  function loadOutbox() {
    try {
      var raw = localStorage.getItem(OUTBOX_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveOutbox(outbox) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); } catch (e) {}
  }

  function init(opts) {
    opts = opts || {};
    var app = String(opts.app || 'app');
    var appVersion = opts.appVersion == null ? null : String(opts.appVersion);
    var endpoint = String(opts.endpoint || '/learning/track/v1') + '/events';
    var dev = device();

    var outbox = loadOutbox();
    var timer = null;
    var inflight = false;
    var backoff = 0;
    var blockedUntil = 0;
    var openSessions = [];

    function emit(type, fields) {
      var ev = { id: uuid(), type: type, at: new Date().toISOString() };
      for (var k in fields) if (fields[k] !== undefined) ev[k] = fields[k];
      outbox.push({ app: app, appVersion: appVersion, ev: ev });
      if (outbox.length > MAX_OUTBOX) outbox.splice(0, outbox.length - MAX_OUTBOX);
      saveOutbox(outbox);
      scheduleFlush(outbox.length >= FLUSH_AT ? 0 : FLUSH_AFTER_MS);
    }

    function scheduleFlush(ms) {
      if (timer) clearTimeout(timer);
      var wait = Math.max(ms, blockedUntil - Date.now());
      timer = setTimeout(flush, wait);
    }

    function nextBatch() {
      if (!outbox.length) return null;
      var first = outbox[0];
      var events = [];
      for (var i = 0; i < outbox.length && events.length < BATCH; i++) {
        if (outbox[i].app === first.app && outbox[i].appVersion === first.appVersion) events.push(outbox[i].ev);
      }
      return { schema: 1, app: first.app, appVersion: first.appVersion, device: dev, events: events };
    }

    function drop(batch) {
      var ids = {};
      batch.events.forEach(function (e) { ids[e.id] = true; });
      outbox = outbox.filter(function (o) { return !ids[o.ev.id]; });
      saveOutbox(outbox);
    }

    function flush() {
      timer = null;
      if (inflight) return Promise.resolve();
      var batch = nextBatch();
      if (!batch) return Promise.resolve();
      inflight = true;
      var body = JSON.stringify(batch);
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        credentials: 'same-origin',
        keepalive: body.length < BEACON_LIMIT,
      }).then(function (r) {
        inflight = false;
        if (r.ok) {
          drop(batch);
          backoff = 0;
          if (outbox.length) scheduleFlush(0);
          return;
        }
        if (r.status === 401) {
          // not signed in yet: keep everything for after the sign-in
          blockedUntil = Date.now() + MAX_BACKOFF_MS;
          return;
        }
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          // the server will never take this batch: it is not worth keeping
          drop(batch);
          try { console.warn('tracker: batch rejected', r.status); } catch (e) {}
          if (outbox.length) scheduleFlush(0);
          return;
        }
        retryLater();
      }).catch(function () {
        inflight = false;
        retryLater();
      });
    }

    function retryLater() {
      backoff = Math.min(backoff ? backoff * 2 : 2000, MAX_BACKOFF_MS);
      scheduleFlush(backoff);
    }

    function beacon() {
      try {
        var batch = nextBatch();
        if (!batch || !navigator.sendBeacon) return;
        var body = JSON.stringify(batch);
        if (body.length > BEACON_LIMIT) return;
        // kept in the outbox: if the beacon lands, the resend is a no-op
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      } catch (e) {}
    }

    function session(spec) {
      spec = spec || {};
      var id = uuid();
      var shownAt = {};
      var lastAt = {};
      var tries = {};
      var open = true;
      emit('session.started', {
        session: id,
        localDate: localDate(),
        exercise: spec.exercise,
        unit: spec.unit,
        params: spec.params || {},
      });
      var handle = {
        id: id,
        presented: function (seq, item, prompt) {
          try {
            shownAt[seq] = Date.now();
            lastAt[seq] = shownAt[seq];
            emit('item.presented', { session: id, seq: seq, item: String(item), prompt: prompt });
          } catch (e) {}
        },
        answered: function (seq, item, r) {
          try {
            r = r || {};
            var t = Date.now();
            var latencyMs = lastAt[seq] ? t - lastAt[seq] : undefined;
            lastAt[seq] = t;
            tries[seq] = (tries[seq] || 0) + 1;
            emit('item.answered', {
              session: id, seq: seq, item: String(item),
              try: r.try || tries[seq],
              response: r.response == null ? null : String(r.response),
              result: r.result,
              judgedBy: r.judgedBy || 'rule',
              score: r.score,
              maxScore: r.maxScore == null ? 1 : r.maxScore,
              feedback: r.feedback == null ? null : String(r.feedback),
              latencyMs: latencyMs,
            });
          } catch (e) {}
        },
        skipped: function (seq, item) {
          try { emit('item.skipped', { session: id, seq: seq, item: String(item) }); } catch (e) {}
        },
        completed: function (totals) {
          try {
            if (!open) return;
            open = false;
            var f = { session: id };
            totals = totals || {};
            for (var k in totals) f[k] = totals[k];
            emit('session.completed', f);
            scheduleFlush(0);
          } catch (e) {}
        },
        abandoned: function () {
          try {
            if (!open) return;
            open = false;
            emit('session.abandoned', { session: id });
            scheduleFlush(0);
          } catch (e) {}
        },
        isOpen: function () { return open; },
      };
      openSessions.push(handle);
      return handle;
    }

    function onLeave() {
      // leaving the page mid-round is the end of the round
      openSessions.forEach(function (h) { if (h.isOpen()) h.abandoned(); });
      beacon();
    }
    try {
      window.addEventListener('pagehide', onLeave);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') beacon();
      });
    } catch (e) {}

    var tracker = {
      app: app,
      session: function (spec) {
        try { return session(spec); } catch (e) { return noopSession(); }
      },
      flush: flush,
      pending: function () { return outbox.length; },
    };
    instances.push(tracker);
    if (outbox.length) scheduleFlush(0);
    return tracker;
  }

  function noopSession() {
    var f = function () {};
    return { id: null, presented: f, answered: f, skipped: f, completed: f, abandoned: f, isOpen: function () { return false; } };
  }

  window.Tracker = {
    init: function (opts) {
      try { return init(opts); } catch (e) {
        return { app: opts && opts.app, session: noopSession, flush: function () { return Promise.resolve(); }, pending: function () { return 0; } };
      }
    },
    /* for tests: post everything every instance still holds */
    flushAll: function () {
      return Promise.all(instances.map(function (t) { return t.flush(); }));
    },
    instances: instances,
  };
})();
