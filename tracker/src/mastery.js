// How well a student knows each item of a unit, and which items need work.
// The parent dashboard, the home card's exam line and the student's own view
// all read this - one computation, one rule, so they never disagree.

/* One rule for "this item needs work": she has met it, and either the last
   time was not right first time, or fewer than two of the last three were. */
export function isWeak(item) {
  if (!item.seen || !item.recent.length) return false;
  const recent = item.recent.slice(0, 3);          // newest first
  if (!recent[0].first_try) return true;
  return recent.filter(r => r.first_try).length < 2 && recent.length === 3;
}

/* Per item of one unit, across every round of it: how many times, how often
   right first time, the last few results newest first, and `weak`. Items the
   unit defines but she never met come back with seen = 0. */
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
    return { ...stat, weak: isWeak(stat), title: def ? def.title : itemId, definition: def ? JSON.parse(def.definition) : null };
  });
}
