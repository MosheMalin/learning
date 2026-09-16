---
name: cycle
description: Run one learning-apps code cycle — plan, implement, review, land. The argument is the item to build (a feature, a fix, a phase from a design doc like "tracking phase 1") — or an epic ("implement the parent dashboard"), which Phase 0 decomposes and executes item by item.
---

# The learning code cycle

Run the item through the phases below. Do not skip a phase because the
change "looks small" — the recorded bugs here (a score running past the
number of words, praise for an unfinished sentence, a dropped Claude
request) all came from small-looking changes. Trivial mechanical edits (a
typo, a comment, a `?v=` bump) may skip straight to implement, but say so.

## Phase 0 — Size it

Decide what you were handed, and say which it is:

- **One item** — a fix, one feature, one phase step: go to Phase 1.
- **An epic** — several landable changes in one sentence (a design-doc
  phase with more than one moving part, a new app, "add the dashboard"):
  do NOT stretch one cycle over it.

For an epic, look for an EXISTING decomposition first — `docs/*.md` holds
the designs (e.g. `docs/parental-tracking-design.md`, section "Phases").
Re-read it against what has actually landed, adjust the item list, state
the adjustments, and go to Epic execution. If no design exists, write one
under `docs/` — audit first (what the change touches, including the
instances the owner did not list), then design, then settle open questions
with the owner ONCE, batched, and get the nod before implementing.

## Epic execution

Run each item through Phases 1–3 and LAND it on `main` before starting the
next — `main` stays green between items and the owner can stop, reorder or
redirect after any of them. Rules:

- work autonomously from item to item; after each landing, report one
  short progress note (item, what landed, anything surprising) and
  continue — don't wait for permission the plan already gave;
- PAUSE for the owner only when: an item surfaces a decision the design
  did not settle; a reviewer critical cannot be fixed within the item's
  scope; `npm test` is red for a cause outside the item; a deploy is
  needed to verify (deploying is the owner's call); or reality shows the
  design itself is wrong;
- the design doc is the progress tracker — mark items done as they land,
  and if a later item invalidates an earlier assumption, amend the doc in
  the same commit.

## Phase 1 — Plan (in the conversation, no file)

1. Restate the item in one sentence; if scope is genuinely ambiguous, ask
   the owner ONE batched set of questions now — never mid-implementation.
2. Collect the facts: the `CLAUDE.md` rules and traps it brushes against,
   the design-doc section, the actual code. Use `Explore` for broad
   searches, `Plan` for genuinely hard design; read narrow things yourself.
3. State: files to touch · which rule it brushes (identity, budget,
   scoring, no-build, secrets) · whether a D1 migration is needed · which
   tests will pin the new decisions · which reviewers apply (Phase 3) ·
   whether it changes anything a phone shows (then the browser walk is
   part of the plan).
4. **Worktree decision.** The hazard is a second *session* sharing this
   checkout, not a second item. `git worktree list && git status
   --porcelain`: only the primary tree and clean → branch in place
   (`git switch -c <b>` … `git switch main` … `merge --no-ff`). Anything
   else, or a reviewer fleet → `git worktree add D:/tmp/<name> <branch>`,
   land with `merge --no-ff`, remove it. Always name the drive.

## Phase 2 — Implement

- One copy of every rule; shared client mechanisms are served once (the
  SDK) or live in `shared/`.
- Every new decision gets a named test, and every named test gets
  mutation-checked: reverse the rule, watch it fail, restore byte-exact.
  Sign-in, `/api/*` and the tracker endpoint stay stubbed in tests.
- Keep `serve.py` honest: every production route the client calls has a
  local stand-in, so the app runs with no key and no account.
- Run `npm test` while iterating (or one spec: `npx playwright test
  tests/<name>.spec.js`); the full suite once before committing.
- A change to `app.js` or `style.css` bumps `?v=` in `index.html`. A change
  to a Worker's persisted shape is a NEW migration file, never an edit.
- A change to a Pages var (`wrangler.toml [vars]`) that the client mirrors
  (`GOOGLE_CLIENT_ID`) changes both.
- Commit on the branch with a message that records the decision, not the
  diff. Do not push and do not deploy unless the owner asked.

## Phase 3 — Review

After the commit, spawn the applicable reviewers IN ONE MESSAGE, in the
background, and keep working:

| spawn | when |
|---|---|
| `review-quality` | always, for any substantive item |
| `review-data-integrity` | anything stored, synced, scored or derived: KV, D1, the fold, migrations, `practice` |
| `review-security` | new routes, inputs, cookies, Claude calls, proxies, router prefixes |
| `review-ux` | anything the child or the parent sees — it verifies in a real browser |

Pass each reviewer the commit shas (or file scope) and any item-specific
questions. When the reports land: fix critical/major findings in a
follow-up commit on the same branch; record judgment calls you decline with
the reason; re-run `npm test`.

## Landing

Merge into `main` with `--no-ff`; remove any worktree. Push only if the
owner asked. Deploy only if the owner asked — and then: `?v=` bumped,
`deploy-english-words.ps1` for the app, `npx wrangler deploy` in the
Worker's folder, and tell the owner what to try on the real site.

## Definition of done

- `npm test` green.
- New decisions pinned by mutation-checked tests.
- Applicable reviewers ran; findings fixed or explicitly declined with
  reasons.
- Anything the child sees was walked in a real browser at a phone viewport.
- Landed on `main`; worktree removed; primary tree untouched.
- Anything non-obvious learned goes into `CLAUDE.md` as a one-liner under
  "Traps already paid for".
