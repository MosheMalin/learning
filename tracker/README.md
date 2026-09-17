# learning-tracker

The Worker behind the parent dashboard. Every app under the family domain
reports what a child did — a round started, a question shown, each answer
tried, the round finished or given up — and this Worker keeps it and shows it
to the parents. Design and reasoning: [`../docs/parental-tracking-design.md`](../docs/parental-tracking-design.md).

```
src/index.js       routes: ingest, auth for the dashboard, parent API, static assets
src/ingest.js      what a batch may look like (sizes, ids, event types)
src/fold.js        events -> sessions / attempts / activities; rebuild from the log
src/people.js      who is a parent, who is a student, the (one) family
src/mastery.js     per-item mastery of a unit and the one "needs work" rule
src/parent-api.js  what the dashboard reads
src/me-api.js      what a student may read about themself
migrations/        D1 schema, one numbered file per change - never edit an applied one
public/learning/track/v1/tracker.js   the client SDK every app loads
public/learning/parent/               the dashboard (plain HTML/JS, Hebrew, RTL)
```

Reached only through the router Worker's service binding, at
`malinvishne.com/learning/track/v1/*` and `malinvishne.com/learning/parent/`.
Identity is the shared `sid` cookie in `LEARNING_KV` (`../shared/auth`), so a
child signed in to an app is already signed in here; the student behind an
event is whoever that cookie names, never a field the client sent.

## Run locally

```
npx wrangler d1 migrations apply learning-tracker --local --env dev   # once, in this folder
npx wrangler dev --env dev --port 8787                                # or launch.json "tracker"
```

`--env dev` turns fixed cookie values into users (`DEV_SESSIONS` in
`wrangler.toml`): `sid=dev` and `sid=kid2` are students, `sid=parent` a parent.
`GET /learning/track/v1/dev-login?as=parent` sets the cookie. That environment
has no Google client id and production has no `DEV_SESSIONS`.

`../serve.py` (the english-words dev server) proxies `/learning/track/*` and
`/learning/parent/*` to `:8787` when it is running, so a round played at
`localhost:8123` appears in the dashboard at `localhost:8123/learning/parent/`.
Without the Worker running, `serve.py` serves the SDK itself and appends event
batches to `dev-events.jsonl`.

## Tests

- `npm run test:tracker` — the fold's promises (duplicates, reordering, split
  batches, repeated tries, a fold that dies mid-batch, concurrent folds of one
  attempt, abandoned vs completed, rebuild), the role rules and the parent API
  through the real `fetch` handler, all against the real SQL on Node's built-in
  SQLite through a D1-shaped adapter (`tests/tracker/`).
- `npm run test:e2e` — includes `tests/tracking.spec.js`: what one round in
  english-words reports, and that folding it gives the numbers on the child's
  summary screen.

## Deploy (first time)

```
npm install                                        # at the repo root: links shared/auth
cd tracker
npx wrangler d1 create learning-tracker            # paste the id into wrangler.toml [[d1_databases]]
npx wrangler d1 migrations apply learning-tracker --remote
npx wrangler deploy
cd ../router-worker && npx wrangler deploy         # picks up the service binding
```

Then deploy english-words (it now loads the SDK and reports). `PARENT_EMAILS`
in `wrangler.toml` seeds the parents; more parents are marked from the
dashboard (✏️ on a person → "זה הורה").

## Deploy (after changes)

```
cd tracker && npx wrangler deploy
```

A new migration file: `npx wrangler d1 migrations apply learning-tracker --remote`
before the deploy that needs it. Bump `?v=` on `app.js`/`style.css` in
`public/learning/parent/index.html` when they change.
