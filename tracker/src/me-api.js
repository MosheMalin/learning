// What a student may read about themself: enough for an app to offer "the
// words you found hard". Every row is the signed-in student's own.

import { masteryOf } from './parent-api.js';

/* One rule for "this word needs work", computed here so every app agrees:
   she has met it, and either the last time was not right first time, or
   fewer than two of the last three times were. */
export function isWeak(item) {
  if (!item.seen || !item.recent.length) return false;
  const recent = item.recent.slice(0, 3);          // newest first
  if (!recent[0].first_try) return true;
  return recent.filter(r => r.first_try).length < 2 && recent.length === 3;
}

export async function meApi({ env, url, person, json }) {
  const route = url.pathname.slice('/learning/track/v1/me/'.length).replace(/\/$/, '');
  let m;
  if ((m = route.match(/^units\/([^/]+)\/(.+)$/))) {
    const [, app, unitId] = m;
    const items = await masteryOf(env.DB, person.sub, app, unitId);
    return json({
      items: items.map(i => ({
        item_id: i.item_id, seen: i.seen, first_try_correct: i.first_try_correct,
        last_at: i.last_at, weak: isWeak(i),
      })),
      weak: items.filter(isWeak).map(i => i.item_id),
    });
  }
  return json({ error: 'not found' }, 404);
}
