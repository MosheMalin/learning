# המילים שלי — English Spelling Practice (הכתבה)

A web app for practicing weekly English word lists: spelling and translation, for a Hebrew-speaking kid.

## Features

- **Word lists**: add a weekly list of English↔Hebrew word pairs, with a list name and exam date. Lists with an exam in the next 7 days show a countdown badge.
- **Three practice modes**:
  - עברית → אנגלית — see the Hebrew word, type the English spelling
  - אנגלית → עברית — see the English word, type the Hebrew translation
  - הכתבה בשמיעה — hear the English word (browser text-to-speech) and type its spelling
- **Forgiving checking**: English is case-insensitive; Hebrew ignores final-letter forms (ם/מ) and nikud. A stored answer can list alternatives separated by `/` or `,` (e.g. `חבר / חברה`) and any one of them is accepted.
- **After each round**: stars, confetti, a review table of mistakes, and a "practice only the mistakes" button.
- **Backup / restore**: data lives in the browser's localStorage (per device, per browser). The 💾 button downloads a JSON backup; 📂 restores/merges it — useful for moving between devices.

## Tech

Plain HTML/CSS/JS, no build step, no dependencies, no backend. Voice uses the browser's built-in Web Speech API (`speechSynthesis`) — free, works offline; Edge and Chrome on Windows have good English voices.

## Run locally

Any static server, e.g.:

```
python -m http.server 8123 --directory english-words
```

then open http://localhost:8123

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
