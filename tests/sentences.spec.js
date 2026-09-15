/* The two sentence exercises: filling a word into a sentence, and writing a
   sentence of her own. The Claude-backed routes are stubbed in the fixture. */
const { test, expect, nextWord, score, WORDS } = require('./app-fixture');

const startFill = async app => {
  await app.click('.mode-btn[data-mode="fill"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
};
const startWrite = async app => {
  await app.click('.mode-btn[data-mode="write"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
};
const current = app => app.evaluate(() => practice.queue[practice.index]);

/* ---------- filling the gap ---------- */

test('the round asks a sentence with one gap, not the word', async ({ app }) => {
  await startFill(app);
  const word = await current(app);
  expect(word.sentence.split('___')).toHaveLength(2);
  await expect(app.locator('#question-word .blank')).toBeVisible();
  // the answer itself must not be given away in the prompt
  expect(await app.locator('#question-word').textContent()).not.toContain(word.en);
});

test('the missing word scores like any other answer', async ({ app }) => {
  await startFill(app);
  const word = await current(app);
  await app.fill('#answer-input', word.en);
  await app.click('#btn-check');
  expect(await score(app)).toMatchObject({ correct: 1, wrong: 0 });
});

test('any word the sentence accepts is marked right', async ({ app }) => {
  await startFill(app);
  // walk to the word whose sentences accept a second answer
  for (let i = 0; i < 9; i++) {
    const word = await current(app);
    if (word.accept.length > 1) {
      const other = word.accept.find(a => a !== word.en);
      const before = (await score(app)).correct;
      await app.fill('#answer-input', other);
      await app.click('#btn-check');
      expect(await app.locator('#feedback').getAttribute('class')).toContain('good');
      expect((await score(app)).correct).toBe(before + 1);
      return;
    }
    await app.fill('#answer-input', word.en);
    await app.click('#btn-check');
    await nextWord(app);
  }
  throw new Error('fixture no longer has a sentence with two accepted words');
});

test('a miss reveals the word itself, not the list of accepted words', async ({ app }) => {
  await startFill(app);
  const word = await current(app);
  await app.fill('#answer-input', 'qqqq');
  await app.click('#btn-check');
  const revealed = await app.locator('#feedback .correct-answer').textContent();
  expect(revealed).toBe(word.en);
});

test('sentences are reused only once the others have had a turn', async ({ app }) => {
  await startFill(app);
  const word = await current(app);
  const seen = await app.evaluate(key => {
    localStorage.removeItem(`seen:l1:${key}`); // start the cycle fresh
    const bank = JSON.parse(localStorage.getItem('bank:l1'));
    return Array.from({ length: 10 }, () => pickSentence('l1', key, bank[key].sentences).text);
  }, word.en);
  expect(new Set(seen).size).toBe(10); // all ten, no repeat inside one cycle
});

/* ---------- writing her own sentence ---------- */

test('a sentence without the target word never reaches the server', async ({ app }) => {
  let calls = 0;
  await app.route('**/api/sentence-check', r => { calls++; r.fallback(); });
  await startWrite(app);
  await app.fill('#sentence-input', 'I like ice cream.');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toContainText('להשתמש במילה');
  expect(calls).toBe(0);
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 1 });
});

test('a good sentence scores, a sloppy one does not', async ({ app }) => {
  await startWrite(app);
  const word = await current(app);
  await app.fill('#sentence-input', 'i have a ' + word.en); // no capital, no full stop
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/almost/);
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 1 });

  await app.fill('#sentence-input', 'I have a ' + word.en + '.');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  await expect(app.locator('#btn-check')).toBeHidden();
  expect(await score(app)).toMatchObject({ correct: 0 }); // right, but not first try
});

test('the marker cannot be asked twice about the same sentence', async ({ app }) => {
  await startWrite(app);
  const word = await current(app);
  let calls = 0;
  await app.route('**/api/sentence-check', async r => {
    calls++;
    await r.fulfill({ json: { verdict: 'great', feedback: 'יופי', correction: '' } });
  });
  await app.fill('#sentence-input', 'I have a ' + word.en + '.');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  for (let i = 0; i < 10; i++) await app.evaluate(() => checkAnswer());
  expect(await score(app)).toMatchObject({ correct: 1 });
  expect(calls).toBe(1);
});

test('a marker that cannot be reached neither scores nor punishes', async ({ app }) => {
  await startWrite(app);
  const word = await current(app);
  await app.route('**/api/sentence-check', r => r.abort());
  await app.fill('#sentence-input', 'I have a ' + word.en + '.');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toContainText('לא הצלחנו לבדוק');
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 0 });
});

test('the write screen shows the textarea and hides the one-line input', async ({ app }) => {
  await startWrite(app);
  await expect(app.locator('#sentence-input')).toBeVisible();
  await expect(app.locator('#answer-input')).toBeHidden();
});

/* ---------- a word she already knows, in a gap written for another ---------- */

test('a different word from her list gets a second chance', async ({ app }) => {
  let asked = null;
  await app.route('**/api/sentence-fits', async r => {
    asked = r.request().postDataJSON();
    await r.fulfill({ json: { fits: true } });
  });
  await app.click('.mode-btn[data-mode="fill"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
  const word = await app.evaluate(() => practice.queue[practice.index]);
  const other = WORDS.map(w => w.en).find(en => !word.accept.includes(en));

  await app.fill('#answer-input', other);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  expect(await score(app)).toMatchObject({ correct: 1, wrong: 0 });
  expect(asked).toMatchObject({ word: other, sentence: word.sentence });
});

test('a word that does not fit is still wrong', async ({ app }) => {
  await app.route('**/api/sentence-fits', r => r.fulfill({ json: { fits: false } }));
  await app.click('.mode-btn[data-mode="fill"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
  const word = await app.evaluate(() => practice.queue[practice.index]);
  const other = WORDS.map(w => w.en).find(en => !word.accept.includes(en));

  await app.fill('#answer-input', other);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/bad/);
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 1 });
});

test('a word not on her list never reaches the server', async ({ app }) => {
  let calls = 0;
  await app.route('**/api/sentence-fits', r => { calls++; r.fulfill({ json: { fits: true } }); });
  await app.click('.mode-btn[data-mode="fill"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
  await app.fill('#answer-input', 'zzzz');
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/bad/);
  expect(calls).toBe(0);
});

/* ---------- a slip outside the test word ---------- */

test('a mistake elsewhere in the sentence still scores the word', async ({ app }) => {
  await app.route('**/api/sentence-check', r => r.fulfill({
    json: { verdict: 'almost', word_ok: true, feedback: 'המילה נכונה!', correction: 'I have a dog.' },
  }));
  await app.click('.mode-btn[data-mode="write"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
  const word = await app.evaluate(() => practice.queue[practice.index].en);

  await app.fill('#sentence-input', 'i have a ' + word);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/good/);
  // scored, and never sent to "practise the mistakes"
  expect(await score(app)).toMatchObject({ correct: 1, wrong: 0 });
});

test('a wrong test word is still a mistake', async ({ app }) => {
  await app.route('**/api/sentence-check', r => r.fulfill({
    json: { verdict: 'try_again', word_ok: false, feedback: 'בדקי את המילה', correction: '' },
  }));
  await app.click('.mode-btn[data-mode="write"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
  const word = await app.evaluate(() => practice.queue[practice.index].en);

  await app.fill('#sentence-input', 'I have a ' + word);
  await app.click('#btn-check');
  await expect(app.locator('#feedback')).toHaveClass(/bad/);
  expect(await score(app)).toMatchObject({ correct: 0, wrong: 1 });
});

test('the summary shows the sentences she wrote', async ({ app }) => {
  await app.route('**/api/sentence-check', r => r.fulfill({
    json: { verdict: 'great', word_ok: true, feedback: 'יופי', correction: '' },
  }));
  await app.click('.mode-btn[data-mode="write"]');
  await app.waitForSelector('#screen-practice:not([hidden])');
  const mine = [];
  for (let i = 0; i < 9; i++) {
    const word = await app.evaluate(() => practice.queue[practice.index].en);
    const text = `I like my ${word}.`;
    mine.push(text);
    await app.fill('#sentence-input', text);
    await app.click('#btn-check');
    await expect(app.locator('#feedback')).toHaveClass(/good/);
    await nextWord(app);
  }
  await app.waitForSelector('#screen-summary:not([hidden])');
  const shown = await app.locator('#summary-written').textContent();
  for (const text of mine) expect(shown).toContain(text);
});
