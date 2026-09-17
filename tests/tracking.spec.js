/* The tracking contract: what one round reports, and that the tracker's fold
   of it gives the numbers the child saw on her summary screen. The tracker is
   stubbed at the network; the fold runs here against the real SQL. */
const { test, expect, answer, nextWord, currentAnswer, reported } = require('./app-fixture');
const { freshDb } = require('./tracker/d1-sqlite');

const ofType = (events, type) => events.filter(e => e.type === type);

/* correct, typo-then-correct, wrong-and-given-up, then six right: 7/9, 8 eventually */
async function playMixedRound(app) {
  await answer(app, 'correct'); await nextWord(app);
  await answer(app, 'typo'); await answer(app, 'correct'); await nextWord(app);
  await answer(app, 'wrong'); await nextWord(app);
  for (let i = 0; i < 6; i++) { await answer(app, 'correct'); await nextWord(app); }
  await expect(app.locator('#screen-summary')).toBeVisible();
}

test('a round reports every question, every try, and the totals she saw', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  await playMixedRound(app);
  const events = await reported(app, tracked);

  const started = ofType(events, 'session.started');
  expect(started).toHaveLength(1);
  expect(started[0].exercise).toMatchObject({ id: 'he2en', title: 'מעברית לאנגלית', interaction: 'fill-in' });
  expect(started[0].unit).toMatchObject({ id: 'l1', kind: 'wordlist', title: 'רשימת בדיקה' });
  expect(started[0].unit.items).toHaveLength(9);
  expect(started[0].params).toMatchObject({ itemCount: 9, retryOf: null, mistakesOnly: false });
  expect(started[0].localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const presented = ofType(events, 'item.presented');
  expect(presented.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(presented[0].prompt.text).toBeTruthy();          // the Hebrew word she saw

  const answered = ofType(events, 'item.answered');
  expect(answered).toHaveLength(10);            // nine first tries and one retry
  const bySeq = seq => answered.filter(e => e.seq === seq).map(e => [e.try, e.result, e.score]);
  expect(bySeq(1)).toEqual([[1, 'correct', 1]]);
  expect(bySeq(2)).toEqual([[1, 'almost', 0], [2, 'correct', 0]]);   // no point on the second try
  expect(bySeq(3)).toEqual([[1, 'wrong', 0]]);
  for (const e of answered) {
    expect(e.judgedBy).toBe('rule');
    expect(e.maxScore).toBe(1);
    expect(typeof e.response).toBe('string');
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
  }

  const completed = ofType(events, 'session.completed');
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ score: 7, maxScore: 9, itemCount: 9, correctFirstTry: 7, correctEventually: 8 });

  // one session, and nothing else was sent
  expect(new Set(events.map(e => e.session)).size).toBe(1);
  expect(events).toHaveLength(1 + 9 + 10 + 1);
  for (const b of tracked) expect(b).toMatchObject({ schema: 1, app: 'english-words', appVersion: expect.any(String) });
});

test('the tracker folds the round to the numbers on her summary screen', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  await playMixedRound(app);
  const events = await reported(app, tracked);
  await expect(app.locator('#summary-score')).toHaveText('ענית נכון על 7 מתוך 9 מילים');

  const { ingestEvents } = await import('../tracker/src/fold.js');
  const { validateBatch } = await import('../tracker/src/ingest.js');
  const v = validateBatch({ schema: 1, app: 'english-words', events });
  expect(v.ok).toBe(true);
  const db = freshDb();
  await ingestEvents(db, { student: 'kid', app: 'english-words', receivedAt: new Date().toISOString() }, events);
  const s = await db.prepare('SELECT * FROM sessions').first();
  expect(s).toMatchObject({ status: 'completed', item_count: 9, answered_count: 9, correct_first_try: 7, correct_eventually: 8, score: 7, max_score: 9 });
  const items = await db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE kind = 'item'`).first();
  expect(items.n).toBe(9);
});

test('practising the mistakes is reported as a round that re-drills the last one', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  await playMixedRound(app);
  await app.click('#btn-retry-wrong');
  const events = await reported(app, tracked);
  const started = ofType(events, 'session.started');
  expect(started).toHaveLength(2);
  expect(started[1].params).toMatchObject({ retryOf: started[0].session, mistakesOnly: true, itemCount: 2 });
  expect(started[1].session).not.toBe(started[0].session);
});

test('leaving a round from its screen reports it as abandoned', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  await answer(app, 'correct');
  await app.click('#screen-practice .back-btn');
  const events = await reported(app, tracked);
  expect(ofType(events, 'session.abandoned')).toHaveLength(1);
  expect(ofType(events, 'session.completed')).toHaveLength(0);
});

test('a listening question reports what was played, not what was shown', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="listen"]');
  const word = await currentAnswer(app);
  const events = await reported(app, tracked);
  expect(ofType(events, 'item.presented')[0].prompt).toEqual({ audio: word });
  expect(ofType(events, 'session.started')[0].exercise.id).toBe('listen');
});

test('a written sentence carries the judge and its note', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="write"]');
  const word = await currentAnswer(app);
  await app.fill('#sentence-input', `i have a ${word}`);     // no capital, no full stop: "almost"
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/almost/);
  await app.fill('#sentence-input', `I have a ${word}.`);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  const events = await reported(app, tracked);
  const tries = ofType(events, 'item.answered').filter(e => e.seq === 1);
  expect(tries.map(e => [e.try, e.result, e.judgedBy])).toEqual([[1, 'almost', 'llm'], [2, 'correct', 'llm']]);
  expect(tries[0].feedback).toContain('משוב לבדיקה');
  expect(tries[0].feedback).toContain('I have a ' + word + '.');     // the correction travels with the note
  expect(tries[0].response).toBe(`i have a ${word}`);
  expect(ofType(events, 'session.started')[0].exercise.interaction).toBe('long-fill-in');
});

test('a sentence that could not be judged is reported as unjudged and not scored', async ({ app, tracked }) => {
  await app.route('**/api/sentence-check', r => r.fulfill({ status: 502, json: { error: 'down' } }));
  await app.click('.mode-btn[data-mode="write"]');
  const word = await currentAnswer(app);
  await app.fill('#sentence-input', `I have a ${word}.`);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toContainText('לא הצלחנו');
  const events = await reported(app, tracked);
  expect(ofType(events, 'item.answered').map(e => [e.result, e.judgedBy, e.score])).toEqual([['unjudged', 'llm', 0]]);
});

test('without the tracker script the app plays exactly the same and reports nothing', async ({ page, tracked }) => {
  await page.route('**/learning/track/v1/tracker.js', r => r.fulfill({ status: 404, body: 'gone' }));
  await page.route('**/accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/me', r => r.fulfill({ json: { sub: 'u1', email: 'test@example.com', name: 'בדיקה', picture: '' } }));
  await page.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'l1', name: 'רשימה', date: '', words: [{ he: 'כלב', en: 'dog' }, { he: 'חתול', en: 'cat' }] }] } }));
  await page.route('**/tts**', r => r.fulfill({ status: 204, body: '' }));
  await page.goto('/index.html');
  await page.click('#lists-container .list-card');
  await page.click('.mode-btn[data-mode="he2en"]');
  await answer(page, 'correct'); await nextWord(page);
  await answer(page, 'correct'); await nextWord(page);
  await expect(page.locator('#summary-score')).toHaveText('ענית נכון על 2 מתוך 2 מילים');
  expect(tracked).toHaveLength(0);
});
