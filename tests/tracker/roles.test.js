// Who may do what, through the Worker's real fetch handler with a fake env:
// the dev session table stands in for Google, the D1 adapter for D1, a Map
// for KV. These are the decisions that could be reversed silently.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./d1-sqlite.js');

let worker;
test.before(async () => { worker = (await import('../../tracker/src/index.js')).default; });

function makeEnv(db) {
  const kv = new Map();
  return {
    DB: db,
    LEARNING_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null; },
      async put(k, v) { kv.set(k, v); },
      async delete(k) { kv.delete(k); },
    },
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    PARENT_EMAILS: 'Parent@Family.test',
    GOOGLE_CLIENT_ID: '',
    DEV_SESSIONS: JSON.stringify({
      p1: { sub: 'p1', email: 'parent@family.test', name: 'הורה' },
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

const batch = (session, seq = 1) => ({
  schema: 1, app: 'english-words', appVersion: '20',
  events: [
    { id: `${session}-start`, type: 'session.started', at: '2026-09-16T17:00:00.000Z', session, localDate: '2026-09-16',
      exercise: { id: 'he2en', title: 'x' }, unit: { id: 'l1', kind: 'wordlist', title: 'רשימה', items: [{ id: 'dog', en: 'dog', he: 'כלב' }] }, params: { itemCount: 1 } },
    { id: `${session}-p${seq}`, type: 'item.presented', at: '2026-09-16T17:00:01.000Z', session, seq, item: 'dog', prompt: { text: 'כלב' } },
    { id: `${session}-a${seq}`, type: 'item.answered', at: '2026-09-16T17:00:05.000Z', session, seq, item: 'dog', try: 1, response: 'dog', result: 'correct', judgedBy: 'rule', score: 1, maxScore: 1 },
    { id: `${session}-done`, type: 'session.completed', at: '2026-09-16T17:00:06.000Z', session, score: 1, maxScore: 1, itemCount: 1 },
  ],
});

test('a seeded email is a parent, everyone else a student, and the cookie decides who wrote what', async () => {
  const env = makeEnv(freshDb());
  const me = await (await call(env, '/learning/track/v1/auth/me', { sid: 'p1' })).json();
  assert.equal(me.role, 'parent');
  const kid = await (await call(env, '/learning/track/v1/auth/me', { sid: 'k1' })).json();
  assert.equal(kid.role, 'student');

  const r = await call(env, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: batch('sess-0001') });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { accepted: 4, duplicates: 0 });
  const row = await env.DB.prepare('SELECT student FROM sessions').first();
  assert.equal(row.student, 'k1');
});

test('nobody without a cookie, and no student, reaches the parent API', async () => {
  const env = makeEnv(freshDb());
  await call(env, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: batch('sess-0001') });
  const routes = [
    ['GET', '/learning/parent/api/students'],
    ['GET', '/learning/parent/api/sessions/sess-0001'],
    ['PATCH', '/learning/parent/api/students/k1'],
    ['DELETE', '/learning/parent/api/sessions/sess-0001'],
    ['POST', '/learning/parent/api/admin/rebuild'],
  ];
  for (const [method, path] of routes) {
    assert.equal((await call(env, path, { method, body: {} })).status, 401, `${method} ${path} anonymous`);
    assert.equal((await call(env, path, { method, sid: 'k1', body: {} })).status, 403, `${method} ${path} as a student`);
    assert.equal((await call(env, path, { method, sid: 'k2', body: {} })).status, 403, `${method} ${path} as another student`);
  }
  assert.equal((await call(env, '/learning/track/v1/events', { method: 'POST', body: batch('sess-0002') })).status, 401);
  // a parent sees the round, question by question
  const view = await (await call(env, '/learning/parent/api/sessions/sess-0001', { sid: 'p1' })).json();
  assert.equal(view.session.student, 'k1');
  assert.equal(view.attempts.length, 1);
  assert.deepEqual(view.attempts[0].prompt, { text: 'כלב' });
  // rebuild is POST-only
  assert.equal((await call(env, '/learning/parent/api/admin/rebuild', { sid: 'p1' })).status, 404);
});

test('a parent may promote and hide, but not demote themself', async () => {
  const env = makeEnv(freshDb());
  await call(env, '/learning/track/v1/auth/me', { sid: 'k1' });
  let r = await call(env, '/learning/parent/api/students/k1', { method: 'PATCH', sid: 'p1', body: { display_name: 'נועה', grade: 'ה', hidden: true, role: 'parent' } });
  assert.equal(r.status, 200);
  const k1 = await env.DB.prepare('SELECT * FROM people WHERE sub = ?').bind('k1').first();
  assert.equal(k1.role, 'parent');
  assert.equal(k1.display_name, 'נועה');
  assert.equal(k1.hidden, 1);
  r = await call(env, '/learning/parent/api/students/p1', { method: 'PATCH', sid: 'p1', body: { role: 'student' } });
  assert.equal(r.status, 200);
  assert.equal((await env.DB.prepare('SELECT role FROM people WHERE sub = ?').bind('p1').first()).role, 'parent');
});

test('another family cannot see this one', async () => {
  const env = makeEnv(freshDb());
  await call(env, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: batch('sess-0001') });
  // a parent of a different family: same tables, another family_id
  await env.DB.prepare(`INSERT INTO families (id, name, created_at) VALUES ('fam-2', 'others', '2026-01-01T00:00:00.000Z')`).run();
  await env.DB.prepare(`INSERT INTO people (sub, email, family_id, role, created_at) VALUES ('p9', 'p9@other.test', 'fam-2', 'parent', '2026-01-01T00:00:00.000Z')`).run();
  env.DEV_SESSIONS = JSON.stringify({ ...JSON.parse(env.DEV_SESSIONS), p9: { sub: 'p9', email: 'p9@other.test', name: 'other' } });
  assert.equal((await call(env, '/learning/parent/api/sessions/sess-0001', { sid: 'p9' })).status, 404);
  assert.equal((await call(env, '/learning/parent/api/students/k1/sessions', { sid: 'p9' })).status, 404);
  assert.equal((await call(env, '/learning/parent/api/sessions/sess-0001', { method: 'DELETE', sid: 'p9' })).status, 404);
  const mine = await (await call(env, '/learning/parent/api/students', { sid: 'p9' })).json();
  assert.deepEqual(mine.students.map(s => s.sub), ['p9']);
});

test('a runaway client is stopped at the minute cap, and a bad event is named', async () => {
  const env = makeEnv(freshDb());
  let last;
  for (let i = 0; i < 101; i++) {
    last = await call(env, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: { schema: 1, app: 'english-words', events: [] } });
    if (last.status !== 200) break;
  }
  assert.equal(last.status, 429);
  const env2 = makeEnv(freshDb());
  const bad = batch('sess-0003');
  bad.events[2].try = 0;
  const r = await call(env2, '/learning/track/v1/events', { method: 'POST', sid: 'k1', body: bad });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'bad try', index: 2 });
});

test('the SDK file is served even when the Worker answers first', async () => {
  const env = makeEnv(freshDb());
  const r = await call(env, '/learning/track/v1/tracker.js');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'asset');
});
