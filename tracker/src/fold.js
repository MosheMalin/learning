// Folding events into the derived tables.
//
// Every fold is an upsert, so events may arrive twice, out of order, or split
// across requests and the tables end up the same. The one rule that makes
// that true: nothing here depends on what came before, only on what the row
// says now plus this event. `rebuild` proves it by replaying the log.
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

/* Summarise an attempt from its tries. Pure; the only place the meaning of
   "first try", "success" and the attempt's score is decided. */
export function summarizeTries(tries) {
  const sorted = [...tries].sort((a, b) => a.try - b.try);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const scores = sorted.map(t => n(t.score)).filter(v => v !== null);
  const maxes = sorted.map(t => n(t.maxScore)).filter(v => v !== null);
  return {
    tries: sorted.length,
    first_try_correct: first.result === 'correct' ? 1 : 0,
    success: sorted.some(t => t.result === 'correct') ? 1 : 0,
    final_result: last.result,
    response: s(last.response),
    score: scores.length ? Math.max(...scores) : null,
    max_score: maxes.length ? Math.max(...maxes) : null,
    latency_ms: n(first.latencyMs),
    feedback: s(last.feedback),
    resolved_at: last.at,
    tries_json: JSON.stringify(sorted),
  };
}

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
  await db.prepare(
    `INSERT INTO sessions (id, student, app, unit_id, exercise_id, started_at, local_date, status,
                           item_count, params, app_version, device)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       unit_id = excluded.unit_id, exercise_id = excluded.exercise_id,
       started_at = excluded.started_at, local_date = excluded.local_date,
       item_count = excluded.item_count, params = excluded.params,
       app_version = excluded.app_version, device = excluded.device`)
    .bind(ev.session, ctx.student, ctx.app, unitId, exerciseId, ev.at,
      s(ev.localDate) || utcDate(ev.at), n(params.itemCount), JSON.stringify(params),
      s(ctx.appVersion), j(ctx.device))
    .run();
  // attempts that arrived before their session know their unit now
  await db.prepare(`UPDATE attempts SET unit_id = ? WHERE session_id = ? AND unit_id = ''`)
    .bind(unitId, ev.session).run();

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
  const row = await db.prepare('SELECT tries_json FROM attempts WHERE session_id = ? AND seq = ?')
    .bind(ev.session, ev.seq).first();
  const tries = JSON.parse(row.tries_json || '[]');
  const tryNo = n(ev.try) ?? tries.length + 1;
  if (!tries.some(t => t.try === tryNo)) {
    tries.push({
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
  }
  const sum = summarizeTries(tries);
  await db.prepare(
    `UPDATE attempts SET tries = ?, first_try_correct = ?, success = ?, final_result = ?, response = ?,
       score = ?, max_score = ?, latency_ms = ?, feedback = ?, resolved_at = ?, tries_json = ?
     WHERE session_id = ? AND seq = ?`)
    .bind(sum.tries, sum.first_try_correct, sum.success, sum.final_result, sum.response,
      sum.score, sum.max_score, sum.latency_ms, sum.feedback, sum.resolved_at, sum.tries_json,
      ev.session, ev.seq)
    .run();
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

/* Store the events of one batch and fold the ones not seen before.
   Returns { accepted, duplicates }. */
export async function ingestEvents(db, ctx, events) {
  let accepted = 0, duplicates = 0;
  for (const ev of events) {
    const r = await db.prepare(
      `INSERT OR IGNORE INTO events (id, student, app, session_id, type, at, received_at, app_version, device, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ev.id, ctx.student, ctx.app, ev.session, ev.type, ev.at, ctx.receivedAt,
        s(ctx.appVersion), j(ctx.device), JSON.stringify(ev))
      .run();
    if (!r.meta || r.meta.changes === 0) { duplicates++; continue; }
    accepted++;
    await foldEvent(db, ctx, ev);
  }
  return { accepted, duplicates };
}

/* Throw the derived tables away and fold the whole log again. */
export async function rebuild(db) {
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
  return results.length;
}
