# Parental tracking across the learning apps — design

*Status: agreed 2026-09-16 (decisions in section 10); phases 1 and 2 implemented the same day in `tracker/`, `shared/auth/` and english-words. Where the code refined the design, this document was amended to match.*

## 1. Goal

Every learning app under `malinvishne.com/learning/` reports what each student did —
which exercise, which question, what they answered, whether it was right, how it
was scored, and when — to one shared store. A parent dashboard reads that store
and shows all students, all apps, down to a single question and a single try.

Non-goals for the first version: grading rubrics shared between apps, an LMS,
notifications. The model must leave room for them; the code need not have them.

## 2. Prior art, and what we take from it

The problem is a solved one in e-learning; the vocabulary is worth adopting even
though the products are not.

| Standard | What it is | Verdict |
| --- | --- | --- |
| **xAPI** (Experience API, "Tin Can"), ADL | A learning event is a *statement*: **actor – verb – object – result – context – timestamp**. Statements are appended to a **Learning Record Store (LRS)**. `result` carries `score {scaled, raw, min, max}`, `success`, `completion`, `response`, `duration`. `object` is an *activity* with a type; question-type activities (`cmi.interaction`) declare an `interactionType` (choice, fill-in, long-fill-in, matching, true-false, numeric, …) and `correctResponsesPattern`. `context.registration` groups the statements of one attempt. | **Adopt the shape and the vocabulary.** It is exactly the "actor / verb / object / result / date" list in the requirement, worked out by people who spent years on the edge cases (retries, partial credit, abandoned attempts, offline clients). |
| **Caliper Analytics** (1EdTech / IMS) | Typed events (`AssessmentEvent`, `AssessmentItemEvent`, `GradeEvent`) with `actor / action / object` and JSON-LD entities. | Same ideas, more ceremony (JSON-LD, controlled vocabularies). Not worth it for a family. |
| **SCORM `cmi` data model** | `cmi.interactions.n.{id,type,learner_response,result,latency}`, `cmi.score.scaled`, `cmi.completion_status`. | Older, packaging-oriented; its interaction fields are what xAPI's `cmi.interaction` inherited. Nothing extra to take. |
| Hosted / open-source LRS (Yet Analytics SQL LRS, Veracity, Learning Locker) | Ready stores that accept xAPI statements and offer dashboards. | Not adopted: another service to run or pay for, generic dashboards that would not show "which words to drill before Thursday's test", and xAPI's IRIs everywhere. Our event is a strict subset of an xAPI statement, so exporting to one later is a mapping, not a migration. |

So: **xAPI's model, our own small store**, on the Cloudflare stack the apps already
use.

## 3. The model

### 3.1 Vocabulary (one set of words for every app)

| Term | Meaning | english-words | Tanach (future) |
| --- | --- | --- | --- |
| **Student** | The person learning. One row per child. | the daughter | the son |
| **App** | One deployed learning app, one `subject`. | `english-words` (subject `english`) | `tanach-2551` (subject `tanach`) |
| **Unit** | The material being practised; the thing that has a date attached. | a word list (has an exam date) | a chapter, or one questionnaire |
| **Exercise** | A way of practising a unit. | a mode: `he2en`, `en2he`, `listen`, `fill`, `write` | `mcq`, `open`, `verse-locate` |
| **Item** | One question. Belongs to a unit. | one word (in `fill`: one sentence with a gap) | one exam question, or one part (7א, 7ב) |
| **Session** | One run through an exercise, start to finish. xAPI calls this a *registration*, SCORM an *attempt*. | one practice round | one questionnaire sitting |
| **Attempt** | One item inside one session, with all its tries. | the word "dog" in this round | question 7 in this sitting |
| **Try** | One submitted answer. An attempt has one or more. | each press of בדיקה | each submit |

Units, exercises and items are all **activities** (xAPI's word) and form a tree:
`app → unit → item`, with the exercise as a label on the session. An activity
carries a **definition snapshot** (the word pair, the sentence, the question text
and its correct answer, the choices shown). Snapshots make the tracker
self-contained: a list the child deletes next week still reads correctly in the
dashboard.

### 3.2 Result model (per try, per attempt, per session)

Per **try**:

- `response` — what was typed or chosen, verbatim.
- `result` — `correct | almost | wrong | unjudged`. `almost` is the app's
  near-miss category (one-letter slip, or Claude's "almost" verdict). `unjudged`
  is for when a judge (Claude) could not be reached.
- `judgedBy` — `rule | llm | self | parent`. Tells the reader how much to trust it.
- `score`, `maxScore` — numbers, so partial credit and weighted questions work
  (Tanach: 8 points here, 18 there). For english-words: 1 / 1.
- `feedback` — the text shown to the child (Claude's Hebrew note, the correction).
- `latencyMs` — from the item being shown (or the previous try) to this submit.

Per **attempt**, derived from its tries:

- `tries` — count.
- `firstTryCorrect` — the number the app itself calls "correct" today. It is
  derived from the app's own `score` (the point was given ⇔ first-try correct),
  not from the first try's `result`: the app spends no first try on an
  unjudged answer or on a sentence that was right but unfinished, and the
  tracker must not either. Without scores, the first *judged* try decides.
- `success` — correct on any try (SCORM/xAPI `success`).
- `finalResult` — result of the last try (so "gave up after two wrongs" is visible).
- `score / maxScore` — as the app reports it; english-words gives the point only
  on the first try, which matches what the child sees.

Per **session**:

- `itemCount`, `answeredCount`, `correctFirstTry`, `correctEventually`.
- `score / maxScore` and `scaled = score / maxScore` (xAPI's `scaled`).
- `startedAt`, `endedAt`, `durationMs`, `status = in_progress | completed | abandoned`.
- `params` — how the round was set up: `retryOf` (the session it re-drills),
  `mistakesOnly`, item count, voice, …
- `localDate` — the calendar day on the child's device. The dashboard groups by
  it, so "Tuesday" means Tuesday in Israel without timezone arithmetic in SQL.

Everything is timestamped in UTC ISO 8601 on the client; the server also stamps
`receivedAt`.

### 3.3 People, families, roles

Identity today is a Google account (`sub`). Tracking needs a **student** that is
not the same thing as an account:

- a parent's account is not a student;
- a younger child may not have a Google account and could later get a
  parent-created profile with a PIN;
- a family has several students and one or two parents.

```
families   id, name
people     sub (Google) PK, email, name, picture, family_id, role ∈ {parent, student},
           display_name, grade, created_at, last_seen_at, hidden
```

Rules:

- `PARENT_EMAILS` (a Worker variable) bootstraps the parent accounts. A parent's
  first sign-in creates the family and their `parent` row. From the dashboard a
  parent can later add another parent by email, and match an existing student
  row to that person, so the variable is only the seed.
- Any other account that signs in and sends events becomes a `student` in the
  (single) family automatically. The parent can rename them, set a grade, or hide
  them from the dashboard. When a second family ever appears, the `family_id`
  column is already there; only the "join the single family" rule changes.
- A parent reads everything in their family. A student reads only their own rows
  (this is how the apps will later show a child their own progress).
- The tracker never trusts a `student` field from the client. The student is
  whoever the session cookie says; events are attributed server-side.

## 4. Reporting: events in, tables out

### 4.1 Event-sourced

Apps emit **immutable events**. The server keeps every event as received and
**folds** them into `sessions` and `attempts` rows on arrival. The event log is
the source of truth; the tables are a cache that can be rebuilt from it by one
admin endpoint. This is what makes the rest robust:

- **Idempotent.** Every event has a client-generated UUID. A batch that is sent
  twice (flaky connection, `sendBeacon` plus a retry) inserts nothing new.
- **Order-tolerant.** An `item.answered` that arrives before its `item.presented`
  still folds; every fold is an upsert.
- **Offline-tolerant.** The client queues events in `localStorage` and drains the
  queue when it can. A round played on the bus arrives when the phone finds Wi-Fi.
- **Rebuildable.** A bug in a fold, or a new derived column, is fixed by replaying
  the log. Nothing is lost by getting the tables wrong.

### 4.2 The wire format

One `POST` carries a batch. This is the "common interface":

```json
{
  "schema": 1,
  "app": "english-words",
  "appVersion": "2026-09-16",
  "device": { "tz": "Asia/Jerusalem", "lang": "he", "ua": "…", "screen": "390x844" },
  "events": [
    {
      "id": "6d1c…", "type": "session.started", "at": "2026-09-16T17:02:11.123Z",
      "session": "9b0e…", "localDate": "2026-09-16",
      "exercise": { "id": "he2en", "title": "עברית ← אנגלית", "interaction": "fill-in" },
      "unit": {
        "id": "l1726081234567", "kind": "wordlist", "title": "רשימה 12",
        "examDate": "2026-09-18",
        "items": [ { "id": "dog", "en": "dog", "he": "כלב" }, { "id": "house", "en": "house", "he": "בית" } ]
      },
      "params": { "itemCount": 12, "retryOf": null, "mistakesOnly": false }
    },
    {
      "id": "…", "type": "item.presented", "at": "…", "session": "9b0e…",
      "seq": 1, "item": "dog",
      "prompt": { "text": "כלב" }
    },
    {
      "id": "…", "type": "item.answered", "at": "…", "session": "9b0e…",
      "seq": 1, "item": "dog", "try": 1,
      "response": "dgo", "result": "almost", "judgedBy": "rule",
      "score": 0, "maxScore": 1, "latencyMs": 4210, "feedback": null
    },
    {
      "id": "…", "type": "item.answered", "at": "…", "session": "9b0e…",
      "seq": 1, "item": "dog", "try": 2,
      "response": "dog", "result": "correct", "judgedBy": "rule",
      "score": 0, "maxScore": 1, "latencyMs": 1900
    },
    {
      "id": "…", "type": "session.completed", "at": "…", "session": "9b0e…",
      "score": 10, "maxScore": 12, "correctFirstTry": 10, "correctEventually": 12, "itemCount": 12
    }
  ]
}
```

Event types, version 1:

| Type | When | Carries |
| --- | --- | --- |
| `session.started` | a round begins | exercise, unit **with its full item definitions**, params |
| `item.presented` | a question is shown (not on revisits) | seq, item id, `prompt` = what the child saw. For MCQ this includes the choices actually displayed — with rotating distractors that is the only way to know what the question was. |
| `item.answered` | every submitted try | seq, item, try number, response, result, judgedBy, score/maxScore, feedback, latency |
| `item.skipped` | the child moved on without a correct answer *and* the app wants to say so explicitly | seq, item. (Optional; the fold also infers "gave up" from the last try.) |
| `session.completed` | the summary screen | totals as the app computed them |
| `session.abandoned` | the app can tell the child left (any way off the practice screen, a new round started over it, or the page going away) | — . Also inferred server-side when read: no answer for 30 minutes and no completion ⇒ abandoned. A page that comes back from the cache and finishes still reports `session.completed`, which wins. |

The `interaction` field on an exercise uses xAPI's `cmi.interaction` types:
`fill-in` (all four spelling modes), `long-fill-in` (write a sentence, judged by
Claude), `choice` (Tanach MCQ), `matching`, `true-false`, `numeric`, `other`.

### 4.3 Store: Cloudflare D1 (SQLite)

KV cannot answer "every attempt at this word, by this child, last month". D1 can,
is on the same account, is free at family scale (5M row reads/day, 100k
writes/day), and is one file to back up. One database, `learning-tracker`, bound
to the tracker Worker.

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,          -- client UUID → idempotent
  student     TEXT NOT NULL,             -- people.sub, from the session cookie
  app         TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  at          TEXT NOT NULL,             -- client UTC ISO
  received_at TEXT NOT NULL,
  app_version TEXT,                      -- from the batch, so a rebuild has them
  device      TEXT,                      -- JSON, from the batch
  payload     TEXT NOT NULL              -- the event as received, JSON
);
CREATE INDEX events_session ON events(session_id, at);
CREATE INDEX events_student ON events(student, at);

CREATE TABLE activities (                 -- unit / exercise / item snapshots
  app        TEXT NOT NULL,
  id         TEXT NOT NULL,               -- unit: <unitId>; exercise: exercise:<id>; item: <unitId>/<itemId>
  kind       TEXT NOT NULL CHECK (kind IN ('unit','exercise','item')),
  parent_id  TEXT,                        -- item → its unit
  title      TEXT,
  definition TEXT NOT NULL,               -- JSON: {en,he} | {text,accept,en} | {question,answer,choices,points}
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, id)
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  student            TEXT NOT NULL,
  app                TEXT NOT NULL,
  unit_id            TEXT NOT NULL,
  exercise_id        TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  local_date         TEXT NOT NULL,       -- YYYY-MM-DD on the child's device
  status             TEXT NOT NULL,       -- in_progress | completed | abandoned
  item_count         INTEGER,
  answered_count     INTEGER DEFAULT 0,
  correct_first_try  INTEGER DEFAULT 0,
  correct_eventually INTEGER DEFAULT 0,
  score              REAL,
  max_score          REAL,
  duration_ms        INTEGER,
  params             TEXT,                -- JSON
  app_version        TEXT,
  device             TEXT,                -- JSON
  deleted            INTEGER DEFAULT 0    -- parent can hide a mistaken round
);
CREATE INDEX sessions_student ON sessions(student, started_at);
CREATE INDEX sessions_unit    ON sessions(app, unit_id, student);

CREATE TABLE attempts (
  session_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  student           TEXT NOT NULL,
  app               TEXT NOT NULL,
  unit_id           TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  presented_at      TEXT,
  resolved_at       TEXT,                 -- last try
  tries             INTEGER DEFAULT 0,
  first_try_correct INTEGER,              -- 0/1, NULL until a try exists
  success           INTEGER,              -- correct on any try
  final_result      TEXT,                 -- result of the last try
  response          TEXT,                 -- last response
  score             REAL,
  max_score         REAL,
  latency_ms        INTEGER,              -- first try
  feedback          TEXT,                 -- last feedback shown
  tries_json        TEXT NOT NULL,        -- [{try, at, response, result, judgedBy, score, latencyMs, feedback}]
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX attempts_item ON attempts(student, app, item_id, presented_at);

CREATE TABLE families (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
CREATE TABLE people (
  sub          TEXT PRIMARY KEY,
  email        TEXT UNIQUE,
  name         TEXT, picture TEXT,
  family_id    TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('parent','student')),
  display_name TEXT, grade TEXT,
  hidden       INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL, last_seen_at TEXT
);
```

`attempts.item_id` is the app's own item id (for english-words `normWord(en)`),
so the same word in two lists aggregates by word; the item's snapshot is found
through `<unit_id>/<item_id>` in `activities`. What the child saw for a question
is not copied into `attempts`: the session view reads it from the
`item.presented` event.

Folding rules (on ingest, one statement at a time). Every step is an upsert;
an event is folded first and recorded in `events` last, so a request that dies
halfway leaves the event unknown and the client's resend folds it again. Any
read-modify-write (appending a try, summarising an attempt) is one SQL
statement, so two requests folding the same attempt at once lose nothing:

1. `INSERT OR IGNORE` into `events`. If nothing was inserted, the event was seen
   before: skip its fold.
2. `session.started` → upsert `sessions` (status `in_progress`) and upsert the
   unit, exercise and every item into `activities`.
3. `item.presented` → upsert `attempts` with `presented_at`.
4. `item.answered` → append this try to `tries_json` unless its number is
   already there (one statement); recompute `tries`, `first_try_correct`,
   `success`, `final_result`, `response`, `score`, `latency_ms`, `feedback`
   from the stored JSON (one statement); recount the session's
   `answered_count` / `correct_*` from its attempts (one statement).
5. `session.completed` → set `ended_at`, `status`, `duration_ms`, and the totals
   the app reported (kept alongside the recount, so a disagreement is visible).
6. `session.abandoned` → `status = abandoned`, `ended_at`.

`POST /admin/rebuild` truncates the three derived tables and replays `events` in
`at` order, then re-marks the sessions a parent had hidden. Parent-only.

`activities` is keyed by `(app, id)` with no family scope: fine with one family,
to be scoped before a second one exists (phase 5).

## 5. Components

```
malinvishne.com (router-worker)
 ├─ /learning/english/…/            english-words   (Pages: static + functions/api)
 ├─ /learning/tanach/…/             tanach app      (later, same pattern)
 ├─ /learning/track/v1/*            tracker Worker  — ingest + per-student read API
 └─ /learning/parent/               tracker Worker  — parent dashboard (static assets) + /learning/parent/api/*

shared:  LEARNING_KV (sessions, already shared by name)   D1 learning-tracker   Google client id
```

### 5.1 `tracker/` — one Worker

- **Ingest** `POST /learning/track/v1/events` — cookie auth via the same `sid`
  session in `LEARNING_KV`; caps: 200 events per batch, 16 KB per event (64 KB
  for `session.started`, at most 400 items), 100 batches per student per minute
  (a KV counter, like the apps' daily Claude budget), numbers bounded, `device`
  trimmed to four short strings. Returns `{accepted, duplicates}`; a refused
  batch names the offending event's `index`, and the SDK drops only that one.
- **Auth for the dashboard** `POST auth/login`, `POST auth/logout`, `GET auth/me`,
  and `GET auth/config` (the public Google client id, so no page copies it).
- **Student read API** `GET /learning/track/v1/me/...` — a student's own summary,
  for apps that want to show "the words you got wrong this week" or feed a
  mistakes-first queue. Not needed for the dashboard; cheap to expose.
- **Parent API** under `/learning/parent/api/` (role `parent` required):
  - `GET students` — family members, last active, this-week counts.
  - `GET students/:sub/sessions?from&to&app` — the timeline.
  - `GET sessions/:id` — the round: every attempt with every try, joined to the
    item definitions.
  - `GET students/:sub/units/:app/:unitId` — mastery per item: times seen,
    first-try accuracy, last three results, trend. This is the "what to drill
    before Thursday" view.
  - `GET students/:sub/activity?days=90` — sessions per local day, for a heatmap.
  - `PATCH students/:sub` (display name, grade, hidden); `DELETE sessions/:id`
    (soft).
  - `POST admin/rebuild`.
- **Dashboard** — static Hebrew RTL page served from the Worker's assets
  (Workers Static Assets), same no-build style as the apps. One deploy for API
  and UI.
- Serves the client SDK at `/learning/track/v1/tracker.js`, so every app loads
  the same file and an SDK fix ships once.

Why one dedicated Worker rather than tracker routes inside each app's Pages
Functions: one D1 binding, one place for the fold logic, one dashboard, and
apps that are pure clients. The router already exists to put it under the family
domain, so the cookie (`Path=/`) is shared for free.

### 5.2 `shared/` — code both sides need

Google token verification and the session cookie are duplicated today between
english-words' Functions and (soon) the tracker. Move them into a workspace
package (`shared/auth`) that both bundle; wrangler bundles `node_modules`, so
no build step is added. The Hebrew date helpers in `app.js` (Hebrew calendar,
holidays) go the same way once the dashboard needs them.

### 5.3 The client SDK (`tracker.js`, ~150 lines, no dependencies)

```js
const track = Tracker.init({ app: 'english-words', appVersion: APP_VERSION });
track.setUser(sub);                                     // after sign-in; null on sign-out

const s = track.session({ exercise, unit, params });   // emits session.started, returns a handle
s.presented(seq, itemId, prompt);
s.answered(seq, itemId, { response, result, judgedBy, score, maxScore, feedback, submittedAt });
s.completed({ score, maxScore, correctFirstTry, correctEventually, itemCount });
s.abandoned();
```

Behaviour: events go to an in-memory queue mirrored in `localStorage`
(`tracker-outbox`, capped at ~2000 events); flushed every 2 s, or at 20 events,
and on `pagehide` / `visibilitychange` with `navigator.sendBeacon` (same origin,
so the cookie travels). Every queued event is stamped with the account that was
signed in when it happened, and only events stamped with the current account are
posted: the server attributes a batch to the cookie it arrives with, so a round
queued under one child must never travel with a sibling's cookie on a shared
laptop; it waits for its own account. `401` keeps the batch; `400` drops the
one event the server named; other `4xx` drops the batch; `5xx`/network retries
with backoff. Latency is measured to the moment she submitted (`submittedAt`),
not to when a judge answered. The script is loaded `async` and the app binds to
it lazily, so a slow tracker cannot delay the app. Nothing the SDK does can
break the app: every call is wrapped, failures are silent.

### 5.4 Local development and tests

`serve.py` already stubs `/api/*`. It proxies `/learning/track/*` and
`/learning/parent/*` to a local `wrangler dev --env dev` when one is running, and
otherwise stubs them: batches append to `dev-events.jsonl` and `tracker.js` is
served from `tracker/public/learning/track/v1/`. Playwright tests get a fixture that captures every batch the
page sends, so the tracking becomes a testable contract: *"a twelve-word round
with two mistakes emits one `session.started`, twelve `item.presented`, fourteen
`item.answered`, one `session.completed`, and the fold of those equals 10/12"*.
The fold itself is a pure function, unit-testable with the same fixtures against
a local D1 (`wrangler d1 execute --local`).

## 6. Instrumenting english-words

The `practice` object already holds everything; five call sites change:

| Where (`app.js`) | Emit |
| --- | --- |
| `startPractice` | `session.started` with the list as `unit` (id, name, examDate, words) and `mode` as `exercise`; `params.retryOf` when started from "practise the mistakes" |
| `showQuestion` (fresh questions only, not `goTo` revisits) | `item.presented` — prompt is the Hebrew word / English word / 🎧 / the gapped sentence |
| `checkAnswer`: the correct branch, the `minor` branch, the wrong branch | `item.answered` with `correct` / `almost` / `wrong`, `judgedBy: 'rule'` (or `'llm'` when `sentenceFits` decided), `score: firstTry ? 1 : 0` |
| `checkWrittenSentence`: local miss, unjudged, `almost`, `great`, `try_again` | `item.answered` with `judgedBy: 'llm'`, `feedback` = Claude's note, `response` = her sentence; the correction goes in `feedback` too |
| `showSummary` | `session.completed` with `correctCount / total` |
| `btn-back-home` / leaving mid-round | `session.abandoned` |

Item ids are `normEn(en)` (the same normalisation as the answer check); `fill`
items are the word too, with the sentence in `prompt`, so the mastery view
aggregates by word across all five modes. The point is awarded in one function
(`awardPoint`) that both the summary count and the reported `score` use; which
question an answer belongs to is fixed at the moment she submits, and "next" is
not offered while a judge is still reading.

## 7. The parent dashboard (`/learning/parent/`)

Hebrew, RTL, same visual family as the apps. Four screens:

1. **Home** — one card per student: last active, sessions and minutes this week,
   current streak, the unit with the nearest exam date and its mastery. Hidden
   students omitted; a toggle shows them.
2. **Student timeline** — sessions newest first, filter by app and date range:
   date (Hebrew and Gregorian), app, unit, exercise, score, duration, status.
   A heatmap of days above it.
3. **Session** — the round as the child saw it: item, prompt, every try
   (response, result, latency), feedback shown, final score. Written sentences and
   Claude's corrections read naturally here.
4. **Unit mastery** — for one list / chapter: per item, times seen, first-try
   rate, last three results as coloured dots, last seen; sorted weakest first.
   The exam countdown at the top. This is the screen that answers "what should
   she do tonight".

Cross-app by construction: every screen is built from `sessions` / `attempts` /
`activities`, never from an app's own storage.

## 8. Privacy, safety, limits

- Data is a child's schoolwork; the store is private to the family. No public
  routes, no analytics vendors.
- The student on every row comes from the server-side session, never the client.
- A parent sees only their family; a student only themselves.
- Parent deletion is soft; the event log keeps the truth. A hard delete of a
  student (data export + purge) is one admin endpoint, to write when needed.
- Cost: D1 and KV free tiers are far above family scale. The tracker adds no
  Claude calls.

## 9. Phases

1. **Pipe** — done 2026-09-16: `tracker/` Worker with D1 schema, migrations,
   ingest, fold, SDK; router service binding; `shared/auth`. english-words emits
   events. Playwright contract tests (`tests/tracking.spec.js`) and fold unit
   tests (`tests/tracker/`). Still to do: verify on the live site with a real round.
2. **Dashboard** — done 2026-09-16: parent API and the four screens (home,
   student timeline + heatmap, session, unit mastery). `PARENT_EMAILS`, student
   auto-enrolment, rename/grade/hide, marking another person as a parent,
   hiding a session.
3. **Feedback into the apps** — `me/` API; english-words offers "the words you
   missed this week" as a round.
4. **Tanach** — the second app uses the same SDK from day one: questionnaire =
   unit, question part = item, MCQ choices shown in `prompt`, open answers judged
   by Claude with partial `score / maxScore`.
5. **Later, if wanted** — weekly digest e-mail; a second family; PIN profiles for
   a child without a Google account; xAPI export.

## 10. Decisions (confirmed by the owner, 2026-09-16)

1. **Identity.** Each child signs in with their own Google account; student =
   account. PIN profiles stay in phase 5.
2. **Parents.** The owner is seeded by `PARENT_EMAILS`; more parents are added
   later from the dashboard and matched to the existing students.
3. **Dashboard** at `malinvishne.com/learning/parent/`.
4. **Score** is what the child sees (english-words: first try only); `success`
   records eventual correctness; the dashboard shows both.
