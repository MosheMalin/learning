// Routes paths on malinvishne.com to the learning apps hosted on Cloudflare Pages.
// Add an entry (and a matching route pattern in wrangler.toml) per app.
const APPS = {
  '/learning/english/heb-eng/spelling/5-grade': 'https://english-words-726.pages.dev',
};

// The tracker Worker (events in, parent dashboard out) is reached through a
// service binding, with the original URL: it routes on the full path itself.
// (serve.py mirrors this list for local development.)
const TRACKER_PREFIXES = ['/learning/track/', '/learning/parent/'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/learning/parent') {
      return Response.redirect(url.origin + '/learning/parent/' + url.search, 301);
    }
    if (env.TRACKER && TRACKER_PREFIXES.some(p => url.pathname.startsWith(p))) {
      return env.TRACKER.fetch(request);
    }
    for (const [prefix, upstream] of Object.entries(APPS)) {
      if (url.pathname === prefix) {
        // enforce trailing slash so the app's relative URLs resolve correctly
        return Response.redirect(url.origin + prefix + '/' + url.search, 301);
      }
      if (url.pathname.startsWith(prefix + '/')) {
        const rest = url.pathname.slice(prefix.length + 1);
        return fetch(upstream + '/' + rest + url.search, request);
      }
    }
    // anything else: a minimal home page listing the family's apps
    const home = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>מלין וישנה</title></head>
<body style="font-family:sans-serif;text-align:center;padding:3em;background:#faf5ff">
<h1>👨‍👩‍👧‍👦 הלמידה של משפחת מלין וישנה</h1>
<ul style="list-style:none;padding:0;font-size:1.2em">
<li><a href="/learning/english/heb-eng/spelling/5-grade/">✨ המילים שלי - תרגול אנגלית ✨</a></li>
</ul>
</body></html>`;
    return new Response(home, {
      status: url.pathname === '/' ? 200 : 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
