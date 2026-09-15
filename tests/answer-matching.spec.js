/* The forgiving answer checking, exercised through the page's own globals. */
const { test, expect } = require('./app-fixture');

const check = (page, answer, stored, lang) =>
  page.evaluate(([a, s, l]) => matches(a, s, l === 'en' ? normEn : normHe), [answer, stored, lang]);

test('English is forgiving about case and stray spaces', async ({ app }) => {
  expect(await check(app, 'Dog', 'dog', 'en')).toBe(true);
  expect(await check(app, '  DOG  ', 'dog', 'en')).toBe(true);
  expect(await check(app, 'ice  cream', 'ice cream', 'en')).toBe(true);
  expect(await check(app, 'dogs', 'dog', 'en')).toBe(false);
});

test('Hebrew ignores final-letter forms and nikud', async ({ app }) => {
  expect(await check(app, 'שלום', 'שלומ', 'he')).toBe(true);
  expect(await check(app, 'יֶלֶד', 'ילד', 'he')).toBe(true);
  expect(await check(app, 'ילדה', 'ילד', 'he')).toBe(false);
});

test('any stored alternative is accepted', async ({ app }) => {
  expect(await check(app, 'חבר', 'חבר / חברה', 'he')).toBe(true);
  expect(await check(app, 'חברה', 'חבר / חברה', 'he')).toBe(true);
  expect(await check(app, 'mum', 'mum, mom', 'en')).toBe(true);
  expect(await check(app, 'mom', 'mum, mom', 'en')).toBe(true);
  expect(await check(app, 'dad', 'mum, mom', 'en')).toBe(false);
});

test('a one-letter slip is treated as "almost", a real miss is not', async ({ app }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  const right = await app.evaluate(() => practice.queue[practice.index].en);

  await app.fill('#answer-input', right.slice(0, -1) + 'x');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/almost/);
  // an "almost" must not give the answer away
  await expect(app.locator('#feedback .correct-answer')).toHaveCount(0);

  await app.fill('#answer-input', 'qqqqqq');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/bad/);
  await expect(app.locator('#feedback .correct-answer')).toHaveText(right);
});

test('the keyboard-layout magic types English even from a Hebrew layout', async ({ app }) => {
  await app.click('.mode-btn[data-mode="he2en"]');
  await app.click('#answer-input');
  // the Hebrew letters sitting on the d, u and g keys of an Israeli keyboard
  for (const key of ['ג', 'ו', 'ע']) {
    await app.locator('#answer-input').dispatchEvent('keydown', { key });
  }
  expect(await app.inputValue('#answer-input')).toBe('dug');
});
