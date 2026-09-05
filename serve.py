"""Static dev server with caching disabled, plus a /tts proxy for word audio.

Usage: python serve.py <directory> [port]

/tts?tl=en&q=hello  ->  streams MP3 speech from Google Translate TTS.
(In production the same route is served by a Cloudflare Pages Function.)
"""
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if not getattr(self, '_skip_nocache', False):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if urlparse(self.path).path == '/tts':
            return self.serve_tts()
        super().do_GET()

    def serve_tts(self):
        qs = parse_qs(urlparse(self.path).query)
        text = qs.get('q', [''])[0]
        lang = qs.get('tl', ['en'])[0]
        url = ('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob'
               f'&tl={quote(lang)}&q={quote(text)}')
        try:
            req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            data = urlopen(req, timeout=10).read()
        except Exception as e:
            self.send_error(502, f'TTS fetch failed: {e}')
            return
        self._skip_nocache = True
        self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()
        self.wfile.write(data)
        self._skip_nocache = False


directory = sys.argv[1] if len(sys.argv) > 1 else '.'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8123
handler = functools.partial(Handler, directory=directory)
print(f'Serving {directory} at http://localhost:{port}')
ThreadingHTTPServer(('', port), handler).serve_forever()
