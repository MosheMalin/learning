// Cloudflare Pages Function: /tts?tl=en&q=hello -> MP3 speech audio.
// Mirrors the /tts route of the local dev server (serve.py).
export async function onRequest({ request }) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const tl = url.searchParams.get('tl') || 'en';
  if (!q || q.length > 200) {
    return new Response('bad request', { status: 400 });
  }
  const upstream =
    'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
    '&tl=' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(q);
  const resp = await fetch(upstream, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!resp.ok) {
    return new Response('tts unavailable', { status: 502 });
  }
  return new Response(resp.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=604800',
    },
  });
}
