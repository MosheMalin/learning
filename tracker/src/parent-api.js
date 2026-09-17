// The parent API. Every route here runs only for a signed-in parent; the
// family is the parent's own, and every query is narrowed by it.

import { rebuild } from './fold.js';

/* A round is "abandoned" once it has been quiet this long with no completion -
   quiet since her last answer, not since it started. */
const ABANDON_AFTER_MS = 30 * 60 * 1000;

const statusSql = `CASE WHEN s.status = 'in_progress'
    AND COALESCE((SELECT MAX(a.resolved_at) FROM attempts a WHERE a.session_id = s.id), s.started_at) < ?
  THEN 'abandoned' ELSE s.status END AS status`;

export async function parentApi({ request, env, url, person, now, json, readJson }) {
  const db = env.DB;
  const route = url.pathname.slice('/learning/parent/api/'.length).replace(/\/$/, '');
  const method = request.method;
  const family = person.family_id;
  const quietBefore = new Date(Date.parse(now) - ABANDON_AFTER_MS).toISOString();
  const today = now.slice(0, 10);

  /* a student in this family, or null */
  const student = async sub => db.prepare(
    `SELECT sub, email, name, picture, role, display_name, grade, hidden, created_at, last_seen_at
     FROM people WHERE sub = ? AND family_id = ?`).bind(sub, family).first();

  if (route === 'students' && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT p.sub, p.email, p.name, p.picture, p.role, p.display_name, p.grade, p.hidden,
              p.created_at, p.last_seen_at,
              (SELECT MAX(started_at) FROM sessions s WHERE s.student = p.sub AND s.deleted = 0) AS last_session_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.student = p.sub AND s.deleted = 0
                 AND s.started_at >= ?) AS sessions_7d,
              (SELECT COALESCE(SUM(duration_ms), 0) FROM sessions s WHERE s.student = p.sub AND s.deleted = 0
                 AND s.started_at >= ?) AS duration_7d_ms
       FROM people p WHERE p.family_id = ? ORDER BY p.role, p.created_at`)
      .bind(weekAgo(now), weekAgo(now), family).all();
    for (const p of results) {
      p.streak = await streakOf(db, p.sub, today);
      p.next_exam = await nextExamOf(db, p.sub, today);
    }
    return json({ students: results, me: person.sub });
  }

  let m;
  if ((m = route.match(/^students\/([^/]+)$/)) && method === 'PATCH') {
    const row = await student(m[1]);
    if (!row) return json({ error: 'not found' }, 404);
    const { body, error } = await readJson(request);
    if (error) return json({ error }, 400);
    const displayName = body.display_name == null ? row.display_name : String(body.display_name).slice(0, 60);
    const grade = body.grade == null ? row.grade : String(body.grade).slice(0, 20);
    const hidden = body.hidden == null ? row.hidden : (body.hidden ? 1 : 0);
    let role = row.role;
    if (body.role === 'parent' || body.role === 'student') {
      // a parent may not demote themself - there must always be one
      if (!(m[1] === person.sub && body.role === 'student')) role = body.role;
    }
    await db.prepare('UPDATE people SET display_name = ?, grade = ?, hidden = ?, role = ? WHERE sub = ? AND family_id = ?')
      .bind(displayName, grade, hidden, role, m[1], family).run();
    return json({ ok: true });
  }

  if ((m = route.match(/^students\/([^/]+)\/sessions$/)) && method === 'GET') {
    if (!await student(m[1])) return json({ error: 'not found' }, 404);
    const from = url.searchParams.get('from') || '0000';
    const to = url.searchParams.get('to') || '9999';
    const app = url.searchParams.get('app');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const { results } = await db.prepare(
      `SELECT s.id, s.app, s.unit_id, s.exercise_id, s.started_at, s.ended_at, s.local_date, ${statusSql},
              s.item_count, s.answered_count, s.correct_first_try, s.correct_eventually,
              s.score, s.max_score, s.duration_ms, s.params, s.app_version,
              u.title AS unit_title, u.definition AS unit_definition, e.title AS exercise_title
       FROM sessions s
       LEFT JOIN activities u ON u.app = s.app AND u.id = s.unit_id
       LEFT JOIN activities e ON e.app = s.app AND e.id = 'exercise:' || s.exercise_id
       WHERE s.student = ? AND s.deleted = 0 AND s.local_date >= ? AND s.local_date <= ?
         AND (? IS NULL OR s.app = ?)
       ORDER BY s.started_at DESC LIMIT ?`)
      .bind(quietBefore, m[1], from, to, app, app, limit).all();
    return json({ sessions: results.map(parseJsonColumns(['params', 'unit_definition'])) });
  }

  if ((m = route.match(/^students\/([^/]+)\/activity$/)) && method === 'GET') {
    if (!await student(m[1])) return json({ error: 'not found' }, 404);
    const days = Math.min(Number(url.searchParams.get('days')) || 90, 400);
    const since = new Date(Date.parse(now) - days * 86400000).toISOString().slice(0, 10);
    const { results } = await db.prepare(
      `SELECT local_date, COUNT(*) AS sessions, COALESCE(SUM(duration_ms), 0) AS duration_ms,
              COALESCE(SUM(answered_count), 0) AS answered, COALESCE(SUM(correct_first_try), 0) AS correct
       FROM sessions WHERE student = ? AND deleted = 0 AND local_date >= ?
       GROUP BY local_date ORDER BY local_date`)
      .bind(m[1], since).all();
    return json({ days: results, since });
  }

  if ((m = route.match(/^students\/([^/]+)\/units$/)) && method === 'GET') {
    if (!await student(m[1])) return json({ error: 'not found' }, 404);
    const { results } = await db.prepare(
      `SELECT s.app, s.unit_id, u.title, u.definition,
              COUNT(*) AS sessions, MAX(s.started_at) AS last_at, MIN(s.started_at) AS first_at
       FROM sessions s LEFT JOIN activities u ON u.app = s.app AND u.id = s.unit_id
       WHERE s.student = ? AND s.deleted = 0 AND s.unit_id <> ''
       GROUP BY s.app, s.unit_id ORDER BY last_at DESC`)
      .bind(m[1]).all();
    return json({ units: results.map(parseJsonColumns(['definition'])) });
  }

  if ((m = route.match(/^students\/([^/]+)\/units\/([^/]+)\/(.+)$/)) && method === 'GET') {
    const [, sub, app, unitId] = m;
    if (!await student(sub)) return json({ error: 'not found' }, 404);
    const unit = await db.prepare('SELECT title, definition FROM activities WHERE app = ? AND id = ?')
      .bind(app, unitId).first();
    const mastery = await masteryOf(db, sub, app, unitId);
    return json({
      unit: unit ? { title: unit.title, definition: JSON.parse(unit.definition) } : null,
      items: mastery,
    });
  }

  if ((m = route.match(/^sessions\/([^/]+)$/)) && method === 'GET') {
    const s = await db.prepare(
      `SELECT s.*, ${statusSql}, u.title AS unit_title, u.definition AS unit_definition, e.title AS exercise_title,
              p.family_id
       FROM sessions s JOIN people p ON p.sub = s.student
       LEFT JOIN activities u ON u.app = s.app AND u.id = s.unit_id
       LEFT JOIN activities e ON e.app = s.app AND e.id = 'exercise:' || s.exercise_id
       WHERE s.id = ?`).bind(quietBefore, m[1]).first();
    if (!s || s.family_id !== family || s.deleted) return json({ error: 'not found' }, 404);
    const { results: attempts } = await db.prepare(
      `SELECT a.seq, a.item_id, a.presented_at, a.resolved_at, a.tries, a.first_try_correct, a.success,
              a.final_result, a.response, a.score, a.max_score, a.latency_ms, a.feedback, a.tries_json,
              i.title AS item_title, i.definition AS item_definition
       FROM attempts a LEFT JOIN activities i ON i.app = a.app AND i.id = a.unit_id || '/' || a.item_id
       WHERE a.session_id = ? ORDER BY a.seq`).bind(m[1]).all();
    // what she saw for each question lives in the presented event
    const { results: presented } = await db.prepare(
      `SELECT payload FROM events WHERE session_id = ? AND type = 'item.presented'`).bind(m[1]).all();
    const prompts = new Map(presented.map(r => { const p = JSON.parse(r.payload); return [p.seq, p.prompt]; }));
    delete s.family_id;
    return json({
      session: parseJsonColumns(['params', 'device', 'unit_definition'])(s),
      attempts: attempts.map(parseJsonColumns(['tries_json', 'item_definition'])).map(a => ({ ...a, prompt: prompts.get(a.seq) ?? null })),
    });
  }

  if ((m = route.match(/^sessions\/([^/]+)$/)) && method === 'DELETE') {
    const r = await db.prepare(
      `UPDATE sessions SET deleted = 1 WHERE id = ? AND student IN (SELECT sub FROM people WHERE family_id = ?)`)
      .bind(m[1], family).run();
    return r.meta.changes ? json({ ok: true }) : json({ error: 'not found' }, 404);
  }

  if (route === 'admin/rebuild' && method === 'POST') {
    const replayed = await rebuild(db);
    return json({ ok: true, replayed });
  }

  return json({ error: 'not found' }, 404);
}

const weekAgo = now => new Date(Date.parse(now) - 7 * 86400000).toISOString();

const parseJsonColumns = cols => row => {
  const out = { ...row };
  for (const c of cols) {
    if (typeof out[c] === 'string') { try { out[c] = JSON.parse(out[c]); } catch {} }
  }
  return out;
};

/* Consecutive practice days ending today or yesterday. */
async function streakOf(db, sub, today) {
  const { results } = await db.prepare(
    `SELECT DISTINCT local_date FROM sessions WHERE student = ? AND deleted = 0
     ORDER BY local_date DESC LIMIT 400`).bind(sub).all();
  const days = new Set(results.map(r => r.local_date));
  let d = new Date(today + 'T00:00:00Z');
  if (!days.has(today)) d.setUTCDate(d.getUTCDate() - 1);   // today isn't over yet
  let streak = 0;
  while (days.has(d.toISOString().slice(0, 10))) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
  return streak;
}

/* The unit with the nearest exam still ahead that this child has practised,
   with how well she knows it - the "what should she do tonight" line. */
async function nextExamOf(db, sub, today) {
  const row = await db.prepare(
    `SELECT s.app, s.unit_id, u.title, json_extract(u.definition, '$.examDate') AS exam_date
     FROM sessions s JOIN activities u ON u.app = s.app AND u.id = s.unit_id
     WHERE s.student = ? AND s.deleted = 0 AND json_extract(u.definition, '$.examDate') >= ?
     GROUP BY s.app, s.unit_id ORDER BY exam_date LIMIT 1`).bind(sub, today).first();
  if (!row) return null;
  const items = await masteryOf(db, sub, row.app, row.unit_id);
  const seen = items.filter(i => i.seen);
  return {
    app: row.app, unit_id: row.unit_id, title: row.title, exam_date: row.exam_date,
    items: items.length,
    known: seen.filter(i => i.first_try_correct / i.seen >= 0.5).length,
    unseen: items.length - seen.length,
    weak: seen.filter(i => i.first_try_correct / i.seen < 0.5).length,
  };
}

/* Per item of one unit, across every round of it: how many times, how often
   right first time, and the last few results newest first. Shared with the
   student's own view (me-api.js). */
export async function masteryOf(db, sub, app, unitId) {
  const { results: items } = await db.prepare(
    `SELECT id, title, definition FROM activities WHERE app = ? AND kind = 'item' AND parent_id = ?`)
    .bind(app, unitId).all();
  const { results: attempts } = await db.prepare(
    `SELECT a.item_id, a.resolved_at, a.first_try_correct, a.success, a.final_result, a.response,
            s.exercise_id, e.title AS exercise_title
     FROM attempts a JOIN sessions s ON s.id = a.session_id
     LEFT JOIN activities e ON e.app = s.app AND e.id = 'exercise:' || s.exercise_id
     WHERE a.student = ? AND a.app = ? AND a.unit_id = ? AND s.deleted = 0 AND a.tries > 0
     ORDER BY a.resolved_at DESC`)
    .bind(sub, app, unitId).all();
  const byItem = new Map();
  for (const a of attempts) {
    const e = byItem.get(a.item_id) || { item_id: a.item_id, seen: 0, first_try_correct: 0, success: 0, recent: [], last_at: null };
    e.seen++;
    e.first_try_correct += a.first_try_correct || 0;
    e.success += a.success || 0;
    if (e.recent.length < 5) {
      e.recent.push({ result: a.final_result, first_try: !!a.first_try_correct, at: a.resolved_at,
        exercise: a.exercise_title || a.exercise_id, response: a.response });
    }
    e.last_at = e.last_at || a.resolved_at;
    byItem.set(a.item_id, e);
  }
  const defs = new Map(items.map(i => [i.id.slice(unitId.length + 1), i]));
  return [...new Set([...defs.keys(), ...byItem.keys()])].map(itemId => {
    const def = defs.get(itemId);
    const stat = byItem.get(itemId) || { item_id: itemId, seen: 0, first_try_correct: 0, success: 0, recent: [], last_at: null };
    return { ...stat, title: def ? def.title : itemId, definition: def ? JSON.parse(def.definition) : null };
  });
}
