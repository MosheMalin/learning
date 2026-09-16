// Multi-user API: Google sign-in sessions + per-user word lists in KV.
// Routes: POST /api/login, POST /api/logout, GET /api/me, GET|PUT /api/lists,
//         GET|POST /api/sentences, POST /api/sentence-check
//
// The two sentence routes are the only ones that call Claude. Sentences are
// generated once per list and then frozen in KV - practice itself never needs
// the network, so a round plays the same offline as online.

import Anthropic from '@anthropic-ai/sdk';
import { getSession, verifyGoogleCredential, createSession, destroySession } from '@learning/auth';

/* Which model writes the sentences and which one marks them. Both are plain
   Pages variables, so either can be changed without touching this code.
   Writing simple sentences is an easier job than judging a child's writing,
   so they are separate knobs. */
const DEFAULT_MODEL = 'claude-opus-5';
const SENTENCES_PER_WORD = 5;
const SENTENCES_ASKED = 7;     // spares, so the vaguest can be dropped
const WORDS_PER_CALL = 2;      // one request must answer well inside ~100s, or
                               // Cloudflare drops the connection with nothing
const WORDS_PER_VERIFY = 3;    // checking finished sentences is the lighter job
const MAX_WORDS_PER_LIST = 40;
const DAILY_CALL_BUDGET = 400; // per user, protects the API key from a runaway loop

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/* ---------- Claude-backed sentence bank ----------
   One list's sentences are generated once and then frozen: new words added to
   a list get their own sentences, existing ones are never rewritten. */

const normWord = w => (w || '').trim().toLowerCase().replace(/\s+/g, ' ');

const bankKey = (user, listId) => `user:${user.sub}:sentences:${listId}`;

/* Accept lists are only true for the word set they were judged against: add a
   word to a list and every earlier sentence has to be asked about again. */
const wordSetKey = words => words.map(w => normWord(w.en)).sort().join('|');

/* a rough daily ceiling per user, so a stuck client can't burn the API key */
async function withinBudget(env, user, n) {
  const key = `budget:${user.sub}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.LEARNING_KV.get(key)) || 0;
  if (used + n > DAILY_CALL_BUDGET) return false;
  await env.LEARNING_KV.put(key, String(used + n), { expirationTtl: 60 * 60 * 48 });
  return true;
}

async function askClaude(env, { system, prompt, schema, effort = 'medium', model }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // streamed: a non-streamed call of this size can outlast the request itself
  const res = await client.messages.stream({
    model: model || DEFAULT_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  }).finalMessage();
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

const SENTENCES_SCHEMA = {
  type: 'object',
  properties: {
    words: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          sentences: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                accept: { type: 'array', items: { type: 'string' } },
              },
              required: ['text', 'accept'],
              additionalProperties: false,
            },
          },
        },
        required: ['word', 'sentences'],
        additionalProperties: false,
      },
    },
  },
  required: ['words'],
  additionalProperties: false,
};

const SENTENCES_SYSTEM = `You write example sentences for a 10-year-old Israeli girl learning English as a foreign language. Her mother tongue is Hebrew and she is practising a fixed list of words for her weekly spelling test.

Her English is far behind her age: write for the reading level of a six-year-old native speaker. Apart from the target word, use only words she is certain to know already - the most common words in English (my, our, the, a, is, has, likes, sees, plays, eats, runs, goes, sits, big, small, red, new, old, good, happy, mom, dad, home, school, park, cat, ball, bed, food, water, day, morning). If a sentence needs "mailman", "vet", "attic", "chimney", "leash", "obedient", "borrowed" or anything like them, throw it away and write a simpler one. A clue she cannot read is not a clue.

For each target word you are given, write exactly ${SENTENCES_ASKED} different sentences. Every sentence must follow all of these rules:
- Write the sentence with the target word replaced by exactly one blank: ___ (three underscores). Exactly one blank per sentence, and the target word must not appear anywhere else in it.
- The blank stands for the target word spelled exactly as given. Never inflect it - no -s, no -ed, no -ing, no capitalisation change beyond the start of a sentence. If a natural sentence would need a different form, write a different sentence instead.
- 4 to 8 words long. Present simple or past simple only.
- American spelling: color, favorite, mom.
- Every sentence must point at its own target word, using a clue she can read: what it does, what it is for, where it belongs, who uses it. A frame that would work with almost any word ("I saw a ___ there.", "This ___ is very nice.", "My ___ is here today.") is not acceptable, however grammatical it is. Someone who knows the words should be able to tell which one belongs in the gap.
- Concrete and friendly. Vary the situation across the ${SENTENCES_ASKED} sentences - home, school, friends, animals, food, family, weather, playground - so she cannot memorise them, and vary the openings: no more than two sentences may start with the same word.
- Before you keep a sentence, read it back with the target word written into the gap and check it is correct English, articles included. "When ___ plays, it makes everyone happy." is wrong; it needs "the" before the gap. What she fills in must end up as a correct sentence.

For "accept", list every word from the full word list that would also make a correct, sensible sentence in that blank - always including the target word itself. Add another word only if the sentence genuinely works with it. Use the exact spelling from the list.`;

async function generateSentences(env, allWords, targets) {
  const vocab = allWords.map(w => `${w.en} (${w.he})`).join(', ');
  const prompt = `The full word list she is practising: ${vocab}.\n\n` +
    `Write sentences for these target words: ${targets.map(w => w.en).join(', ')}.`;
  const out = await askClaude(env, {
    system: SENTENCES_SYSTEM, prompt, schema: SENTENCES_SCHEMA,
    model: env.SENTENCES_MODEL,
    effort: 'low', // short beginner sentences don't need deliberation, and speed matters here
  });
  const known = new Set(allWords.map(w => normWord(w.en)));
  const clean = {};
  for (const entry of out.words || []) {
    const target = targets.find(t => normWord(t.en) === normWord(entry.word));
    if (!target) continue;
    const sentences = (entry.sentences || [])
      // a sentence is only usable if it has exactly one blank to fill
      .filter(s => s && typeof s.text === 'string' && s.text.split('___').length === 2)
      .map(s => ({
        text: s.text.trim(),
        // keep only real list words, and make sure the target is always accepted
        accept: [...new Set([
          target.en,
          ...(Array.isArray(s.accept) ? s.accept : []).filter(a => known.has(normWord(a))),
        ])],
      }))
      // A sentence that half the list could fill isn't pointing at its word, and
      // the model tells us which those are: the longer the accept list, the
      // vaguer the sentence. Keep the sharpest, drop the spares.
      .sort((a, b) => a.accept.length - b.accept.length)
      .slice(0, SENTENCES_PER_WORD);
    if (sentences.length) clean[normWord(target.en)] = { en: target.en, he: target.he, sentences };
  }
  return clean;
}

/* Which of her words fit each gap.

   Deciding this while writing the sentence is a side-task, and it shows: a
   sentence written for "clock" ("My ___ wakes me up each morning") came back
   accepting only "clock", though "father" is just as right - and she was marked
   wrong for it. Asked on its own, about finished sentences, it is a much easier
   question. It also catches up when words are added to a list later. */

const ACCEPT_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          accept: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'accept'],
        additionalProperties: false,
      },
    },
  },
  required: ['sentences'],
  additionalProperties: false,
};

const ACCEPT_SYSTEM = `Each sentence below has one gap, written as ___. You are given the full list of words a child is practising.

For every sentence, list each word from the list that would make the finished sentence correct and sensible English. Put the word in the gap, read the whole sentence back, and ask whether a reader would accept it without a second thought. Judge only the finished sentence - never which word the sentence was "meant" for.

Include a word when it genuinely works, even if the sentence was clearly written for a different one: "My ___ wakes me up each morning" works with "clock" and with "father", and both belong in its list. Leave a word out when the result is odd, ungrammatical, or means something the sentence cannot mean. Copy each sentence's text back exactly as given, and use the exact spelling of the words from the list.`;

async function verifyAccepts(env, allWords, entries) {
  const texts = entries.flatMap(e => e.sentences.map(s => s.text));
  if (!texts.length) return;
  const out = await askClaude(env, {
    system: ACCEPT_SYSTEM,
    prompt: [
      `The words she is practising: ${allWords.map(w => w.en).join(', ')}.`,
      '',
      'Sentences:',
      ...texts.map(t => `- ${t}`),
    ].join(`
`),
    schema: ACCEPT_SCHEMA,
    model: env.CHECK_MODEL,
    effort: 'low',
  });
  const known = new Set(allWords.map(w => normWord(w.en)));
  const byText = new Map((out.sentences || []).map(s => [s.text, s.accept]));
  for (const entry of entries) {
    for (const sentence of entry.sentences) {
      const verified = byText.get(sentence.text);
      if (!Array.isArray(verified)) continue;   // unanswered: keep what we had
      sentence.accept = [...new Set([
        entry.en,                               // its own word always counts
        ...verified.filter(a => known.has(normWord(a))),
      ])];
    }
  }
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['great', 'almost', 'try_again'] },
    word_ok: { type: 'boolean' },
    feedback: { type: 'string' },
    correction: { type: 'string' },
  },
  required: ['verdict', 'word_ok', 'feedback', 'correction'],
  additionalProperties: false,
};

const CHECK_SYSTEM = `A 10-year-old Israeli girl learning English (mother tongue Hebrew) was asked to write her own English sentence using one target word. Judge her sentence.

"great": she used the target word with its real meaning and the sentence is understandable and basically correct. Small slips that a native reader would not stumble over - a missing full stop, a lower-case first letter - are still "great".
"almost": the meaning comes through and the target word is used sensibly, but there is one clear mistake to fix (a wrong verb form, a missing article, a misspelled word, wrong word order).
"try_again": she did not use the target word, used it with the wrong meaning, or the sentence cannot be understood.

Be generous and encouraging - this is a beginner writing a foreign language, not an exam. Never ask for longer or fancier sentences; a short correct sentence is a great sentence.

"word_ok": true when the target word itself is right - spelled correctly and used with its real meaning. It stays true when the rest of the sentence has a mistake. It is false only when the target word is missing, misspelled, or used to mean something it does not mean. This is the word she is tested on, so judge it on its own.

"feedback": one or two short sentences in simple Hebrew, warm and specific. Name the single most useful thing to fix, and say what she did well. Do not use English grammar jargon. When "word_ok" is true, open by telling her the test word is right - a mistake elsewhere is worth mentioning, not worth worrying about.
"correction": her sentence rewritten correctly in English, keeping her idea and her words as far as possible. If nothing needs fixing, repeat her sentence unchanged.`;

export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join('/');
  const method = request.method;

  if (path === 'login' && method === 'POST') {
    const { credential } = await request.json().catch(() => ({}));
    if (!credential) return json({ error: 'missing credential' }, 400);
    const user = await verifyGoogleCredential(credential, env.GOOGLE_CLIENT_ID);
    if (!user) return json({ error: 'invalid token' }, 401);
    const cookie = await createSession(env, user);
    return json(user, 200, { 'Set-Cookie': cookie });
  }

  if (path === 'logout' && method === 'POST') {
    const cookie = await destroySession(request, env);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  const user = await getSession(request, env);

  if (path === 'me' && method === 'GET') {
    return user ? json(user) : json({ error: 'not logged in' }, 401);
  }

  if (path === 'lists') {
    if (!user) return json({ error: 'not logged in' }, 401);
    const key = 'user:' + user.sub + ':lists';
    if (method === 'GET') {
      const raw = await env.LEARNING_KV.get(key);
      return json({ lists: raw ? JSON.parse(raw) : [] });
    }
    if (method === 'PUT') {
      const body = await request.text();
      if (body.length > 200000) return json({ error: 'too large' }, 413);
      let data;
      try { data = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }
      if (!Array.isArray(data)) return json({ error: 'expected an array' }, 400);
      await env.LEARNING_KV.put(key, body);
      return json({ ok: true });
    }
  }

  /* Sentence bank for one list.
     GET  -> what we already have (never calls Claude)
     POST -> generate the next few missing words, then report what is left */
  if (path === 'sentences') {
    if (!user) return json({ error: 'not logged in' }, 401);
    const { listId } = method === 'POST'
      ? await request.json().catch(() => ({}))
      : { listId: new URL(request.url).searchParams.get('listId') };
    if (!listId) return json({ error: 'missing listId' }, 400);

    const raw = await env.LEARNING_KV.get(bankKey(user, listId));
    const bank = raw ? JSON.parse(raw) : { listId, words: {} };

    const listsRaw = await env.LEARNING_KV.get('user:' + user.sub + ':lists');
    const list = (listsRaw ? JSON.parse(listsRaw) : []).find(l => l.id === listId);
    if (!list) return json({ error: 'no such list' }, 404);
    const words = (list.words || []).filter(w => w && w.en && w.he).slice(0, MAX_WORDS_PER_LIST);
    const missing = words.filter(w => !bank.words[normWord(w.en)]);
    const setKey = wordSetKey(words);
    const unverified = () => Object.values(bank.words).filter(e => e.checkedFor !== setKey);

    if (method === 'GET') {
      return json({
        words: bank.words,
        remaining: missing.length + unverified().length,
        ready: missing.length === 0 && unverified().length === 0,
      });
    }
    if (method !== 'POST') return json({ error: 'not found' }, 404);

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'sentence generation is not configured' }, 503);
    }
    if (!await withinBudget(env, user, 1)) {
      return json({ error: 'daily limit reached' }, 429);
    }

    // everything is written: check the accept lists of whatever hasn't been
    // judged against this word set yet, a few words at a time
    if (missing.length === 0) {
      const stale = unverified().slice(0, WORDS_PER_VERIFY);
      if (stale.length === 0) {
        return json({ words: bank.words, remaining: 0, ready: true });
      }
      if (!await withinBudget(env, user, 1)) return json({ error: 'daily limit reached' }, 429);
      const t0 = Date.now();
      try {
        await verifyAccepts(env, words, stale);
      } catch (e) {
        console.error(`accepts FAILED for [${stale.map(e2 => e2.en)}]: ${e && e.message || e}`);
        // a sentence with an unchecked accept list is still usable - don't loop
        stale.forEach(e2 => { e2.checkedFor = setKey; });
      }
      stale.forEach(e2 => { e2.checkedFor = setKey; });
      await env.LEARNING_KV.put(bankKey(user, listId), JSON.stringify(bank));
      console.log(`accepts: [${stale.map(e2 => e2.en)}] in ${Date.now() - t0}ms`);
      const left = unverified().length;
      return json({ words: bank.words, remaining: left, ready: left === 0 });
    }

    const batch = missing.slice(0, WORDS_PER_CALL);
    let made;
    const started = Date.now();
    try {
      made = await generateSentences(env, words, batch);
    } catch (e) {
      // `wrangler pages deployment tail` is the only window into this
      console.error(`sentences FAILED for [${batch.map(w => w.en)}] after ` +
        `${Date.now() - started}ms: ${e && e.message || e}`);
      return json({ error: 'generation failed', detail: String(e && e.message || e) }, 502);
    }
    console.log(`sentences: [${batch.map(w => w.en)}] in ${Date.now() - started}ms`);
    // merge: only ever add words, never rewrite sentences we already have
    for (const [key, entry] of Object.entries(made)) {
      if (!bank.words[key]) bank.words[key] = entry;
    }
    await env.LEARNING_KV.put(bankKey(user, listId), JSON.stringify(bank));

    const left = words.filter(w => !bank.words[normWord(w.en)]).length;
    // a word Claude returned nothing usable for would loop forever - report it
    const stuck = left === missing.length;
    return json({
      words: bank.words,
      remaining: left + unverified().length,
      ready: false,           // the accept pass still has to run
      stuck,
    });
  }

  /* She filled the gap with another word from her own list. The sentence's
     accept list is whatever the writer thought of at the time, so ask - and if
     it does fit, write it into the bank so the sentence never refuses it again. */
  if (path === 'sentence-fits' && method === 'POST') {
    if (!user) return json({ error: 'not logged in' }, 401);
    const { listId, word, sentence } = await request.json().catch(() => ({}));
    if (!listId || !word || !sentence) return json({ error: 'missing fields' }, 400);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not configured' }, 503);

    const raw = await env.LEARNING_KV.get(bankKey(user, listId));
    if (!raw) return json({ error: 'no sentences for this list' }, 404);
    const bank = JSON.parse(raw);
    // only ever judge a sentence we actually wrote, filled with a word she owns
    const entry = Object.values(bank.words).find(
      e => e.sentences.some(s => s.text === sentence));
    if (!entry) return json({ error: 'unknown sentence' }, 404);
    const target = entry.sentences.find(s => s.text === sentence);
    if (target.accept.some(a => normWord(a) === normWord(word))) return json({ fits: true });
    if (!await withinBudget(env, user, 1)) return json({ error: 'daily limit reached' }, 429);

    let fits = false;
    try {
      const out = await askClaude(env, {
        system: `A 10-year-old learning English filled a gap in a practice sentence. Decide whether her word makes the sentence correct and sensible English - not whether it was the word the sentence was written for. If a reader would accept the finished sentence without a second thought, it fits. Judge the finished sentence only.`,
        prompt: `Sentence: ${sentence}
She wrote: ${word}
Finished sentence: ${sentence.replace('___', word)}`,
        schema: {
          type: 'object',
          properties: { fits: { type: 'boolean' } },
          required: ['fits'],
          additionalProperties: false,
        },
        model: env.CHECK_MODEL,
        effort: 'low',
      });
      fits = out.fits === true;
    } catch (e) {
      console.error(`sentence-fits FAILED "${word}": ${e && e.message || e}`);
      return json({ error: 'check failed' }, 502);
    }

    if (fits) {
      target.accept.push(word);
      await env.LEARNING_KV.put(bankKey(user, listId), JSON.stringify(bank));
      console.log(`sentence-fits: "${word}" now accepted for "${sentence}"`);
    }
    return json({ fits });
  }

  /* Grade a sentence she wrote herself. */
  if (path === 'sentence-check' && method === 'POST') {
    if (!user) return json({ error: 'not logged in' }, 401);
    const { word, sentence } = await request.json().catch(() => ({}));
    if (!word || !sentence) return json({ error: 'missing word or sentence' }, 400);
    if (String(sentence).length > 300 || String(word).length > 60) {
      return json({ error: 'too long' }, 413);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'checking is not configured' }, 503);
    if (!await withinBudget(env, user, 1)) return json({ error: 'daily limit reached' }, 429);

    try {
      const out = await askClaude(env, {
        system: CHECK_SYSTEM,
        prompt: `Target word: ${word}\nHer sentence: ${sentence}`,
        schema: CHECK_SCHEMA,
        model: env.CHECK_MODEL,
      });
      return json({
        verdict: ['great', 'almost', 'try_again'].includes(out.verdict) ? out.verdict : 'almost',
        word_ok: out.word_ok !== false,
        feedback: String(out.feedback || ''),
        correction: String(out.correction || ''),
      });
    } catch (e) {
      console.error(`sentence-check FAILED for "${word}": ${e && e.message || e}`);
      return json({ error: 'check failed', detail: String(e && e.message || e) }, 502);
    }
  }

  return json({ error: 'not found' }, 404);
}
