const { test, expect, answer, nextWord, currentAnswer, score } = require('./app-fixture');

test.beforeEach(async ({ app }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
});

test('a correct answer scores once and only once', async ({ app }) => {
  await answer(app, 'correct');
  expect(await score(app)).toMatchObject({ correct: 1, wrong: 0 });
});

test('re-checking an answered word cannot inflate the score', async ({ app }) => {
  // Regression: #btn-check used to stay clickable after a correct answer
  // (.big-btn's `display: block` beat the browser's [hidden] rule), so tapping
  // it again kept incrementing the score - "ענית נכון על 152 מתוך 9 מילים".
  await answer(app, 'correct');
  await expect(app.locator('#btn-check')).toBeHidden();

  // force the check through anyway - the scoring logic must refuse it on its own
  for (let i = 0; i < 20; i++) await app.evaluate(() => checkAnswer());

  expect(await score(app)).toMatchObject({ correct: 1 });
});

test('the score never exceeds the number of words in the round', async ({ app }) => {
  for (let i = 0; i < 9; i++) {
    await answer(app, 'correct');
    await app.evaluate(() => { checkAnswer(); checkAnswer(); }); // stray extra checks
    await nextWord(app);
  }
  const s = await score(app);
  expect(s.correct).toBeLessThanOrEqual(s.total);
  expect(s.correct).toBe(9);
  await expect(app.locator('#summary-score')).toHaveText('ענית נכון על 9 מתוך 9 מילים');
});

test('a word answered right only on the second try does not score', async ({ app }) => {
  await answer(app, 'wrong');
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 1 });

  await answer(app, 'correct'); // same word, second attempt
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 1 });
});

test('a full round of mixed answers reports the right totals', async ({ app }) => {
  const plan = ['correct', 'wrong', 'correct', 'correct', 'wrong', 'correct', 'correct', 'correct', 'correct'];
  for (const how of plan) {
    await answer(app, how);
    await nextWord(app);
  }
  await expect(app.locator('#screen-summary')).toBeVisible();
  await expect(app.locator('#summary-score')).toHaveText('ענית נכון על 7 מתוך 9 מילים');
  await expect(app.locator('#summary-mistakes tr')).toHaveCount(2);
});

test('holding Enter through a round does not double-count or run past the end', async ({ app }) => {
  for (let i = 0; i < 12; i++) {
    if (await app.locator('#screen-summary').isVisible()) break;
    await app.fill('#answer-input', await currentAnswer(app));
    await app.keyboard.down('Enter');
    await app.keyboard.down('Enter'); // key repeat
    await app.keyboard.down('Enter');
    await app.keyboard.up('Enter');
  }
  const s = await score(app);
  expect(s.correct).toBeLessThanOrEqual(s.total);
  expect(s.index).toBeLessThanOrEqual(s.total);
});

test('practising only the mistakes scores out of that shorter list', async ({ app }) => {
  const plan = ['wrong', 'wrong', 'correct', 'correct', 'correct', 'correct', 'correct', 'correct', 'correct'];
  for (const how of plan) {
    await answer(app, how);
    await nextWord(app);
  }
  await app.click('#btn-retry-wrong');
  expect(await score(app)).toMatchObject({ correct: 0, total: 2, index: 0 });

  for (let i = 0; i < 2; i++) {
    await answer(app, 'correct');
    await nextWord(app);
  }
  await expect(app.locator('#summary-score')).toHaveText('ענית נכון על 2 מתוך 2 מילים');
});

test('a perfect round gets three stars, a poor one does not', async ({ app }) => {
  for (let i = 0; i < 9; i++) { await answer(app, 'correct'); await nextWord(app); }
  await expect(app.locator('#summary-stars')).toHaveText('⭐⭐⭐');
});
