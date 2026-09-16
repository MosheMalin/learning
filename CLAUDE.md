# CLAUDE.md — learning

Family learning apps for the owner's children, hosted under
`malinvishne.com/learning/` on Cloudflare. Hebrew-speaking kids on phones and
laptops; the owner is a senior engineer who wants the apps to be correct, kind
to a child, and cheap to run. Design documents live in `docs/`; read the one
that covers the area before changing it.

## What is here

```
english-words/    daughter's weekly spelling practice (הכתבה) — static HTML/CSS/JS,
                  no build step; functions/api/[[path]].js = Pages Functions
                  (Google sign-in, per-account lists in KV, Claude-backed
                  sentence exercises); functions/tts.js = voice proxy
router-worker/    Worker on the malinvishne.com apex: path prefix → Pages app;
                  APPS map in src/index.js; serves the family home page at /
tracker/          (planned — docs/parental-tracking-design.md) Worker + D1:
                  every app reports what each student did; parent dashboard
shared/           (planned) code both Pages Functions and Workers bundle
tests/            Playwright end-to-end tests driving the real page; /api/*
                  and Google are stubbed in tests/app-fixture.js
serve.py          local static server with fake /api/*, /tts and canned
                  sentence routes — no key, no account needed
materials/ questions/   Tanach bagrut research for the son's future app
```

Run locally: `preview_start` with launch.json name `english-words`
(never Bash for servers). Tests: `npm test` (Playwright, chromium). Deploy:
`deploy-english-words.ps1` for the app, `npx wrangler deploy` inside
`router-worker/` for the router — **deploy only when the owner asks**, and
bump the `?v=` query on `style.css`/`app.js` in `index.html` with every app
change or phones keep the old file.

## Rules

1. **The child is the user.** Every message she sees is warm, simple Hebrew;
   a mistake is never punished twice; "almost" beats "wrong" when one letter
   is off; a failed network call never blocks her, never scores against her,
   and says so plainly. Hebrew RTL everywhere, English strings marked `.en`.
2. **No build step in the apps.** Plain files served as they are. Shared
   code arrives as a served script or a bundled workspace package, never a
   bundler in an app folder.
3. **Secrets never reach the client or the repo.** `ANTHROPIC_API_KEY` is a
   Pages secret; model names and the Google client id are plain vars
   (`wrangler.toml [vars]`, mirrored in `app.js` — keep them in sync).
4. **Identity is the server's.** Who a request belongs to comes from the
   `sid` cookie looked up in `LEARNING_KV`, never from a field the client
   sends. The cookie is `Path=/` on the family domain, so every app and
   Worker under it shares one sign-in; the `pages.dev` origins do not.
5. **Claude calls are bounded.** Every route that calls Claude checks the
   per-user daily budget first and caps its input size; sentence banks are
   generated once and frozen, practice never calls out. A new Claude route
   needs the same three things.
6. **One copy of every rule.** Answer normalisation (`normEn`/`normHe`),
   the word key (`normWord`), scoring ("a word scores once, on the first
   try"), and the tracker's fold live in exactly one place each.
7. **Tests pin decisions and are attacked.** A new behaviour gets a named
   Playwright (or unit) test; reverse the rule, watch that test fail,
   restore byte-exact. Sign-in and `/api/*` stay stubbed — tests need no
   account and no network. Keep the suite fast (no sleeps; wait on state).
8. **Verify in a real browser.** The recorded bugs were DOM/CSS bugs
   (hidden buttons still clickable, bidi-mirrored glyphs) that unit tests
   sail past. Use the preview pane; check RTL and a phone viewport.
9. **Migrations are new files, never edits.** When D1 arrives, a change to a
   persisted shape is a new numbered migration; the event log is the truth
   and derived tables are rebuilt from it, never patched by hand.
10. **Commit and push only per the owner's ask.** Deploy the same way. The
    owner tests on the real site with the real child; a round of feedback
    from that is worth more than a guess.

## The code cycle

Every non-trivial item goes plan → implement → review → land: `/cycle` runs
it (`.claude/skills/cycle/SKILL.md`). Reviewers are project agents under
`.claude/agents/`, spawned in the background after a commit; findings are
folded into a follow-up commit:

| agent | when |
|---|---|
| `review-quality` | any substantive change (attacks the new tests, hunts second copies of a rule) |
| `review-data-integrity` | anything that stores or derives data: KV writes, the tracker fold, migrations, scoring |
| `review-security` | new routes, inputs, cookies, Claude calls, proxies, secrets |
| `review-ux` | anything the child or the parent sees — verifies in a real browser |

## Traps already paid for

- `hidden` elements that are still clickable ran a score past the number of
  words; the test `visibility.spec.js` walks every hidden element.
- Bracket ornaments get bidi-mirrored in RTL; use arrow glyphs.
- Browser `speechSynthesis` is unusable on the family's machines; voice is
  Google Translate TTS proxied through the app's own origin (`/tts`).
- A Claude request that answers in more than ~100 s is dropped by Cloudflare
  with nothing; keep one request small (`WORDS_PER_CALL`), stream it.
- Wrangler rejects a `compatibility_date` ahead of UTC today; this machine's
  clock runs ahead.
- Scratch space is the session scratchpad or `D:\tmp`, never bare `/tmp`
  (Git Bash and the file tools map it to different directories).
