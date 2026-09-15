/* Stepping back through a round: she can see a word she has already done,
   with what she wrote and what she was told - and it is never re-scored. */
const { test, expect, answer, nextWord, score } = require('./app-fixture');

test.beforeEach(async ({ app }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
});

test('there is nothing to go back to on the first word', async ({ app }) => {
  await expect(app.locator('#btn-prev')).toBeHidden();
});

test('going back shows the answer she gave', async ({ app }) => {
  const first = await app.evaluate(() => practice.queue[0].en);
  await answer(app, 'correct');
  await nextWord(app);
  await expect(app.locator('#btn-prev')).toBeVisible();

  await app.click('#btn-prev');
  await expect(app.locator('#answer-input')).toHaveValue(first);
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  await expect(app.locator('#btn-check')).toBeHidden(); // done: nothing to check
});

test('revisiting a finished word cannot score it again', async ({ app }) => {
  await answer(app, 'correct');
  await nextWord(app);
  await app.click('#btn-prev');
  for (let i = 0; i < 10; i++) await app.evaluate(() => checkAnswer());
  expect(await score(app)).toMatchObject({ correct: 1 });
});

test('going back then forward returns to the word she was on', async ({ app }) => {
  await answer(app, 'correct');
  await nextWord(app);
  const onSecond = await app.evaluate(() => practice.index);
  await app.click('#btn-prev');
  expect(await app.evaluate(() => practice.index)).toBe(onSecond - 1);
  await app.click('#btn-next');
  expect(await app.evaluate(() => practice.index)).toBe(onSecond);
  // still answerable - going back must not finish it for her
  await expect(app.locator('#btn-check')).toBeVisible();
  await expect(app.locator('#answer-input')).toBeEnabled();
});

test('a half-answered word keeps its state while she looks back', async ({ app }) => {
  await answer(app, 'correct');
  await nextWord(app);
  await answer(app, 'wrong');           // wrong, still retryable
  await app.click('#btn-prev');
  await app.click('#btn-next');
  await expect(app.locator('#answer-input')).toHaveValue('qqqq');
  await expect(app.locator('#feedback')).toHaveClass(/bad/);
  await expect(app.locator('#btn-check')).toBeVisible();
  // and the second chance is still hers to take, without a second mistake
  const before = await score(app);
  await answer(app, 'correct');
  expect(await score(app)).toMatchObject({ wrong: before.wrong });
});

test('the progress bar reaches the end on the last word', async ({ app }) => {
  for (let i = 0; i < 9; i++) {
    await answer(app, 'correct');
    if (i === 8) break;
    await nextWord(app);
  }
  const width = await app.evaluate(() => document.getElementById('progress-fill').style.width);
  expect(width).toBe('100%');
});

test('coming back to an untouched word does not offer a skip', async ({ app }) => {
  await answer(app, 'correct');
  await nextWord(app);                    // now on word 2, untouched
  await app.click('#btn-prev');
  await app.click('#btn-next');           // back to word 2
  await expect(app.locator('#btn-next')).toBeHidden();
  await expect(app.locator('#btn-check')).toBeVisible();
});
