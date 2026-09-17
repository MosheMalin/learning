/* The learning tracker client. One file, no dependencies, loaded by every app:
     <script async src="/learning/track/v1/tracker.js"></script>

   const tracker = Tracker.init({ app: 'english-words', appVersion: '19' });
   tracker.setUser(sub);                 // after sign-in; null on sign-out
   const s = tracker.session({ exercise, unit, params });
   s.presented(seq, itemId, prompt);
   s.answered(seq, itemId, { response, result, judgedBy, score, maxScore, feedback, submittedAt });
   s.completed({ score, maxScore, correctFirstTry, correctEventually, itemCount });
   s.abandoned();

   Events queue in memory and in localStorage, and are posted in batches:
   two seconds after the last one, at once when twenty are waiting or a
   session ends, and with sendBeacon when the page is hidden or left. A batch
   that fails stays queued; the server ignores an event it has already seen,
   so resending is always safe.

   Every queued event is stamped with the account that was signed in when it
   happened, and only events stamped with the current account are ever posted:
   the server attributes a batch to the cookie it arrives with, so a round
   queued under one child must not travel with the next child's cookie on a
   shared laptop. Nothing here can break the app: every entry point swallows
   its own errors. */
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
    var user = null;            // the signed-in account; nothing is posted without one
    var timer = null;
    var inflight = null;        // the promise of the post in progress
    var backoff = 0;
    var blockedUntil = 0;
    var openSessions = [];

    function emit(type, fields) {
      var ev = { id: uuid(), type: type, at: new Date().toISOString() };
      for (var k in fields) if (fields[k] !== undefined) ev[k] = fields[k];
      outbox.push({ app: app, appVersion: appVersion, user: user, ev: ev });
      if (outbox.length > MAX_OUTBOX) outbox.splice(0, outbox.length - MAX_OUTBOX);
      saveOutbox(outbox);
      scheduleFlush(sendable().length >= FLUSH_AT ? 0 : FLUSH_AFTER_MS);
    }

    /* the queued entries that may travel with the current account's cookie */
    function sendable() {
      if (!user) return [];
      return outbox.filter(function (o) { return o.user === user; });
    }

    function scheduleFlush(ms) {
      if (timer) clearTimeout(timer);
      var wait = Math.max(ms, blockedUntil - Date.now());
      timer = setTimeout(flush, wait);
    }

    function nextBatch() {
      var mine = sendable();
      if (!mine.length) return null;
      var first = mine[0];
      var events = [];
      for (var i = 0; i < mine.length && events.length < BATCH; i++) {
        if (mine[i].app === first.app && mine[i].appVersion === first.appVersion) events.push(mine[i].ev);
      }
      return { schema: 1, app: first.app, appVersion: first.appVersion, device: dev, events: events };
    }

    function dropIds(ids) {
      var set = {};
      ids.forEach(function (id) { set[id] = true; });
      outbox = outbox.filter(function (o) { return !set[o.ev.id]; });
      saveOutbox(outbox);
    }

    function flush() {
      timer = null;
      if (inflight) return inflight;
      var batch = nextBatch();
      if (!batch) return Promise.resolve();
      var body = JSON.stringify(batch);
      inflight = fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        credentials: 'same-origin',
        keepalive: body.length < BEACON_LIMIT,
      }).then(function (r) {
        inflight = null;
        if (r.ok) {
          dropIds(batch.events.map(function (e) { return e.id; }));
          backoff = 0;
          if (sendable().length) scheduleFlush(0);
          return;
        }
        if (r.status === 401) {
          // not signed in as far as the server knows: keep everything for later
          blockedUntil = Date.now() + MAX_BACKOFF_MS;
          return;
        }
        if (r.status === 400) {
          // the server named the one event it will never take; the rest is fine
          return r.json().catch(function () { return {}; }).then(function (info) {
            var bad = typeof info.index === 'number' && batch.events[info.index]
              ? [batch.events[info.index].id]
              : batch.events.map(function (e) { return e.id; });
            dropIds(bad);
            try { console.warn('tracker: event rejected', info.error); } catch (e) {}
            if (sendable().length) scheduleFlush(0);
          });
        }
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          dropIds(batch.events.map(function (e) { return e.id; }));
          try { console.warn('tracker: batch rejected', r.status); } catch (e) {}
          if (sendable().length) scheduleFlush(0);
          return;
        }
        retryLater();
      }).catch(function () {
        inflight = null;
        retryLater();
      });
      return inflight;
    }

    function retryLater() {
      backoff = Math.min(backoff ? backoff * 2 : 2000, MAX_BACKOFF_MS);
      scheduleFlush(backoff);
    }

    function beacon() {
      try {
        if (inflight) return;                  // a keepalive post is already carrying it
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
            lastAt[seq] = Date.now();
            emit('item.presented', { session: id, seq: seq, item: String(item), prompt: prompt });
          } catch (e) {}
        },
        answered: function (seq, item, r) {
          try {
            r = r || {};
            // her thinking time ends when she submits, not when a judge answers
            var t = typeof r.submittedAt === 'number' ? r.submittedAt : Date.now();
            var latencyMs = lastAt[seq] ? Math.max(0, t - lastAt[seq]) : undefined;
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
        /* the page is going away: say so, but if it comes back from the
           cache and she finishes, the completion must still be reported */
        suspended: function () {
          try { if (open) emit('session.abandoned', { session: id }); } catch (e) {}
        },
        isOpen: function () { return open; },
      };
      openSessions.push(handle);
      return handle;
    }

    function onLeave() {
      openSessions.forEach(function (h) { h.suspended(); });
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
      /* who is signed in; queued events of anyone else stay queued */
      setUser: function (sub) {
        try {
          user = sub == null ? null : String(sub);
          blockedUntil = 0;
          if (sendable().length) scheduleFlush(0);
        } catch (e) {}
      },
      session: function (spec) {
        try { return session(spec); } catch (e) { return noopSession(); }
      },
      flush: flush,
      pending: function () { return sendable().length; },
      queued: function () { return outbox.length; },
    };
    instances.push(tracker);
    return tracker;
  }

  function noopSession() {
    var f = function () {};
    return { id: null, presented: f, answered: f, skipped: f, completed: f, abandoned: f, suspended: f, isOpen: function () { return false; } };
  }

  window.Tracker = {
    init: function (opts) {
      try { return init(opts); } catch (e) {
        return { app: opts && opts.app, setUser: function () {}, session: noopSession,
          flush: function () { return Promise.resolve(); }, pending: function () { return 0; }, queued: function () { return 0; } };
      }
    },
    /* for tests: post everything every instance may still post */
    flushAll: function () {
      return Promise.all(instances.map(function (t) { return t.flush(); }));
    },
    instances: instances,
  };
})();
