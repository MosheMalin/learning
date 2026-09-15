# המילים שלי — English Spelling Practice (הכתבה)

A web app for practicing weekly English word lists: spelling and translation, for a Hebrew-speaking kid.

## Features

- **Word lists**: add a weekly list of English↔Hebrew word pairs, with a list name and exam date. Lists with an exam in the next 7 days show a countdown badge.
- **Five practice modes**:
  - עברית → אנגלית — see the Hebrew word, type the English spelling
  - אנגלית → עברית — see the English word, type the Hebrew translation
  - הכתבה בשמיעה — hear the English word (browser text-to-speech) and type its spelling
  - להשלים משפט — a sentence with the word missing; she fills the gap
  - לכתוב משפט — she writes her own sentence using the word, and gets feedback on it
- **Forgiving checking**: English is case-insensitive; Hebrew ignores final-letter forms (ם/מ) and nikud. A stored answer can list alternatives separated by `/` or `,` (e.g. `חבר / חברה`) and any one of them is accepted.
- **After each round**: stars, confetti, a review table of mistakes, and a "practice only the mistakes" button.
- **Backup / restore**: data lives in the browser's localStorage (per device, per browser). The 💾 button downloads a JSON backup; 📂 restores/merges it — useful for moving between devices.

## The sentence exercises

The two sentence modes are the only part of the app that needs Claude, and they
use it in the two places a computer genuinely cannot manage alone.

**להשלים משפט** — ten sentences are written for every word in a list, once, the
first time the mode is opened (a progress card shows it happening). They are then
frozen in KV and cached in the browser, so practice itself never calls out: the
round plays the same offline, costs nothing to repeat, and a word keeps the
sentences it was given. Ten per word means she meets a different one each time
instead of memorising the sentence along with the word. Each sentence also stores
every other word from her list that would fit the gap, so a sensible answer isn't
marked wrong just because it wasn't the one intended. Marking is local and exact -
the same forgiving comparison the other modes use.

**לכתוב משפט** — the app checks locally that she used the word at all (a miss
there never costs a request), then asks Claude whether the sentence is real
English used with the word's real meaning, and gets back a short Hebrew note and
a corrected version. There is no deterministic way to judge that, and the check
is deliberately generous - a short correct sentence is a great sentence. If the
check can't be reached, the sentence is neither scored nor counted as a mistake.

### Setting it up

Both routes need an Anthropic API key, as a Cloudflare secret (never in the
client, never in the repo):

```
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name english-words
```

Without it the app keeps working exactly as before and the two sentence modes say
they aren't ready.

Which model does each job is a plain Pages variable, so it can be changed without
touching the code - `SENTENCES_MODEL` for writing the sentences, `CHECK_MODEL` for
marking what she wrote. Both default to `claude-opus-5`. Writing simple sentences
is the easier job of the two, so it is the better candidate for a cheaper model
(`claude-haiku-4-5`, `claude-sonnet-5`); marking a child's writing and answering
her in warm, correct Hebrew is the one worth keeping capable. They live in
`wrangler.toml` under `[vars]` next to `GOOGLE_CLIENT_ID` - edit the value there
and deploy. Only the API key is a secret; a model name isn't.

Note that a model restriction on the Console workspace is not a way to choose the
model - the app asks for one by name, so blocking it stops the feature rather
than making it cheaper. Change the variable, and let the workspace limits be the
backstop. Usage is capped per user per day (`DAILY_CALL_BUDGET`) so a
stuck client can't run up a bill. Generating a whole weekly list costs a few
cents; a marked sentence is well under one.

Locally, `serve.py` answers both routes with obviously-fake canned sentences, so
the exercises can be worked on without a key.

## Tech

Plain HTML/CSS/JS in the browser, no build step. Sign-in, storage and the two
sentence routes are Cloudflare Pages Functions backed by KV; the sentence routes
call Claude (`@anthropic-ai/sdk`), which is the project's only dependency. Voice uses the browser's built-in Web Speech API (`speechSynthesis`) — free, works offline; Edge and Chrome on Windows have good English voices.

## Run locally

Any static server, e.g.:

```
python -m http.server 8123 --directory english-words
```

then open http://localhost:8123

## Tests

End-to-end tests (Playwright) live in `../tests` and drive the real page in a
real browser - the scoring bugs worth catching here are DOM/CSS bugs that unit
tests of the pure functions would sail straight past.

```
npm install
npx playwright install chromium   # one-time, downloads the browser
npm test                          # or: npm run test:ui
```

They cover the practice scoring (a word scores at most once, the score can never
exceed the number of words in the round, retry-the-mistakes rounds), the
forgiving answer matching, the keyboard-language magic, and that everything the
app hides with the `hidden` attribute is genuinely hidden. Sign-in and `/api/*`
are stubbed, so the tests need no account and no network.

## Deploy to Cloudflare Pages

Deployed as the Cloudflare Pages project **english-words**, live at
https://english-words-726.pages.dev. The `functions/tts.js` Pages Function
serves the `/tts` voice proxy in production (mirroring `serve.py` locally).

To deploy after changes (wrangler login is cached on this machine):

```
powershell -File ..\deploy-english-words.ps1
```

or from this folder: `npx wrangler pages deploy . --project-name english-words --branch main`

When bumping app code, also bump the `?v=` query on style.css/app.js in index.html.

Note: data is stored in the browser, so practicing on the phone and on the computer are separate — use backup/restore to sync, or we can later add a small backend (Cloudflare KV/D1) for shared storage.
