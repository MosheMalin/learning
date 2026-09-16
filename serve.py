"""Static dev server for the learning apps.

Usage: python serve.py <directory> [port]

- caching disabled, so edits always show on reload
- /tts?tl=en&q=hello -> streams MP3 speech from Google Translate TTS
- /api/* -> fake local versions of the production auth/storage API
  (any login is accepted as a "dev user"; lists persist to dev-lists.json)
- /api/sentences, /api/sentence-check -> canned stand-ins for the Claude-backed
  routes, so the sentence exercises can be worked on without an API key. They are
  ten fixed frames reused for every word and tagged "[demo]": generic on purpose,
  no clue to the answer, and nothing to do with what the real prompt produces.
- /learning/track/* and /learning/parent/* -> proxied to the tracker Worker when
  `npx wrangler dev --env dev` is running on :8787 (launch.json "tracker"), so a
  round played here lands in the local dashboard. Without it, the SDK is served
  from tracker/public and event batches are appended to dev-events.jsonl.
In production these routes are served by Cloudflare Pages Functions and the
tracker Worker.
"""
import functools
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, 'dev-lists.json')
EVENTS_FILE = os.path.join(HERE, 'dev-events.jsonl')
SDK_FILE = os.path.join(HERE, 'tracker', 'public', 'learning', 'track', 'v1', 'tracker.js')
TRACKER_DEV = 'http://localhost:8787'
TRACKER_PREFIXES = ('/learning/track/', '/learning/parent')
DEV_USER = {'sub': 'dev', 'email': 'dev@local', 'name': 'משתמש פיתוח', 'picture': ''}

# in-memory stand-in for the KV sentence bank: {listId: {word: {...}}}
DEV_BANK = {}
DEV_FRAMES = [
    'My ___ is here today.',
    'I can see a ___ outside.',
    'She likes the ___ very much.',
    'We found a ___ in the garden.',
    'The ___ is on the table.',
    'My friend has a ___ too.',
    'I want a ___ please.',
    'This ___ is very nice.',
    'He looked at the ___ and smiled.',
    'Yesterday I saw a ___ there.',
]


def dev_sentences(word):
    # Labelled loudly: these are fixed frames, not Claude's work. They are
    # deliberately generic - do not judge the real exercise by them.
    return [{'text': f'[demo {i + 1}] {f}', 'accept': [word['en']]}
            for i, f in enumerate(DEV_FRAMES)]


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

    def is_tracker(self, path):
        return path.startswith(TRACKER_PREFIXES)

    def tracker(self, body=b''):
        """Hand the request to the local tracker Worker; fall back to a stub."""
        path = urlparse(self.path).path
        try:
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() in ('cookie', 'content-type', 'accept')}
            req = Request(TRACKER_DEV + self.path, data=body or None, headers=headers,
                          method=self.command)
            with urlopen(req, timeout=30) as r:
                data = r.read()
                self._skip_nocache = True
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() in ('content-type', 'set-cookie', 'cache-control'):
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                self._skip_nocache = False
                return
        except HTTPError as e:
            data = e.read()
            self._skip_nocache = True
            self.send_response(e.code)
            self.send_header('Content-Type', e.headers.get('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self._skip_nocache = False
            return
        except (URLError, OSError):
            pass  # no local tracker running: the stub below
        if path == '/learning/track/v1/tracker.js' and self.command == 'GET':
            with open(SDK_FILE, 'rb') as f:
                data = f.read()
            self._skip_nocache = True
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            self._skip_nocache = False
            return
        if path == '/learning/track/v1/events' and self.command == 'POST':
            try:
                batch = json.loads(body or b'{}')
            except ValueError:
                return self.send_json({'error': 'bad json'}, 400)
            with open(EVENTS_FILE, 'a', encoding='utf-8') as f:
                f.write(json.dumps(batch, ensure_ascii=False) + '\n')
            return self.send_json({'accepted': len(batch.get('events', [])), 'duplicates': 0})
        self.send_json({'error': 'tracker is not running (launch.json "tracker")'}, 502)

    def do_PATCH(self):
        if self.is_tracker(urlparse(self.path).path):
            return self.tracker(self.read_body())
        self.send_error(404)

    def do_DELETE(self):
        if self.is_tracker(urlparse(self.path).path):
            return self.tracker(self.read_body())
        self.send_error(404)

    def do_GET(self):
        path = urlparse(self.path).path
        if self.is_tracker(path):
            return self.tracker()
        if path == '/tts':
            return self.serve_tts()
        if path == '/api/me':
            if self.has_session():
                return self.send_json(DEV_USER)
            return self.send_json({'error': 'not logged in'}, 401)
        if path == '/api/sentences':
            if not self.has_session():
                return self.send_json({'error': 'not logged in'}, 401)
            qs = parse_qs(urlparse(self.path).query)
            list_id = qs.get('listId', [''])[0]
            bank = DEV_BANK.get(list_id, {})
            missing = self.missing_words(list_id, bank)
            return self.send_json({'words': bank, 'remaining': len(missing),
                                   'ready': not missing})
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
        body = self.read_body()
        if self.is_tracker(path):
            return self.tracker(body)
        if path == '/api/login':
            return self.send_json(DEV_USER, cookies=['sid=dev; Path=/'])
        if path == '/api/logout':
            return self.send_json({'ok': True}, cookies=['sid=; Max-Age=0; Path=/'])
        if path == '/api/sentences':
            if not self.has_session():
                return self.send_json({'error': 'not logged in'}, 401)
            list_id = (json.loads(body or b'{}') or {}).get('listId', '')
            bank = DEV_BANK.setdefault(list_id, {})
            # four words per call, exactly like the real route
            for word in self.missing_words(list_id, bank)[:4]:
                bank[word['en'].strip().lower()] = {
                    'en': word['en'], 'he': word['he'], 'sentences': dev_sentences(word)}
            missing = self.missing_words(list_id, bank)
            return self.send_json({'words': bank, 'remaining': len(missing),
                                   'ready': not missing, 'stuck': False})
        if path == '/api/sentence-check':
            if not self.has_session():
                return self.send_json({'error': 'not logged in'}, 401)
            data = json.loads(body or b'{}') or {}
            return self.send_json(self.fake_check(data.get('word', ''),
                                                  data.get('sentence', '')))
        self.send_error(404)

    def missing_words(self, list_id, bank):
        try:
            with open(DATA_FILE, encoding='utf-8') as f:
                lists = json.load(f)
        except Exception:
            lists = []
        wanted = next((l for l in lists if l.get('id') == list_id), None)
        words = (wanted or {}).get('words', [])
        return [w for w in words if w.get('en') and w['en'].strip().lower() not in bank]

    @staticmethod
    def fake_check(word, sentence):
        """A crude stand-in for Claude, good enough to drive the UI locally."""
        text = sentence.strip()
        if word.lower() not in text.lower():
            return {'verdict': 'try_again',
                    'feedback': f'לא השתמשת במילה {word} 🙂',
                    'correction': f'I like my {word}.'}
        if not text[:1].isupper() or text[-1:] not in '.!?':
            return {'verdict': 'almost',
                    'feedback': 'כמעט! משפט מתחיל באות גדולה ונגמר בנקודה ✍️',
                    'correction': text[:1].upper() + text[1:].rstrip('.') + '.'}
        return {'verdict': 'great',
                'feedback': 'משפט יפה מאוד! כל הכבוד 🌟',
                'correction': text}

    def do_PUT(self):
        path = urlparse(self.path).path
        body = self.read_body()
        if self.is_tracker(path):
            return self.tracker(body)
        if path == '/api/sentences':
            if not self.has_session():
                return self.send_json({'error': 'not logged in'}, 401)
            qs = parse_qs(urlparse(self.path).query)
            list_id = qs.get('listId', [''])[0]
            bank = DEV_BANK.get(list_id, {})
            missing = self.missing_words(list_id, bank)
            return self.send_json({'words': bank, 'remaining': len(missing),
                                   'ready': not missing})
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
