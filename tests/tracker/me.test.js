// The student's own view: scoped to the cookie's student, and one rule for
// "this word needs work" that both the app and the dashboard can rely on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./d1-sqlite.js');

let worker, me;
test.before(async () => {
  worker = (await import('../../tracker/src/index.js')).default;
  me = await import('../../tracker/src/me-api.js');
});

function makeEnv(db) {
  const kv = new Map();
  return {
    DB: db,
    LEARNING_KV: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } },
    ASSETS: { fetch: async () => new Response('asset') },
    PARENT_EMAILS: 'parent@family.test',
    GOOGLE_CLIENT_ID: '',
    DEV_SESSIONS: JSON.stringify({
      k1: { sub: 'k1', email: 'kid1@family.test', name: 'ילדה' },
      k2: { sub: 'k2', email: 'kid2@family.test', name: 'ילד' },
    }),
  };
}

const call = (env, path, { method = 'GET', sid, body } = {}) => worker.fetch(new Request('https://malinvishne.com' + path, {
  method,
  headers: { ...(sid ? { Cookie: `sid=${sid}` } : {}), 'Content-Type': 'application/json' },
  body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
}), env);

/* one round of two words: dog right first time, cat wrong then right */
function round(session, at) {
  const t = s => `${at}${String(s).padStart(2, '0')}.000Z`;
  return {
    schema: 1, app: 'english-words',
    events: [
      { id: `${session}-start`, type: 'session.started', at: t(0), session, localDate: at.slice(0, 10),
        exercise: { id: 'he2en', title: 'x' }, unit: { id: 'l1', kind: 'wordlist', title: 'רשימה', items: [{ id: 'dog', en: 'dog', he: 'כלב' }, { id: 'cat', en: 'cat', he: 'חתול' }] }, params: { itemCount: 2 } },
      { id: `${session}-p1`, type: 'item.presented', at: t(1), session, seq: 1, item: 'dog', prompt: { text: 'כלב' } },
      { id: `${session}-a1`, type: 'item.answered', at: t(2), session, seq: 1, item: 'dog', try: 1, response: 'dog', result: 'correct', judgedBy: 'rule', score: 1, maxScore: 1 },
      { id: `${session}-p2`, type: 'item.presented', at: t(3), session, seq: 2, item: 'cat', prompt: { text: 'חתול' } },
      { id: `${session}-a2`, type: 'item.answered', at: t(4), session, seq: 2, item: 'cat', try: 1, response: 'cta', result: 'almost', judgedBy: 'rule', score: 0, maxScore: 1 },
      { id: `${session}-a3`, type: 'item.answered', at: t(5), session, seq: 2, item: 'cat', try: 2, response: 'cat', result: 'correct', judgedBy: 'rule', score: 0, maxScore: 1 },
      { id: `${session}-done`, type: 'session.completed', at: t(6), session, score: 1, maxScore: 2, itemCount: 2 },
    ],
  };
}

test('a student sees only their own weak words', async () => {
  const env = makeEnv(freshDb());
  await call(env, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: round('sess-0001', '2026-09-16T17:00:') });
  const mine = await (await call(env, '/learning/track/v1/me/units/english-words/l1', { sid: 'k1' })).json();
  assert.deepEqual(mine.weak, ['cat']);
  assert.deepEqual(mine.items.map(i => [i.item_id, i.seen, i.weak]).sort(), [['cat', 1, true], ['dog', 1, false]]);
  // the sibling has no history on this list: not even its word list comes back
  const theirs = await (await call(env, '/learning/track/v1/me/units/english-words/l1', { sid: 'k2' })).json();
  assert.deepEqual(theirs, { items: [], weak: [] });
  assert.equal((await call(env, '/learning/track/v1/me/units/english-words/l1')).status, 401);
  assert.equal((await call(env, '/learning/parent/api/students', { sid: 'k1' })).status, 403);
});

test('a unit id with awkward characters round-trips through the URL', async () => {
  const env = makeEnv(freshDb());
  const r = round('sess-0002', '2026-09-16T18:00:');
  r.events[0].unit.id = 'list 1/a';
  await call(env, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: r });
  const mine = await (await call(env, '/learning/track/v1/me/units/english-words/' + encodeURIComponent('list 1/a'), { sid: 'k1' })).json();
  assert.deepEqual(mine.weak, ['cat']);
});

test('the student view is rate-limited like ingest', async () => {
  const env = makeEnv(freshDb());
  let last;
  for (let i = 0; i < 101; i++) {
    last = await call(env, '/learning/track/v1/me/units/english-words/l1', { sid: 'k1' });
    if (last.status !== 200) break;
  }
  assert.equal(last.status, 429);
});

test('the weak rule: the last time, or two of the last three', () => {
  const item = recent => ({ seen: recent.length, recent: recent.map(f => ({ first_try: f })) });
  assert.equal(me.isWeak(item([])), false);
  assert.equal(me.isWeak(item([false])), true);              // missed last time
  assert.equal(me.isWeak(item([true])), false);
  assert.equal(me.isWeak(item([true, false])), false);       // one slip, then right: not yet weak
  assert.equal(me.isWeak(item([true, false, false])), true); // right once in three
  assert.equal(me.isWeak(item([true, true, false])), false);
  assert.equal(me.isWeak(item([true, false, false, false])), true);   // only the last three count
});
