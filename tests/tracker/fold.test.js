// The fold's promises, each one a way the parent's numbers could go wrong:
// a batch sent twice, events out of order, a round split across requests,
// a repeated try, abandoned-then-completed, and rebuild from the log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./d1-sqlite.js');

let fold, ingest;
test.before(async () => {
  fold = await import('../../tracker/src/fold.js');
  ingest = await import('../../tracker/src/ingest.js');
});

const CTX = { student: 'kid', app: 'english-words', appVersion: '19', device: { tz: 'Asia/Jerusalem' }, receivedAt: '2026-09-16T17:10:00.000Z' };

/* A nine-word round: word 1 right first time, word 2 right on the second
   try, word 3 never right, the rest right first time. Score 7/9 as the app
   counts it, 8 eventually right. */
function round(session = 'sess-0001') {
  const t = i => `2026-09-16T17:0${Math.min(9, Math.floor(i / 10))}:${String(i % 60).padStart(2, '0')}.000Z`;
  let i = 0;
  const ev = (type, f) => ({ id: `${session}-ev-${String(++i).padStart(3, '0')}`, type, at: t(i), session, ...f });
  const words = ['dog', 'cat', 'house', 'book', 'tree', 'water', 'sun', 'boy', 'flower'];
  const out = [ev('session.started', {
    localDate: '2026-09-16',
    exercise: { id: 'he2en', title: 'מעברית לאנגלית', interaction: 'fill-in' },
    unit: { id: 'l1', kind: 'wordlist', title: 'רשימת בדיקה', examDate: '2026-09-18',
      items: words.map(w => ({ id: w, en: w, he: 'x' })) },
    params: { itemCount: 9, retryOf: null, mistakesOnly: false },
  })];
  words.forEach((w, k) => {
    const seq = k + 1;
    out.push(ev('item.presented', { seq, item: w, prompt: { text: 'x' } }));
    if (seq === 2) {
      out.push(ev('item.answered', { seq, item: w, try: 1, response: 'cta', result: 'almost', judgedBy: 'rule', score: 0, maxScore: 1, latencyMs: 4000 }));
      out.push(ev('item.answered', { seq, item: w, try: 2, response: 'cat', result: 'correct', judgedBy: 'rule', score: 0, maxScore: 1, latencyMs: 1500 }));
    } else if (seq === 3) {
      out.push(ev('item.answered', { seq, item: w, try: 1, response: 'home', result: 'wrong', judgedBy: 'rule', score: 0, maxScore: 1, latencyMs: 3000 }));
      out.push(ev('item.answered', { seq, item: w, try: 2, response: 'hous', result: 'almost', judgedBy: 'rule', score: 0, maxScore: 1, latencyMs: 2000 }));
    } else {
      out.push(ev('item.answered', { seq, item: w, try: 1, response: w, result: 'correct', judgedBy: 'rule', score: 1, maxScore: 1, latencyMs: 2500 }));
    }
  });
  out.push(ev('session.completed', { score: 7, maxScore: 9, correctFirstTry: 7, correctEventually: 8, itemCount: 9 }));
  return out;
}

async function sessionRow(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
}
async function snapshot(db) {
  const tables = {};
  for (const t of ['sessions', 'attempts', 'activities']) {
    tables[t] = (await db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return tables;
}

test('a round folds to the numbers the child saw', async () => {
  const db = freshDb();
  const r = await fold.ingestEvents(db, CTX, round());
  assert.deepEqual(r, { accepted: 22, duplicates: 0 });
  const s = await sessionRow(db, 'sess-0001');
  assert.equal(s.status, 'completed');
  assert.equal(s.unit_id, 'l1');
  assert.equal(s.exercise_id, 'he2en');
  assert.equal(s.local_date, '2026-09-16');
  assert.equal(s.item_count, 9);
  assert.equal(s.answered_count, 9);
  assert.equal(s.correct_first_try, 7);
  assert.equal(s.correct_eventually, 8);
  assert.equal(s.score, 7);
  assert.equal(s.max_score, 9);
  assert.ok(s.duration_ms > 0);
  const a2 = await db.prepare('SELECT * FROM attempts WHERE session_id = ? AND seq = 2').bind('sess-0001').first();
  assert.equal(a2.tries, 2);
  assert.equal(a2.first_try_correct, 0);
  assert.equal(a2.success, 1);
  assert.equal(a2.final_result, 'correct');
  assert.equal(a2.latency_ms, 4000);
  assert.equal(a2.response, 'cat');
  const a3 = await db.prepare('SELECT * FROM attempts WHERE session_id = ? AND seq = 3').bind('sess-0001').first();
  assert.equal(a3.success, 0);
  assert.equal(a3.final_result, 'almost');
  assert.equal(a3.unit_id, 'l1');
  const items = (await db.prepare(`SELECT id FROM activities WHERE kind = 'item' AND parent_id = 'l1'`).all()).results;
  assert.equal(items.length, 9);
  const unit = await db.prepare(`SELECT definition FROM activities WHERE id = 'l1'`).first();
  assert.equal(JSON.parse(unit.definition).examDate, '2026-09-18');
  assert.equal(JSON.parse(unit.definition).items, undefined, 'items are their own rows, not repeated in the unit');
});

test('the same batch twice changes nothing', async () => {
  const db = freshDb();
  await fold.ingestEvents(db, CTX, round());
  const before = await snapshot(db);
  const r = await fold.ingestEvents(db, CTX, round());
  assert.deepEqual(r, { accepted: 0, duplicates: 22 });
  assert.deepEqual(await snapshot(db), before);
});

test('events out of order fold to the same tables', async () => {
  const db = freshDb();
  await fold.ingestEvents(db, CTX, round());
  const expected = await snapshot(db);
  const shuffled = round().reverse();     // completion first, start last
  const db2 = freshDb();
  await fold.ingestEvents(db2, CTX, shuffled);
  assert.deepEqual(await snapshot(db2), expected);
});

test('a round split across requests folds to the same tables', async () => {
  const db = freshDb();
  await fold.ingestEvents(db, CTX, round());
  const expected = await snapshot(db);
  const db2 = freshDb();
  const events = round();
  for (let i = 0; i < events.length; i += 4) {
    await fold.ingestEvents(db2, { ...CTX, receivedAt: `2026-09-16T17:2${i % 10}:00.000Z` }, events.slice(i, i + 4));
  }
  assert.deepEqual(await snapshot(db2), expected);
});

test('a repeated try number is counted once', async () => {
  const db = freshDb();
  const events = round();
  const again = { ...events.find(e => e.type === 'item.answered' && e.seq === 2 && e.try === 1), id: 'dup-different-id-0001' };
  await fold.ingestEvents(db, CTX, [...events, again]);
  const a2 = await db.prepare('SELECT tries FROM attempts WHERE session_id = ? AND seq = 2').bind('sess-0001').first();
  assert.equal(a2.tries, 2);
});

test('completed wins over abandoned, in either order', async () => {
  const abandoned = { id: 'abandon-0001', type: 'session.abandoned', at: '2026-09-16T17:09:59.000Z', session: 'sess-0001' };
  const db = freshDb();
  await fold.ingestEvents(db, CTX, [...round(), abandoned]);
  assert.equal((await sessionRow(db, 'sess-0001')).status, 'completed');
  const db2 = freshDb();
  await fold.ingestEvents(db2, CTX, [abandoned, ...round()]);
  assert.equal((await sessionRow(db2, 'sess-0001')).status, 'completed');
  // and a round that was only abandoned is abandoned
  const db3 = freshDb();
  await fold.ingestEvents(db3, CTX, [...round().filter(e => e.type !== 'session.completed'), abandoned]);
  const s = await sessionRow(db3, 'sess-0001');
  assert.equal(s.status, 'abandoned');
  assert.ok(s.ended_at);
});

test('rebuild from the log reproduces the tables exactly', async () => {
  const db = freshDb();
  await fold.ingestEvents(db, CTX, round('sess-0001'));
  await fold.ingestEvents(db, { ...CTX, student: 'kid2' }, round('sess-0002').reverse());
  const before = await snapshot(db);
  await db.prepare(`UPDATE sessions SET correct_first_try = 99`).run();   // corrupt a derived value
  const replayed = await fold.rebuild(db);
  assert.equal(replayed, 44);
  assert.deepEqual(await snapshot(db), before);
});

test('the student comes from the context, whatever the event says', async () => {
  const db = freshDb();
  const events = round().map(e => ({ ...e, student: 'someone-else', sub: 'someone-else' }));
  await fold.ingestEvents(db, CTX, events);
  const rows = (await db.prepare(`SELECT DISTINCT student FROM attempts`).all()).results;
  assert.deepEqual(rows.map(r => r.student), ['kid']);
  assert.equal((await sessionRow(db, 'sess-0001')).student, 'kid');
});

test('validation refuses what the fold must never see', () => {
  const ok = ingest.validateBatch({ schema: 1, app: 'english-words', events: round() });
  assert.equal(ok.ok, true);
  assert.equal(ok.events.length, 22);
  const bad = body => ingest.validateBatch(body).ok;
  assert.equal(bad({ schema: 2, app: 'english-words', events: [] }), false);
  assert.equal(bad({ schema: 1, app: '../x', events: [] }), false);
  assert.equal(bad({ schema: 1, app: 'a', events: [{ id: 'e1e1e1e1', type: 'nope', at: '2026-09-16T00:00:00.000Z', session: 's1s1s1s1' }] }), false);
  assert.equal(bad({ schema: 1, app: 'a', events: [{ id: 'e1e1e1e1', type: 'item.answered', at: '2026-09-16T00:00:00.000Z', session: 's1s1s1s1', seq: 1, result: 'maybe' }] }), false);
  assert.equal(bad({ schema: 1, app: 'a', events: [{ id: 'e1e1e1e1', type: 'item.presented', at: 'yesterday', session: 's1s1s1s1', seq: 1 }] }), false);
  assert.equal(bad({ schema: 1, app: 'a', events: Array.from({ length: 201 }, (_, i) => ({ id: `e${i}e1e1e1e1`, type: 'session.abandoned', at: '2026-09-16T00:00:00.000Z', session: 's1s1s1s1' })) }), false);
  assert.equal(bad({ schema: 1, app: 'a', events: [{ id: 'e1e1e1e1', type: 'session.abandoned', at: '2026-09-16T00:00:00.000Z', session: 's1s1s1s1', big: 'x'.repeat(20000) }] }), false);
});
