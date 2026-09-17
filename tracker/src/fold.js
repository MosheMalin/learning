// Folding events into the derived tables.
//
// Every fold is an upsert, so events may arrive twice, out of order, or split
// across requests and the tables end up the same. Two rules make that true:
// nothing here depends on what came before, only on what the row says now
// plus this event; and anything that reads a row and writes it back is a
// single SQL statement, so two requests folding the same attempt at once
// cannot lose each other's work. `rebuild` proves it by replaying the log.
//
// An event is folded first and recorded in `events` last: if a fold dies
// halfway the client resends, the event is still unknown, and the fold runs
// again - which is safe, because it is an upsert.
//
// Only the D1 statement API is used (prepare/bind/first/all/run), so the
// tests run the same code against Node's built-in SQLite.

export const EVENT_TYPES = new Set([
  'session.started', 'item.presented', 'item.answered', 'item.skipped',
  'session.completed', 'session.abandoned',
]);
export const RESULTS = new Set(['correct', 'almost', 'wrong', 'unjudged']);
export const JUDGES = new Set(['rule', 'llm', 'self', 'parent']);

const s = v => (v === undefined || v === null ? null : String(v));
const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const j = v => (v === undefined ? null : JSON.stringify(v));

/* YYYY-MM-DD of an ISO timestamp, in UTC - the fallback when the client did
   not say what day it was for the child. */
const utcDate = iso => iso.slice(0, 10);

/* The attempt's summary, computed from its tries_json by SQLite itself in
   ONE statement - the only place the meaning of these columns is decided.

   first_try_correct follows the app's own scoring, not the try results: the
   app gives the point (score >= maxScore) exactly when it counts the word as
   right first time, and it does not spend the first try on an unjudged
   answer or an unfinished-but-right sentence. Without scores (another app,
   another day) the first judged try decides. */
const SUMMARY_SQL = `
  UPDATE attempts SET
    tries_json = (SELECT json_group_array(json(value)) FROM
                   (SELECT value FROM json_each(attempts.tries_json) ORDER BY json_extract(value, '$.try'))),
    tries = (SELECT COUNT(*) FROM json_each(attempts.tries_json)),
    first_try_correct = CASE
      WHEN (SELECT MAX(json_extract(value, '$.maxScore')) FROM json_each(attempts.tries_json)) IS NOT NULL
       AND (SELECT MAX(json_extract(value, '$.score')) FROM json_each(attempts.tries_json)) IS NOT NULL
      THEN (SELECT MAX(json_extract(value, '$.score')) FROM json_each(attempts.tries_json))
           >= (SELECT MAX(json_extract(value, '$.maxScore')) FROM json_each(attempts.tries_json))
      ELSE COALESCE((SELECT json_extract(value, '$.result') = 'correct' FROM json_each(attempts.tries_json)
                     WHERE json_extract(value, '$.result') <> 'unjudged'
                     ORDER BY json_extract(value, '$.try') LIMIT 1), 0)
    END,
    success = EXISTS (SELECT 1 FROM json_each(attempts.tries_json) WHERE json_extract(value, '$.result') = 'correct'),
    final_result = (SELECT json_extract(value, '$.result') FROM json_each(attempts.tries_json)
                    ORDER BY json_extract(value, '$.try') DESC LIMIT 1),
    response = (SELECT json_extract(value, '$.response') FROM json_each(attempts.tries_json)
                ORDER BY json_extract(value, '$.try') DESC LIMIT 1),
    score = (SELECT MAX(json_extract(value, '$.score')) FROM json_each(attempts.tries_json)),
    max_score = (SELECT MAX(json_extract(value, '$.maxScore')) FROM json_each(attempts.tries_json)),
    latency_ms = (SELECT json_extract(value, '$.latencyMs') FROM json_each(attempts.tries_json)
                  ORDER BY json_extract(value, '$.try') LIMIT 1),
    feedback = (SELECT json_extract(value, '$.feedback') FROM json_each(attempts.tries_json)
                ORDER BY json_extract(value, '$.try') DESC LIMIT 1),
    resolved_at = (SELECT MAX(json_extract(value, '$.at')) FROM json_each(attempts.tries_json))
  WHERE session_id = ? AND seq = ?`;

async function ensureSession(db, ctx, ev) {
  // a stub, so counters have somewhere to land when session.started is late
  await db.prepare(
    `INSERT OR IGNORE INTO sessions (id, student, app, started_at, local_date, status, app_version, device)
     VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`)
    .bind(ev.session, ctx.student, ctx.app, ev.at, utcDate(ev.at), s(ctx.appVersion), j(ctx.device))
    .run();
}

async function unitOfSession(db, sessionId) {
  const row = await db.prepare('SELECT unit_id FROM sessions WHERE id = ?').bind(sessionId).first();
  return row ? row.unit_id : '';
}

async function upsertActivity(db, app, id, kind, parentId, title, definition, at) {
  await db.prepare(
    `INSERT INTO activities (app, id, kind, parent_id, title, definition, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app, id) DO UPDATE SET
       kind = excluded.kind, parent_id = excluded.parent_id, title = excluded.title,
       definition = excluded.definition, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= activities.updated_at`)
    .bind(app, id, kind, s(parentId), s(title), JSON.stringify(definition), at)
    .run();
}

async function recountSession(db, sessionId) {
  await db.prepare(
    `UPDATE sessions SET
       answered_count     = (SELECT COUNT(*)                   FROM attempts WHERE session_id = ? AND tries > 0),
       correct_first_try  = (SELECT COALESCE(SUM(first_try_correct), 0) FROM attempts WHERE session_id = ?),
       correct_eventually = (SELECT COALESCE(SUM(success), 0)  FROM attempts WHERE session_id = ?)
     WHERE id = ?`)
    .bind(sessionId, sessionId, sessionId, sessionId)
    .run();
}

async function foldStarted(db, ctx, ev) {
  const unit = ev.unit || {};
  const exercise = ev.exercise || {};
  const unitId = s(unit.id) || '';
  const exerciseId = s(exercise.id) || '';
  const params = ev.params || {};
  // a second start for the same id: the newer one describes the round, in
  // whatever order the two arrive
  await db.prepare(
    `INSERT INTO sessions (id, student, app, unit_id, exercise_id, started_at, local_date, status,
                           item_count, params, app_version, device)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       unit_id = excluded.unit_id, exercise_id = excluded.exercise_id,
       started_at = excluded.started_at, local_date = excluded.local_date,
       item_count = COALESCE(excluded.item_count, sessions.item_count), params = excluded.params,
       app_version = excluded.app_version, device = excluded.device
     WHERE excluded.started_at >= sessions.started_at OR sessions.unit_id = ''`)
    .bind(ev.session, ctx.student, ctx.app, unitId, exerciseId, ev.at,
      s(ev.localDate) || utcDate(ev.at), n(params.itemCount), JSON.stringify(params),
      s(ctx.appVersion), j(ctx.device))
    .run();
  // every attempt of the session belongs to the unit the session now names
  await db.prepare(`UPDATE attempts SET unit_id = (SELECT unit_id FROM sessions WHERE id = ?) WHERE session_id = ?`)
    .bind(ev.session, ev.session).run();

  if (unitId) {
    const { items, ...unitDef } = unit;
    await upsertActivity(db, ctx.app, unitId, 'unit', null, unit.title, unitDef, ev.at);
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.id === undefined) continue;
      await upsertActivity(db, ctx.app, `${unitId}/${item.id}`, 'item', unitId,
        item.title ?? item.en ?? item.text ?? null, item, ev.at);
    }
  }
  if (exerciseId) {
    await upsertActivity(db, ctx.app, `exercise:${exerciseId}`, 'exercise', null,
      exercise.title, exercise, ev.at);
  }
  // a completion that arrived first must not be undone by the late start
  await db.prepare(
    `UPDATE sessions SET duration_ms = CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = ? AND ended_at IS NOT NULL`).bind(ev.session).run();
}

async function foldPresented(db, ctx, ev) {
  await ensureSession(db, ctx, ev);
  const unitId = await unitOfSession(db, ev.session);
  await db.prepare(
    `INSERT INTO attempts (session_id, seq, student, app, unit_id, item_id, presented_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, seq) DO UPDATE SET
       presented_at = COALESCE(attempts.presented_at, excluded.presented_at),
       item_id = excluded.item_id`)
    .bind(ev.session, ev.seq, ctx.student, ctx.app, unitId, s(ev.item) || '', ev.at)
    .run();
}

async function foldAnswered(db, ctx, ev) {
  await ensureSession(db, ctx, ev);
  const unitId = await unitOfSession(db, ev.session);
  await db.prepare(
    `INSERT OR IGNORE INTO attempts (session_id, seq, student, app, unit_id, item_id)
     VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(ev.session, ev.seq, ctx.student, ctx.app, unitId, s(ev.item) || '')
    .run();
  const tryNo = n(ev.try);
  const record = JSON.stringify({
    try: tryNo,
    at: ev.at,
    response: s(ev.response),
    result: ev.result,
    judgedBy: JUDGES.has(ev.judgedBy) ? ev.judgedBy : 'rule',
    score: n(ev.score),
    maxScore: n(ev.maxScore),
    latencyMs: n(ev.latencyMs),
    feedback: s(ev.feedback),
  });
  // append this try unless a try with that number is already there - one
  // statement, so a concurrent fold of the same attempt cannot drop it
  await db.prepare(
    `UPDATE attempts SET tries_json = json_insert(tries_json, '$[#]', json(?))
     WHERE session_id = ? AND seq = ?
       AND NOT EXISTS (SELECT 1 FROM json_each(attempts.tries_json) WHERE json_extract(value, '$.try') = ?)`)
    .bind(record, ev.session, ev.seq, tryNo)
    .run();
  await db.prepare(SUMMARY_SQL).bind(ev.session, ev.seq).run();
  await recountSession(db, ev.session);
}

async function foldSkipped(db, ctx, ev) {
  await ensureSession(db, ctx, ev);
  const unitId = await unitOfSession(db, ev.session);
  await db.prepare(
    `INSERT INTO attempts (session_id, seq, student, app, unit_id, item_id, final_result, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?)
     ON CONFLICT(session_id, seq) DO UPDATE SET
       final_result = CASE WHEN attempts.tries = 0 THEN 'skipped' ELSE attempts.final_result END,
       resolved_at = COALESCE(attempts.resolved_at, excluded.resolved_at)`)
    .bind(ev.session, ev.seq, ctx.student, ctx.app, unitId, s(ev.item) || '', ev.at)
    .run();
}

async function foldCompleted(db, ctx, ev) {
  await ensureSession(db, ctx, ev);
  await db.prepare(
    `UPDATE sessions SET
       ended_at = ?, status = 'completed',
       duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
       score = ?, max_score = ?,
       item_count = COALESCE(?, item_count)
     WHERE id = ?`)
    .bind(ev.at, ev.at, n(ev.score), n(ev.maxScore), n(ev.itemCount), ev.session)
    .run();
}

async function foldAbandoned(db, ctx, ev) {
  await ensureSession(db, ctx, ev);
  // completed wins over abandoned whatever the order of arrival
  await db.prepare(
    `UPDATE sessions SET
       ended_at = ?, status = 'abandoned',
       duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = ? AND status <> 'completed'`)
    .bind(ev.at, ev.at, ev.session)
    .run();
}

const FOLDS = {
  'session.started': foldStarted,
  'item.presented': foldPresented,
  'item.answered': foldAnswered,
  'item.skipped': foldSkipped,
  'session.completed': foldCompleted,
  'session.abandoned': foldAbandoned,
};

/* ctx: { student, app, appVersion, device, receivedAt } */
export async function foldEvent(db, ctx, ev) {
  await FOLDS[ev.type](db, ctx, ev);
}

/* Fold the events of one batch that have not been seen before, recording
   each one only once its fold has landed. Returns { accepted, duplicates }. */
export async function ingestEvents(db, ctx, events) {
  let accepted = 0, duplicates = 0;
  for (const ev of events) {
    const seen = await db.prepare('SELECT 1 AS x FROM events WHERE id = ?').bind(ev.id).first();
    if (seen) { duplicates++; continue; }
    await foldEvent(db, ctx, ev);
    const r = await db.prepare(
      `INSERT OR IGNORE INTO events (id, student, app, session_id, type, at, received_at, app_version, device, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ev.id, ctx.student, ctx.app, ev.session, ev.type, ev.at, ctx.receivedAt,
        s(ctx.appVersion), j(ctx.device), JSON.stringify(ev))
      .run();
    // a twin request folded it a moment ago: harmless, the fold is an upsert
    if (r.meta && r.meta.changes === 0) duplicates++; else accepted++;
  }
  return { accepted, duplicates };
}

/* Throw the derived tables away and fold the whole log again. The one thing
   a parent writes by hand - a hidden session - is carried across. */
export async function rebuild(db) {
  const { results: hidden } = await db.prepare('SELECT id FROM sessions WHERE deleted = 1').all();
  for (const t of ['attempts', 'sessions', 'activities']) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  const { results } = await db.prepare(
    'SELECT student, app, app_version, device, received_at, payload FROM events ORDER BY at, received_at').all();
  for (const row of results) {
    const ctx = {
      student: row.student, app: row.app, appVersion: row.app_version,
      device: row.device ? JSON.parse(row.device) : null, receivedAt: row.received_at,
    };
    await foldEvent(db, ctx, JSON.parse(row.payload));
  }
  for (const h of hidden) {
    await db.prepare('UPDATE sessions SET deleted = 1 WHERE id = ?').bind(h.id).run();
  }
  return results.length;
}
