/* Phase 3: the tracker tells the app which words she keeps missing, and the
   app offers a round of exactly those. Without an answer, nothing appears. */
const { test, expect, reported, WORDS } = require('./app-fixture');

const ofType = (events, type) => events.filter(e => e.type === type);

test('the list screen offers the words the tracker flagged, and the round is exactly those', async ({ page, tracked }) => {
  await page.route('**/learning/track/v1/me/units/english-words/l1', r =>
    r.fulfill({ json: { items: [], weak: ['dog', 'Cat'] } }));
  await page.route('**/accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'application/javascript' }));
  await page.route('**/api/me', r => r.fulfill({ json: { sub: 'u1', email: 'test@example.com', name: 'בדיקה', picture: '' } }));
  await page.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'l1', name: 'רשימת בדיקה', date: '', words: WORDS }] } }));
  await page.route('**/tts**', r => r.fulfill({ status: 204, body: '' }));
  await page.goto('/index.html');
  await page.click('#lists-container .list-card');
  const btn = page.locator('#btn-weak');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText(/2 מילים/);
  await btn.click();
  await expect(page.locator('#screen-practice')).toBeVisible();
  const queue = await page.evaluate(() => practice.queue.map(w => w.en).sort());
  expect(queue).toEqual(['cat', 'dog']);          // 'Cat' matched the list's 'cat' by normalisation
  const events = await reported(page, tracked);
  expect(ofType(events, 'session.started')[0].params).toMatchObject({ source: 'weak', mistakesOnly: true, itemCount: 2, retryOf: null });
});

test('no offer when the tracker has nothing to say or cannot be reached', async ({ app }) => {
  // the fixture's static server answers 404 for the me route: nothing appears
  await expect(app.locator('#btn-weak')).toBeHidden();
  await app.route('**/learning/track/v1/me/**', r => r.fulfill({ json: { items: [], weak: [] } }));
  await app.click('.back-btn[data-back="home"]');
  await app.click('#lists-container .list-card');
  await expect(app.locator('#btn-weak')).toBeHidden();
  await app.route('**/learning/track/v1/me/**', r => r.fulfill({ status: 500, body: 'boom' }));
  await app.click('.back-btn[data-back="home"]');
  await app.click('#lists-container .list-card');
  await expect(app.locator('#btn-weak')).toBeHidden();
});

test('a whole-list round is not a mistakes round', async ({ app, tracked }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  const events = await reported(app, tracked);
  expect(ofType(events, 'session.started')[0].params).toMatchObject({ source: 'list', mistakesOnly: false });
});
