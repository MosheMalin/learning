/* The tracking promises the first review found untested: a verdict lands on
   the word it was written for; a queued round never travels under another
   account; a batch refused for sign-in is kept and delivered later; a
   revisited word is not presented twice; a judge that is away is "unjudged";
   an item id is the normalised word. */
const { test, expect, answer, nextWord, currentAnswer, reported } = require('./app-fixture');

const ofType = (events, type) => events.filter(e => e.type === type);

test('a verdict that arrives after she pressed Next still belongs to the word she wrote about', async ({ app, tracked }) => {
  let release;
  const held = new Promise(r => { release = r; });
  await app.route('**/api/sentence-check', async r => {
    await held;
    await r.fulfill({ json: { verdict: 'great', word_ok: true, feedback: 'יופי', correction: '' } });
  });
  await app.click('.mode-btn[data-mode="write"]');
  const word = await currentAnswer(app);
  await app.fill('#sentence-input', `I have a ${word}.`);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toContainText('קוראים');
  // "next" is not offered while the judge is reading, and forcing it does nothing
  await expect(app.locator('#btn-next')).toBeHidden();
  await app.evaluate(() => nextQuestion());
  await app.keyboard.press('Enter');
  expect(await app.evaluate(() => practice.index)).toBe(0);
  release();
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  const events = await reported(app, tracked);
  const tries = ofType(events, 'item.answered');
  expect(tries).toHaveLength(1);
  expect(tries[0]).toMatchObject({ seq: 1, result: 'correct', score: 1, response: `I have a ${word}.` });
  expect(tries[0].item).toBe(ofType(events, 'item.presented')[0].item);
  expect(await app.evaluate(() => practice.correctCount)).toBe(1);
});

test('a round queued under one account is not posted under the next one', async ({ app, tracked }) => {
  // the tracker is unreachable while the first child plays
  let down = true;
  await app.route('**/learning/track/v1/events', async r => {
    if (down) return r.abort('connectionrefused');
    const batch = r.request().postDataJSON();
    tracked.push(batch);
    await r.fulfill({ json: { accepted: batch.events.length, duplicates: 0 } });
  });
  await app.click('.mode-btn[data-mode="he2en"]');
  await answer(app, 'correct'); await nextWord(app);
  await app.evaluate(() => Tracker.flushAll());
  expect(await app.evaluate(() => Tracker.instances[0].queued())).toBeGreaterThan(0);

  // she signs out; her sibling signs in on the same laptop
  await app.route('**/api/logout', r => r.fulfill({ json: { ok: true } }));
  await app.route('**/api/login', r => r.fulfill({ json: { sub: 'u2', email: 'sibling@example.com', name: 'אח', picture: '' } }));
  await app.route('**/api/me', r => r.fulfill({ json: { sub: 'u2', email: 'sibling@example.com', name: 'אח', picture: '' } }));
  await app.evaluate(() => logout());
  await app.evaluate(() => onGoogleCredential({ credential: 'x' }));
  await app.waitForSelector('#screen-home:not([hidden])');
  down = false;
  await app.evaluate(() => Tracker.flushAll());
  await app.waitForTimeout(300);
  // nothing of hers travels with the sibling's cookie; it waits for her
  expect(tracked).toHaveLength(0);
  expect(await app.evaluate(() => Tracker.instances[0].pending())).toBe(0);
  expect(await app.evaluate(() => Tracker.instances[0].queued())).toBeGreaterThan(0);

  // the sibling's own round goes through
  await app.click('#lists-container .list-card');
  await app.click('.mode-btn[data-mode="he2en"]');
  await answer(app, 'correct');
  const events = await reported(app, tracked);
  expect(ofType(events, 'session.started')).toHaveLength(1);
  expect(events.every(e => e.session === events[0].session)).toBe(true);
});

test('a batch refused for sign-in is kept and delivered once signed in, even across a reload', async ({ app, tracked }) => {
  let signedIn = false;
  await app.route('**/learning/track/v1/events', async r => {
    if (!signedIn) return r.fulfill({ status: 401, json: { error: 'not logged in' } });
    const batch = r.request().postDataJSON();
    tracked.push(batch);
    await r.fulfill({ json: { accepted: batch.events.length, duplicates: 0 } });
  });
  await app.click('.mode-btn[data-mode="he2en"]');
  await answer(app, 'correct'); await nextWord(app);
  await app.evaluate(() => Tracker.flushAll());
  const ids = await app.evaluate(() => JSON.parse(localStorage.getItem('tracker-outbox')).map(o => o.ev.id));
  expect(ids.length).toBeGreaterThan(0);

  signedIn = true;
  await app.reload();
  await app.waitForSelector('#screen-home:not([hidden])');
  await app.waitForFunction(() => window.Tracker && Tracker.instances.length && Tracker.instances[0].pending() === 0);
  const delivered = tracked.flatMap(b => b.events).map(e => e.id);
  for (const id of ids) expect(delivered).toContain(id);
});

test('an event the server refuses is dropped alone; the rest of the batch still lands', async ({ app, tracked }) => {
  await app.route('**/learning/track/v1/events', async r => {
    const batch = r.request().postDataJSON();
    const bad = batch.events.findIndex(e => e.type === 'item.presented');
    if (bad >= 0) return r.fulfill({ status: 400, json: { error: 'bad seq', index: bad } });
    tracked.push(batch);
    await r.fulfill({ json: { accepted: batch.events.length, duplicates: 0 } });
  });
  await app.click('.mode-btn[data-mode="he2en"]');
  await answer(app, 'correct');
  const events = await reported(app, tracked);
  expect(ofType(events, 'item.presented')).toHaveLength(0);
  expect(ofType(events, 'session.started')).toHaveLength(1);
  expect(ofType(events, 'item.answered')).toHaveLength(1);
});

test('stepping back to a word does not present it again', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  await answer(app, 'correct'); await nextWord(app);
  await answer(app, 'wrong');
  await app.click('#btn-prev');
  await app.click('#btn-next');
  const events = await reported(app, tracked);
  expect(ofType(events, 'item.presented').map(e => e.seq)).toEqual([1, 2]);
});

test('a gap judge that is away leaves the answer unjudged and unscored', async ({ app, tracked }) => {
  await app.route('**/api/sentence-fits', r => r.fulfill({ status: 502, json: { error: 'down' } }));
  await app.click('.mode-btn[data-mode="fill"]');
  await expect(app.locator('#screen-practice')).toBeVisible();
  // every fixture sentence accepts its own word; "cat" is on the list and fits none of the others
  const word = await currentAnswer(app);
  const other = word === 'cat' ? 'sun' : 'cat';
  await app.fill('#answer-input', other);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toContainText('לא הצלחנו לבדוק');
  const events = await reported(app, tracked);
  expect(ofType(events, 'item.answered').map(e => [e.result, e.judgedBy, e.score])).toEqual([['unjudged', 'llm', 0]]);
  expect(await app.evaluate(() => practice.wrong.length)).toBe(0);
});

test('item ids are the normalised word, so a capital or a stray space cannot split a word in two', async ({ page, tracked }) => {
  await page.route('**/accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/me', r => r.fulfill({ json: { sub: 'u1', email: 'test@example.com', name: 'בדיקה', picture: '' } }));
  await page.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'l1', name: 'רשימה', date: '', words: [{ he: 'כלב', en: 'Dog ' }] }] } }));
  await page.route('**/tts**', r => r.fulfill({ status: 204, body: '' }));
  await page.goto('/index.html');
  await page.click('#lists-container .list-card');
  await page.click('.mode-btn[data-mode="he2en"]');
  await answer(page, 'correct');
  const events = await reported(page, tracked);
  expect(ofType(events, 'session.started')[0].unit.items[0].id).toBe('dog');
  expect(ofType(events, 'item.presented')[0].item).toBe('dog');
  expect(ofType(events, 'item.answered')[0].item).toBe('dog');
});
