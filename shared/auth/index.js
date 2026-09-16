// One sign-in for every app and Worker under the family domain.
//
// A Google credential (from the GIS button) is verified against Google's
// tokeninfo endpoint, and a random session id is stored in LEARNING_KV under
// `session:<sid>` with the user inside. The cookie is `Path=/`, so every app
// and Worker behind malinvishne.com sees the same sign-in, and every one of
// them resolves it through the same KV namespace with this same code.
//
// Nothing here trusts the client for who it is: the user is whatever the KV
// row for the cookie says.

export const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

/* The signed-in user for this request, or null. */
export async function getSession(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid || !/^[0-9a-f-]{20,100}$/i.test(sid)) return null;
  const raw = await env.LEARNING_KV.get('session:' + sid);
  return raw ? JSON.parse(raw) : null;
}

/* Verify a Google ID token and return the user it names, or null. */
export async function verifyGoogleCredential(credential, clientId) {
  if (!credential || !clientId) return null;
  const verify = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!verify.ok) return null;
  const info = await verify.json();
  if (info.aud !== clientId || info.email_verified !== 'true' || !info.sub) return null;
  return {
    sub: info.sub,
    email: info.email,
    name: info.name || info.email,
    picture: info.picture || '',
  };
}

/* Start a session for a verified user; returns the Set-Cookie value. */
export async function createSession(env, user) {
  const sid = crypto.randomUUID() + crypto.randomUUID();
  await env.LEARNING_KV.put('session:' + sid, JSON.stringify(user), { expirationTtl: SESSION_TTL });
  return `sid=${sid}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/* Forget the session named by the cookie; returns the clearing Set-Cookie value. */
export async function destroySession(request, env) {
  const sid = getCookie(request, 'sid');
  if (sid) await env.LEARNING_KV.delete('session:' + sid);
  return 'sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
}
