/* Regression tests for the `hidden` attribute.
   `.big-btn { display: block }` used to override the browser's
   `[hidden] { display: none }`, leaving "hidden" buttons on screen and
   clickable - which is what let the practice score run away. */
const { test, expect } = require('./app-fixture');

test('every element the app hides with [hidden] is really hidden', async ({ app }) => {
  const offenders = await app.evaluate(() => {
    const bad = [];
    document.querySelectorAll('[hidden]').forEach(el => {
      if (getComputedStyle(el).display !== 'none') {
        bad.push(el.id || el.className || el.tagName);
      }
    });
    return bad;
  });
  expect(offenders).toEqual([]);
});

test('hidden practice buttons stay hidden at the right moments', async ({ app }) => {
  await app.click('.mode-btn[data-mode="he2en"]');

  // start of a question: only "check" is offered
  await expect(app.locator('#btn-check')).toBeVisible();
  await expect(app.locator('#btn-next')).toBeHidden();
  await expect(app.locator('#feedback')).toBeHidden();
  await expect(app.locator('#btn-speak')).toBeHidden(); // typing mode, nothing to replay

  // after a correct answer: only "next" is offered
  const right = await app.evaluate(() => practice.queue[practice.index].en);
  await app.fill('#answer-input', right);
  await app.click('#btn-check');
  await expect(app.locator('#btn-check')).toBeHidden();
  await expect(app.locator('#btn-next')).toBeVisible();
  await expect(app.locator('#feedback')).toBeVisible();
});

test('the replay button only shows in listening mode', async ({ app }) => {
  await app.click('.mode-btn[data-mode="listen"]');
  await expect(app.locator('#btn-speak')).toBeVisible();
});

test('a flawless round offers no "practise the mistakes" button', async ({ app }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  for (let i = 0; i < 9; i++) {
    await app.fill('#answer-input', await app.evaluate(() => practice.queue[practice.index].en));
    await app.click('#btn-check');
    await app.click('#btn-next');
  }
  await expect(app.locator('#screen-summary')).toBeVisible();
  await expect(app.locator('#btn-retry-wrong')).toBeHidden();
});

test('an alert dialog shows only an OK button, not a stray Cancel', async ({ app }) => {
  await app.evaluate(() => showAlert('בדיקה'));
  await expect(app.locator('#modal-overlay')).toBeVisible();
  await expect(app.locator('#modal-ok')).toBeVisible();
  await expect(app.locator('#modal-cancel')).toBeHidden();
});

test('only one screen is on show at a time', async ({ app }) => {
  const visible = await app.evaluate(() =>
    [...document.querySelectorAll('.screen')]
      .filter(s => getComputedStyle(s).display !== 'none')
      .map(s => s.id));
  expect(visible).toEqual(['screen-list']);
});
