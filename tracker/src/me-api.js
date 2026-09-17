// What a student may read about themself: enough for an app to offer "the
// words you found hard". Every row is the signed-in student's own - a unit
// they never practised answers with nothing, not with its word list.

import { masteryOf } from './mastery.js';

const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };

export async function meApi({ env, url, person, json }) {
  const route = url.pathname.slice('/learning/track/v1/me/'.length).replace(/\/$/, '');
  let m;
  if ((m = route.match(/^units\/([^/]+)\/(.+)$/))) {
    const app = decode(m[1]);
    const unitId = decode(m[2]);
    const items = (await masteryOf(env.DB, person.sub, app, unitId)).filter(i => i.seen > 0);
    return json({
      items: items.map(i => ({
        item_id: i.item_id, seen: i.seen, first_try_correct: i.first_try_correct,
        last_at: i.last_at, weak: i.weak,
      })),
      weak: items.filter(i => i.weak).map(i => i.item_id),
    });
  }
  return json({ error: 'not found' }, 404);
}
