// The tracker Worker. Behind the router on the family domain it answers:
//
//   POST /learning/track/v1/events          a batch of events from an app (signed-in student)
//   POST /learning/track/v1/auth/login      Google credential -> session cookie (for the dashboard)
//   POST /learning/track/v1/auth/logout
//   GET  /learning/track/v1/auth/me
//   GET  /learning/track/v1/tracker.js      the client SDK (a static asset)
//   GET  /learning/parent/                  the parent dashboard (static assets)
//   *    /learning/parent/api/*             the parent API (parents only)
//
// The student behind every event is whoever the session cookie names. The
// client never says who it is.

import {
  getSession, getCookie, verifyGoogleCredential, createSession, destroySession,
} from '@learning/auth';
import { validateBatch, MAX_BODY_BYTES } from './ingest.js';
import { ingestEvents } from './fold.js';
import { ensurePerson } from './people.js';
import { parentApi } from './parent-api.js';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

/* The signed-in user, or null. In `wrangler dev --env dev` a fixed table of
   cookie values stands in for Google; production has no such table. */
async function currentUser(request, env) {
  if (env.DEV_SESSIONS) {
    const sid = getCookie(request, 'sid');
    const table = JSON.parse(env.DEV_SESSIONS);
    return sid && table[sid] ? table[sid] : null;
  }
  return getSession(request, env);
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) return { error: 'too large' };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'too large' };
  try { return { body: JSON.parse(text) }; } catch { return { error: 'bad json' }; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const now = new Date().toISOString();

    if (path.startsWith('/learning/track/v1/')) {
      const route = path.slice('/learning/track/v1/'.length);

      if (route === 'auth/login' && method === 'POST') {
        const { body, error } = await readJson(request);
        if (error) return json({ error }, error === 'too large' ? 413 : 400);
        const user = await verifyGoogleCredential(body && body.credential, env.GOOGLE_CLIENT_ID);
        if (!user) return json({ error: 'invalid token' }, 401);
        const cookie = await createSession(env, user);
        const person = await ensurePerson(env.DB, env, user, now);
        return json({ ...user, role: person.role }, 200, { 'Set-Cookie': cookie });
      }
      if (route === 'auth/logout' && method === 'POST') {
        const cookie = await destroySession(request, env);
        return json({ ok: true }, 200, { 'Set-Cookie': cookie });
      }
      if (route === 'dev-login' && env.DEV_SESSIONS && method === 'GET') {
        const as = url.searchParams.get('as') || 'parent';
        return new Response(`signed in as ${as}`, {
          headers: { 'Set-Cookie': `sid=${as}; Path=/; SameSite=Lax`, 'Content-Type': 'text/plain' },
        });
      }

      const user = await currentUser(request, env);
      if (route === 'auth/me' && method === 'GET') {
        if (!user) return json({ error: 'not logged in' }, 401);
        const person = await ensurePerson(env.DB, env, user, now);
        return json({ ...user, role: person.role });
      }
      if (route === 'events' && method === 'POST') {
        if (!user) return json({ error: 'not logged in' }, 401);
        const { body, error } = await readJson(request);
        if (error) return json({ error }, error === 'too large' ? 413 : 400);
        const v = validateBatch(body);
        if (!v.ok) return json({ error: v.error }, 400);
        const person = await ensurePerson(env.DB, env, user, now);
        const ctx = {
          student: person.sub, app: v.app, appVersion: v.appVersion, device: v.device, receivedAt: now,
        };
        const result = await ingestEvents(env.DB, ctx, v.events);
        return json(result);
      }
      return json({ error: 'not found' }, 404);
    }

    if (path.startsWith('/learning/parent/api/')) {
      const user = await currentUser(request, env);
      if (!user) return json({ error: 'not logged in' }, 401);
      const person = await ensurePerson(env.DB, env, user, now);
      if (person.role !== 'parent') return json({ error: 'parents only' }, 403);
      return parentApi({ request, env, url, person, now, json, readJson });
    }

    // anything else under our prefixes is a static asset (dashboard, SDK)
    return env.ASSETS.fetch(request);
  },
};
