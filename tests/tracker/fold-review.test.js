// The second round of the fold's promises - one per finding of the first
// review: the point decides "first try", a fold that dies mid-batch, two
// folds of one attempt at once, rebuild vs hidden rounds, an abandoned
// round's counts, the child's day, a second start, and stricter validation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, failingAt } = require('./d1-sqlite.js');

let fold, ingest;
test.before(async () => {
  fold = await import('../../tracker/src/fold.js');
  ingest = await import('../../tracker/src/ingest.js');
});

const CTX = { student: 'kid', app: 'english-words', appVersion: '20', device: { tz: 'Asia/Jerusalem' }, receivedAt: '2026-09-16T18:10:00.000Z' };

const answered = (session, seq, tryNo, fields) => ({
  id: `${session}-x-${seq}-${tryNo}`, type: 'item.answered',
  at: `2026-09-16T18:00:${String(tryNo).padStart(2, '0')}.000Z`,
  session, seq, item: 'dog', try: tryNo, judgedBy: 'rule', maxScore: 1, ...fields,
});

/* the same nine-word round as fold.test.js */
function round(session = 'sess-0001') {
  const t = i => `2026-09-16T17:0${Math.min(9, Math.floor(i / 10))}:${String(i % 60).padStart(2, '0')}.000Z`;
  let i = 0;
  const ev = (type, f) => ({ id: `${session}-ev-${String(++i).padStart(3, '0')}`, type, at: t(i), session, ...f });
  const words = ['dog', 'cat', 'house', 'book', 'tree', 'water', 'sun', 'boy', 'flower'];
  const out = [ev('session.started', {
    localDate: '2026-09-16',
    exercise: { id: 'he2en', title: 'מעברית לאנגלית', interaction: 'fill-in' },
    unit: { id: 'l1', kind: 'wordlist', title: 'רשימת בדיקה', examDate: '2026-09-18', items: words.map(w => ({ id: w, en: w, he: 'x' })) },
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
    } else {
      out.push(ev('item.answered', { seq, item: w, try: 1, response: w, result: 'correct', judgedBy: 'rule', score: 1, maxScore: 1, latencyMs: 2500 }));
    }
  });
  out.push(ev('session.completed', { score: 7, maxScore: 9, correctFirstTry: 7, correctEventually: 8, itemCount: 9 }));
  return out;
}

const sessionRow = (db, id) => db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
async function snapshot(db) {
  const tables = {};
  for (const t of ['sessions', 'attempts', 'activities']) {
    tables[t] = (await db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return tables;
}

test('first try follows the point the app gave, not the first result', async () => {
  // a yellow sentence fixed on the second go, and an unreachable judge then a
  // right answer: the app spends no first try on either, so nor does the fold
  for (const first of ['almost', 'unjudged']) {
    const db = freshDb();
    await fold.ingestEvents(db, CTX, [
      answered('sess-0009', 1, 1, { result: first, score: 0, response: 'i have dog' }),
      answered('sess-0009', 1, 2, { result: 'correct', score: 1, response: 'I have a dog.' }),
    ]);
    const a = await db.prepare('SELECT * FROM attempts WHERE session_id = ?').bind('sess-0009').first();
    assert.equal(a.first_try_correct, 1, `${first} then correct with the point`);
    assert.equal(a.success, 1);
    assert.equal(a.score, 1);
    assert.equal((await sessionRow(db, 'sess-0009')).correct_first_try, 1);
  }
  // a plain retry, scored 0 by the app, is not first-try
  const db = freshDb();
  await fold.ingestEvents(db, CTX, [
    answered('sess-0010', 1, 1, { result: 'wrong', score: 0 }),
    answered('sess-0010', 1, 2, { result: 'correct', score: 0 }),
  ]);
  const a = await db.prepare('SELECT * FROM attempts WHERE session_id = ?').bind('sess-0010').first();
  assert.equal(a.first_try_correct, 0);
  assert.equal(a.success, 1);
  // without scores at all, the first judged try decides
  const db2 = freshDb();
  await fold.ingestEvents(db2, CTX, [
    answered('sess-0011', 1, 1, { result: 'unjudged', score: undefined, maxScore: undefined }),
    answered('sess-0011', 1, 2, { result: 'correct', score: undefined, maxScore: undefined }),
  ]);
  assert.equal((await db2.prepare('SELECT first_try_correct FROM attempts').first()).first_try_correct, 1);
});

test('a fold that dies mid-batch is repaired by the resend', async () => {
  const good = freshDb();
  await fold.ingestEvents(good, CTX, round());
  const expected = await snapshot(good);

  const db = freshDb();
  const events = round();
  // the 14th statement run is inside the fold of an early item.answered
  await assert.rejects(fold.ingestEvents(failingAt(db, 14), CTX, events), /D1_ERROR/);
  const stored = (await db.prepare('SELECT COUNT(*) AS n FROM events').first()).n;
  assert.ok(stored < events.length, 'the failed event was not recorded');
  const again = await fold.ingestEvents(db, CTX, events);      // the SDK retries the same batch
  assert.equal(again.accepted + again.duplicates, events.length);
  assert.ok(again.accepted >= 1, 'the failed event is folded on the resend');
  assert.deepEqual(await snapshot(db), expected);
});

test('two folds of the same attempt at once lose nothing', async () => {
  // both appends land before either summary runs; the last summary sees both
  const db = freshDb();
  const t1 = answered('sess-0012', 1, 1, { result: 'almost', score: 0 });
  const t2 = answered('sess-0012', 1, 2, { result: 'correct', score: 0 });
  await Promise.all([fold.foldEvent(db, CTX, t1), fold.foldEvent(db, CTX, t2)]);
  const a = await db.prepare('SELECT * FROM attempts').first();
  assert.equal(a.tries, 2);
  assert.equal(a.first_try_correct, 0);
  assert.equal(a.final_result, 'correct');
  assert.deepEqual(JSON.parse(a.tries_json).map(t => t.try), [1, 2]);
});

test('rebuild drops phantom rows and keeps what the parent hid', async () => {
  const db = freshDb();
  await fold.ingestEvents(db, CTX, round('sess-0001'));
  await fold.ingestEvents(db, CTX, round('sess-0002'));
  const before = await snapshot(db);
  await db.prepare(`INSERT INTO sessions (id, student, app, started_at, local_date, status)
    VALUES ('ghost', 'kid', 'english-words', '2026-01-01T00:00:00.000Z', '2026-01-01', 'completed')`).run();
  await db.prepare(`INSERT INTO attempts (session_id, seq, student, app, item_id) VALUES ('ghost', 1, 'kid', 'english-words', 'x')`).run();
  await db.prepare(`UPDATE sessions SET deleted = 1 WHERE id = 'sess-0002'`).run();
  await fold.rebuild(db);
  const after = await snapshot(db);
  assert.equal(after.sessions.find(s => s.id === 'ghost'), undefined);
  assert.equal(after.attempts.find(a => a.session_id === 'ghost'), undefined);
  assert.equal(after.sessions.find(s => s.id === 'sess-0002').deleted, 1, 'the hidden round stays hidden');
  await db.prepare(`UPDATE sessions SET deleted = 0`).run();
  assert.deepEqual(await snapshot(db), before);
});

test('an abandoned round counts only the questions she answered', async () => {
  const db = freshDb();
  const events = round().filter(e => !(e.type === 'session.completed' || (e.seq === 9 && e.type === 'item.answered')));
  events.push({ id: 'abandon-0009', type: 'session.abandoned', at: '2026-09-16T17:09:59.000Z', session: 'sess-0001' });
  await fold.ingestEvents(db, CTX, events);
  const s = await sessionRow(db, 'sess-0001');
  assert.equal(s.status, 'abandoned');
  assert.equal(s.item_count, 9);
  assert.equal(s.answered_count, 8);
  assert.equal(s.correct_first_try, 6);
  const last = await db.prepare('SELECT * FROM attempts WHERE seq = 9').first();
  assert.equal(last.tries, 0);
  assert.ok(last.presented_at);
});

test('the day on the device wins over the UTC date', async () => {
  const db = freshDb();
  const start = { ...round()[0], at: '2026-09-16T22:30:00.000Z', localDate: '2026-09-17' };
  await fold.ingestEvents(db, CTX, [start]);
  assert.equal((await sessionRow(db, 'sess-0001')).local_date, '2026-09-17');
});

test('an older second start does not overwrite the newer one, and rebuild agrees', async () => {
  const older = { ...round()[0], id: 'start-old-0001', at: '2026-09-16T16:00:00.000Z', unit: { id: 'l-old', kind: 'wordlist', title: 'old', items: [] } };
  const newer = { ...round()[0], id: 'start-new-0001', at: '2026-09-16T17:00:00.000Z' };
  const presented = round().find(e => e.type === 'item.presented');
  const db = freshDb();
  await fold.ingestEvents(db, CTX, [newer, presented, older]);
  const live = await snapshot(db);
  assert.equal(live.sessions[0].unit_id, 'l1');
  assert.equal(live.attempts[0].unit_id, 'l1');
  await fold.rebuild(db);
  assert.deepEqual(await snapshot(db), live);
});

test('validation names the bad event and refuses what the SDK never sends', () => {
  const base = { schema: 1, app: 'a' };
  const ok = e => ingest.validateBatch({ ...base, events: [e] });
  const good = { id: 'e1e1e1e1', type: 'item.answered', at: '2026-09-16T00:00:00.000Z', session: 's1s1s1s1', seq: 1, try: 1, result: 'correct', score: 1, maxScore: 1 };
  assert.equal(ok(good).ok, true);
  assert.deepEqual(ok({ ...good, try: 0 }), { ok: false, error: 'bad try', index: 0 });
  assert.equal(ok({ ...good, try: 2.5 }).ok, false);
  assert.equal(ok({ ...good, try: 101 }).ok, false);
  assert.equal(ok({ ...good, score: 1e300 }).ok, false);
  assert.equal(ok({ ...good, at: 'Wed, 16 Sep 2026 17:00:00 GMT' }).ok, false);
  assert.equal(ok({ ...good, at: '2026-09-16T17:00:00' }).ok, false);
  const start = { id: 'e1e1e1e1', type: 'session.started', at: '2026-09-16T00:00:00.000Z', session: 's1s1s1s1' };
  assert.equal(ok({ ...start, localDate: '2026-09-16' }).ok, true);
  assert.equal(ok({ ...start, localDate: 'Wed 16' }).ok, false);
  assert.equal(ok({ ...start, unit: { id: 'u', items: Array.from({ length: 401 }, (_, i) => ({ id: i })) } }).ok, false);
  // a long list still fits: 300 items is well under the start event's own cap
  assert.equal(ok({ ...start, unit: { id: 'u', items: Array.from({ length: 300 }, (_, i) => ({ id: `word${i}`, en: `word${i}`, he: 'מילה' })) } }).ok, true);
  const second = ingest.validateBatch({ ...base, events: [good, { ...good, id: 'e2e2e2e2', result: 'nope' }] });
  assert.deepEqual(second, { ok: false, error: 'bad result', index: 1 });
  // the device blob is trimmed to what the dashboard uses
  const dev = ingest.validateBatch({ ...base, events: [], device: { tz: 'Asia/Jerusalem', junk: 'x'.repeat(50000), ua: 'y'.repeat(500) } });
  assert.deepEqual(dev.device, { tz: 'Asia/Jerusalem', ua: 'y'.repeat(200) });
});
