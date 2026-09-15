/* Boots the english-words app in a signed-in state with a known word list.
   The Google sign-in script and the /api/* backend are stubbed, so the tests
   never touch the network and never depend on a real account. */
const { test: base, expect } = require('@playwright/test');

const WORDS = [
  { he: 'כלב', en: 'dog' },
  { he: 'חתול', en: 'cat' },
  { he: 'בית', en: 'house' },
  { he: 'ספר', en: 'book' },
  { he: 'עץ', en: 'tree' },
  { he: 'מים', en: 'water' },
  { he: 'שמש', en: 'sun' },
  { he: 'ילד', en: 'boy' },
  { he: 'פרח', en: 'flower' },
];

const test = base.extend({
  // a page sitting on the list screen of a 9-word list, ready to pick a mode
  app: async ({ page }, use) => {
    await page.route('**/accounts.google.com/**', r =>
      r.fulfill({ body: '', contentType: 'application/javascript' }));
    await page.route('**/api/me', r =>
      r.fulfill({ json: { sub: 'u1', email: 'test@example.com', name: 'בדיקה', picture: '' } }));
    await page.route('**/api/lists', r =>
      r.fulfill({ json: { lists: [{ id: 'l1', name: 'רשימת בדיקה', date: '', words: WORDS }] } }));
    await page.route('**/tts**', r => r.fulfill({ status: 204, body: '' }));

    // the Claude-backed routes: a fixed bank, and a marker with predictable
    // verdicts, so the sentence exercises are testable without an API key
    const bank = {};
    const fill = w => ({
      en: w.en, he: w.he,
      sentences: Array.from({ length: 10 }, (_, i) => ({
        text: `Sentence number ${i} about the ___ here.`,
        // "dog" and "cat" stand in for a blank more than one word fits
        accept: w.en === 'dog' ? ['dog', 'cat'] : [w.en],
      })),
    });
    await page.route('**/api/sentences**', async r => {
      const first = Object.keys(bank).length === 0;
      if (r.request().method() === 'POST') {
        // hand them over four at a time, as the real route does
        WORDS.filter(w => !bank[w.en]).slice(0, 4).forEach(w => { bank[w.en] = fill(w); });
      }
      const remaining = WORDS.filter(w => !bank[w.en]).length;
      await r.fulfill({ json: { words: bank, remaining, ready: remaining === 0 && !first } });
    });
    await page.route('**/api/sentence-check', async r => {
      const { word, sentence } = r.request().postDataJSON();
      const verdict = !sentence.includes(word) ? 'try_again'
        : /^[A-Z].*[.!?]$/.test(sentence.trim()) ? 'great' : 'almost';
      await r.fulfill({ json: {
        verdict,
        word_ok: sentence.includes(word),   // the tested word, judged on its own
        feedback: 'משוב לבדיקה',
        correction: 'I have a ' + word + '.',
      } });
    });

    await page.goto('/index.html');
    await page.waitForSelector('#screen-home:not([hidden])');
    await page.click('#lists-container .list-card');
    await use(page);
  },
});

/* The queue is shuffled, so tests ask the app what the current word is
   rather than assuming an order. */
const currentAnswer = page => page.evaluate(() => {
  const w = practice.queue[practice.index];
  return practice.mode === 'en2he' ? w.he : w.en;
});

const score = page => page.evaluate(() => ({
  correct: practice.correctCount,
  total: practice.queue.length,
  index: practice.index,
  wrong: practice.wrong.length,
}));

/** Answer the current word and move on. `how`: 'correct' | 'wrong' | 'typo' */
async function answer(page, how = 'correct') {
  const right = await currentAnswer(page);
  const typed = how === 'correct' ? right
    : how === 'typo' ? right.slice(0, -1) + 'x'
    : 'qqqq';
  await page.fill('#answer-input', typed);
  await page.click('#btn-check');
}

async function nextWord(page) {
  await page.click('#btn-next');
}

module.exports = { test, expect, answer, nextWord, currentAnswer, score, WORDS };
