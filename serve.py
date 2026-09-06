"""Static dev server for the learning apps.

Usage: python serve.py <directory> [port]

- caching disabled, so edits always show on reload
- /tts?tl=en&q=hello -> streams MP3 speech from Google Translate TTS
- /api/* -> fake local versions of the production auth/storage API
  (any login is accepted as a "dev user"; lists persist to dev-lists.json)
In production these routes are served by Cloudflare Pages Functions.
"""
import functools
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dev-lists.json')
DEV_USER = {'sub': 'dev', 'email': 'dev@local', 'name': 'משתמש פיתוח', 'picture': ''}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if not getattr(self, '_skip_nocache', False):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def send_json(self, obj, status=200, cookies=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self._skip_nocache = True
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        for c in cookies or []:
            self.send_header('Set-Cookie', c)
        self.end_headers()
        self.wfile.write(body)
        self._skip_nocache = False

    def has_session(self):
        return 'sid=dev' in (self.headers.get('Cookie') or '')

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(length) if length else b''

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/tts':
            return self.serve_tts()
        if path == '/api/me':
            if self.has_session():
                return self.send_json(DEV_USER)
            return self.send_json({'error': 'not logged in'}, 401)
        if path == '/api/lists':
            if not self.has_session():
                return self.send_json({'error': 'not logged in'}, 401)
            try:
                with open(DATA_FILE, encoding='utf-8') as f:
                    lists = json.load(f)
            except Exception:
                lists = []
            return self.send_json({'lists': lists})
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        self.read_body()
        if path == '/api/login':
            return self.send_json(DEV_USER, cookies=['sid=dev; Path=/'])
        if path == '/api/logout':
            return self.send_json({'ok': True}, cookies=['sid=; Max-Age=0; Path=/'])
        self.send_error(404)

    def do_PUT(self):
        path = urlparse(self.path).path
        body = self.read_body()
        if path == '/api/lists':
            if not self.has_session():
                return self.send_json({'error': 'not logged in'}, 401)
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                f.write(body.decode('utf-8'))
            return self.send_json({'ok': True})
        self.send_error(404)

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
