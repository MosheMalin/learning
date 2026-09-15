// Multi-user API: Google sign-in sessions + per-user word lists in KV.
// Routes: POST /api/login, POST /api/logout, GET /api/me, GET|PUT /api/lists,
//         GET|POST /api/sentences, POST /api/sentence-check
//
// The two sentence routes are the only ones that call Claude. Sentences are
// generated once per list and then frozen in KV - practice itself never needs
// the network, so a round plays the same offline as online.

import Anthropic from '@anthropic-ai/sdk';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

/* Which model writes the sentences and which one marks them. Both are plain
   Pages variables, so either can be changed without touching this code.
   Writing simple sentences is an easier job than judging a child's writing,
   so they are separate knobs. */
const DEFAULT_MODEL = 'claude-opus-5';
const SENTENCES_PER_WORD = 5;
const SENTENCES_ASKED = 7;     // spares, so the vaguest can be dropped
const WORDS_PER_CALL = 2;      // one request must answer well inside ~100s, or
                               // Cloudflare drops the connection with nothing
const MAX_WORDS_PER_LIST = 40;
const DAILY_CALL_BUDGET = 400; // per user, protects the API key from a runaway loop

function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

async function getSession(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid) return null;
  const raw = await env.LEARNING_KV.get('session:' + sid);
  return raw ? JSON.parse(raw) : null;
}

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

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['great', 'almost', 'try_again'] },
    feedback: { type: 'string' },
    correction: { type: 'string' },
  },
  required: ['verdict', 'feedback', 'correction'],
  additionalProperties: false,
};

const CHECK_SYSTEM = `A 10-year-old Israeli girl learning English (mother tongue Hebrew) was asked to write her own English sentence using one target word. Judge her sentence.

"great": she used the target word with its real meaning and the sentence is understandable and basically correct. Small slips that a native reader would not stumble over - a missing full stop, a lower-case first letter - are still "great".
"almost": the meaning comes through and the target word is used sensibly, but there is one clear mistake to fix (a wrong verb form, a missing article, a misspelled word, wrong word order).
"try_again": she did not use the target word, used it with the wrong meaning, or the sentence cannot be understood.

Be generous and encouraging - this is a beginner writing a foreign language, not an exam. Never ask for longer or fancier sentences; a short correct sentence is a great sentence.

"feedback": one or two short sentences in simple Hebrew, warm and specific. Name the single most useful thing to fix, and say what she did well. Do not use English grammar jargon.
"correction": her sentence rewritten correctly in English, keeping her idea and her words as far as possible. If nothing needs fixing, repeat her sentence unchanged.`;

export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join('/');
  const method = request.method;

  if (path === 'login' && method === 'POST') {
    const { credential } = await request.json().catch(() => ({}));
    if (!credential) return json({ error: 'missing credential' }, 400);
    const verify = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!verify.ok) return json({ error: 'invalid token' }, 401);
    const info = await verify.json();
    if (!env.GOOGLE_CLIENT_ID || info.aud !== env.GOOGLE_CLIENT_ID || info.email_verified !== 'true') {
      return json({ error: 'invalid token' }, 401);
    }
    const user = {
      sub: info.sub,
      email: info.email,
      name: info.name || info.email,
      picture: info.picture || '',
    };
    const sid = crypto.randomUUID() + crypto.randomUUID();
    await env.LEARNING_KV.put('session:' + sid, JSON.stringify(user), { expirationTtl: SESSION_TTL });
    return json(user, 200, {
      'Set-Cookie': `sid=${sid}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  if (path === 'logout' && method === 'POST') {
    const sid = getCookie(request, 'sid');
    if (sid) await env.LEARNING_KV.delete('session:' + sid);
    return json({ ok: true }, 200, {
      'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    });
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

    if (method === 'GET' || missing.length === 0) {
      return json({ words: bank.words, remaining: missing.length, ready: missing.length === 0 });
    }
    if (method !== 'POST') return json({ error: 'not found' }, 404);

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'sentence generation is not configured' }, 503);
    }
    if (!await withinBudget(env, user, 1)) {
      return json({ error: 'daily limit reached' }, 429);
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
    return json({ words: bank.words, remaining: left, ready: left === 0, stuck });
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
