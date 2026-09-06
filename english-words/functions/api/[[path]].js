// Multi-user API: Google sign-in sessions + per-user word lists in KV.
// Routes: POST /api/login, POST /api/logout, GET /api/me, GET|PUT /api/lists

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

async function getSession(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid) return null;
  const raw = await env.LEARNING_KV.get('session:' + sid);
  return raw ? JSON.parse(raw) : null;
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join('/');
  const method = request.method;

  if (path === 'login' && method === 'POST') {
    const { credential } = await request.json().catch(() => ({}));
    if (!credential) return json({ error: 'missing credential' }, 400);
    const verify = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!verify.ok) return json({ error: 'invalid token' }, 401);
    const info = await verify.json();
    if (!env.GOOGLE_CLIENT_ID || info.aud !== env.GOOGLE_CLIENT_ID || info.email_verified !== 'true') {
      return json({ error: 'invalid token' }, 401);
    }
    const user = {
      sub: info.sub,
      email: info.email,
      name: info.name || info.email,
      picture: info.picture || '',
    };
    const sid = crypto.randomUUID() + crypto.randomUUID();
    await env.LEARNING_KV.put('session:' + sid, JSON.stringify(user), { expirationTtl: SESSION_TTL });
    return json(user, 200, {
      'Set-Cookie': `sid=${sid}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  if (path === 'logout' && method === 'POST') {
    const sid = getCookie(request, 'sid');
    if (sid) await env.LEARNING_KV.delete('session:' + sid);
    return json({ ok: true }, 200, {
      'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    });
  }

  const user = await getSession(request, env);

  if (path === 'me' && method === 'GET') {
    return user ? json(user) : json({ error: 'not logged in' }, 401);
  }

  if (path === 'lists') {
    if (!user) return json({ error: 'not logged in' }, 401);
    const key = 'user:' + user.sub + ':lists';
    if (method === 'GET') {
      const raw = await env.LEARNING_KV.get(key);
      return json({ lists: raw ? JSON.parse(raw) : [] });
    }
    if (method === 'PUT') {
      const body = await request.text();
      if (body.length > 200000) return json({ error: 'too large' }, 413);
      let data;
      try { data = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }
      if (!Array.isArray(data)) return json({ error: 'expected an array' }, 400);
      await env.LEARNING_KV.put(key, body);
      return json({ ok: true });
    }
  }

  return json({ error: 'not found' }, 404);
}
