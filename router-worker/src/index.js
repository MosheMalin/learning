// Routes paths on malinvishme.com to the learning apps hosted on Cloudflare Pages.
// Add an entry (and a matching route pattern in wrangler.toml) per app.
const APPS = {
  '/learning/english/heb-eng/spelling/5-grade': 'https://english-words-726.pages.dev',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
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
    return new Response('not found', { status: 404 });
  },
};
